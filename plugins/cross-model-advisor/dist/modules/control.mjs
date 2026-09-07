#!/usr/bin/env node
import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/control.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLD_START_MS,
  MAX_STDIN_BYTES,
  SESSION_END_TIMEOUT_MS,
  WARM_IPC_MS
} from "./session/constants.mjs";
import { requestIpc, socketExists } from "./session/ipc.mjs";
import {
  locatorPath,
  pidIsLive,
  readIdentity,
  readLocator,
  sessionDir,
  statePath,
  validateSessionId
} from "./session/paths.mjs";
var CONTROL_COMMANDS = /* @__PURE__ */ new Set(["on", "off", "status", "doctor", "hook"]);
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
    return JSON.parse(fs.readFileSync(file, "utf8"));
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
  const configDir = env.CLAUDE_CONFIG_DIR || identity.configDir || path.join(os.homedir(), ".claude");
  const cfg = readJsonFile(path.join(configDir, "cross-model-advisor.json"));
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
  const here = path.dirname(fileURLToPath(metaUrl));
  if (path.basename(here) === "modules") return path.join(here, "..", "worker.mjs");
  return path.join(here, "worker.mjs");
}
function parseControlArgv(argv) {
  const op = argv[0];
  if (!CONTROL_COMMANDS.has(op)) {
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
    saved = JSON.parse(fs.readFileSync(statePath(sessionDir(identity.pluginData, identity.sessionId)), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        throw new IdentityError("Stored session identity is unreadable. Start a new Claude Code session.");
      }
      throw error;
    }
  }
  if (saved !== void 0) {
    if (!saved || typeof saved.projectRoot !== "string" || !path.isAbsolute(saved.projectRoot)) {
      throw new IdentityError("Stored session project root is invalid. Start a new Claude Code session.");
    }
    identity.projectRoot = saved.projectRoot;
  } else if (!identity.projectRoot) {
    identity.projectRoot = op === "hook" ? typeof payload.cwd === "string" ? payload.cwd : "" : process.cwd();
  }
  if (!identity.projectRoot || !path.isAbsolute(identity.projectRoot)) {
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
    if (!CONTROL_COMMANDS.has(op)) {
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
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
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
