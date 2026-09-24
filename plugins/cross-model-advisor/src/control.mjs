#!/usr/bin/env node
/**
 * Hook/control client. Contacts the per-session worker and waits only for
 * an enqueue/drain acknowledgement — never a provider. Fail-open: parse,
 * startup, and IPC errors exit 0 with empty stdout. Control commands do
 * not load provider SDKs. Live session settings/apply never start a worker.
 */

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
import { createClientMeta, PROTOCOL_VERSION, requestIpc, socketExists, writeCompleted } from "./session/ipc.mjs";
import {
  locatorPath,
  pidIsLive,
  readIdentity,
  explicitPluginData,
  readLocator,
  readSessionProjectRoot,
  sessionDir,
  statePath,
  userConfigPath,
  validateSessionId
} from "./session/paths.mjs";

const CONTROL_COMMANDS = new Set(["on", "off", "status", "doctor", "hook"]);
const CONTROL_COMMAND_MS = 90_000;
const STATUS_OFF_MS = 5_000;
const SETTINGS_ERROR_CODES = new Set([
  "identity",
  "no-live",
  "protocol",
  "stale",
  "busy",
  "root",
  "config",
  "unavailable"
]);
const WORKER_ENV_ALLOW = [
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
const ENV_DENY =
  /CUSTOM_HEADERS|(?:^|_)LOG$|VERTEX|GOOGLE_GENAI_USE|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_|GCLOUD_|CLOUDSDK_|GOOGLE_VERTEX|GEMINI_SYSTEM_MD|GOOGLE_GEMINI_BASE_URL|GEMINI_CLI_IDE_|NODE_OPTIONS|^PI_|KIMI_CODE_OAUTH_HOST|KIMI_OAUTH_HOST|CHATGPT_BASE_URL|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID|OPENAI_LOG/;

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
    // no snapshot yet
  }
  const configDir = env.CLAUDE_CONFIG_DIR || identity.configDir || path.join(os.homedir(), ".claude");
  const cfg = readJsonFile(path.join(configDir, "cross-model-advisor.json"));
  return cfg?.providers ?? {};
}

/**
 * Explicit child environment: process allowlist plus named snapshot/config
 * key variables. HOME and CLAUDE_CONFIG_DIR stay for the private auth store.
 * Never copies ambient headers.
 *
 * @param {object} identity
 * @param {NodeJS.ProcessEnv} [env]
 */
export function workerChildEnv(identity, env = process.env) {
  const out = Object.create(null);
  for (const name of WORKER_ENV_ALLOW) {
    if (typeof env[name] === "string" && !ENV_DENY.test(name)) out[name] = env[name];
  }
  out.CLAUDE_CODE_SESSION_ID = identity.sessionId;
  out.CLAUDE_PROJECT_DIR = identity.projectRoot;
  out.CLAUDE_PLUGIN_DATA = identity.pluginData;
  if (identity.pluginRoot) out.CLAUDE_PLUGIN_ROOT = identity.pluginRoot;
  if (identity.configDir) out.CLAUDE_CONFIG_DIR = identity.configDir;
  const providers = providersFromIdentity(identity, env);
  const keyNames = new Set();
  for (const provider of Object.values(providers)) {
    if (typeof provider?.apiKeyEnv === "string") keyNames.add(provider.apiKeyEnv);
  }
  for (const name of keyNames) {
    if (typeof env[name] === "string" && !ENV_DENY.test(name)) out[name] = env[name];
  }
  return out;
}

/**
 * @param {string} metaUrl
 */
export function workerExecutablePath(metaUrl = import.meta.url) {
  const here = path.dirname(fileURLToPath(metaUrl));
  if (path.basename(here) === "modules") return path.join(here, "..", "worker.mjs");
  return path.join(here, "worker.mjs");
}

/**
 * @param {string[]} argv
 */
