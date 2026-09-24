/**
 * Trusted user configuration for cross-model-advisor.
 * Keys are never persisted; `apiKeyEnv` is a variable name only.
 * Configured slots (`advisors[].provider`) are distinct from upstream
 * SDK ids (`providers.*.provider`).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CONFIG_VERSION = 2;
export const CONFIG_VERSION_V1 = 1;
export const CONFIG_FILENAME = "cross-model-advisor.json";

export const REASONING_EFFORTS = Object.freeze([
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

export const THINKING_FORMATS = Object.freeze(["openai", "openrouter", "zai"]);
export const THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
const NATIVE_LEVEL_MAX = 64;

export const API_PROVIDERS = Object.freeze([
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "openai-compatible",
  "zai",
  "xai",
  "moonshotai",
  "kimi-coding"
]);

export const OAUTH_PROVIDERS = Object.freeze([
  "openai-codex",
  "github-copilot",
  "xai",
  "kimi-coding"
]);

export const DEFAULT_LIMITS = Object.freeze({
  maxConcurrentAdvisors: 2,
  reviewTimeoutSeconds: 90,
  maxToolCallsPerReview: 8,
  maxOutputTokens: 1500,
  maxReviewsPerAdvisorPerSession: 40
});

/**
 * Stop-gate behaviour. `block` sends Claude back to address concerns and
 * blockers; `report` only shows findings to the user. `maxRounds` bounds how
 * many times one prompt can be sent back.
 */
export const GATE_MODES = Object.freeze(["block", "report"]);
export const DEFAULT_GATE = Object.freeze({ mode: "block", maxRounds: 2 });
const GATE_KEYS = Object.freeze(["mode", "maxRounds"]);

const IDENTIFIER_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MIN_NODE = Object.freeze([22, 19, 0]);
const LIMIT_BOUNDS = Object.freeze({
  maxConcurrentAdvisors: [1, 16],
  // The Stop hook's own timeout is 300 seconds; reviews must finish inside it.
  reviewTimeoutSeconds: [1, 240],
  maxToolCallsPerReview: [1, 100],
  maxOutputTokens: [1, 100_000],
  maxReviewsPerAdvisorPerSession: [1, 10_000]
});
const MODEL_INPUTS = new Set(["text", "image"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const CONFIG_KEYS = Object.freeze(["version", "providers", "advisors", "exclude", "limits", "gate"]);
const API_KEYS = Object.freeze(["kind", "provider", "apiKeyEnv"]);
const COMPAT_KEYS = Object.freeze(["kind", "provider", "apiKeyEnv", "baseUrl", "models"]);
const OAUTH_KEYS = Object.freeze(["kind", "provider"]);
const ADVISOR_KEYS_V1 = Object.freeze(["name", "provider", "model", "instructions"]);
const ADVISOR_KEYS_V2 = Object.freeze([
  "name",
  "provider",
  "model",
  "instructions",
  "enabled",
  "reasoningEffort"
]);
const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));
const MODEL_META_KEYS_V1 = Object.freeze([
  "contextWindow",
  "maxTokens",
  "reasoning",
  "input",
  "pricing"
]);
const MODEL_META_KEYS_V2 = Object.freeze([
  "contextWindow",
  "maxTokens",
  "reasoning",
  "input",
  "pricing",
  "thinkingFormat",
  "thinkingLevelMap",
  "supportsReasoningEffort"
]);
const PRICING_KEYS = Object.freeze(["prompt", "completion"]);

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  const error = new Error(message);
  error.name = "ConfigError";
  throw error;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail(`${label} must be a plain object`);
  }
}

/**
 * @param {object} value
 * @param {readonly string[]} allowed
 * @param {string} label
 */
