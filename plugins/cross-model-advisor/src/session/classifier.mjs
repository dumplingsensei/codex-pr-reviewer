/**
 * Classify control turns before drainage, task replacement, or scheduling.
 * Namespaced on/off/status/doctor/setup/login/logout are control-only.
 */

import { CONTROL_COMMANDS } from "./constants.mjs";

const CONTROL_SET = new Set(CONTROL_COMMANDS);

/**
 * @param {string} name
 */
export function isControlCommandName(name) {
  return CONTROL_SET.has(String(name ?? "").trim());
}

/**
 * Parse a submitted prompt into control / slash / task.
 * Ambiguous aliases (`/on`, `/advisor:on`, un-namespaced status) are not control.
 *
 * @param {string} prompt
 * @returns {{ kind: "control" | "slash" | "task", command?: string, rest: string }}
 */
export function classifyPrompt(prompt) {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text.startsWith("/")) return { kind: "task", rest: text };
  const match = /^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return { kind: "task", rest: text };
  const command = match[1];
  const rest = (match[2] ?? "").trim();
  if (CONTROL_SET.has(command)) return { kind: "control", command, rest };
  return { kind: "slash", command, rest };
}

/**
 * UserPromptExpansion resolves deferred slash classification.
 *
 * @param {{ command_name?: unknown, command_source?: unknown, prompt?: unknown }} payload
 */
export function classifyExpansion(payload) {
  const name = typeof payload?.command_name === "string" ? payload.command_name.trim() : "";
  const source = typeof payload?.command_source === "string" ? payload.command_source.trim() : "";
  const original = classifyPrompt(typeof payload?.prompt === "string" ? payload.prompt : "");
  if (CONTROL_SET.has(name) && (source === "plugin" || source === "" || original.kind === "control")) {
    return { kind: "control", command: name, rest: original.rest };
  }
  if (original.kind === "control") return original;
  if (name || original.kind === "slash") {
    return { kind: "slash", command: name || original.command, rest: original.rest };
  }
  return { kind: "task", rest: original.rest };
}

/**
 * Reporting turns for plugin control helpers (skill output echoed as user
 * or assistant text) must not replace the last real task.
 *
 * @param {string} text
 */
export function looksLikeControlTraffic(text) {
  const sample = String(text ?? "");
  if (CONTROL_COMMANDS.some((name) => sample.includes(`/${name}`))) return true;
  if (/cross-model-advisor:(?:on|off|status|doctor|setup|login|logout)\b/.test(sample)) return true;
  return false;
}