export function parseControlArgv(argv) {
  const op = argv[0];
  const usage = () => {
    const error = new Error("usage: control.mjs hook | on|off|status|doctor [--plugin-data <path>]");
    error.code = "usage";
    return error;
  };
  if (!CONTROL_COMMANDS.has(op)) throw usage();
  if (argv.length === 1) return { op, pluginData: null };
  // Hooks receive this plugin's CLAUDE_PLUGIN_DATA from the host; skills
  // must name it because the Bash tool environment does not carry it.
  if (op === "hook" || argv.length !== 3 || argv[1] !== "--plugin-data") throw usage();
  try {
    return { op, pluginData: explicitPluginData(argv[2]) };
  } catch {
    throw new IdentityError(
      "Invalid --plugin-data. Run this command through the plugin's skill so Claude Code substitutes the path."
    );
  }
}

/**
 * @param {NodeJS.ReadableStream} stream
 * @param {number} [max]
 */
export async function readBoundedStdin(stream, max = MAX_STDIN_BYTES) {
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

/**
 * @param {object} identity
 * @param {{ env?: NodeJS.ProcessEnv, workerPath?: string, spawnImpl?: typeof spawn }} [options]
 */
export function spawnWorkerProcess(identity, { env = process.env, workerPath, spawnImpl = spawn } = {}) {
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

function locatorReachable(locator) {
  return Boolean(
    locator?.socketPath &&
    locator?.controlCapability &&
    pidIsLive(locator.pid) &&
    socketExists(locator.socketPath)
  );
}

/**
 * @param {object} identity
 * @param {number} deadlineMs
 */
export async function waitForLocator(identity, deadlineMs, { isDead } = {}) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (typeof isDead === "function" && isDead()) return null;
    const locator = await readLocator(identity.pluginData, identity.sessionId);
    if (locatorReachable(locator)) {
      return locator;
    }
    await sleep(20);
  }
  return null;
}

/**
 * @param {object} identity
 * @param {{ env?: NodeJS.ProcessEnv, workerPath?: string, spawnImpl?: typeof spawn, request?: typeof requestIpc }} options
 */
export async function ensureWorker(identity, options = {}) {
  const request = options.request ?? requestIpc;
  let locator = await readLocator(identity.pluginData, identity.sessionId);
  if (locatorReachable(locator)) {
    try {
      const ping = await request(
        locator.socketPath,
        { capability: locator.controlCapability, op: "ping" },
        { timeoutMs: WARM_IPC_MS }
      );
      if (ping?.ok) return { locator, cold: false };
    } catch {
      // fall through to cold start
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
        // not a group leader or already gone
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    const locFile = locatorPath(sessionDir(identity.pluginData, identity.sessionId));
    const error = new Error(
      exitInfo
        ? `worker exited before locator (code=${exitInfo.code} signal=${exitInfo.signal}) file=${workerPath} pid=${child?.pid ?? "none"} locator=${locFile}`
        : `worker startup timeout file=${workerPath} pid=${child?.pid ?? "none"} locator=${locFile}`
    );
    error.code = "startup";
    throw error;
  }
  return { locator, cold: true };
}

class IdentityError extends Error {
  code = "identity";
}

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
  // A Bash tool may change cwd or omit CLAUDE_PROJECT_DIR. Never rebind a
  // known session to that new directory, including after a worker restart.
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
  if (saved !== undefined) {
    if (!saved || typeof saved.projectRoot !== "string" || !path.isAbsolute(saved.projectRoot)) {
      throw new IdentityError("Stored session project root is invalid. Start a new Claude Code session.");
    }
    identity.projectRoot = saved.projectRoot;
  } else if (!identity.projectRoot) {
    identity.projectRoot = op === "hook"
      ? (typeof payload.cwd === "string" ? payload.cwd : "")
      : process.cwd();
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
  const code = typeof error?.code === "string" && Object.hasOwn(messages, error.code)
    ? error.code : "control";
  return `${code}: ${messages[code] ?? "Command failed. Check the runtime, plugin bundle, and plugin-data access."}`;
}

function settingsFailure(code) {
  return { ok: false, error: SETTINGS_ERROR_CODES.has(code) ? code : "protocol" };
}

function pathsMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function sanitizeAdvisor(row) {
  if (!row || typeof row !== "object" || typeof row.name !== "string") return null;
  const out = { name: row.name };
  if (typeof row.enabled === "boolean") out.enabled = row.enabled;
  if (typeof row.available === "boolean") out.available = row.available;
  if (typeof row.provider === "string") out.provider = row.provider;
  if (typeof row.model === "string") out.model = row.model;
  if (typeof row.kind === "string") out.kind = row.kind;
  if (typeof row.reasoningEffort === "string") out.reasoningEffort = row.reasoningEffort;
  if (typeof row.error === "string") out.error = row.error;
  return out;
}

function sanitizeSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  if (value.protocolVersion !== PROTOCOL_VERSION) return null;
  if (typeof value.sessionId !== "string" || !value.sessionId) return null;
  if (typeof value.projectRoot !== "string" || !path.isAbsolute(value.projectRoot)) return null;
  if (typeof value.configPath !== "string" || !value.configPath) return null;
  if (!Number.isInteger(value.workerGeneration) || !Number.isInteger(value.settingsRevision)) return null;
  if (typeof value.enabled !== "boolean" || typeof value.paused !== "boolean") return null;
  if (!Array.isArray(value.advisors)) return null;
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    sessionId: value.sessionId,
    projectRoot: value.projectRoot,
    configPath: value.configPath,
    workerGeneration: value.workerGeneration,
    settingsRevision: value.settingsRevision,
    enabled: value.enabled,
    paused: value.paused,
    advisors: value.advisors.map(sanitizeAdvisor).filter(Boolean)
  };
}