function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.includes(key)) {
      fail(`${label} has unknown key ${key}`);
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value) || FORBIDDEN_KEYS.has(value)) {
    fail(`${label} is not a restricted identifier`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} min
 * @param {number} max
 */
function assertInteger(value, label, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer from ${min} to ${max}`);
  }
}

/**
 * @param {string} host
 */
function isLoopbackHost(host) {
  const hostname = String(host ?? "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  const ipv4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (!ipv4) return false;
  return hostname.split(".").every((part) => {
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertBaseUrl(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    fail(`${label} must be a URL`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a URL`);
  }
  if (parsed.username || parsed.password) fail(`${label} must not include credentials`);
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return parsed.toString();
  fail(`${label} must use HTTPS (HTTP is allowed only for localhost/loopback)`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertNativeLevel(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > NATIVE_LEVEL_MAX) {
    fail(`${label} must be a bounded native string or null`);
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) fail(`${label} must be a bounded native string or null`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertThinkingLevelMap(value, label) {
  assertPlainObject(value, label);
  assertKnownKeys(value, THINKING_LEVELS, label);
  /** @type {Record<string, string | null>} */
  const mapped = {};
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(value, level)) fail(`${label} is missing ${level}`);
    mapped[level] = assertNativeLevel(value[level], `${label}.${level}`);
  }
  return mapped;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {1 | 2} version
 */
function assertModelMeta(value, label, version) {
  assertPlainObject(value, label);
  assertKnownKeys(value, version === 2 ? MODEL_META_KEYS_V2 : MODEL_META_KEYS_V1, label);
  for (const key of ["contextWindow", "maxTokens", "reasoning", "input"]) {
    if (!(key in value)) fail(`${label} is missing ${key}`);
  }
  assertInteger(value.contextWindow, `${label}.contextWindow`, 1, 10_000_000);
  assertInteger(value.maxTokens, `${label}.maxTokens`, 1, 10_000_000);
  if (typeof value.reasoning !== "boolean") fail(`${label}.reasoning must be a boolean`);
  if (!Array.isArray(value.input) || value.input.length === 0) {
    fail(`${label}.input must be a nonempty array`);
  }
  for (const item of value.input) {
    if (typeof item !== "string" || !MODEL_INPUTS.has(item)) {
      fail(`${label}.input values must be "text" or "image"`);
    }
  }
  /** @type {{
   *   contextWindow: number,
   *   maxTokens: number,
   *   reasoning: boolean,
   *   input: string[],
   *   pricing?: { prompt?: number, completion?: number },
   *   thinkingFormat?: "openai" | "openrouter" | "zai",
   *   thinkingLevelMap?: Record<string, string | null>,
   *   supportsReasoningEffort?: boolean
   * }} */
  const meta = {
    contextWindow: value.contextWindow,
    maxTokens: value.maxTokens,
    reasoning: value.reasoning,
    input: [...value.input]
  };
  if ("pricing" in value) {
    assertPlainObject(value.pricing, `${label}.pricing`);
    assertKnownKeys(value.pricing, PRICING_KEYS, `${label}.pricing`);
    /** @type {{ prompt?: number, completion?: number }} */
    const pricing = {};
    for (const key of PRICING_KEYS) {
      if (!(key in value.pricing)) continue;
      const amount = value.pricing[key];
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
        fail(`${label}.pricing.${key} must be a non-negative number`);
      }
      pricing[key] = amount;
    }
    meta.pricing = pricing;
  }
  const hasFormat = Object.hasOwn(value, "thinkingFormat");
  const hasMap = Object.hasOwn(value, "thinkingLevelMap");
  if (hasFormat !== hasMap) {
    fail(`${label} must pair thinkingFormat with thinkingLevelMap`);
  }
  if (hasFormat) {
    if (typeof value.thinkingFormat !== "string" || !THINKING_FORMATS.includes(value.thinkingFormat)) {
      fail(`${label}.thinkingFormat must be "openai", "openrouter", or "zai"`);
    }
    meta.thinkingFormat = value.thinkingFormat;
    meta.thinkingLevelMap = assertThinkingLevelMap(value.thinkingLevelMap, `${label}.thinkingLevelMap`);
  }
  if (Object.hasOwn(value, "supportsReasoningEffort")) {
    if (!hasFormat) {
      fail(`${label}.supportsReasoningEffort is only valid with thinkingFormat and thinkingLevelMap`);
    }
    if (typeof value.supportsReasoningEffort !== "boolean") {
      fail(`${label}.supportsReasoningEffort must be a boolean`);
    }
    meta.supportsReasoningEffort = value.supportsReasoningEffort;
  }
  return meta;
}

