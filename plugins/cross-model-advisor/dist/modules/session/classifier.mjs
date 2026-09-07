import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/session/classifier.mjs
import { CONTROL_COMMANDS } from "./constants.mjs";
var CONTROL_SET = new Set(CONTROL_COMMANDS);
function isControlCommandName(name) {
  return CONTROL_SET.has(String(name ?? "").trim());
}
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
function classifyExpansion(payload) {
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
function looksLikeControlTraffic(text) {
  const sample = String(text ?? "");
  if (CONTROL_COMMANDS.some((name) => sample.includes(`/${name}`))) return true;
  if (/cross-model-advisor:(?:on|off|status|doctor|setup|login|logout)\b/.test(sample)) return true;
  return false;
}
export {
  classifyExpansion,
  classifyPrompt,
  isControlCommandName,
  looksLikeControlTraffic
};