function mapResultCode(result) {
  if (result && typeof result.code === "string" && SETTINGS_ERROR_CODES.has(result.code)) return result.code;
  const error = typeof result?.error === "string" ? result.error : "";
  if (SETTINGS_ERROR_CODES.has(error)) return error;
  if (error === "protocol mismatch") return "protocol";
  if (error === "root mismatch") return "root";
  if (error === "stale worker generation" || error === "stale settings revision") return "stale";
  if (error === "api environment unavailable") return "unavailable";
  if (
    error === "missing worker generation" ||
    error === "missing settings revision" ||
    error === "missing config revision" ||
    error === "config revision mismatch" ||
    error === "config unavailable" ||
    error === "invalid config"
  ) {
    return "config";
  }
  return null;
}

function interpretTransportError(error) {
  if (error === "unknown op" || error === "unauthorized" || error === "protocol mismatch") return "protocol";
  if (typeof error === "string" && SETTINGS_ERROR_CODES.has(error)) return error;
  return "no-live";
}

function interpretSettingsIpc(response, fallback) {
  if (!response) return settingsFailure(fallback);
  if (response.ok !== true) {
    return settingsFailure(interpretTransportError(response.error) === "protocol"
      ? "protocol"
      : (SETTINGS_ERROR_CODES.has(response.error) ? response.error : fallback));
  }
  const result = response.result;
  if (!result || typeof result !== "object") return settingsFailure("protocol");
  if (result.ok === false) {
    return settingsFailure(mapResultCode(result) ?? fallback);
  }
  const snapshot = sanitizeSnapshot(result);
  if (!snapshot) return settingsFailure("protocol");
  return snapshot;
}

function settingsIdentity(env) {
  const identity = readIdentity(env, {});
  if (!identity.sessionId || !identity.pluginData) return settingsFailure("identity");
  try {
    identity.sessionId = validateSessionId(identity.sessionId);
  } catch {
    return settingsFailure("identity");
  }
  identity.configPath = userConfigPath(env);
  return { ok: true, identity };
}

async function readLiveLocator(identity) {
  let locator;
  try {
    locator = await readLocator(identity.pluginData, identity.sessionId);
  } catch {
    return settingsFailure("no-live");
  }
  if (!locatorReachable(locator)) return settingsFailure("no-live");
  return { ok: true, locator };
}

function verifySnapshotIdentity(snapshot, identity, frozenRoot, targetRoot) {
  if (snapshot.sessionId !== identity.sessionId) return settingsFailure("identity");
  if (!pathsMatch(snapshot.configPath, identity.configPath)) return settingsFailure("config");
  if (frozenRoot && !pathsMatch(snapshot.projectRoot, frozenRoot)) return settingsFailure("root");
  if (identity.projectRoot && !pathsMatch(snapshot.projectRoot, identity.projectRoot)) {
    return settingsFailure("root");
  }
  if (targetRoot && !pathsMatch(snapshot.projectRoot, targetRoot)) return settingsFailure("root");
  return snapshot;
}