/**
 * @param {unknown} value
 * @param {string} id
 * @param {1 | 2} version
 */
function assertProvider(value, id, version) {
  assertPlainObject(value, `providers.${id}`);
  if (value.kind === "api") {
    const compatible = value.provider === "openai-compatible";
    assertKnownKeys(value, compatible ? COMPAT_KEYS : API_KEYS, `providers.${id}`);
    if (typeof value.provider !== "string" || !API_PROVIDERS.includes(value.provider)) {
      fail(`providers.${id}.provider is not a supported API provider`);
    }
    if (typeof value.apiKeyEnv !== "string" || !ENV_NAME_RE.test(value.apiKeyEnv)) {
      fail(`providers.${id}.apiKeyEnv must be an environment variable name`);
    }
    /** @type {Record<string, unknown>} */
    const entry = {
      kind: "api",
      provider: value.provider,
      apiKeyEnv: value.apiKeyEnv
    };
    if (compatible) {
      if (!("baseUrl" in value) || !("models" in value)) {
        fail(`providers.${id} requires baseUrl and models`);
      }
      entry.baseUrl = assertBaseUrl(value.baseUrl, `providers.${id}.baseUrl`);
      assertPlainObject(value.models, `providers.${id}.models`);
      const modelIds = Object.keys(value.models);
      if (modelIds.length === 0) fail(`providers.${id}.models must include at least one model`);
      /** @type {Record<string, ReturnType<typeof assertModelMeta>>} */
      const models = {};
      for (const modelId of modelIds) {
        if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > 256 || FORBIDDEN_KEYS.has(modelId)) {
          fail(`providers.${id}.models has an invalid model id`);
        }
        models[modelId] = assertModelMeta(value.models[modelId], `providers.${id}.models.${modelId}`, version);
      }
      entry.models = models;
    }
    return entry;
  }
  if (value.kind === "oauth") {
    assertKnownKeys(value, OAUTH_KEYS, `providers.${id}`);
    if (typeof value.provider !== "string" || !OAUTH_PROVIDERS.includes(value.provider)) {
      fail(`providers.${id}.provider is not a supported OAuth provider`);
    }
    return { kind: "oauth", provider: value.provider };
  }
  fail(`providers.${id}.kind must be "api" or "oauth"`);
}

/**
 * @param {unknown} value
 */
function assertExclude(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("exclude must be an array of strings");
  if (value.length > 256) fail("exclude is too long");
  const patterns = [];
  for (const [index, pattern] of value.entries()) {
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 512) {
      fail(`exclude[${index}] must be a nonempty string`);
    }
    if (pattern.includes("\0")) fail(`exclude[${index}] is not a valid pattern`);
    const trimmed = pattern.trim();
    if (trimmed.startsWith("!")) fail("exclude patterns may only narrow access (negation is not allowed)");
    patterns.push(pattern);
  }
  return patterns;
}

/**
 * @param {unknown} value
 */
function assertLimits(value) {
  if (value === undefined) return { ...DEFAULT_LIMITS };
  assertPlainObject(value, "limits");
  assertKnownKeys(value, LIMIT_KEYS, "limits");
  /** @type {typeof DEFAULT_LIMITS} */
  const limits = { ...DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) {
    if (!(key in value)) continue;
    const [min, max] = LIMIT_BOUNDS[key];
    assertInteger(value[key], `limits.${key}`, min, max);
    limits[key] = value[key];
  }
  return limits;
}

/**
 * @param {unknown} entry
 * @param {number} index
 * @param {Record<string, object>} providers
 * @param {1 | 2} version
 * @param {Set<string>} names
 */
