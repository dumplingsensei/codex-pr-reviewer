import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/session/sanitize.mjs
var CREDENTIAL_ASSIGNMENT = /\b(?:api[_-]?key|token|password|secret|authorization|bearer)\b\s*[:=]\s*([^\s,;]+)/gi;
var ENV_CREDENTIAL_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*[:=]\s*["']?)([^\s"'`,;]{8,})/g;
var KNOWN_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g;
var CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
function redactCredentials(text) {
  return text.replace(KNOWN_TOKEN, "[redacted]").replace(CREDENTIAL_ASSIGNMENT, (match, value) => match.replace(value, "[redacted]")).replace(
    ENV_CREDENTIAL_ASSIGNMENT,
    (match, name, sep, value) => /[A-Za-z]/.test(value) ? `${name}${sep}[redacted]` : match
  );
}
function sanitizeText(text, secrets = []) {
  if (typeof text !== "string" || text.length === 0) return "";
  let out = text.replace(CONTROL_CHARS, "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return redactCredentials(out);
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
  redactCredentials,
  resolveSecrets,
  sanitizeText,
  secretNamesFromSnapshot,
  truncateLabeled
};