/**
 * Live-only sanitized session snapshot for the terminal menu.
 * Never starts or replaces a worker.
 *
 * @param {{ env?: NodeJS.ProcessEnv, request?: typeof requestIpc }} [options]
 */
export async function getSessionSettings({ env = process.env, request = requestIpc } = {}) {
  const parsed = settingsIdentity(env);
  if (!parsed.ok) return parsed;
  const { identity } = parsed;
  const live = await readLiveLocator(identity);
  if (!live.ok) return live;
  let response;
  try {
    response = await request(
      live.locator.socketPath,
      {
        capability: live.locator.controlCapability,
        op: "settings",
        protocolVersion: PROTOCOL_VERSION
      },
      { timeoutMs: STATUS_OFF_MS }
    );
  } catch {
    return settingsFailure("no-live");
  }
  const interpreted = interpretSettingsIpc(response, "no-live");
  if (!interpreted.ok) return interpreted;
  const frozenRoot = await readSessionProjectRoot(identity.pluginData, identity.sessionId);
  return verifySnapshotIdentity(interpreted, identity, frozenRoot);
}

/**
 * Apply a captured live target to the exact saved config revision.
 * Never starts, retries, or rebinds a worker.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   target?: object,
 *   configRevision?: unknown,
 *   enable?: boolean,
 *   request?: typeof requestIpc
 * }} [options]
 */
export async function applySessionSettings({
  env = process.env,
  target,
  configRevision,
  enable,
  request = requestIpc
} = {}) {
  const parsed = settingsIdentity(env);
  if (!parsed.ok) return parsed;
  const { identity } = parsed;
  if (!target || typeof target !== "object") return settingsFailure("stale");
  if (target.protocolVersion !== PROTOCOL_VERSION) return settingsFailure("protocol");
  if (typeof target.sessionId !== "string" || target.sessionId !== identity.sessionId) {
    return settingsFailure("identity");
  }
  if (typeof target.projectRoot !== "string" || !path.isAbsolute(target.projectRoot)) {
    return settingsFailure("root");
  }
  if (typeof target.configPath !== "string" || !pathsMatch(target.configPath, identity.configPath)) {
    return settingsFailure("config");
  }
  if (!Number.isInteger(target.workerGeneration) || !Number.isInteger(target.settingsRevision)) {
    return settingsFailure("stale");
  }
  if (configRevision === undefined) return settingsFailure("config");
  const frozenRoot = await readSessionProjectRoot(identity.pluginData, identity.sessionId);
  if (frozenRoot && !pathsMatch(frozenRoot, target.projectRoot)) return settingsFailure("root");
  if (identity.projectRoot && !pathsMatch(identity.projectRoot, target.projectRoot)) {
    return settingsFailure("root");
  }
  const live = await readLiveLocator(identity);
  if (!live.ok) return live;
  let ping;
  try {
    ping = await request(
      live.locator.socketPath,
      { capability: live.locator.controlCapability, op: "ping" },
      { timeoutMs: WARM_IPC_MS }
    );
  } catch {
    return settingsFailure("no-live");
  }
  if (!ping || ping.ok !== true) {
    return settingsFailure(interpretTransportError(ping?.error));
  }
  const pingBody = ping.result;
  if (!pingBody || pingBody.protocolVersion !== PROTOCOL_VERSION) return settingsFailure("protocol");
  if (pingBody.sessionId !== identity.sessionId) return settingsFailure("identity");
  if (!pathsMatch(pingBody.projectRoot, target.projectRoot)) return settingsFailure("root");
  if (!pathsMatch(pingBody.configPath, identity.configPath) || !pathsMatch(pingBody.configPath, target.configPath)) {
    return settingsFailure("config");
  }
  if (
    pingBody.workerGeneration !== target.workerGeneration ||
    pingBody.settingsRevision !== target.settingsRevision
  ) {
    return settingsFailure("stale");
  }
  const applyReq = {
    capability: live.locator.controlCapability,
    op: "apply",
    protocolVersion: PROTOCOL_VERSION,
    workerGeneration: target.workerGeneration,
    settingsRevision: target.settingsRevision,
    configRevision
  };
  if (enable === true) applyReq.enable = true;
  let response;
  try {
    response = await request(live.locator.socketPath, applyReq, { timeoutMs: CONTROL_COMMAND_MS });
  } catch {
    return settingsFailure("no-live");
  }
  const interpreted = interpretSettingsIpc(response, "stale");
  if (!interpreted.ok) return interpreted;
  return verifySnapshotIdentity(interpreted, identity, frozenRoot, target.projectRoot);
}


