import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/session/paths.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DIR_MODE, FILE_MODE } from "./constants.mjs";
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
var lockDir = (dir) => path.join(dir, "lock");
var errorLogPath = (dir) => path.join(dir, "errors.log");
async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE).catch(() => {
  });
}
async function atomicWriteFile(file, body) {
  const dir = path.dirname(file);
  await ensurePrivateDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const data = typeof body === "string" ? body : body;
  await fs.writeFile(tmp, data, { mode: FILE_MODE, flag: "wx" });
  await fs.chmod(tmp, FILE_MODE).catch(() => {
  });
  await fs.rename(tmp, file);
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
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return { sessionId, projectRoot, pluginData, pluginRoot, configDir };
}
async function readLocator(pluginData, sessionId) {
  const file = locatorPath(sessionDir(pluginData, sessionId));
  try {
    const raw = await fs.readFile(file, "utf8");
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
async function createSocketDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cma"));
  await fs.chmod(dir, DIR_MODE).catch(() => {
  });
  return { dir, socketPath: path.join(dir, "s") };
}
export {
  atomicWriteFile,
  atomicWriteJson,
  createSocketDir,
  ensurePrivateDir,
  errorLogPath,
  locatorPath,
  lockDir,
  pidIsLive,
  readIdentity,
  readLocator,
  sessionDir,
  statePath,
  validateSessionId
};
