/**
 * Disclosure minimization for observations and envelopes. This is not a
 * promise to detect every secret in prose.
 */

const CREDENTIAL_ASSIGNMENT =
  /\b(?:api[_-]?key|token|password|secret|authorization|bearer)\b\s*[:=]\s*([^\s,;]+)/gi;

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * @param {string} text
 * @param {string[]} secrets
 */
export function sanitizeText(text, secrets = []) {
  if (typeof text !== "string" || text.length === 0) return "";
  let out = text.replace(CONTROL_CHARS, "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  out = out.replace(CREDENTIAL_ASSIGNMENT, (match, value) => match.replace(value, "[redacted]"));
  return out;
}

/**
 * @param {string} text
 * @param {number} cap
 */
export function truncateLabeled(text, cap) {
  if (typeof text !== "string") return "";
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n[truncated ${text.length - cap} chars]`;
}

/**
 * Boundary markers inside a finding must not split the envelope.
 * @param {string} text
 */
export function escapeEnvelope(text) {
  return sanitizeText(text).replaceAll("---", "—-—");
}

/**
 * Resolve configured key-variable names without persisting values.
 * @param {string[]} names
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveSecrets(names, env = process.env) {
  const secrets = [];
  for (const name of names) {
    if (typeof name !== "string" || !name) continue;
    const value = env[name];
    if (typeof value === "string" && value.length > 0) secrets.push(value);
  }
  return secrets;
}

/**
 * @param {{ providers?: Record<string, { apiKeyEnv?: unknown }> } | null | undefined} snapshot
 */
export function secretNamesFromSnapshot(snapshot) {
  const names = [];
  const providers = snapshot?.providers;
  if (!providers || typeof providers !== "object") return names;
  for (const entry of Object.values(providers)) {
    if (entry && typeof entry.apiKeyEnv === "string") names.push(entry.apiKeyEnv);
  }
  return names;
}
