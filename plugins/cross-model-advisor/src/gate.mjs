#!/usr/bin/env node
/**
 * The review gate. When Claude finishes a turn that changed files, enabled
 * advisors from other model families review what git measured, and concerns
 * or blockers send Claude back to address them (`gate.mode: "block"`) or are
 * shown to the user (`"report"`). Also `on` and `doctor`, which need the
 * provider SDK that the lightweight control helper does not load.
 *
 *   gate.mjs stop                        Stop hook; payload on stdin
 *   gate.mjs on|doctor --plugin-data <p> session skills
 *
 * The Stop hook fails open: errors let Claude stop, are recorded for
 * /status, and are never reported as a successful review.
 */

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
  USER_TEXT_CAP
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
import { loadState, saveState } from "./session/state.mjs";

const USAGE = "usage: gate.mjs stop | on|doctor --plugin-data <path> | review --plugin-data <path> [--base <ref>]";
const USER_SUMMARY_CHARS = 2_000;
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
export function formatBlockReason(findings, { round, maxRounds }) {
  const intro =
    `Cross-model advisors reviewed the changes from this turn (review round ${round} of at most ${maxRounds}) and raised issues. ` +
    "They are other AI models, not the user, and their findings are unverified. Check each one against the code. " +
    "Fix the ones that are real; for any you judge wrong, say briefly why instead of changing code. Do not make unrelated changes.";
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
 * @param {{ name: string, error?: string }[]} failed
 */
function notReviewedBy(failed) {
  const detail = failed.map((result) => `${result.name}: ${result.error}`).join("; ");
  return `${failed.length === 1 ? "one advisor" : `${failed.length} advisors`} did not finish reviewing this turn (${detail})`;
}

/**
 * What the user sees when some advisors failed and the rest found nothing, or
 * found enough to send Claude back. The block reason goes to Claude, not the
 * user, so without this a failed advisor would go unmentioned.
 *
 * @param {{ name: string, error?: string }[]} failed
 * @param {{ blocked?: boolean }} [options]
 */
export function formatPartialFailure(failed, { blocked = false } = {}) {
  const text = blocked
    ? `cross-model-advisor: ${notReviewedBy(failed)}. Claude was sent back with the findings reported.`
    : `cross-model-advisor: no findings, but ${notReviewedBy(failed)}`;
  return truncateLabeled(sanitizeText(text), USER_SUMMARY_CHARS);
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
 * reviews, so both apply the same tools, evidence rules, and limits. Updates
 * per-advisor usage in `state`; the caller saves it.
 *
 * @param {{ runnable: any[], config: any, state: any, session: any, deps: typeof defaultDeps, env: NodeJS.ProcessEnv,
 *   secrets: string[], credDir: string, ignoredPaths: string[], turnContext: object, observations: object[],
 *   deadline: number, projectRoot?: string }} input
 */
function runAdvisors({ runnable, config, state, session, deps, env, secrets, credDir, ignoredPaths, turnContext, observations, deadline, projectRoot = state.projectRoot }) {
  const { limits } = config;
  return pool(
    runnable.map((advisor) => async () => {
      const provider = config.providers[advisor.provider];
      const base = { name: advisor.name, provider: advisor.provider, model: advisor.model, findings: [] };
      const stats = (state.advisors[advisor.name] ??= { reviews: 0, usage: null, lastError: null });
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
          ignoredPaths
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
 * Stop hook. Returns hook stdout: "" to let Claude stop silently, a block
 * decision, or a user-visible systemMessage.
 *
 * @param {any} payload
 * @param {{ env?: NodeJS.ProcessEnv, deps?: Partial<typeof defaultDeps> }} [options]
 * @returns {Promise<string>}
 */
export async function runStop(payload, { env = process.env, deps: overrides = {} } = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const deadline = deps.now() + STOP_REVIEW_BUDGET_MS;
  if (!payload || typeof payload !== "object" || payload.agent_id) return "";
  const session = sessionFrom(env, payload);
  const state = await loadState(session.dir);
  if (!state.enabled || !state.projectRoot) return "";

  const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : null;
  /**
   * @param {string} outcome
   * @param {string} reason
   * @param {object} [extra]
   */
  const record = async (outcome, reason, extra = {}) => {
    const entry = { at: deps.now(), promptId, outcome, reason, ...extra };
    // A skip must not erase the last real review: /status and the round-limit
    // message point at its findings.
    if (outcome === "skipped") state.lastSkip = entry;
    else state.last = entry;
    await saveState(session.dir, state);
  };

  const turn = state.turn;
  if (!turn || (promptId && turn.promptId && turn.promptId !== promptId)) {
    await record("skipped", "no snapshot for this prompt");
    return "";
  }
  if (!turn.baseTree) {
    await record("skipped", `no snapshot for this prompt: ${turn.error ?? "unknown"}`);
    return "";
  }

  let config;
  try {
    config = await deps.loadConfig({ env });
  } catch (error) {
    const message = sanitizeText(error instanceof Error ? error.message : "invalid config");
    await record("failed", `config: ${message}`);
    return `${JSON.stringify({ systemMessage: `cross-model-advisor: review skipped, configuration is invalid (${message})` })}\n`;
  }
  const { gate, limits } = config;

  let head;
  try {
    head = await deps.snapshotTree(state.projectRoot, session.dir, { env });
  } catch {
    await record("failed", "could not snapshot the working tree");
    return "";
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

  if (state.rounds.promptId !== promptId) state.rounds = { promptId, count: 0 };
  if (gate.mode === "block" && state.rounds.count >= gate.maxRounds) {
    await record("skipped", `round limit (${gate.maxRounds}) reached for this prompt`);
    return `${JSON.stringify({
      systemMessage: `cross-model-advisor: stopped sending Claude back after ${gate.maxRounds} review round${gate.maxRounds === 1 ? "" : "s"}. Run /cross-model-advisor:status for the last findings.`
    })}\n`;
  }

  const secrets = resolveSecrets(secretNamesFromSnapshot(config), env);
  const credDir = credentialDir(env);
  const diagnosed = await diagnoseAdvisors(config, env, deps);
  const runnable = config.advisors.filter((advisor) => {
    const row = diagnosed.find((item) => item.name === advisor.name);
    const used = state.advisors[advisor.name]?.reviews ?? 0;
    return row?.available && used < limits.maxReviewsPerAdvisorPerSession;
  });
  if (runnable.length === 0) {
    await record("skipped", "no available advisors");
    return "";
  }

  let ignoredPaths;
  try {
    ignoredPaths = await deps.gitIgnoredPaths(state.projectRoot, { env });
  } catch {
    await record("failed", "could not list the paths git ignores");
    return "";
  }

  let diff;
  try {
    const probe = await deps.createReviewTools({
      root: state.projectRoot,
      exclude: config.exclude,
      observations: [],
      pluginData: session.pluginData,
      credentialDir: credDir,
      secrets,
      ignoredPaths
    });
    diff = await deps.turnDiff(state.projectRoot, turn.baseTree, head, { env, isExcluded: probe.excluded });
  } catch {
    await record("failed", "could not compute the diff");
    return "";
  }
  // Every changed path, shown or not, must match for a turn to be skipped.
  const changed = [...diff.files.map((file) => file.path), ...diff.omitted, ...diff.unshown];
  if (gate.skipWhenOnly?.length && changed.length) {
    const skip = (typeof ignoreFactory === "function" ? ignoreFactory : ignoreFactory.default)().add(gate.skipWhenOnly);
    if (changed.every((file) => skip.ignores(file))) {
      state.reviewed.push(key);
      await record("skipped", "only files matching gate.skipWhenOnly changed");
      return "";
    }
  }
  if (diff.files.length === 0) {
    state.reviewed.push(key);
    await record("skipped", "only excluded files changed");
    return "";
  }
  const files = diff.files.map((file) => ({ ...file, eventId: `diff:${file.path}`, text: sanitizeText(file.text, secrets) }));
  const round = state.rounds.count + 1;
  const previous =
    round > 1 && state.last?.promptId === promptId && Array.isArray(state.last?.findings)
      ? state.last.findings.map(({ severity, advisor, note }) => ({ severity, advisor, note }))
      : [];
  const turnContext = {
    request: truncateLabeled(sanitizeText(turn.request ?? "", secrets), USER_TEXT_CAP),
    final: truncateLabeled(sanitizeText(String(payload.last_assistant_message ?? ""), secrets), USER_TEXT_CAP),
    round,
    previous,
    diff: { files, omitted: diff.omitted, unshown: diff.unshown }
  };
  const observations = [{ eventId: "request" }, { eventId: "final" }, ...files.map((file) => ({ eventId: file.eventId }))];

  const results = await runAdvisors({
    runnable,
    config,
    state,
    session,
    deps,
    env,
    secrets,
    credDir,
    ignoredPaths,
    turnContext,
    observations,
    deadline
  });

  state.reviewed.push(key);
  const findings = collectFindings(results);
  const advisors = results.map((result) => ({
    name: result.name,
    provider: result.provider,
    model: result.model,
    ok: result.ok,
    findings: result.findings.length,
    error: result.error
  }));
  const failed = results.filter((result) => !result.ok);

  if (gate.mode === "block" && findings.some((item) => item.severity !== "nit")) {
    state.rounds.count = round;
    await record("blocked", "concerns or blockers found", { round, findings, advisors });
    return `${JSON.stringify({
      decision: "block",
      reason: formatBlockReason(findings, { round, maxRounds: gate.maxRounds }),
      ...(failed.length ? { systemMessage: formatPartialFailure(failed, { blocked: true }) } : {})
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
  return failed.length ? `${JSON.stringify({ systemMessage: formatPartialFailure(failed) })}\n` : "";
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
  const results = await runAdvisors({
    runnable,
    config,
    state,
    session,
    deps,
    env,
    secrets,
    credDir,
    ignoredPaths,
    turnContext,
    observations,
    deadline,
    projectRoot
  });
  await saveState(session.dir, state);
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
  await ensurePrivateDir(session.dir);
  const state = await loadState(session.dir);
  state.enabled = enabled;
  state.optedOut = false;
  state.projectRoot = projectRoot;
  state.turn = null;
  state.rounds = { promptId: null, count: 0 };
  await saveState(session.dir, state);
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
