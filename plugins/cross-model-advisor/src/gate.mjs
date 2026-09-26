#!/usr/bin/env node
/**
 * The review gate. When Claude finishes a turn that changed files, enabled
 * advisors from other model families review what git measured, and concerns
 * or blockers send Claude back to address them (`gate.mode: "block"`) or are
 * shown to the user (`"report"`). In `"advise"` mode Claude stops at once and
 * a background review wakes it only for blockers. Also `on` and `doctor`,
 * which need the provider SDK that the lightweight control helper does not
 * load.
 *
 *   gate.mjs stop                        Stop hook; payload on stdin
 *   gate.mjs advise                      asyncRewake Stop hook; exits 2 to wake Claude
 *   gate.mjs on|doctor --plugin-data <p> session skills
 *
 * The Stop hook fails open: errors let Claude stop, are recorded for
 * /status, and are never reported as a successful review.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ignoreFactory from "ignore";
import { reviewApi, validateApi } from "./backends/api.mjs";
import { configFilePath, loadConfig, runtimeErrors, validateRoot } from "./config.mjs";
import { advisorSystemPrompt } from "./prompt.mjs";
import { gitIgnoredPaths, gitTopLevel, reviewBaseTree, snapshotTree, turnDiff } from "./snapshot.mjs";
import { createReviewTools, normalizeFinding } from "./tools.mjs";
import {
  MAX_FINDINGS_PER_REVIEW,
  MAX_REASON_CHARS,
  MAX_STDIN_BYTES,
  SESSION_RETENTION_MS,
  SEVERITY_ORDER,
  STOP_REVIEW_BUDGET_MS,
  USER_SUMMARY_CHARS,
  ADVISE_WAIT_MS,
  USER_TEXT_CAP,
  WAKE_MARKER
} from "./session/constants.mjs";
import { createErrorLog } from "./session/errors.mjs";
import {
  ensurePrivateDir,
  explicitPluginData,
  readIdentity,
  sessionDir,
  statePath,
  validateSessionId
} from "./session/paths.mjs";
import { resolveSecrets, sanitizeText, secretNamesFromSnapshot, truncateLabeled } from "./session/sanitize.mjs";
import { loadState, pushNotice, sweepAdviseStops, takeNotices, updateState } from "./session/state.mjs";

const MAX_ADVISE_STOPS = 16;
// Both Stop hooks start together, so this Stop's entry is never older than
// the background hook by more than clock noise.
const ADVISE_CLOCK_SLACK_MS = 1_000;

const USAGE = "usage: gate.mjs stop | advise | on|doctor --plugin-data <path> | review --plugin-data <path> [--base <ref>]";
const DISCLOSURE =
  "At the end of each turn that changes files, the request, Claude's final message, and the git diff (minus excluded paths) go to the configured external providers, which may also read allowed project files. Claude's own credentials are never used.";

class GateError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
function credentialDir(env) {
  return path.join(path.dirname(configFilePath(env)), "cross-model-advisor", "credentials");
}

function pluginRootFromHere() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.basename(here);
  if (dir === "src" || dir === "dist") return path.dirname(here);
  if (dir === "modules") return path.dirname(path.dirname(here));
  return here;
}

/**
 * @param {{ usage?: object | null } | null} prev
 * @param {any} next
 */
