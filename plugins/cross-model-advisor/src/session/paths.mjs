/**
 * Session directory layout and identity checks. Session state lives only under
 * the private plugin-data session directory.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DIR_MODE, FILE_MODE } from "./constants.mjs";

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function validateSessionId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!SESSION_ID_RE.test(id)) {
    throw new Error("invalid session id");
  }
  return id;
}

/**
 * Plugin data named on a skill's command line. Claude Code substitutes
 * `${CLAUDE_PLUGIN_DATA}` into skill text but does not export it to Bash tool
 * commands, and another plugin's SessionStart can export its own value into
 * every Bash command through CLAUDE_ENV_FILE. Outside hooks, only this
 * substituted path identifies this plugin's data.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function explicitPluginData(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.includes("${") || !path.isAbsolute(text)) {
    throw new Error("invalid --plugin-data");
  }
  return path.resolve(text);
}

/**
 * @param {string} pluginData
 * @param {string} sessionId
 */
export function sessionDir(pluginData, sessionId) {
  return path.join(pluginData, "sessions", validateSessionId(sessionId));
}

export const statePath = (dir) => path.join(dir, "state.json");
export const errorLogPath = (dir) => path.join(dir, "errors.log");

/**
 * @param {string} dir
 */
export async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE).catch(() => {});
}

/**
 * Atomic replace of a 0600 file. Writes to a sibling tmp then renames.
 * @param {string} file
 * @param {string|Uint8Array} body
 */
export async function atomicWriteFile(file, body) {
  const dir = path.dirname(file);
  await ensurePrivateDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const data = typeof body === "string" ? body : body;
  await fs.writeFile(tmp, data, { mode: FILE_MODE, flag: "wx" });
  await fs.chmod(tmp, FILE_MODE).catch(() => {});
  await fs.rename(tmp, file);
}

/**
 * @param {string} file
 * @param {unknown} value
 */
export async function atomicWriteJson(file, value) {
  await atomicWriteFile(file, `${JSON.stringify(value)}\n`);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ session_id?: unknown }} [payload]
 */
export function readIdentity(env = process.env, payload = {}) {
  const sessionId =
    env.CLAUDE_CODE_SESSION_ID?.trim() ||
    env.CLAUDE_SESSION_ID?.trim() ||
    (typeof payload.session_id === "string" ? payload.session_id.trim() : "");
  const projectRoot = env.CLAUDE_PROJECT_DIR?.trim() || "";
  const pluginData = env.CLAUDE_PLUGIN_DATA?.trim() || "";
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT?.trim() || "";
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return { sessionId, projectRoot, pluginData, pluginRoot, configDir };
}

/**
 * Trusted user config path from launcher/Claude env. Never inferred from cwd.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function userConfigPath(env = process.env) {
  return path.join(readIdentity(env).configDir, "cross-model-advisor.json");
}


/**
 * True when `pid` still refers to a live process of this user.
 * @param {unknown} pid
 */
export function pidIsLive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}
