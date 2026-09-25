#!/usr/bin/env node
import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/control.mjs
import fs4 from "node:fs";
import path3 from "node:path";
import { fileURLToPath } from "node:url";

// ../../plugins/cross-model-advisor/src/snapshot.mjs
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
var GIT_TIMEOUT_MS = 2e4;
var MAX_GIT_OUTPUT = 32 * 1024 * 1024;
var MAX_FILE_DIFF_CHARS = 16 * 1024;
var MAX_TOTAL_DIFF_CHARS = 60 * 1024;
var SnapshotError = class extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
};
function gitEnv(env, extra = {}) {
  const out = { ...env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX"]) {
    delete out[name];
  }
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_OPTIONAL_LOCKS = "0";
  return { ...out, ...extra };
}
function git(cwd, args, { env = process.env, extraEnv, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      {
        cwd,
        env: gitEnv(env, extraEnv),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT,
        encoding: "utf8",
        signal
      },
      (error, stdout) => {
        if (error) {
          reject(new SnapshotError("git", `git ${args[0]} failed`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}
async function snapshotTree(root, scratchDir, { env = process.env, signal } = {}) {
  const tmpIndex = path.join(scratchDir, `index.${process.pid}.${Date.now()}`);
  try {
    const realIndex = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"], { env })).trim();
    try {
      await fs.copyFile(realIndex, tmpIndex);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new SnapshotError("git", "unable to copy the index");
    }
    const extraEnv = { GIT_INDEX_FILE: tmpIndex };
    await git(root, ["add", "--all", "--", "."], { env, extraEnv, signal });
    const tree = (await git(root, ["write-tree"], { env, extraEnv, signal })).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new SnapshotError("git", "write-tree returned no tree");
    return tree;
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => {
    });
    await fs.rm(`${tmpIndex}.lock`, { force: true }).catch(() => {
    });
  }
}

// ../../plugins/cross-model-advisor/src/session/constants.mjs
var CONTROL_COMMANDS = Object.freeze([
  "cross-model-advisor:on",
  "cross-model-advisor:off",
  "cross-model-advisor:status",
  "cross-model-advisor:doctor",
  "cross-model-advisor:setup",
  "cross-model-advisor:login",
  "cross-model-advisor:logout"
]);
var SEVERITY_ORDER = Object.freeze({ blocker: 0, concern: 1, nit: 2 });
var USER_TEXT_CAP = 8 * 1024;
var MAX_STDIN_BYTES = 1048576;
var SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var ERROR_LOG_MAX_BYTES = 64 * 1024;
var DIR_MODE = 448;
var FILE_MODE = 384;
var STATE_VERSION = 2;

// ../../plugins/cross-model-advisor/src/session/classifier.mjs
var CONTROL_SET = new Set(CONTROL_COMMANDS);
function classifyPrompt(prompt) {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text.startsWith("/")) return { kind: "task", rest: text };
  const match = /^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return { kind: "task", rest: text };
  const command = match[1];
  const rest = (match[2] ?? "").trim();
  if (CONTROL_SET.has(command)) return { kind: "control", command, rest };
  return { kind: "slash", command, rest };
}

// ../../plugins/cross-model-advisor/src/session/paths.mjs
import fs2 from "node:fs/promises";
import os from "node:os";
import path2 from "node:path";
var SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
function validateSessionId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!SESSION_ID_RE.test(id)) {
    throw new Error("invalid session id");
  }
  return id;
}
function explicitPluginData(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.includes("${") || !path2.isAbsolute(text)) {
    throw new Error("invalid --plugin-data");
  }
  return path2.resolve(text);
}
function sessionDir(pluginData, sessionId) {
  return path2.join(pluginData, "sessions", validateSessionId(sessionId));
}
var statePath = (dir) => path2.join(dir, "state.json");
async function ensurePrivateDir(dir) {
  await fs2.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs2.chmod(dir, DIR_MODE).catch(() => {
  });
}
async function atomicWriteFile(file, body) {
  const dir = path2.dirname(file);
  await ensurePrivateDir(dir);
  const tmp = path2.join(dir, `.${path2.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const data = typeof body === "string" ? body : body;
  await fs2.writeFile(tmp, data, { mode: FILE_MODE, flag: "wx" });
  await fs2.chmod(tmp, FILE_MODE).catch(() => {
  });
  await fs2.rename(tmp, file);
}
async function atomicWriteJson(file, value) {
  await atomicWriteFile(file, `${JSON.stringify(value)}
`);
}
function readIdentity(env = process.env, payload = {}) {
  const sessionId = env.CLAUDE_CODE_SESSION_ID?.trim() || env.CLAUDE_SESSION_ID?.trim() || (typeof payload.session_id === "string" ? payload.session_id.trim() : "");
  const projectRoot = env.CLAUDE_PROJECT_DIR?.trim() || "";
  const pluginData = env.CLAUDE_PLUGIN_DATA?.trim() || "";
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT?.trim() || "";
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path2.join(os.homedir(), ".claude");
  return { sessionId, projectRoot, pluginData, pluginRoot, configDir };
}

// ../../plugins/cross-model-advisor/src/session/sanitize.mjs
var CREDENTIAL_ASSIGNMENT = /\b(?:api[_-]?key|token|password|secret|authorization|bearer)\b\s*[:=]\s*([^\s,;]+)/gi;
var ENV_CREDENTIAL_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*[:=]\s*["']?)([^\s"'`,;]{8,})/g;
var KNOWN_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g;
var CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
function redactCredentials(text) {
  return text.replace(KNOWN_TOKEN, "[redacted]").replace(CREDENTIAL_ASSIGNMENT, (match, value) => match.replace(value, "[redacted]")).replace(
    ENV_CREDENTIAL_ASSIGNMENT,
    (match, name, sep, value) => /[A-Za-z]/.test(value) ? `${name}${sep}[redacted]` : match
  );
}
function sanitizeText(text, secrets = []) {
  if (typeof text !== "string" || text.length === 0) return "";
  let out = text.replace(CONTROL_CHARS, "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return redactCredentials(out);
}
function truncateLabeled(text, cap) {
  if (typeof text !== "string") return "";
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}
[truncated ${text.length - cap} chars]`;
}

// ../../plugins/cross-model-advisor/src/session/state.mjs
import fs3 from "node:fs/promises";
var MAX_REVIEWED = 64;
function emptyState(overrides = {}) {
  return {
    version: STATE_VERSION,
    enabled: false,
    projectRoot: null,
    /** @type {Turn | null} */
    turn: null,
    rounds: { promptId: null, count: 0 },
    /** @type {string[]} base..head pairs already reviewed */
    reviewed: [],
    /** @type {LastReview | null} the last review that ran */
    last: null,
    /** @type {LastReview | null} the last Stop that did not review, and why */
    lastSkip: null,
    /** @type {Record<string, { reviews: number, usage: object | null, lastError: string | null }>} */
    advisors: {},
    ...overrides
  };
}
async function loadState(dir) {
  let raw;
  try {
    raw = await fs3.readFile(statePath(dir), "utf8");
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_VERSION) return emptyState();
    return emptyState(parsed);
  } catch {
    return emptyState();
  }
}
async function saveState(dir, state) {
  const reviewed = Array.isArray(state.reviewed) ? state.reviewed.slice(-MAX_REVIEWED) : [];
  await atomicWriteJson(statePath(dir), { ...state, reviewed });
}

// ../../plugins/cross-model-advisor/src/control.mjs
var USAGE = "usage: control.mjs hook | off|status --plugin-data <path>";
function sessionFrom(env, payload = {}) {
  const identity = readIdentity(env, payload);
  if (typeof payload.session_id === "string" && identity.sessionId && payload.session_id !== identity.sessionId) {
    throw new Error("hook session id does not match the Claude session environment");
  }
  if (!identity.sessionId || !identity.pluginData) throw new Error("missing session identity");
  const sessionId = validateSessionId(identity.sessionId);
  return { ...identity, sessionId, dir: sessionDir(identity.pluginData, sessionId) };
}
async function recordPrompt(payload, { env = process.env, snapshot = snapshotTree, now = Date.now } = {}) {
  if (!payload || typeof payload !== "object" || payload.agent_id) return;
  const session = sessionFrom(env, payload);
  const state = await loadState(session.dir);
  if (!state.enabled || !state.projectRoot) return;
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (classifyPrompt(prompt).kind === "control") {
    state.turn = null;
    await saveState(session.dir, state);
    return;
  }
  const turn = {
    promptId: typeof payload.prompt_id === "string" ? payload.prompt_id : null,
    baseTree: (
      /** @type {string | null} */
      null
    ),
    request: truncateLabeled(sanitizeText(prompt), USER_TEXT_CAP),
    at: now()
  };
  try {
    turn.baseTree = await snapshot(state.projectRoot, session.dir, { env });
  } catch (error) {
    turn.error = error instanceof Error ? error.message : "snapshot failed";
  }
  state.turn = turn;
  await saveState(session.dir, state);
}
async function runOff(env) {
  const session = sessionFrom(env);
  await ensurePrivateDir(session.dir);
  const state = await loadState(session.dir);
  state.enabled = false;
  state.turn = null;
  await saveState(session.dir, state);
  return { ok: true, enabled: false };
}
async function runStatus(env) {
  const session = sessionFrom(env);
  const state = await loadState(session.dir);
  return {
    ok: true,
    enabled: state.enabled,
    projectRoot: state.projectRoot,
    lastReview: state.last,
    lastSkip: state.lastSkip,
    advisors: state.advisors
  };
}
async function readStdin(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) throw new Error("stdin too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const op = argv[0];
  if (op === "hook" && argv.length === 1) {
    try {
      const raw = await readStdin(process.stdin);
      if (raw.trim()) await recordPrompt(JSON.parse(raw), { env });
    } catch {
    }
    process.exitCode = 0;
    return;
  }
  if ((op === "off" || op === "status") && argv.length === 3 && argv[1] === "--plugin-data") {
    let scoped;
    try {
      scoped = { ...env, CLAUDE_PLUGIN_DATA: explicitPluginData(argv[2]) };
    } catch {
      process.stderr.write("cross-model-advisor: identity: invalid --plugin-data; run this through the plugin's skill\n");
      process.exitCode = 1;
      return;
    }
    try {
      const result = op === "off" ? await runOff(scoped) : await runStatus(scoped);
      process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
    } catch (error) {
      const message = sanitizeText(error instanceof Error ? error.message : "command failed");
      process.stdout.write(`${JSON.stringify({ ok: false, error: "identity", message }, null, 2)}
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
    return fs4.realpathSync(value);
  } catch {
    return path3.resolve(value);
  }
};
var invokedDirectly = process.argv[1] && path3.basename(fileURLToPath(import.meta.url)) === "control.mjs" && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
export {
  main,
  recordPrompt,
  runOff,
  runStatus
};