function assertAdvisor(entry, index, providers, version, names) {
  const label = `advisors[${index}]`;
  assertPlainObject(entry, label);
  assertKnownKeys(entry, version === 2 ? ADVISOR_KEYS_V2 : ADVISOR_KEYS_V1, label);
  assertIdentifier(entry.name, `${label}.name`);
  if (names.has(entry.name)) fail(`advisor name ${entry.name} is not unique`);
  names.add(entry.name);
  if (typeof entry.provider !== "string" || !Object.hasOwn(providers, entry.provider)) {
    fail(`${label}.provider is not a configured provider`);
  }
  if (typeof entry.model !== "string" || entry.model.length === 0 || entry.model.length > 256) {
    fail(`${label}.model must be a user-selected model id`);
  }
  const provider = providers[entry.provider];
  if (provider.kind === "api" && provider.provider === "openai-compatible") {
    if (!Object.hasOwn(provider.models, entry.model)) {
      fail(`${label}.model is not defined on providers.${entry.provider}`);
    }
  }
  if (typeof entry.instructions !== "string" || entry.instructions.length === 0 || entry.instructions.length > 8192) {
    fail(`${label}.instructions must be a literal string`);
  }
  let enabled = true;
  let reasoningEffort = "default";
  if (version === 2) {
    if (typeof entry.enabled !== "boolean") fail(`${label}.enabled must be a boolean`);
    enabled = entry.enabled;
    if (typeof entry.reasoningEffort !== "string" || !REASONING_EFFORTS.includes(entry.reasoningEffort)) {
      fail(`${label}.reasoningEffort is not a supported value`);
    }
    reasoningEffort = entry.reasoningEffort;
  }
  return {
    name: entry.name,
    provider: entry.provider,
    model: entry.model,
    instructions: entry.instructions,
    enabled,
    reasoningEffort
  };
}

/**
 * @param {unknown} value
 */
function assertGate(value) {
  if (value === undefined) return { ...DEFAULT_GATE };
  assertPlainObject(value, "gate");
  assertKnownKeys(value, GATE_KEYS, "gate");
  const gate = { ...DEFAULT_GATE };
  if ("mode" in value) {
    if (!GATE_MODES.includes(value.mode)) fail(`gate.mode must be one of ${GATE_MODES.join(", ")}`);
    gate.mode = value.mode;
  }
  if ("maxRounds" in value) {
    assertInteger(value.maxRounds, "gate.maxRounds", 1, 5);
    gate.maxRounds = value.maxRounds;
  }
  return gate;
}

/**
 * Strict nested validation. Unknown keys and malformed entries throw.
 * Version 1 is accepted and normalized in memory to version 2 (enabled true,
 * reasoningEffort default). Version 2 allows empty providers/advisors when
 * references remain valid. New fields are valid only in version 2.
 * @param {unknown} value
 * @returns {{
 *   version: 2,
 *   providers: Record<string, object>,
 *   advisors: object[],
 *   exclude: string[],
 *   limits: typeof DEFAULT_LIMITS,
 *   gate: { mode: "block" | "report", maxRounds: number }
 * }}
 */
export function validateConfig(value) {
  assertPlainObject(value, "config");
  assertKnownKeys(value, CONFIG_KEYS, "config");
  if (value.version !== CONFIG_VERSION_V1 && value.version !== CONFIG_VERSION) {
    fail("config.version must be 1 or 2");
  }
  /** @type {1 | 2} */
  const version = value.version;
  if (!("providers" in value) || !("advisors" in value)) {
    fail("config requires providers and advisors");
  }
  assertPlainObject(value.providers, "providers");
  const providerIds = Object.keys(value.providers);
  if (version === CONFIG_VERSION_V1 && providerIds.length === 0) {
    fail("providers must include at least one entry");
  }
  /** @type {Record<string, object>} */
  const providers = {};
  for (const id of providerIds) {
    assertIdentifier(id, `providers key ${id}`);
    providers[id] = assertProvider(value.providers[id], id, version);
  }
  if (!Array.isArray(value.advisors)) fail("advisors must be an array");
  if (version === CONFIG_VERSION_V1 && value.advisors.length === 0) {
    fail("advisors must be a nonempty array");
  }
  if (value.advisors.length > 32) fail("too many advisors");
  const names = new Set();
  const advisors = value.advisors.map((entry, index) =>
    assertAdvisor(entry, index, providers, version, names)
  );
  return {
    version: CONFIG_VERSION,
    providers,
    advisors,
    exclude: assertExclude(value.exclude),
    limits: assertLimits(value.limits),
    gate: assertGate(value.gate)
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function configFilePath(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, CONFIG_FILENAME);
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, projectRoot?: string }} [options]
 */
