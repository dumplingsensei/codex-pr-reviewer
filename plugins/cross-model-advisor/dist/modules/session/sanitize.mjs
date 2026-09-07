import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/session/sanitize.mjs
var CREDENTIAL_ASSIGNMENT = /\b(?:api[_-]?key|token|password|secret|authorization|bearer)\b\s*[:=]\s*([^\s,;]+)/gi;
var CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
function sanitizeText(text, secrets = []) {
  if (typeof text !== "string" || text.length === 0) return "";
  let out = text.replace(CONTROL_CHARS, "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  out = out.replace(CREDENTIAL_ASSIGNMENT, (match, value) => match.replace(value, "[redacted]"));
  return out;
}
function truncateLabeled(text, cap) {
  if (typeof text !== "string") return "";
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}
[truncated ${text.length - cap} chars]`;
}
function escapeEnvelope(text) {
  return sanitizeText(text).replaceAll("---", "—-—");
}
function resolveSecrets(names, env = process.env) {
  const secrets = [];
  for (const name of names) {
    if (typeof name !== "string" || !name) continue;
    const value = env[name];
    if (typeof value === "string" && value.length > 0) secrets.push(value);
  }
  return secrets;
}
function secretNamesFromSnapshot(snapshot) {
  const names = [];
  const providers = snapshot?.providers;
  if (!providers || typeof providers !== "object") return names;
  for (const entry of Object.values(providers)) {
    if (entry && typeof entry.apiKeyEnv === "string") names.push(entry.apiKeyEnv);
  }
  return names;
}
export {
  escapeEnvelope,
  resolveSecrets,
  sanitizeText,
  secretNamesFromSnapshot,
  truncateLabeled
};
