#!/usr/bin/env node
import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/control.mjs
import { spawn } from "node:child_process";
import fs3 from "node:fs";
import fsPromises from "node:fs/promises";
import os2 from "node:os";
import path2 from "node:path";
import { fileURLToPath } from "node:url";

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
var CONTROL_OPS = Object.freeze(["on", "off", "status", "doctor", "hook", "ack"]);
var DRAIN_EVENTS = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure"
]);
var SILENT_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptExpansion",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "SessionEnd"
]);
var SEVERITY_ORDER = Object.freeze({ blocker: 0, concern: 1, nit: 2 });
var WARM_IPC_MS = 200;
var COLD_START_MS = 1e3;
var SESSION_END_TIMEOUT_MS = 1e3;
var USER_TEXT_CAP = 8 * 1024;
var TRANSCRIPT_TAIL_BYTES = 256 * 1024;
var MAX_STDIN_BYTES = 1048576;
var SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var ERROR_LOG_MAX_BYTES = 64 * 1024;

// ../../plugins/cross-model-advisor/src/session/ipc.mjs
import fs from "node:fs";
import net from "node:net";
var MAX_FRAME = 1048576;
function encodeFrame(value) {
  return `${JSON.stringify(value)}
`;
}
function splitFrames(buffer) {
  const frames = [];
  const errors = [];
  let offset = 0;
  while (offset < buffer.length) {
    const nl = buffer.indexOf(10, offset);
    if (nl === -1) break;
    const line = buffer.subarray(offset, nl).toString("utf8").replace(/\r$/, "");
    offset = nl + 1;
    if (line.trim() === "") continue;
    if (line.length > MAX_FRAME) {
      errors.push("frame too large");
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") frames.push(parsed);
      else errors.push("frame not an object");
    } catch {
      errors.push("invalid json");
    }
  }
  return { frames, rest: buffer.subarray(offset), errors };
}
async function requestIpc(socketPath, request, { timeoutMs = WARM_IPC_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error("ipc timeout"));
    }, timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.on("connect", () => {
      socket.write(encodeFrame(request));
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const split = splitFrames(buf);
      buf = split.rest;
      const frame = split.frames[0];
      if (!frame) return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolve(frame);
    });
    socket.on("error", fail);
    socket.on("end", () => {
      if (!settled) fail(new Error("ipc closed"));
    });
  });
}
function socketExists(socketPath) {
  try {
    return fs.existsSync(socketPath);
  } catch {
    return false;
  }
}