export async function loadConfig({ env = process.env, projectRoot: _projectRoot } = {}) {
  const file = configFilePath(env);
  let raw;
  try {
    raw = await fs.readFile(file, { encoding: "utf8", flag: "r" });
  } catch (error) {
    if (error && error.code === "ENOENT") fail(`missing config file ${CONFIG_FILENAME}`);
    fail("unable to read config file");
  }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("config file is not valid JSON");
  }
  return validateConfig(parsed);
}

/**
 * Refuse `/`, the home directory, or a missing root. Returns the real path.
 * `follow: false` (review tools) rejects a root that is now a symlink instead of
 * recanonicalizing to a new target.
 * @param {unknown} rootPath
 * @param {{ follow?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function validateRoot(rootPath, { follow = true } = {}) {
  if (typeof rootPath !== "string" || rootPath.length === 0) fail("project root is missing");
  const resolved = path.resolve(rootPath);
  let listing;
  try {
    listing = await fs.lstat(resolved);
  } catch {
    fail("project root is missing");
  }
  if (listing.isSymbolicLink() && !follow) fail("project root cannot be a symlink");
  if (!listing.isSymbolicLink() && !listing.isDirectory()) fail("project root is missing");
  let canonical;
  try {
    canonical = await fs.realpath(resolved);
  } catch {
    fail("project root is missing");
  }
  let stats;
  try {
    stats = await fs.stat(canonical);
  } catch {
    fail("project root is missing");
  }
  if (!stats.isDirectory()) fail("project root is missing");
  if (!follow) {
    let again;
    try {
      again = await fs.lstat(resolved);
    } catch {
      fail("project root is missing");
    }
    if (again.isSymbolicLink() || again.dev !== listing.dev || again.ino !== listing.ino) {
      fail("project root changed");
    }
    if (stats.dev !== listing.dev || stats.ino !== listing.ino) fail("project root changed");
  }
  const root = path.parse(canonical).root;
  if (canonical === root || canonical === "/") fail("project root cannot be the filesystem root");
  let home = os.homedir();
  try {
    home = await fs.realpath(home);
  } catch {
    home = path.resolve(home);
  }
  if (canonical === home) fail("project root cannot be the home directory");
  return canonical;
}

/**
 * Canonical root plus directory identity for the activation snapshot.
 * @param {unknown} rootPath
 * @param {{ follow?: boolean }} [options]
 */
export async function snapshotRoot(rootPath, options = {}) {
  const canonical = await validateRoot(rootPath, options);
  const listing = await fs.lstat(canonical);
  if (listing.isSymbolicLink() || !listing.isDirectory()) fail("project root is missing");
  return { path: canonical, dev: listing.dev, ino: listing.ino };
}

/**
 * @param {string} version
 * @param {readonly number[]} minimum
 */
function versionAtLeast(version, minimum) {
  const parts = String(version)
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < minimum.length; i += 1) {
    const n = Number.isInteger(parts[i]) ? parts[i] : 0;
    if (n > minimum[i]) return true;
    if (n < minimum[i]) return false;
  }
  return true;
}

/**
 * Runtime diagnostics for doctor. Ordinary hooks stay fail-open elsewhere.
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {string[]}
 */
export function runtimeErrors({ env: _env = process.env } = {}) {
  const errors = [];
  if (!versionAtLeast(process.versions.node, MIN_NODE)) {
    errors.push(`Node ${process.versions.node} is unsupported; need 22.19.0 or newer`);
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    errors.push(`OS ${process.platform} is unsupported; need macOS or Linux`);
  }
  return errors;
}
