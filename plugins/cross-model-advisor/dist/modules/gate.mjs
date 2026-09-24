#!/usr/bin/env node
import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/gate.mjs
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewApi, validateApi } from "./backends/api.mjs";
import { configFilePath, loadConfig, runtimeErrors, validateRoot } from "./config.mjs";
import { advisorSystemPrompt } from "./prompt.mjs";
import { gitTopLevel, snapshotTree, turnDiff } from "./snapshot.mjs";
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
var USAGE = "usage: gate.mjs stop | on|doctor --plugin-data <path>";
var USER_SUMMARY_CHARS = 2e3;
var DISCLOSURE = "At the end of each turn that changes files, the request, Claude's final message, and the git diff (minus excluded paths) go to the configured external providers, which may also read allowed project files. Claude's own credentials are never used.";
var GateError = class extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
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
function mergeUsage(prev, next) {
  if (!next) return prev ?? null;
  const base = prev ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  const cost = base.costUsd === "unknown" || next.costUsd === "unknown" || typeof next.costUsd !== "number" ? "unknown" : base.costUsd + next.costUsd;
  return {
    inputTokens: (base.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (base.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (base.totalTokens ?? 0) + (next.totalTokens ?? 0),
    costUsd: cost
  };
}
async function diagnoseAdvisors(config, env, deps) {
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
      error: void 0
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
function sessionFrom(env, payload = {}) {
  const identity = readIdentity(env, payload);
  if (typeof payload.session_id === "string" && identity.sessionId && payload.session_id !== identity.sessionId) {
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
    }
  }
}
function evidenceLine(finding) {
  return finding.evidence.map((item) => {
    const where = item.kind === "file" ? `${item.path}:${item.line}` : item.eventId;
    return `${where} — ${item.detail}`;
  }).join("; ");
}
function formatBlockReason(findings, { round, maxRounds }) {
  const intro = `Cross-model advisors reviewed the changes from this turn (review round ${round} of at most ${maxRounds}) and raised issues. They are other AI models, not the user, and their findings are unverified. Check each one against the code. Fix the ones that are real; for any you judge wrong, say briefly why instead of changing code. Do not make unrelated changes.`;
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
function formatUserSummary(findings, failed = []) {
  const lines = [`cross-model-advisor: ${findings.length} finding${findings.length === 1 ? "" : "s"} on this turn`];
  if (failed.length) lines.push(`- ${notReviewedBy(failed)}`);
  for (const item of findings) lines.push(`- [${item.severity}] ${item.advisor}: ${item.note}`);
  return truncateLabeled(sanitizeText(lines.join("\n")), USER_SUMMARY_CHARS);
}
function notReviewedBy(failed) {
  const detail = failed.map((result) => `${result.name}: ${result.error}`).join("; ");
  return `${failed.length === 1 ? "one advisor" : `${failed.length} advisors`} did not review this turn (${detail})`;
}
function formatPartialFailure(failed, { blocked = false } = {}) {
  const text = blocked ? `cross-model-advisor: ${notReviewedBy(failed)}. Claude was sent back with the findings from the rest.` : `cross-model-advisor: no findings, but ${notReviewedBy(failed)}`;
  return truncateLabeled(sanitizeText(text), USER_SUMMARY_CHARS);
}
function collectFindings(results) {
  const seen = /* @__PURE__ */ new Set();
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
var defaultDeps = {
  loadConfig,
  validateApi,
  reviewApi,
  createReviewTools,
  snapshotTree,
  turnDiff,
  now: () => Date.now()
};
async function runStop(payload, { env = process.env, deps: overrides = {} } = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const deadline = deps.now() + STOP_REVIEW_BUDGET_MS;
  if (!payload || typeof payload !== "object" || payload.agent_id) return "";
  const session = sessionFrom(env, payload);
  const state = await loadState(session.dir);
  if (!state.enabled || !state.projectRoot) return "";
  const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : null;
  const record = async (outcome, reason, extra = {}) => {
    const entry = { at: deps.now(), promptId, outcome, reason, ...extra };
    if (outcome === "skipped") state.lastSkip = entry;
    else state.last = entry;
    await saveState(session.dir, state);
  };
  const turn = state.turn;
  if (!turn || promptId && turn.promptId && turn.promptId !== promptId) {
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
    return `${JSON.stringify({ systemMessage: `cross-model-advisor: review skipped, configuration is invalid (${message})` })}
`;
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
    })}
`;
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
  let diff;
  try {
    const probe = await deps.createReviewTools({
      root: state.projectRoot,
      exclude: config.exclude,
      observations: [],
      pluginData: session.pluginData,
      credentialDir: credDir,
      secrets
    });
    diff = await deps.turnDiff(state.projectRoot, turn.baseTree, head, { env, isExcluded: probe.excluded });
  } catch {
    await record("failed", "could not compute the diff");
    return "";
  }
  if (diff.files.length === 0) {
    state.reviewed.push(key);
    await record("skipped", "only excluded files changed");
    return "";
  }
  const files = diff.files.map((file) => ({ ...file, eventId: `diff:${file.path}`, text: sanitizeText(file.text, secrets) }));
  const round = state.rounds.count + 1;
  const previous = round > 1 && state.last?.promptId === promptId && Array.isArray(state.last?.findings) ? state.last.findings.map(({ severity, advisor, note }) => ({ severity, advisor, note })) : [];
  const turnContext = {
    request: truncateLabeled(sanitizeText(turn.request ?? "", secrets), USER_TEXT_CAP),
    final: truncateLabeled(sanitizeText(String(payload.last_assistant_message ?? ""), secrets), USER_TEXT_CAP),
    round,
    previous,
    diff: { files, omitted: diff.omitted, unshown: diff.unshown }
  };
  const observations = [{ eventId: "request" }, { eventId: "final" }, ...files.map((file) => ({ eventId: file.eventId }))];
  const results = await pool(
    runnable.map((advisor) => async () => {
      const provider = config.providers[advisor.provider];
      const base = { name: advisor.name, provider: advisor.provider, model: advisor.model, findings: [] };
      const stats = state.advisors[advisor.name] ??= { reviews: 0, usage: null, lastError: null };
      const remaining = deadline - deps.now();
      if (remaining <= 0) {
        stats.lastError = "timeout: the Stop hook's review time ran out before this advisor started";
        return { ...base, ok: false, error: stats.lastError };
      }
      stats.reviews += 1;
      const abort = new AbortController();
      const timer = setTimeout(
        () => abort.abort({ code: "timeout" }),
        Math.min(limits.reviewTimeoutSeconds * 1e3, remaining)
      );
      try {
        const tools = await deps.createReviewTools({
          root: state.projectRoot,
          exclude: config.exclude,
          observations,
          advisor: { name: advisor.name },
          signal: abort.signal,
          pluginData: session.pluginData,
          credentialDir: credDir,
          secrets,
          maxFindings: MAX_FINDINGS_PER_REVIEW
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
        return { ...base, ok: false, error: stats.lastError };
      } finally {
        clearTimeout(timer);
      }
    }),
    limits.maxConcurrentAdvisors
  );
  state.reviewed.push(key);
  const findings = collectFindings(results.filter((result) => result.ok));
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
      ...failed.length ? { systemMessage: formatPartialFailure(failed, { blocked: true }) } : {}
    })}
`;
  }
  if (findings.length) {
    await record("reported", "findings shown to the user", { round, findings, advisors });
    return `${JSON.stringify({ systemMessage: formatUserSummary(findings, failed) })}
`;
  }
  if (failed.length === results.length) {
    await record("failed", "every advisor failed", { round, findings, advisors });
    const detail = failed.map((result) => `${result.name}: ${result.error}`).join("; ");
    return `${JSON.stringify({ systemMessage: truncateLabeled(`cross-model-advisor: review failed, so this turn was not reviewed (${detail})`, USER_SUMMARY_CHARS) })}
`;
  }
  await record("passed", failed.length ? "no findings from the advisors that completed" : "no findings", {
    round,
    findings,
    advisors
  });
  return failed.length ? `${JSON.stringify({ systemMessage: formatPartialFailure(failed) })}
` : "";
}
async function runOn(env, overrides = {}) {
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
  state.projectRoot = projectRoot;
  state.turn = null;
  state.rounds = { promptId: null, count: 0 };
  await saveState(session.dir, state);
  await pruneSessions(session.pluginData, session.sessionId, deps.now());
  return { ok: true, enabled, projectRoot, gate: config.gate, limits: config.limits, advisors, disclosure: DISCLOSURE };
}
async function runDoctor(env, overrides = {}) {
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
  const keys = config ? secretNamesFromSnapshot(config).map((name) => ({ name, present: Boolean(env[name]?.trim()) })) : [];
  const advisors = config ? await diagnoseAdvisors(config, env, deps) : [];
  const dist = path.join(env.CLAUDE_PLUGIN_ROOT || pluginRootFromHere(), "dist");
  const missing = ["control.mjs", "gate.mjs", "auth-control.mjs", "setup-control.mjs"].filter(
    (name) => !fs.existsSync(path.join(dist, name))
  );
  return {
    ok: runtime.length === 0 && Boolean(config) && Boolean(top) && missing.length === 0,
    runtime: { node: process.versions.node, platform: process.platform, errors: runtime },
    config: { ok: Boolean(config), error: configError, gate: config?.gate },
    git: { ok: Boolean(top), root: top ?? void 0, error: top ? void 0 : "not inside a git work tree" },
    keys,
    advisors,
    bundle: { ok: missing.length === 0, missing }
  };
}
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
async function main(argv = process.argv.slice(2), env = process.env) {
  const op = argv[0];
  if (op === "stop") {
    let payload = null;
    try {
      const raw = await readStdin(process.stdin);
      payload = raw.trim() ? JSON.parse(raw) : null;
      const out = await runStop(payload, { env });
      if (out) process.stdout.write(out);
    } catch (error) {
      try {
        const session = sessionFrom(env, payload ?? {});
        await ensurePrivateDir(session.dir);
        await createErrorLog(session.dir).record(error);
      } catch {
      }
    }
    process.exitCode = 0;
    return;
  }
  if ((op === "on" || op === "doctor") && argv.length === 3 && argv[1] === "--plugin-data") {
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
      const result = op === "on" ? await runOn(scoped) : await runDoctor(scoped);
      process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
    } catch (error) {
      const code = error instanceof GateError ? error.code : "error";
      const message = error instanceof GateError ? error.message : "command failed";
      process.stdout.write(`${JSON.stringify({ ok: false, error: code, message }, null, 2)}
`);
    }
    return;
  }
  process.stderr.write(`${USAGE}
`);
  process.exitCode = 1;
}
var realPath = (value) => {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};
var invokedDirectly = process.argv[1] && path.basename(fileURLToPath(import.meta.url)) === "gate.mjs" && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = process.argv[2] === "stop" ? 0 : 1;
  });
}
export {
  collectFindings,
  diagnoseAdvisors,
  formatBlockReason,
  formatPartialFailure,
  formatUserSummary,
  main,
  runDoctor,
  runOn,
  runStop
};
