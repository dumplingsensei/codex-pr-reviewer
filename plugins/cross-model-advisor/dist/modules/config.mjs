import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/config.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
var CONFIG_VERSION = 1;
var CONFIG_FILENAME = "cross-model-advisor.json";
var API_PROVIDERS = Object.freeze([
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
var OAUTH_PROVIDERS = Object.freeze([
  "openai-codex",
  "github-copilot",
  "xai",
  "kimi-coding"
]);
var DEFAULT_LIMITS = Object.freeze({
  maxConcurrentAdvisors: 2,
  reviewTimeoutSeconds: 90,
  maxToolCallsPerReview: 8,
  maxOutputTokens: 1500,
  maxReviewsPerAdvisorPerSession: 40
});
var IDENTIFIER_RE = /^[a-z][a-z0-9-]{0,63}$/;
var ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var MIN_NODE = Object.freeze([22, 19, 0]);
var LIMIT_BOUNDS = Object.freeze({
  maxConcurrentAdvisors: [1, 16],
  reviewTimeoutSeconds: [1, 600],
  maxToolCallsPerReview: [1, 100],
  maxOutputTokens: [1, 1e5],
  maxReviewsPerAdvisorPerSession: [1, 1e4]
});
var MODEL_INPUTS = /* @__PURE__ */ new Set(["text", "image"]);
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var CONFIG_KEYS = Object.freeze(["version", "providers", "advisors", "exclude", "limits"]);
var API_KEYS = Object.freeze(["kind", "provider", "apiKeyEnv"]);
var COMPAT_KEYS = Object.freeze(["kind", "provider", "apiKeyEnv", "baseUrl", "models"]);
var OAUTH_KEYS = Object.freeze(["kind", "provider"]);
var ADVISOR_KEYS = Object.freeze(["name", "provider", "model", "instructions"]);
var LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));
var MODEL_META_KEYS = Object.freeze([
  "contextWindow",
  "maxTokens",
  "reasoning",
  "input",
  "pricing"
]);
var PRICING_KEYS = Object.freeze(["prompt", "completion"]);
function fail(message) {
  const error = new Error(message);
  error.name = "ConfigError";
  throw error;
}
function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail(`${label} must be a plain object`);
  }
}
function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.includes(key)) {
      fail(`${label} has unknown key ${key}`);
    }
  }
}
function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value) || FORBIDDEN_KEYS.has(value)) {
    fail(`${label} is not a restricted identifier`);
  }
}
function assertInteger(value, label, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer from ${min} to ${max}`);
  }
}
function isLoopbackHost(host) {
  const hostname = String(host ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  const ipv4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (!ipv4) return false;
  return hostname.split(".").every((part) => {
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}
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
function assertModelMeta(value, label) {
  assertPlainObject(value, label);
  assertKnownKeys(value, MODEL_META_KEYS, label);
  for (const key of ["contextWindow", "maxTokens", "reasoning", "input"]) {
    if (!(key in value)) fail(`${label} is missing ${key}`);
  }
  assertInteger(value.contextWindow, `${label}.contextWindow`, 1, 1e7);
  assertInteger(value.maxTokens, `${label}.maxTokens`, 1, 1e7);
  if (typeof value.reasoning !== "boolean") fail(`${label}.reasoning must be a boolean`);
  if (!Array.isArray(value.input) || value.input.length === 0) {
    fail(`${label}.input must be a nonempty array`);
  }
  for (const item of value.input) {
    if (typeof item !== "string" || !MODEL_INPUTS.has(item)) {
      fail(`${label}.input values must be "text" or "image"`);
    }
  }
  const meta = {
    contextWindow: value.contextWindow,
    maxTokens: value.maxTokens,
    reasoning: value.reasoning,
    input: [...value.input]
  };
  if ("pricing" in value) {
    assertPlainObject(value.pricing, `${label}.pricing`);
    assertKnownKeys(value.pricing, PRICING_KEYS, `${label}.pricing`);
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
  return meta;
}
function assertProvider(value, id) {
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
      const models = {};
      for (const modelId of modelIds) {
        if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > 256 || FORBIDDEN_KEYS.has(modelId)) {
          fail(`providers.${id}.models has an invalid model id`);
        }
        models[modelId] = assertModelMeta(value.models[modelId], `providers.${id}.models.${modelId}`);
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
function assertExclude(value) {
  if (value === void 0) return [];
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
function assertLimits(value) {
  if (value === void 0) return { ...DEFAULT_LIMITS };
  assertPlainObject(value, "limits");
  assertKnownKeys(value, LIMIT_KEYS, "limits");
  const limits = { ...DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) {
    if (!(key in value)) continue;
    const [min, max] = LIMIT_BOUNDS[key];
    assertInteger(value[key], `limits.${key}`, min, max);
    limits[key] = value[key];
  }
  return limits;
}
function validateConfig(value) {
  assertPlainObject(value, "config");
  assertKnownKeys(value, CONFIG_KEYS, "config");
  if (value.version !== CONFIG_VERSION) fail("config.version must be 1");
  if (!("providers" in value) || !("advisors" in value)) {
    fail("config requires providers and advisors");
  }
  assertPlainObject(value.providers, "providers");
  const providerIds = Object.keys(value.providers);
  if (providerIds.length === 0) fail("providers must include at least one entry");
  const providers = {};
  for (const id of providerIds) {
    assertIdentifier(id, `providers key ${id}`);
    providers[id] = assertProvider(value.providers[id], id);
  }
  if (!Array.isArray(value.advisors) || value.advisors.length === 0) {
    fail("advisors must be a nonempty array");
  }
  if (value.advisors.length > 32) fail("too many advisors");
  const names = /* @__PURE__ */ new Set();
  const advisors = value.advisors.map((entry, index) => {
    const label = `advisors[${index}]`;
    assertPlainObject(entry, label);
    assertKnownKeys(entry, ADVISOR_KEYS, label);
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
    return {
      name: entry.name,
      provider: entry.provider,
      model: entry.model,
      instructions: entry.instructions
    };
  });
  return {
    version: CONFIG_VERSION,
    providers,
    advisors,
    exclude: assertExclude(value.exclude),
    limits: assertLimits(value.limits)
  };
}
function configFilePath(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, CONFIG_FILENAME);
}
async function loadConfig({ env = process.env, projectRoot: _projectRoot } = {}) {
  const file = configFilePath(env);
  let raw;
  try {
    raw = await fs.readFile(file, { encoding: "utf8", flag: "r" });
  } catch (error) {
    if (error && error.code === "ENOENT") fail(`missing config file ${CONFIG_FILENAME}`);
    fail("unable to read config file");
  }
  const text = raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("config file is not valid JSON");
  }
  return validateConfig(parsed);
}
async function validateRoot(rootPath, { follow = true } = {}) {
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
async function snapshotRoot(rootPath, options = {}) {
  const canonical = await validateRoot(rootPath, options);
  const listing = await fs.lstat(canonical);
  if (listing.isSymbolicLink() || !listing.isDirectory()) fail("project root is missing");
  return { path: canonical, dev: listing.dev, ino: listing.ino };
}
function versionAtLeast(version, minimum) {
  const parts = String(version).replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < minimum.length; i += 1) {
    const n = Number.isInteger(parts[i]) ? parts[i] : 0;
    if (n > minimum[i]) return true;
    if (n < minimum[i]) return false;
  }
  return true;
}
function runtimeErrors({ env: _env = process.env } = {}) {
  const errors = [];
  if (!versionAtLeast(process.versions.node, MIN_NODE)) {
    errors.push(`Node ${process.versions.node} is unsupported; need 22.19.0 or newer`);
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    errors.push(`OS ${process.platform} is unsupported; need macOS or Linux`);
  }
  return errors;
}
export {
  API_PROVIDERS,
  CONFIG_FILENAME,
  CONFIG_VERSION,
  DEFAULT_LIMITS,
  OAUTH_PROVIDERS,
  configFilePath,
  loadConfig,
  runtimeErrors,
  snapshotRoot,
  validateConfig,
  validateRoot
};
