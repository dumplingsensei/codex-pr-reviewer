/**
 * POSIX-shell quoting for terminal launcher commands. No config, credential,
 * or capability reads.
 */

import fs from "node:fs";
import path from "node:path";
import { configFilePath } from "./config.mjs";
import { validateSessionId } from "./session/paths.mjs";

/**
 * @param {unknown} value
 */
export function posixQuote(value) {
  const text = String(value);
  if (text.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string} value
 */
export function resolvedPath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

/**
 * @param {Array<[string, string]>} assignments
 * @param {string[]} argv
 */
export function formatEnvCommand(assignments, argv) {
  const envText = [];
  for (const [name, value] of assignments) {
    if (typeof value !== "string") continue;
    envText.push(`${name}=${posixQuote(value)}`);
  }
  const command = argv.map((part) => posixQuote(part)).join(" ");
  return envText.length > 0 ? `${envText.join(" ")} ${command}` : command;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, helperPath: string, slot: string }} options
 */
export function formatLoginCommand({ env = process.env, helperPath, slot }) {
  const configDir = path.dirname(path.resolve(configFilePath(env)));
  return formatEnvCommand(
    [["CLAUDE_CONFIG_DIR", configDir]],
    ["node", helperPath, "login", slot]
  );
}

/**
 * Safely quoted menu launcher. Captures the installed helper and config
 * directory. Validated session id and plugin-data are pinned when both are
 * present and well-formed. CLAUDE_SESSION_ID and CLAUDE_PROJECT_DIR are
 * always cleared so a stale shell value cannot retarget or reject Apply;
 * the worker's stored root remains authority. Without a valid session pair,
 * session/plugin-data are also cleared. Never reads config, credentials, or
 * capabilities.
 *
 * @param {{ env?: NodeJS.ProcessEnv, helperPath: string }} options
 */
export function formatMenuCommand({ env = process.env, helperPath }) {
  const configDir = path.dirname(path.resolve(configFilePath(env)));
  const sessionId = env.CLAUDE_CODE_SESSION_ID?.trim() || env.CLAUDE_SESSION_ID?.trim() || "";
  const pluginData = env.CLAUDE_PLUGIN_DATA?.trim() || "";
  let validId = "";
  try {
    if (sessionId) validId = validateSessionId(sessionId);
  } catch {
    validId = "";
  }
  const bind = Boolean(validId && pluginData && path.isAbsolute(pluginData));
  return formatEnvCommand(
    [
      ["CLAUDE_CONFIG_DIR", configDir],
      ["CLAUDE_CODE_SESSION_ID", bind ? validId : ""],
      ["CLAUDE_PLUGIN_DATA", bind ? path.resolve(pluginData) : ""],
      ["CLAUDE_SESSION_ID", ""],
      ["CLAUDE_PROJECT_DIR", ""]
    ],
    ["node", helperPath, "menu"]
  );
}