// ../../plugins/cross-model-advisor/src/session/paths.mjs
import fs2 from "node:fs/promises";
import os from "node:os";
import path from "node:path";
var SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
function validateSessionId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!SESSION_ID_RE.test(id)) {
    throw new Error("invalid session id");
  }
  return id;
}
function sessionDir(pluginData, sessionId) {
  return path.join(pluginData, "sessions", validateSessionId(sessionId));
}
var locatorPath = (dir) => path.join(dir, "locator.json");
var statePath = (dir) => path.join(dir, "state.json");
function readIdentity(env = process.env, payload = {}) {
  const sessionId = env.CLAUDE_CODE_SESSION_ID?.trim() || env.CLAUDE_SESSION_ID?.trim() || (typeof payload.session_id === "string" ? payload.session_id.trim() : "");
  const projectRoot = env.CLAUDE_PROJECT_DIR?.trim() || "";
  const pluginData = env.CLAUDE_PLUGIN_DATA?.trim() || "";
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT?.trim() || "";
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return { sessionId, projectRoot, pluginData, pluginRoot, configDir };
}
async function readLocator(pluginData, sessionId) {
  const file = locatorPath(sessionDir(pluginData, sessionId));
  try {
    const raw = await fs2.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}
function pidIsLive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

// ../../plugins/cross-model-advisor/src/control.mjs
var CONTROL_COMMANDS2 = /* @__PURE__ */ new Set(["on", "off", "status", "doctor", "hook"]);
var CONTROL_COMMAND_MS = 9e4;
var STATUS_OFF_MS = 5e3;
var WORKER_ENV_ALLOW = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "XDG_RUNTIME_DIR",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_CONFIG_DIR"
];
var ENV_DENY = /CUSTOM_HEADERS|(?:^|_)LOG$|VERTEX|GOOGLE_GENAI_USE|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_|GCLOUD_|CLOUDSDK_|GOOGLE_VERTEX|GEMINI_SYSTEM_MD|GOOGLE_GEMINI_BASE_URL|GEMINI_CLI_IDE_|NODE_OPTIONS|^PI_|KIMI_CODE_OAUTH_HOST|KIMI_OAUTH_HOST|CHATGPT_BASE_URL|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID|OPENAI_LOG/;
function readJsonFile(file) {
  try {
    return JSON.parse(fs3.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function providersFromIdentity(identity, env) {
  try {
    const snapshot = readJsonFile(statePath(sessionDir(identity.pluginData, identity.sessionId)));
    if (snapshot?.activation?.providers) return snapshot.activation.providers;
  } catch {
  }
  const configDir = env.CLAUDE_CONFIG_DIR || identity.configDir || path2.join(os2.homedir(), ".claude");
  const cfg = readJsonFile(path2.join(configDir, "cross-model-advisor.json"));
  return cfg?.providers ?? {};
}
function workerChildEnv(identity, env = process.env) {
  const out = /* @__PURE__ */ Object.create(null);
  for (const name of WORKER_ENV_ALLOW) {
    if (typeof env[name] === "string" && !ENV_DENY.test(name)) out[name] = env[name];
  }
  out.CLAUDE_CODE_SESSION_ID = identity.sessionId;
  out.CLAUDE_PROJECT_DIR = identity.projectRoot;
  out.CLAUDE_PLUGIN_DATA = identity.pluginData;
  if (identity.pluginRoot) out.CLAUDE_PLUGIN_ROOT = identity.pluginRoot;
  if (identity.configDir) out.CLAUDE_CONFIG_DIR = identity.configDir;
  const providers = providersFromIdentity(identity, env);
  const keyNames = /* @__PURE__ */ new Set();
  for (const provider of Object.values(providers)) {
    if (typeof provider?.apiKeyEnv === "string") keyNames.add(provider.apiKeyEnv);
  }
  for (const name of keyNames) {
    if (typeof env[name] === "string" && !ENV_DENY.test(name)) out[name] = env[name];
  }
  return out;
}
function workerExecutablePath(metaUrl = import.meta.url) {
  const here = path2.dirname(fileURLToPath(metaUrl));
  if (path2.basename(here) === "modules") return path2.join(here, "..", "worker.mjs");
  return path2.join(here, "worker.mjs");
}
function parseControlArgv(argv) {
  const op = argv[0];
  if (!CONTROL_COMMANDS2.has(op)) {
    const error = new Error("usage: control.mjs hook|on|off|status|doctor");
    error.code = "usage";
    throw error;
  }
  return { op };
}
async function readBoundedStdin(stream, max = MAX_STDIN_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > max) {
      const error = new Error("stdin too large");
      error.code = "overflow";
      throw error;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function spawnWorkerProcess(identity, { env = process.env, workerPath, spawnImpl = spawn } = {}) {
  const file = workerPath ?? workerExecutablePath();
  const child = spawnImpl(
    process.execPath,
    [file, "--session", identity.sessionId, "--root", identity.projectRoot, "--data", identity.pluginData],
    {
      detached: true,
      stdio: "ignore",
      env: workerChildEnv(identity, env)
    }
  );
  child.unref();
  return child;
}
async function waitForLocator(identity, deadlineMs, { isDead } = {}) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (typeof isDead === "function" && isDead()) return null;
    const locator = await readLocator(identity.pluginData, identity.sessionId);
    if (locator?.socketPath && locator?.controlCapability && pidIsLive(locator.pid) && socketExists(locator.socketPath)) {
      return locator;
    }
    await sleep(20);
  }
  return null;
}
async function ensureWorker(identity, options = {}) {
  const request = options.request ?? requestIpc;
  let locator = await readLocator(identity.pluginData, identity.sessionId);
  if (locator?.socketPath && locator?.controlCapability && pidIsLive(locator.pid) && socketExists(locator.socketPath)) {
    try {
      const ping = await request(
        locator.socketPath,
        { capability: locator.controlCapability, op: "ping" },
        { timeoutMs: WARM_IPC_MS }
      );
      if (ping?.ok) return { locator, cold: false };
    } catch {
    }
  }
  const workerPath = options.workerPath ?? workerExecutablePath();
  const child = spawnWorkerProcess(identity, { ...options, workerPath });
  let exitInfo = null;
  const onExit = (code, signal) => {
    exitInfo = { code, signal };
  };
  if (typeof child?.once === "function") child.once("exit", onExit);
  try {
    locator = await waitForLocator(identity, COLD_START_MS, { isDead: () => Boolean(exitInfo) });
  } finally {
    if (typeof child?.off === "function") child.off("exit", onExit);
  }
  if (!locator) {
    const pid = Number(child?.pid);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
    const locFile = locatorPath(sessionDir(identity.pluginData, identity.sessionId));
    const error = new Error(
      exitInfo ? `worker exited before locator (code=${exitInfo.code} signal=${exitInfo.signal}) file=${workerPath} pid=${child?.pid ?? "none"} locator=${locFile}` : `worker startup timeout file=${workerPath} pid=${child?.pid ?? "none"} locator=${locFile}`
    );
    error.code = "startup";
    throw error;
  }
  return { locator, cold: true };
}
var IdentityError = class extends Error {
  code = "identity";
};
function identityFrom(env, payload, op) {
  const identity = readIdentity(env, payload);
  if (!identity.sessionId) {
    throw new IdentityError("Missing CLAUDE_CODE_SESSION_ID or CLAUDE_SESSION_ID. Run this command inside Claude Code.");
  }
  if (!identity.pluginData) {
    throw new IdentityError("Missing CLAUDE_PLUGIN_DATA. Load the plugin in Claude Code before running this command.");
  }
  try {
    identity.sessionId = validateSessionId(identity.sessionId);
  } catch {
    throw new IdentityError("Invalid Claude session id. Start a new Claude Code session.");
  }
  if (payload?.session_id && payload.session_id !== identity.sessionId) {
    throw new IdentityError("Hook session id does not match the Claude session environment.");
  }
  let saved;
  try {
    saved = JSON.parse(fs3.readFileSync(statePath(sessionDir(identity.pluginData, identity.sessionId)), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        throw new IdentityError("Stored session identity is unreadable. Start a new Claude Code session.");
      }
      throw error;
    }
  }
  if (saved !== void 0) {
    if (!saved || typeof saved.projectRoot !== "string" || !path2.isAbsolute(saved.projectRoot)) {
      throw new IdentityError("Stored session project root is invalid. Start a new Claude Code session.");
    }
    identity.projectRoot = saved.projectRoot;
  } else if (!identity.projectRoot) {
    identity.projectRoot = op === "hook" ? typeof payload.cwd === "string" ? payload.cwd : "" : process.cwd();
  }
  if (!identity.projectRoot || !path2.isAbsolute(identity.projectRoot)) {
    throw new IdentityError("Missing or invalid project root. Hooks require cwd; commands must run from the project directory.");
  }
  return identity;
}
function commandFailure(error) {
  if (error instanceof IdentityError) return `identity: ${error.message}`;
  const messages = {
    startup: "Worker could not start. Check Node 22.19.0+, the built plugin bundle, and plugin-data permissions.",
    EACCES: "Access denied. Check permissions on the plugin-data and configuration directories.",
    EPERM: "Operation not permitted. Check plugin-data permissions and local process restrictions.",
    ENOSPC: "No space left to write plugin state. Free disk space and retry.",
    ENOENT: "A required path is missing. Check the project directory and plugin installation.",
    ECONNREFUSED: "Worker connection refused. Retry the command to restart the session worker.",
    ECONNRESET: "Worker connection closed. Retry the command.",
    ETIMEDOUT: "Worker communication timed out. Retry the command."
  };
  const code = typeof error?.code === "string" && Object.hasOwn(messages, error.code) ? error.code : "control";
  return `${code}: ${messages[code] ?? "Command failed. Check the runtime, plugin bundle, and plugin-data access."}`;
}
async function runControl(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const argv = options.argv ?? process.argv.slice(2);
  const { op } = parseControlArgv(argv);
  const request = options.request ?? requestIpc;
  try {
    let payload = {};
    if (op === "hook") {
      const raw = await readBoundedStdin(options.stdin ?? process.stdin);
      if (raw.trim()) payload = JSON.parse(raw);
    }
    const identity = identityFrom(env, payload, op);
    await fsPromises.mkdir(sessionDir(identity.pluginData, identity.sessionId), {
      recursive: true,
      mode: 448
    });
    const { locator, cold } = await ensureWorker(identity, {
      env,
      workerPath: options.workerPath,
      spawnImpl: options.spawnImpl,
      request
    });
    let ipcTimeout;
    if (op === "hook") {
      ipcTimeout = payload.hook_event_name === "SessionEnd" ? SESSION_END_TIMEOUT_MS : cold ? COLD_START_MS : WARM_IPC_MS;
    } else if (op === "on" || op === "doctor") {
      ipcTimeout = CONTROL_COMMAND_MS;
    } else {
      ipcTimeout = STATUS_OFF_MS;
    }
    const response = await request(
      locator.socketPath,
      {
        capability: locator.controlCapability,
        op,
        payload: op === "hook" ? payload : void 0
      },
      { timeoutMs: ipcTimeout }
    );
    if (!response?.ok) {
      if (op === "hook") return { exitCode: 0, stdout: "" };
      const body2 = `${JSON.stringify({ ok: false, error: response?.error ?? "worker error" }, null, 2)}
`;
      stdout.write(body2);
      return { exitCode: 0, stdout: body2 };
    }
    if (op === "hook") {
      const text = response.result?.stdout ?? "";
      if (text) stdout.write(text);
      const claimId = response.result?.claimId;
      if (claimId) {
        try {
          await request(
            locator.socketPath,
            { capability: locator.controlCapability, op: "ack", claimId },
            { timeoutMs: WARM_IPC_MS }
          );
        } catch {
        }
      }
      return { exitCode: 0, stdout: text };
    }
    const body = `${JSON.stringify(response.result ?? { ok: true }, null, 2)}
`;
    stdout.write(body);
    return { exitCode: 0, stdout: body };
  } catch (error) {
    if (op === "hook") return { exitCode: 0, stdout: "" };
    throw error;
  }
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const op = argv[0];
  try {
    if (!CONTROL_COMMANDS2.has(op)) {
      process.stderr.write("usage: control.mjs hook|on|off|status|doctor\n");
      process.exitCode = 1;
      return;
    }
    await runControl({ argv, env });
  } catch (error) {
    if (op === "hook") {
      process.exitCode = 0;
      return;
    }
    process.stderr.write(`cross-model-advisor: ${commandFailure(error)}
`);
    process.exitCode = 1;
  }
}
var realPath = (value) => {
  try {
    return fs3.realpathSync(value);
  } catch {
    return path2.resolve(value);
  }
};
var invokedDirectly = process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
export {
  ensureWorker,
  main,
  parseControlArgv,
  readBoundedStdin,
  runControl,
  spawnWorkerProcess,
  waitForLocator,
  workerChildEnv,
  workerExecutablePath
};