function mergeUsage(prev, next) {
  if (!next) return prev ?? null;
  const base = prev ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  const cost =
    base.costUsd === "unknown" || next.costUsd === "unknown" || typeof next.costUsd !== "number"
      ? "unknown"
      : base.costUsd + next.costUsd;
  return {
    inputTokens: (base.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (base.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (base.totalTokens ?? 0) + (next.totalTokens ?? 0),
    costUsd: cost
  };
}

/**
 * @typedef {{ reviews: number, usage: object | null, lastError: string | null }} AdvisorUsage
 */

/**
 * Add one review's advisor usage to the session's totals.
 *
 * @param {{ advisors: Record<string, AdvisorUsage> }} state
 * @param {Record<string, AdvisorUsage>} spent
 */
function addUsage(state, spent) {
  for (const [name, entry] of Object.entries(spent)) {
    const total = (state.advisors[name] ??= { reviews: 0, usage: null, lastError: null });
    total.reviews += entry.reviews;
    total.usage = mergeUsage(total.usage, entry.usage);
    total.lastError = entry.lastError;
  }
}

/**
 * Enabled advisors whose provider and model validate offline. No network.
 *
 * @param {Awaited<ReturnType<typeof loadConfig>>} config
 * @param {NodeJS.ProcessEnv} env
 * @param {{ validateApi: typeof validateApi }} deps
 */
export async function diagnoseAdvisors(config, env, deps) {
  const rows = [];
  for (const advisor of config.advisors) {
    const provider = config.providers[advisor.provider];
    const row = {
      name: advisor.name,
      enabled: advisor.enabled !== false,
      available: false,
      provider: advisor.provider,
      model: advisor.model,
      kind: provider?.kind,
      reasoningEffort: advisor.reasoningEffort ?? "default",
      error: undefined
    };
    if (!row.enabled) {
      rows.push(row);
      continue;
    }
    if (!provider) {
      row.error = "missing provider";
      rows.push(row);
      continue;
    }
    const diagnostic = await deps.validateApi({
      provider,
      advisor,
      env,
      maxOutputTokens: config.limits.maxOutputTokens
    });
    row.available = Boolean(diagnostic?.available);
    if (!row.available) {
      const err = diagnostic?.error;
      row.error = sanitizeText(typeof err === "string" ? err : err?.message || "unavailable");
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Session identity for a hook (payload) or a skill (flag).
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ session_id?: unknown }} [payload]
 */
function sessionFrom(env, payload = {}) {
  const identity = readIdentity(env, payload);
  if (
    typeof payload.session_id === "string" &&
    identity.sessionId &&
    payload.session_id !== identity.sessionId
  ) {
    throw new GateError("identity", "hook session id does not match the Claude session environment");
  }
  if (!identity.sessionId) throw new GateError("identity", "missing Claude session id; run this inside Claude Code");
  if (!identity.pluginData) throw new GateError("identity", "missing plugin data directory");
  let sessionId;
  try {
    sessionId = validateSessionId(identity.sessionId);
  } catch {
    throw new GateError("identity", "invalid Claude session id");
  }
  return { ...identity, sessionId, dir: sessionDir(identity.pluginData, sessionId) };
}

/**
 * @param {string} pluginData
 * @param {string} liveId
 * @param {number} now
 */
async function pruneSessions(pluginData, liveId, now) {
  const root = path.join(pluginData, "sessions");
  let entries;
  try {
    entries = await fsPromises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === liveId) continue;
    const dir = path.join(root, entry.name);
    try {
      const stat = await fsPromises.stat(statePath(dir));
      if (now - stat.mtimeMs > SESSION_RETENTION_MS) await fsPromises.rm(dir, { recursive: true, force: true });
    } catch {
      // unreadable or partial directories are left alone
    }
  }
}

/**
 * @param {{ severity: string, advisor: string, provider: string, model: string, note: string, evidence: any[] }} finding
 */
function evidenceLine(finding) {
  return finding.evidence
    .map((item) => {
      const where = item.kind === "file" ? `${item.path}:${item.line}` : item.eventId;
      return `${where} — ${item.detail}`;
    })
    .join("; ");
}

/**
 * What Claude sees when the gate sends it back.
 *
 * @param {ReturnType<typeof collectFindings>} findings
 * @param {{ round: number, maxRounds: number }} rounds
 */
export function formatBlockReason(findings, { round, maxRounds }, intro = defaultBlockIntro(round, maxRounds)) {
  const required = findings.filter((item) => item.severity !== "nit");
  const optional = findings.filter((item) => item.severity === "nit");
  const lines = [intro, ""];
  required.forEach((item, index) => {
    lines.push(`${index + 1}. [${item.severity}] ${item.advisor} (${item.provider}/${item.model})`);
    lines.push(`   ${item.note}`);
    lines.push(`   Evidence: ${evidenceLine(item)}`);
  });
  if (optional.length) {
    lines.push("", "Optional (nits):");
    for (const item of optional) lines.push(`- ${item.advisor}: ${item.note}`);
  }
  return truncateLabeled(sanitizeText(lines.join("\n")), MAX_REASON_CHARS);
}

/**
 * @param {number} round
 * @param {number} maxRounds
 */
function defaultBlockIntro(round, maxRounds) {
  return (
    `Cross-model advisors reviewed the changes from this turn (review round ${round} of at most ${maxRounds}) and raised issues. ` +
    "They are other AI models, not the user, and their findings are unverified. Check each one against the code. " +
    "Fix the ones that are real; for any you judge wrong, say briefly why instead of changing code. Do not make unrelated changes."
  );
}

/**
 * What wakes Claude when advise mode's background review finds a blocker.
 * Claude may be idle or busy with a newer request by the time it arrives.
 *
 * @param {ReturnType<typeof collectFindings>} findings
 * @param {{ round: number, maxRounds: number }} rounds
 */
export function formatWakeReason(findings, { round, maxRounds }) {
  const intro =
    `${WAKE_MARKER} Cross-model advisors reviewed an earlier turn in the background (wake ${round} of at most ${maxRounds} ` +
    "before the user's next prompt) and found a blocker. They are other AI models, not the user, and their findings are unverified. " +
    "If the user has asked for something since, finish that first unless a finding bears on it. Then check each finding against " +
    "the code as it is now, which may have changed: fix the real ones, and for any you judge wrong or already fixed, say briefly why. " +
    "Begin your reply by telling the user in one line that a background review flagged these. Do not make unrelated changes.";
  return formatBlockReason(findings, { round, maxRounds }, intro);
}

/**
 * The user's card for a background review, shown with their next prompt.
 *
 * @param {string} headline
 * @param {ReturnType<typeof collectFindings>} findings
 * @param {{ name: string, error?: string }[]} failed
 */
function formatBackgroundCard(headline, findings, failed) {
  const lines = [`cross-model-advisor: ${headline}`];
  if (failed.length) lines.push(`- ${notReviewedBy(failed)}`);
  for (const item of findings) lines.push(`- [${item.severity}] ${item.advisor}: ${item.note}`);
  return truncateLabeled(sanitizeText(lines.join("\n")), USER_SUMMARY_CHARS);
}

/**
 * What Claude is given with the next prompt for findings it was not woken for.
 *
 * @param {ReturnType<typeof collectFindings>} findings
 */
function formatNoticeContext(findings) {
  const lines = [
    "cross-model-advisor: a background review of an earlier turn raised these. They are other AI models' unverified claims, " +
      "and the user has been shown them. Do not act on them unless they bear on the current request or the user asks."
  ];
  for (const item of findings) lines.push(`- [${item.severity}] ${item.advisor}: ${item.note} (evidence: ${evidenceLine(item)})`);
  return sanitizeText(lines.join("\n"));
}

/**
 * What the user sees when findings do not send Claude back.
 *
 * @param {ReturnType<typeof collectFindings>} findings
 */
export function formatUserSummary(findings, failed = []) {
  const lines = [`cross-model-advisor: ${findings.length} finding${findings.length === 1 ? "" : "s"} on this turn`];
  // Before the findings, so truncating a long summary cannot drop it.
  if (failed.length) lines.push(`- ${notReviewedBy(failed)}`);
  for (const item of findings) lines.push(`- [${item.severity}] ${item.advisor}: ${item.note}`);
  return truncateLabeled(sanitizeText(lines.join("\n")), USER_SUMMARY_CHARS);
}

/**
 * What the user sees when the gate sends Claude back. The block reason goes to
 * Claude, so without this the user would only learn of the findings from
 * Claude's reply.
 *
 * @param {ReturnType<typeof collectFindings>} findings
 * @param {{ name: string, error?: string }[]} failed
 * @param {{ round: number, maxRounds: number }} rounds
 */
export function formatBlockedSummary(findings, failed, { round, maxRounds }) {
  const count = `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
  const lines = [`cross-model-advisor: sent Claude back with ${count} (round ${round} of at most ${maxRounds})`];
  if (failed.length) lines.push(`- ${notReviewedBy(failed)}`);
  for (const item of findings) lines.push(`- [${item.severity}] ${item.advisor}: ${item.note}`);
  return truncateLabeled(sanitizeText(lines.join("\n")), USER_SUMMARY_CHARS);
}

/**
 * What the user sees when the gate lets Claude stop without reviewing a turn
 * that changed files.
 *
 * @param {string} why
 */
export function formatNotReviewed(why) {
  return `${JSON.stringify({
    systemMessage: truncateLabeled(sanitizeText(`cross-model-advisor: this turn was not reviewed (${why})`), USER_SUMMARY_CHARS)
  })}\n`;
}

/**
 * @param {{ name: string, error?: string }[]} failed
 */
function notReviewedBy(failed) {
  const detail = failed.map((result) => `${result.name}: ${result.error}`).join("; ");
  return `${failed.length === 1 ? "one advisor" : `${failed.length} advisors`} did not finish reviewing this turn (${detail})`;
}

/**
 * What the user sees when some advisors failed and the rest found nothing.
 *
 * @param {{ name: string, error?: string }[]} failed
 */
export function formatPartialFailure(failed) {
  return truncateLabeled(sanitizeText(`cross-model-advisor: no findings, but ${notReviewedBy(failed)}`), USER_SUMMARY_CHARS);
}

/**
 * Merge advisors' findings: most severe first, duplicates across advisors
 * dropped.
 *
 * @param {{ name: string, provider: string, model: string, findings: any[] }[]} results
 */
export function collectFindings(results) {
  const seen = new Set();
  const all = [];
  for (const result of results) {
    for (const finding of result.findings) {
      const key = normalizeFinding(finding.note);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        advisor: result.name,
        provider: result.provider,
        model: result.model,
        severity: finding.severity,
        note: finding.note,
        evidence: finding.evidence
      });
    }
  }
  return all.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
}

/**
 * Run `tasks` with at most `limit` in flight.
 *
 * @template T
 * @param {(() => Promise<T>)[]} tasks
 * @param {number} limit
 * @returns {Promise<T[]>}
 */
async function pool(tasks, limit) {
  const out = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      out[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Every runnable advisor reviews one diff, at most maxConcurrentAdvisors at a
 * time and all inside one deadline. Shared by the Stop gate and on-demand
 * reviews, so both apply the same tools, evidence rules, and limits. Records
 * this review's per-advisor usage in `spent`; the caller adds it to the session.
 *
 * @param {{ runnable: any[], config: any, spent: Record<string, AdvisorUsage>, session: any, deps: typeof defaultDeps, env: NodeJS.ProcessEnv,
 *   secrets: string[], credDir: string, ignoredPaths: string[], turnContext: object, observations: object[],
 *   deadline: number, tree: string, projectRoot: string }} input `tree` is the snapshot under review, which
 *   the advisors' tools read instead of the working tree.
 */
function runAdvisors({ runnable, config, spent, session, deps, env, secrets, credDir, ignoredPaths, turnContext, observations, deadline, tree, projectRoot }) {
  const { limits } = config;
  return pool(
    runnable.map((advisor) => async () => {
      const provider = config.providers[advisor.provider];
      const base = { name: advisor.name, provider: advisor.provider, model: advisor.model, findings: [] };
      const stats = (spent[advisor.name] ??= { reviews: 0, usage: null, lastError: null });
      // Advisors queued behind maxConcurrentAdvisors share one budget, so their
      // timeouts cannot add up past the point where Claude Code kills the hook.
      const remaining = deadline - deps.now();
      if (remaining <= 0) {
        stats.lastError = "timeout: the review's time ran out before this advisor started";
        return { ...base, ok: false, error: stats.lastError };
      }
      stats.reviews += 1;
      const abort = new AbortController();
      const timer = setTimeout(
        () => abort.abort({ code: "timeout" }),
        Math.min(limits.reviewTimeoutSeconds * 1000, remaining)
      );
      let tools;
      try {
        tools = await deps.createReviewTools({
          root: projectRoot,
          exclude: config.exclude,
          observations,
          advisor: { name: advisor.name },
          signal: abort.signal,
          pluginData: session.pluginData,
          credentialDir: credDir,
          secrets,
          maxFindings: MAX_FINDINGS_PER_REVIEW,
          ignoredPaths,
          tree,
          env
        });
        const result = await deps.reviewApi({
          provider,
          advisor,
          turn: turnContext,
          systemPrompt: [advisorSystemPrompt, advisor.instructions].filter(Boolean).join("\n\n"),
          tools,
          limits,
          signal: abort.signal,
          env
        });
        stats.usage = mergeUsage(stats.usage, result?.usage);
        stats.lastError = null;
        return { ...base, ok: true, findings: tools.candidates ?? [] };
      } catch (error) {
        stats.usage = mergeUsage(stats.usage, error?.usage);
        const code = typeof error?.code === "string" ? error.code : "error";
        stats.lastError = sanitizeText(`${code}: ${error instanceof Error ? error.message : "review failed"}`, secrets);
        // Findings staged before a cutoff passed evidence checks; keep them.
        return { ...base, ok: false, error: stats.lastError, findings: tools?.candidates ?? [] };
      } finally {
        clearTimeout(timer);
        tools?.close?.();
      }
    }),
    limits.maxConcurrentAdvisors
  );
}

const defaultDeps = {
  loadConfig,
  validateApi,
  reviewApi,
  createReviewTools,
  snapshotTree,
  turnDiff,
  gitIgnoredPaths,
  reviewBaseTree,
  now: () => Date.now()
};

/**
 * Review one measured turn: choose the advisors that can run, compute the
 * diff, and collect their findings. Shared by the Stop gate and advise mode's
 * background review so both apply the same checks. Adds `key` to `reviewed`
 * once the turn needs no further review, and this review's usage to `spent`.
 *
 * @param {{ config: any, session: any, deps: typeof defaultDeps, env: NodeJS.ProcessEnv, projectRoot: string,
 *   totals: Record<string, AdvisorUsage>, base: string, head: string, key: string, request: string, final: unknown,
 *   round: number, previous: object[], deadline: number, spent: Record<string, AdvisorUsage>, reviewed: string[] }} input
 * @returns {Promise<
 *   | { outcome: "skipped" | "failed", reason: string, notice?: string }
 *   | { outcome: "reviewed", findings: ReturnType<typeof collectFindings>, advisors: object[], failed: any[], results: any[] }>}
 */
async function reviewMeasured({ config, session, deps, env, projectRoot, totals, base, head, key, request, final, round, previous, deadline, spent, reviewed }) {
  const { gate, limits } = config;
  const secrets = resolveSecrets(secretNamesFromSnapshot(config), env);
  const credDir = credentialDir(env);
  const diagnosed = await diagnoseAdvisors(config, env, deps);
  const runnable = config.advisors.filter((advisor) => {
    const row = diagnosed.find((item) => item.name === advisor.name);
    const used = totals[advisor.name]?.reviews ?? 0;
    return row?.available && used < limits.maxReviewsPerAdvisorPerSession;
  });
  if (runnable.length === 0) {
    const enabled = diagnosed.filter((row) => row.enabled);
    const why = enabled.length
      ? enabled.map((row) => `${row.name}: ${row.available ? "session review limit reached" : row.error}`).join("; ")
      : "no advisor is enabled";
    return { outcome: "skipped", reason: "no available advisors", notice: why };
  }

  let ignoredPaths;
  try {
    ignoredPaths = await deps.gitIgnoredPaths(projectRoot, { env });
  } catch {
    return { outcome: "failed", reason: "could not list the paths git ignores", notice: "could not list the paths git ignores" };
  }

  let diff;
  try {
    const probe = await deps.createReviewTools({
      root: projectRoot,
      exclude: config.exclude,
      observations: [],
      pluginData: session.pluginData,
      credentialDir: credDir,
      secrets,
      ignoredPaths
    });
    diff = await deps.turnDiff(projectRoot, base, head, { env, isExcluded: probe.excluded });
  } catch {
    return { outcome: "failed", reason: "could not compute the diff", notice: "could not compute the diff" };
  }
  // Every changed path, shown or not, must match for a turn to be skipped.
  const changed = [...diff.files.map((file) => file.path), ...diff.omitted, ...diff.unshown];
  if (gate.skipWhenOnly?.length && changed.length) {
    const skip = (typeof ignoreFactory === "function" ? ignoreFactory : ignoreFactory.default)().add(gate.skipWhenOnly);
    if (changed.every((file) => skip.ignores(file))) {
      reviewed.push(key);
      return { outcome: "skipped", reason: "only files matching gate.skipWhenOnly changed" };
    }
  }
  if (diff.files.length === 0) {
    reviewed.push(key);
    return { outcome: "skipped", reason: "only excluded files changed" };
  }
  const files = diff.files.map((file) => ({ ...file, eventId: `diff:${file.path}`, text: sanitizeText(file.text, secrets) }));
  const turnContext = {
    request: truncateLabeled(sanitizeText(request, secrets), USER_TEXT_CAP),
    final: truncateLabeled(sanitizeText(String(final ?? ""), secrets), USER_TEXT_CAP),
    round,
    previous,
    diff: { files, omitted: diff.omitted, unshown: diff.unshown }
  };
  const observations = [{ eventId: "request" }, { eventId: "final" }, ...files.map((file) => ({ eventId: file.eventId }))];

  const results = await runAdvisors({
    runnable,
    config,
    spent,
    session,
    deps,
    env,
    secrets,
    credDir,
    ignoredPaths,
    turnContext,
    observations,
    deadline,
    tree: head,
    projectRoot
  });

  reviewed.push(key);
  const findings = collectFindings(results);
  const advisors = results.map((result) => ({
    name: result.name,
    provider: result.provider,
    model: result.model,
    ok: result.ok,
    findings: result.findings.length,
    error: result.error
  }));
  return { outcome: "reviewed", findings, advisors, failed: results.filter((result) => !result.ok), results };
}

/**
 * Stop hook. Returns hook stdout: "" to let Claude stop silently, a block
 * decision, or a user-visible systemMessage. In advise mode it only measures
 * the turn and queues it for the background review (`runAdvise`); it also
 * shows the user what earlier background reviews left.
 *
 * @param {any} payload
 * @param {{ env?: NodeJS.ProcessEnv, deps?: Partial<typeof defaultDeps> }} [options]
 * @returns {Promise<string>}
 */
export async function runStop(payload, options = {}) {
  /** What this Stop did, for afterStop: whether it queued a background job. */
  const stop = { queued: false };
  const out = await stopTurn(payload, options, stop);
  return afterStop(payload, out, options, stop);
}

/**
 * @param {any} payload
 * @param {{ env?: NodeJS.ProcessEnv, deps?: Partial<typeof defaultDeps> }} options
 * @param {{ queued: boolean }} stop
 * @returns {Promise<string>}
 */
async function stopTurn(payload, { env = process.env, deps: overrides = {} }, stop) {
  const deps = { ...defaultDeps, ...overrides };
  const deadline = deps.now() + STOP_REVIEW_BUDGET_MS;
  if (!payload || typeof payload !== "object" || payload.agent_id) return "";
  const session = sessionFrom(env, payload);
  const state = await loadState(session.dir);
  if (!state.enabled || !state.projectRoot) return "";

  const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : null;
  /** This Stop's advisor usage, added to the session when it records. */
  const spent = {};
  /**
   * @param {string} outcome
   * @param {string} reason
   * @param {object} [extra]
   */
  const record = async (outcome, reason, extra = {}) => {
    const entry = { at: deps.now(), promptId, outcome, reason, ...extra };
    // Applied to the state as it is now: a background review may have saved
    // since this Stop loaded it. Only the Stop gate changes the turn and rounds.
    await updateState(session.dir, (fresh) => {
      fresh.turn = state.turn;
      fresh.rounds = state.rounds;
      fresh.reviewed = [...new Set([...fresh.reviewed, ...state.reviewed])];
      addUsage(fresh, spent);
      // A skip must not erase the last real review: /status and the
      // round-limit message point at its findings.
      if (outcome === "skipped") fresh.lastSkip = entry;
      else fresh.last = entry;
    });
    for (const name of Object.keys(spent)) delete spent[name];
  };

  const turn = state.turn;
  // Every prompt leaves a turn, and a Stop that lets Claude stop marks it used,
  // so a Stop that is not a continuation and finds no fresh turn belongs to a
  // prompt the prompt hook missed. Prompt ids catch the same when both hooks
  // have them.
  const stale = Boolean(turn?.stopped) && payload.stop_hook_active !== true;
  const mismatched = Boolean(promptId && turn?.promptId && turn.promptId !== promptId);
  if (!turn || stale || mismatched) {
    // Dropped, so a continuation of this prompt cannot reuse an older baseline.
    state.turn = null;
    const why = "the prompt hook did not snapshot this prompt";
    await record("skipped", why);
    return formatNotReviewed(why);
  }
  turn.stopped = true;
  if (turn.control) {
    await record("skipped", "control prompt");
    return "";
  }
  if (!turn.baseTree) {
    const why = `no snapshot for this prompt: ${turn.error ?? "unknown"}`;
    await record("skipped", why);
    return formatNotReviewed(why);
  }

  let config;
  try {
    config = await deps.loadConfig({ env });
  } catch (error) {
    const message = sanitizeText(error instanceof Error ? error.message : "invalid config");
    await record("failed", `config: ${message}`);
    return `${JSON.stringify({ systemMessage: `cross-model-advisor: review skipped, configuration is invalid (${message})` })}\n`;
  }
  const { gate } = config;

  let head;
  try {
    head = await deps.snapshotTree(state.projectRoot, session.dir, { env });
  } catch {
    await record("failed", "could not snapshot the working tree");
    return formatNotReviewed("could not snapshot the working tree");
  }
  if (head === turn.baseTree) {
    await record("skipped", "no file changes this turn");
    return "";
  }
  const key = `${turn.baseTree}..${head}`;
  if (state.reviewed.includes(key)) {
    await record("skipped", "these changes were already reviewed");
    return "";
  }

  if (gate.mode === "advise") {
    // Claude stops now; the background review picks this job up by its Stop.
    state.reviewed.push(key);
    const stopKey = stopKeyOf(payload);
    const job = { base: turn.baseTree, head, key, request: turn.request ?? "", status: "queued", wake: Boolean(turn.wake) };
    await updateState(session.dir, (fresh) => {
      fresh.turn = state.turn;
      fresh.rounds = state.rounds;
      fresh.reviewed = [...new Set([...fresh.reviewed, ...state.reviewed])];
      // Appended, never replacing: another Stop can share this key.
      fresh.advise.stops = [...fresh.advise.stops, { id: randomUUID(), stopKey, at: deps.now(), job }].slice(-MAX_ADVISE_STOPS);
    });
    stop.queued = true;
    return "";
  }

  if (state.rounds.promptId !== promptId) state.rounds = { promptId, count: 0 };
  if (gate.mode === "block" && state.rounds.count >= gate.maxRounds) {
    await record("skipped", `round limit (${gate.maxRounds}) reached for this prompt`);
    return `${JSON.stringify({
      systemMessage: `cross-model-advisor: stopped sending Claude back after ${gate.maxRounds} review round${gate.maxRounds === 1 ? "" : "s"}. Run /cross-model-advisor:status for the last findings.`
    })}\n`;
  }

  const round = state.rounds.count + 1;
  const previous =
    round > 1 && state.last?.promptId === promptId && Array.isArray(state.last?.findings)
      ? state.last.findings.map(({ severity, advisor, note }) => ({ severity, advisor, note }))
      : [];
  const review = await reviewMeasured({
    config,
    session,
    deps,
    env,
    projectRoot: state.projectRoot,
    totals: state.advisors,
    base: turn.baseTree,
    head,
    key,
    request: turn.request ?? "",
    final: payload.last_assistant_message,
    round,
    previous,
    deadline,
    spent,
    reviewed: state.reviewed
  });
  if (review.outcome !== "reviewed") {
    await record(review.outcome, review.reason);
    return review.notice ? formatNotReviewed(review.notice) : "";
  }
  const { findings, advisors, failed, results } = review;

  if (gate.mode === "block" && findings.some((item) => item.severity !== "nit")) {
    // Claude keeps working on this prompt, so the turn is not over.
    turn.stopped = false;
    state.rounds.count = round;
    await record("blocked", "concerns or blockers found", { round, findings, advisors });
    return `${JSON.stringify({
      decision: "block",
      reason: formatBlockReason(findings, { round, maxRounds: gate.maxRounds }),
      systemMessage: formatBlockedSummary(findings, failed, { round, maxRounds: gate.maxRounds })
    })}\n`;
  }
  if (findings.length) {
    await record("reported", "findings shown to the user", { round, findings, advisors });
    return `${JSON.stringify({ systemMessage: formatUserSummary(findings, failed) })}\n`;
  }
  if (failed.length === results.length) {
    await record("failed", "every advisor failed", { round, findings, advisors });
    const detail = failed.map((result) => `${result.name}: ${result.error}`).join("; ");
    return `${JSON.stringify({ systemMessage: truncateLabeled(`cross-model-advisor: review failed, so this turn was not reviewed (${detail})`, USER_SUMMARY_CHARS) })}\n`;
  }
  await record("passed", failed.length ? "no findings from the advisors that completed" : "no findings", {
    round,
    findings,
    advisors
  });
  if (failed.length) return `${JSON.stringify({ systemMessage: formatPartialFailure(failed) })}\n`;
  const names = results.map((result) => result.name).join(", ");
  return `${JSON.stringify({ systemMessage: truncateLabeled(sanitizeText(`cross-model-advisor: no findings from ${names}`), USER_SUMMARY_CHARS) })}\n`;
}

/**
 * Identifies one Stop to both Stop hooks, which start together with the same
 * payload.
 *
 * @param {any} payload
 */
export function stopKeyOf(payload) {
  return createHash("sha256")
    .update(JSON.stringify([payload?.prompt_id ?? null, payload?.stop_hook_active === true, String(payload?.last_assistant_message ?? "")]))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Both outputs' user messages, one after the other; the first output's
 * decision, if any, stands.
 *
 * @param {string} first
 * @param {string} second
 */
function joinHookOutput(first, second) {
  if (!second) return first;
  if (!first) return second;
  const a = JSON.parse(first);
  const b = JSON.parse(second);
  const systemMessage = [a.systemMessage, b.systemMessage].filter(Boolean).join("\n");
  return `${JSON.stringify({ ...a, ...(systemMessage ? { systemMessage } : {}) })}\n`;
}

/**
 * After every Stop: in advise mode, record it so its background review stops
 * waiting even when there is nothing to review, report background reviews
 * that were lost, and show the user what earlier ones left (Claude gets its
 * part with the next prompt).
 *
 * @param {any} payload
 * @param {string} out
 * @param {{ env?: NodeJS.ProcessEnv, deps?: Partial<typeof defaultDeps> }} options
 * @param {{ queued: boolean }} stop what this Stop did
 */
async function afterStop(payload, out, { env = process.env, deps: overrides = {} }, stop) {
  if (!payload || typeof payload !== "object" || payload.agent_id) return out;
  const deps = { ...defaultDeps, ...overrides };
  const session = sessionFrom(env, payload);
  const seen = await loadState(session.dir);
  if (!seen.enabled) return out;
  const advise = await deps.loadConfig({ env }).then(
    (config) => config.gate.mode === "advise",
    () => false
  );
  if (!advise && !seen.advise.stops.length && !seen.advise.notices.some((notice) => notice.user)) return out;
  const stopKey = stopKeyOf(payload);
  const notices = await updateState(session.dir, (state) => {
    // Only a Stop that queued nothing leaves a marker. Its background hook may
    // already have taken the job, so the list cannot answer this.
    if (advise && !stop.queued) {
      state.advise.stops = [...state.advise.stops, { id: randomUUID(), stopKey, at: deps.now(), job: null }].slice(-MAX_ADVISE_STOPS);
    }
    sweepAdviseStops(state, deps.now());
    return takeNotices(state, { context: false });
  });
  return joinHookOutput(out, notices);
}

/**
 * Advise mode's background review: the asyncRewake Stop hook. Starts with the
 * Stop gate, waits for it to measure the turn, reviews it with the same checks
 * as the gate, and returns the text that wakes Claude when a blocker is found
 * (the hook exits 2 with it) or null. Everything else becomes a notice for the
 * user's next prompt, since Claude Code discards this hook's own output.
 *
 * @param {any} payload
 * @param {{ env?: NodeJS.ProcessEnv, deps?: Partial<typeof defaultDeps>, pollMs?: number, waitMs?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function runAdvise(payload, { env = process.env, deps: overrides = {}, pollMs = 100, waitMs = ADVISE_WAIT_MS } = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const started = deps.now();
  const deadline = started + STOP_REVIEW_BUDGET_MS;
  if (!payload || typeof payload !== "object" || payload.agent_id) return null;
  const session = sessionFrom(env, payload);
  let state = await loadState(session.dir);
  if (!state.enabled || !state.projectRoot) return null;
  let config;
  try {
    config = await deps.loadConfig({ env });
  } catch {
    return null; // The Stop gate reports an invalid configuration.
  }
  if (config.gate.mode !== "advise") return null;

  // This Stop's entry: its key, not yet taken, and written since this hook
  // started (another Stop can share the key; an older entry is not ours).
  const stopKey = stopKeyOf(payload);
  const ours = (/** @type {{ stopKey: string, at: number, claimedAt?: number }} */ stop) =>
    stop.stopKey === stopKey && !stop.claimedAt && stop.at >= started - ADVISE_CLOCK_SLACK_MS;
  for (;;) {
    if (state.advise.stops.some(ours) || deps.now() - started > waitMs) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    state = await loadState(session.dir);
  }
  const claimed = await updateState(session.dir, (fresh) => {
    const stop = fresh.advise.stops.find(ours);
    if (!stop) return null;
    if (!stop.job) {
      fresh.advise.stops = fresh.advise.stops.filter((item) => item !== stop);
      return null;
    }
    stop.claimedAt = deps.now();
    stop.job.status = "running";
    return { id: stop.id, job: { ...stop.job }, totals: structuredClone(fresh.advisors), wakes: fresh.advise.wakes, last: fresh.last };
  });
  if (!claimed) return null;
  try {
    return await reviewClaimed({ payload, config, session, deps, env, state, claimed, deadline });
  } catch (error) {
    // Say so now; if even this cannot save, the next prompt's sweep reports it.
    await createErrorLog(session.dir).record(error).catch(() => {});
    await updateState(session.dir, (fresh) => {
      fresh.advise.stops = fresh.advise.stops.filter((item) => item.id !== claimed.id);
      fresh.reviewed = fresh.reviewed.filter((item) => item !== claimed.job.key);
      pushNotice(fresh, "cross-model-advisor: an earlier turn was not reviewed in the background (the background review failed)");
    }).catch(() => {});
    return null;
  }
}

/**
 * Review a claimed background job and save the result.
 *
 * @param {{ payload: any, config: any, session: any, deps: typeof defaultDeps, env: NodeJS.ProcessEnv, state: any,
 *   claimed: { id: string, job: any, totals: Record<string, AdvisorUsage>, wakes: number, last: any }, deadline: number }} input
 * @returns {Promise<string | null>}
 */
async function reviewClaimed({ payload, config, session, deps, env, state, claimed, deadline }) {
  const { job } = claimed;
  const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : null;
  const maxWakes = config.gate.maxRounds;
  const round = Math.min(claimed.wakes + 1, maxWakes);
  // A turn Claude was woken for is reviewed with the findings that woke it.
  const previous =
    job.wake && Array.isArray(claimed.last?.findings)
      ? claimed.last.findings.map(({ severity, advisor, note }) => ({ severity, advisor, note }))
      : [];
  /** @type {Record<string, AdvisorUsage>} */
  const spent = {};
  /** @type {string[]} */
  const reviewed = [];
  let review;
  try {
    review = await reviewMeasured({
      config,
      session,
      deps,
      env,
      projectRoot: state.projectRoot,
      totals: claimed.totals,
      base: job.base,
      head: job.head,
      key: job.key,
      request: job.request,
      final: payload.last_assistant_message,
      round,
      previous,
      deadline,
      spent,
      reviewed
    });
  } catch (error) {
    await createErrorLog(session.dir).record(error).catch(() => {});
    review = { outcome: "failed", reason: "the background review failed", notice: "the background review failed" };
  }

  return updateState(session.dir, (fresh) => {
    fresh.advise.stops = fresh.advise.stops.filter((item) => item.id !== claimed.id);
    // The Stop gate counted the diff as reviewed when it queued it; it stays so
    // only if this review got that far, as in block mode.
    fresh.reviewed = [...new Set([...fresh.reviewed.filter((item) => item !== job.key), ...reviewed])];
    addUsage(fresh, spent);
    const at = deps.now();
    if (review.outcome !== "reviewed") {
      const entry = { at, promptId, outcome: review.outcome, reason: `background: ${review.reason}` };
      if (review.outcome === "skipped") fresh.lastSkip = entry;
      else fresh.last = entry;
      if (review.notice) pushNotice(fresh, `cross-model-advisor: an earlier turn was not reviewed in the background (${review.notice})`);
      return null;
    }
    const { findings, advisors, failed, results } = review;
    const blocker = findings.some((item) => item.severity === "blocker");
    const record = (outcome, reason) => {
      fresh.last = { at, promptId, outcome, reason, round, findings, advisors };
    };
    if (blocker && fresh.enabled && fresh.advise.wakes < maxWakes) {
      fresh.advise.wakes += 1;
      const rounds = { round: fresh.advise.wakes, maxRounds: maxWakes };
      record("woke", "a blocker found in the background woke Claude");
      pushNotice(
        fresh,
        formatBackgroundCard(`a background review woke Claude with ${findings.length} finding${findings.length === 1 ? "" : "s"} on an earlier turn (wake ${rounds.round} of at most ${rounds.maxRounds})`, findings, failed)
      );
      return formatWakeReason(findings, rounds);
    }
    if (findings.length) {
      const limited = blocker ? `; not waking Claude again before your next prompt (limit ${maxWakes})` : "";
      record("reported", blocker ? "the wake limit was reached" : "findings shown with the next prompt");
      pushNotice(
        fresh,
        formatBackgroundCard(`${findings.length} finding${findings.length === 1 ? "" : "s"} from the background review of an earlier turn${limited}`, findings, failed),
        formatNoticeContext(findings)
      );
      return null;
    }
    if (failed.length === results.length) {
      const detail = failed.map((result) => `${result.name}: ${result.error}`).join("; ");
      // Not reviewed, so a later Stop on this diff may try again.
      fresh.reviewed = fresh.reviewed.filter((item) => item !== job.key);
      record("failed", "every advisor failed");
      pushNotice(fresh, truncateLabeled(sanitizeText(`cross-model-advisor: the background review failed, so an earlier turn was not reviewed (${detail})`), USER_SUMMARY_CHARS));
      return null;
    }
    record("passed", failed.length ? "no findings from the advisors that completed" : "no findings");
    const names = results.filter((result) => result.ok).map((result) => result.name).join(", ");
    pushNotice(
      fresh,
      failed.length
        ? formatBackgroundCard(`no findings on an earlier turn, but ${notReviewedBy(failed)}`, [], [])
        : truncateLabeled(sanitizeText(`cross-model-advisor: no findings from ${names} on an earlier turn`), USER_SUMMARY_CHARS)
    );
    return null;
  });
}

/**
 * On-demand review, whether or not the gate is on: the working tree against
 * HEAD, or with `base` against HEAD's merge base with it, untracked files
 * included. Same advisors, tools, evidence rules, exclusions, and per-session
 * review cap as the gate; it reports and never blocks, and leaves the gate's
 * own state alone apart from advisor usage.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ base?: string | null }} [options]
 * @param {Partial<typeof defaultDeps>} [overrides]
 */
export async function runReview(env, { base = null } = {}, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const deadline = deps.now() + STOP_REVIEW_BUDGET_MS;
  if (base !== null && (!/^[A-Za-z0-9._/@{}^~-]{1,200}$/.test(base) || base.startsWith("-"))) {
    throw new GateError("base", "--base takes one git ref, such as main or origin/main");
  }
  const session = sessionFrom(env);
  const config = await deps.loadConfig({ env }).catch((error) => {
    throw new GateError("config", sanitizeText(error instanceof Error ? error.message : "invalid config"));
  });
  const top = await gitTopLevel(env.CLAUDE_PROJECT_DIR?.trim() || process.cwd(), { env });
  if (!top) throw new GateError("git", "the project is not inside a git work tree; a review needs git to see what changed");
  let projectRoot;
  try {
    projectRoot = await validateRoot(top);
  } catch (error) {
    throw new GateError("root", sanitizeText(error instanceof Error ? error.message : "invalid project root"));
  }
  await ensurePrivateDir(session.dir);
  const state = await loadState(session.dir);

  let from;
  let head;
  try {
    from = await deps.reviewBaseTree(projectRoot, base, { env });
    head = await deps.snapshotTree(projectRoot, session.dir, { env });
  } catch (error) {
    throw new GateError("git", sanitizeText(error instanceof Error ? error.message : "could not read the changes"));
  }
  const scope = base
    ? `everything since ${base} (merge base ${from.commit?.slice(0, 12)}), committed and uncommitted`
    : "uncommitted changes: HEAD against the working tree, untracked files included";
  const report = { ok: true, projectRoot, scope, files: [], omitted: [], unshown: [], advisors: [], findings: [] };
  if (head === from.tree) return { ...report, note: "nothing changed in this scope" };

  const secrets = resolveSecrets(secretNamesFromSnapshot(config), env);
  const credDir = credentialDir(env);
  const diagnosed = await diagnoseAdvisors(config, env, deps);
  const runnable = config.advisors.filter((advisor) => {
    const row = diagnosed.find((item) => item.name === advisor.name);
    return row?.available && (state.advisors[advisor.name]?.reviews ?? 0) < config.limits.maxReviewsPerAdvisorPerSession;
  });
  if (runnable.length === 0) {
    return { ...report, ok: false, error: "advisors", message: "no available advisors; run /cross-model-advisor:doctor" };
  }

  let ignoredPaths;
  let diff;
  try {
    ignoredPaths = await deps.gitIgnoredPaths(projectRoot, { env });
    const probe = await deps.createReviewTools({
      root: projectRoot,
      exclude: config.exclude,
      observations: [],
      pluginData: session.pluginData,
      credentialDir: credDir,
      secrets,
      ignoredPaths
    });
    diff = await deps.turnDiff(projectRoot, from.tree, head, { env, isExcluded: probe.excluded });
  } catch {
    throw new GateError("git", "could not compute the diff");
  }
  report.omitted = diff.omitted;
  report.unshown = diff.unshown;
  if (diff.files.length === 0) return { ...report, note: "only excluded files changed" };

  const files = diff.files.map((file) => ({ ...file, eventId: `diff:${file.path}`, text: sanitizeText(file.text, secrets) }));
  const turnContext = {
    request: `On-demand review requested by the user, not a single Claude turn. Scope: ${scope}. Review the change as it stands; it may span several turns and commits.`,
    final: "",
    round: 1,
    previous: [],
    diff: { files, omitted: diff.omitted, unshown: diff.unshown }
  };
  const observations = [{ eventId: "request" }, ...files.map((file) => ({ eventId: file.eventId }))];
  /** @type {Record<string, AdvisorUsage>} */
  const spent = {};
  const results = await runAdvisors({
    runnable,
    config,
    spent,
    session,
    deps,
    env,
    secrets,
    credDir,
    ignoredPaths,
    turnContext,
    observations,
    deadline,
    tree: head,
    projectRoot
  });
  await updateState(session.dir, (fresh) => addUsage(fresh, spent));
  return {
    ...report,
    files: files.map((file) => file.path),
    advisors: results.map((result) => ({
      name: result.name,
      provider: result.provider,
      model: result.model,
      ok: result.ok,
      findings: result.findings.length,
      error: result.error
    })),
    findings: collectFindings(results)
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {Partial<typeof defaultDeps>} [overrides]
 */
export async function runOn(env, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const session = sessionFrom(env);
  const config = await deps.loadConfig({ env }).catch((error) => {
    throw new GateError("config", sanitizeText(error instanceof Error ? error.message : "invalid config"));
  });
  const start = env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
  const top = await gitTopLevel(start, { env });
  if (!top) throw new GateError("git", "the project is not inside a git work tree; the gate needs git to see what changed");
  let projectRoot;
  try {
    projectRoot = await validateRoot(top);
  } catch (error) {
    throw new GateError("root", sanitizeText(error instanceof Error ? error.message : "invalid project root"));
  }
  const advisors = await diagnoseAdvisors(config, env, deps);
  const enabled = advisors.some((row) => row.available);
  await updateState(session.dir, (state) => {
    state.enabled = enabled;
    state.optedOut = false;
    state.projectRoot = projectRoot;
    // The prompt that ran /on was submitted while the gate was off.
    state.turn = { promptId: null, control: true };
    state.rounds = { promptId: null, count: 0 };
  });
  await pruneSessions(session.pluginData, session.sessionId, deps.now());
  return { ok: true, enabled, projectRoot, gate: config.gate, limits: config.limits, advisors, disclosure: DISCLOSURE };
}

/**
 * Offline checks only: no model request, token refresh, or login.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {Partial<typeof defaultDeps>} [overrides]
 */
export async function runDoctor(env, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const runtime = runtimeErrors({ env });
  let config = null;
  let configError;
  try {
    config = await deps.loadConfig({ env });
  } catch (error) {
    configError = sanitizeText(error instanceof Error ? error.message : "invalid config");
  }
  const start = env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
  const top = await gitTopLevel(start, { env });
  const keys = config
    ? secretNamesFromSnapshot(config).map((name) => ({ name, present: Boolean(env[name]?.trim()) }))
    : [];
  const advisors = config ? await diagnoseAdvisors(config, env, deps) : [];
  const dist = path.join(env.CLAUDE_PLUGIN_ROOT || pluginRootFromHere(), "dist");
  const missing = ["control.mjs", "gate.mjs", "auth-control.mjs", "setup-control.mjs"].filter(
    (name) => !fs.existsSync(path.join(dist, name))
  );
  return {
    ok: runtime.length === 0 && Boolean(config) && Boolean(top) && missing.length === 0,
    runtime: { node: process.versions.node, platform: process.platform, errors: runtime },
    config: { ok: Boolean(config), error: configError, gate: config?.gate },
    git: { ok: Boolean(top), root: top ?? undefined, error: top ? undefined : "not inside a git work tree" },
    keys,
    advisors,
    bundle: { ok: missing.length === 0, missing }
  };
}

/**
 * @param {NodeJS.ReadableStream} stream
 */
async function readStdin(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) throw new GateError("overflow", "stdin too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const op = argv[0];
  if (op === "stop") {
    let payload = null;
    try {
      const raw = await readStdin(process.stdin);
      payload = raw.trim() ? JSON.parse(raw) : null;
      const out = await runStop(payload, { env });
      if (out) process.stdout.write(out);
    } catch (error) {
      // Fail open: let Claude stop, keep a sanitized local record.
      try {
        const session = sessionFrom(env, payload ?? {});
        await ensurePrivateDir(session.dir);
        await createErrorLog(session.dir).record(error);
      } catch {
        // nothing more to do without a session
      }
    }
    process.exitCode = 0;
    return;
  }
  if (op === "advise" && argv.length === 1) {
    let payload = null;
    let wake = null;
    try {
      const raw = await readStdin(process.stdin);
      payload = raw.trim() ? JSON.parse(raw) : null;
      wake = await runAdvise(payload, { env });
    } catch (error) {
      try {
        const session = sessionFrom(env, payload ?? {});
        await ensurePrivateDir(session.dir);
        await createErrorLog(session.dir).record(error);
      } catch {
        // nothing more to do without a session
      }
    }
    // Exit 2 is how an asyncRewake hook wakes Claude; its stderr is the
    // message. Exit explicitly once stderr has flushed: a lingering handle,
    // such as an HTTP keep-alive socket, must not hold the wake back until
    // Claude Code's timeout kills this hook.
    if (wake) process.stderr.write(wake, () => process.exit(2));
    else process.exit(0);
    return;
  }
  const reviewArgs =
    op === "review" && argv[1] === "--plugin-data" && (argv.length === 3 || (argv.length === 5 && argv[3] === "--base"));
  if (((op === "on" || op === "doctor") && argv.length === 3 && argv[1] === "--plugin-data") || reviewArgs) {
    let pluginData;
    try {
      pluginData = explicitPluginData(argv[2]);
    } catch {
      process.stderr.write("cross-model-advisor: identity: invalid --plugin-data; run this through the plugin's skill\n");
      process.exitCode = 1;
      return;
    }
    const scoped = { ...env, CLAUDE_PLUGIN_DATA: pluginData };
    try {
      const result =
        op === "on" ? await runOn(scoped) : op === "review" ? await runReview(scoped, { base: argv[4] ?? null }) : await runDoctor(scoped);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      const code = error instanceof GateError ? error.code : "error";
      const message = error instanceof GateError ? error.message : "command failed";
      process.stdout.write(`${JSON.stringify({ ok: false, error: code, message }, null, 2)}\n`);
    }
    return;
  }
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 1;
}

const realPath = (value) => {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};
const invokedDirectly =
  process.argv[1] &&
  path.basename(fileURLToPath(import.meta.url)) === "gate.mjs" &&
  realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = process.argv[2] === "stop" ? 0 : 1;
  });
}
