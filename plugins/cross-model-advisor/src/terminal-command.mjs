/**
 * POSIX-shell quoting for terminal launcher commands. No config, credential,
 * or capability reads.
 */

import fs from "node:fs";
import path from "node:path";
import { configFilePath } from "./config.mjs";

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
 * Safely quoted menu launcher: the installed helper plus the config
 * directory it edits. The menu edits saved settings only, so no session is
 * named. Never reads config, credentials, or capabilities.
 *
 * @param {{ env?: NodeJS.ProcessEnv, helperPath: string }} options
 */
export function formatMenuCommand({ env = process.env, helperPath }) {
  const configDir = path.dirname(path.resolve(configFilePath(env)));
  return formatEnvCommand([["CLAUDE_CONFIG_DIR", configDir]], ["node", helperPath, "menu"]);
}