/**
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   stdin?: NodeJS.ReadableStream,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream,
 *   request?: typeof requestIpc,
 *   workerPath?: string,
 *   spawnImpl?: typeof spawn
 * }} [options]
 */
export async function runControl(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const argv = options.argv ?? process.argv.slice(2);
  const { op, pluginData } = parseControlArgv(argv);
  const baseEnv = options.env ?? process.env;
  const env = pluginData ? { ...baseEnv, CLAUDE_PLUGIN_DATA: pluginData } : baseEnv;
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
      mode: 0o700
    });

    const { locator, cold } = await ensureWorker(identity, {
      env,
      workerPath: options.workerPath,
      spawnImpl: options.spawnImpl,
      request
    });

    let ipcTimeout;
    if (op === "hook") {
      ipcTimeout =
        payload.hook_event_name === "SessionEnd"
          ? SESSION_END_TIMEOUT_MS
          : cold
            ? COLD_START_MS
            : WARM_IPC_MS;
    } else if (op === "on" || op === "doctor") {
      ipcTimeout = CONTROL_COMMAND_MS;
    } else {
      ipcTimeout = STATUS_OFF_MS;
    }
    const client = op === "hook" ? createClientMeta() : undefined;
    const response = await request(
      locator.socketPath,
      {
        capability: locator.controlCapability,
        op,
        payload: op === "hook" ? payload : undefined,
        client
      },
      { timeoutMs: ipcTimeout }
    );

    if (!response?.ok) {
      if (op === "hook") return { exitCode: 0, stdout: "" };
      const body = `${JSON.stringify({ ok: false, error: response?.error ?? "worker error" }, null, 2)}\n`;
      stdout.write(body);
      return { exitCode: 0, stdout: body };
    }

    if (op === "hook") {
      const text = typeof response.result?.stdout === "string" ? response.result.stdout : "";
      const claimId = response.result?.claimId;
      if (text) {
        try {
          await writeCompleted(stdout, text);
        } catch {
          return { exitCode: 0, stdout: text };
        }
      }
      if (text && claimId && client) {
        try {
          await request(
            locator.socketPath,
            { capability: locator.controlCapability, op: "ack", claimId, client },
            { timeoutMs: WARM_IPC_MS }
          );
        } catch {
          // Issuance remains until ack or proven death; lease expiry must not clear it.
        }
      }
      return { exitCode: 0, stdout: text };
    }

    const body = `${JSON.stringify(response.result ?? { ok: true }, null, 2)}\n`;
    stdout.write(body);
    return { exitCode: 0, stdout: body };
  } catch (error) {
    if (op === "hook") return { exitCode: 0, stdout: "" };
    throw error;
  }
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  const op = argv[0];
  try {
    if (!CONTROL_COMMANDS.has(op)) {
      process.stderr.write("usage: control.mjs hook | on|off|status|doctor [--plugin-data <path>]\n");
      process.exitCode = 1;
      return;
    }
    await runControl({ argv, env });
  } catch (error) {
    if (op === "hook") {
      process.exitCode = 0;
      return;
    }
    process.stderr.write(`cross-model-advisor: ${commandFailure(error)}\n`);
    process.exitCode = 1;
  }
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
  path.basename(fileURLToPath(import.meta.url)) === "control.mjs" &&
  realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
