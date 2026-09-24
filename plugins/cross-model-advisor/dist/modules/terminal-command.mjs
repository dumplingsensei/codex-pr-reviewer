import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/terminal-command.mjs
import fs from "node:fs";
import path from "node:path";
import { configFilePath } from "./config.mjs";
function posixQuote(value) {
  const text = String(value);
  if (text.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
function resolvedPath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
function formatEnvCommand(assignments, argv) {
  const envText = [];
  for (const [name, value] of assignments) {
    if (typeof value !== "string") continue;
    envText.push(`${name}=${posixQuote(value)}`);
  }
  const command = argv.map((part) => posixQuote(part)).join(" ");
  return envText.length > 0 ? `${envText.join(" ")} ${command}` : command;
}
function formatLoginCommand({ env = process.env, helperPath, slot }) {
  const configDir = path.dirname(path.resolve(configFilePath(env)));
  return formatEnvCommand(
    [["CLAUDE_CONFIG_DIR", configDir]],
    ["node", helperPath, "login", slot]
  );
}
function formatMenuCommand({ env = process.env, helperPath }) {
  const configDir = path.dirname(path.resolve(configFilePath(env)));
  return formatEnvCommand([["CLAUDE_CONFIG_DIR", configDir]], ["node", helperPath, "menu"]);
}
export {
  formatEnvCommand,
  formatLoginCommand,
  formatMenuCommand,
  posixQuote,
  resolvedPath
};
