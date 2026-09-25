#!/usr/bin/env node
import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/control.mjs
import fs5 from "node:fs";
import path4 from "node:path";
import { fileURLToPath } from "node:url";

// ../../plugins/cross-model-advisor/src/config.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
var CONFIG_VERSION = 2;
var CONFIG_VERSION_V1 = 1;
var CONFIG_FILENAME = "cross-model-advisor.json";
var REASONING_EFFORTS = Object.freeze([
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
var THINKING_FORMATS = Object.freeze(["openai", "openrouter", "zai"]);
var THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
var NATIVE_LEVEL_MAX = 64;
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
var GATE_MODES = Object.freeze(["block", "report"]);
var DEFAULT_GATE = Object.freeze({ mode: "block", maxRounds: 2 });
var GATE_KEYS = Object.freeze(["mode", "maxRounds", "autoOn", "skipWhenOnly"]);
var MAX_GATE_LIST = 64;
var IDENTIFIER_RE = /^[a-z][a-z0-9-]{0,63}$/;
var ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var MIN_NODE = Object.freeze([22, 19, 0]);
var LIMIT_BOUNDS = Object.freeze({
  maxConcurrentAdvisors: [1, 16],
  // The Stop hook's own timeout is 300 seconds; reviews must finish inside it.
  reviewTimeoutSeconds: [1, 240],
  maxToolCallsPerReview: [1, 100],
  maxOutputTokens: [1, 1e5],
  maxReviewsPerAdvisorPerSession: [1, 1e4]
});
var MODEL_INPUTS = /* @__PURE__ */ new Set(["text", "image"]);
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var CONFIG_KEYS = Object.freeze(["version", "providers", "advisors", "exclude", "limits", "gate"]);
var API_KEYS = Object.freeze(["kind", "provider", "apiKeyEnv"]);
var COMPAT_KEYS = Object.freeze(["kind", "provider", "apiKeyEnv", "baseUrl", "models"]);
var OAUTH_KEYS = Object.freeze(["kind", "provider"]);
var ADVISOR_KEYS_V1 = Object.freeze(["name", "provider", "model", "instructions"]);
var ADVISOR_KEYS_V2 = Object.freeze([
  "name",
  "provider",
  "model",
  "instructions",
  "enabled",
  "reasoningEffort"
]);
var LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));
var MODEL_META_KEYS_V1 = Object.freeze([
  "contextWindow",
  "maxTokens",
  "reasoning",
  "input",
  "pricing"
]);
var MODEL_META_KEYS_V2 = Object.freeze([
  "contextWindow",
  "maxTokens",
  "reasoning",
  "input",
  "pricing",
  "thinkingFormat",
  "thinkingLevelMap",
  "supportsReasoningEffort"
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
function assertThinkingLevelMap(value, label) {
  assertPlainObject(value, label);
  assertKnownKeys(value, THINKING_LEVELS, label);
  const mapped = {};
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(value, level)) fail(`${label} is missing ${level}`);
    mapped[level] = assertNativeLevel(value[level], `${label}.${level}`);
  }
  return mapped;
}
function assertModelMeta(value, label, version) {
  assertPlainObject(value, label);
  assertKnownKeys(value, version === 2 ? MODEL_META_KEYS_V2 : MODEL_META_KEYS_V1, label);
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
function assertGate(value) {
  if (value === void 0) return { ...DEFAULT_GATE };
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
  if ("autoOn" in value) {
    gate.autoOn = assertStringList(value.autoOn, "gate.autoOn", (item) => {
      if (!path.isAbsolute(item)) fail("gate.autoOn entries must be absolute project paths");
    });
  }
  if ("skipWhenOnly" in value) {
    gate.skipWhenOnly = assertStringList(value.skipWhenOnly, "gate.skipWhenOnly", (item) => {
      if (item.trim().startsWith("!")) fail("gate.skipWhenOnly patterns cannot be negated");
    });
  }
  return gate;
}
function assertStringList(value, label, check) {
  if (!Array.isArray(value) || value.length > MAX_GATE_LIST) fail(`${label} must be a list of at most ${MAX_GATE_LIST} strings`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 1024 || item.includes("\0")) {
      fail(`${label} entries must be non-empty strings`);
    }
    check(item);
    return item;
  });
}
function validateConfig(value) {
  assertPlainObject(value, "config");
  assertKnownKeys(value, CONFIG_KEYS, "config");
  if (value.version !== CONFIG_VERSION_V1 && value.version !== CONFIG_VERSION) {
    fail("config.version must be 1 or 2");
  }
  const version = value.version;
  if (!("providers" in value) || !("advisors" in value)) {
    fail("config requires providers and advisors");
  }
  assertPlainObject(value.providers, "providers");
  const providerIds = Object.keys(value.providers);
  if (version === CONFIG_VERSION_V1 && providerIds.length === 0) {
    fail("providers must include at least one entry");
  }
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
  const names = /* @__PURE__ */ new Set();
  const advisors = value.advisors.map(
    (entry, index) => assertAdvisor(entry, index, providers, version, names)
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

// ../../plugins/cross-model-advisor/src/snapshot.mjs
import { execFile } from "node:child_process";
import fs2 from "node:fs/promises";
import path2 from "node:path";
var GIT_TIMEOUT_MS = 2e4;
var MAX_GIT_OUTPUT = 32 * 1024 * 1024;
var MAX_FILE_DIFF_CHARS = 16 * 1024;
var MAX_TOTAL_DIFF_CHARS = 60 * 1024;
var SnapshotError = class extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
};
function gitEnv(env, extra = {}) {
  const out = { ...env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX"]) {
    delete out[name];
  }
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_OPTIONAL_LOCKS = "0";
  return { ...out, ...extra };
}
function git(cwd, args, { env = process.env, extraEnv, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      {
        cwd,
        env: gitEnv(env, extraEnv),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT,
        encoding: "utf8",
        signal
      },
      (error, stdout) => {
        if (error) {
          reject(new SnapshotError("git", `git ${args[0]} failed`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}
async function gitTopLevel(dir, { env = process.env } = {}) {
  try {
    const out = (await git(dir, ["rev-parse", "--show-toplevel"], { env })).trim();
    return out ? await fs2.realpath(out) : null;
  } catch {
    return null;
  }
}
async function snapshotTree(root, scratchDir, { env = process.env, signal } = {}) {
  const tmpIndex = path2.join(scratchDir, `index.${process.pid}.${Date.now()}`);
  try {
    const realIndex = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"], { env })).trim();
    try {
      await fs2.copyFile(realIndex, tmpIndex);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new SnapshotError("git", "unable to copy the index");
    }
    const extraEnv = { GIT_INDEX_FILE: tmpIndex };
    await git(root, ["add", "--all", "--", "."], { env, extraEnv, signal });
    const tree = (await git(root, ["write-tree"], { env, extraEnv, signal })).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new SnapshotError("git", "write-tree returned no tree");
    return tree;
  } finally {
    await fs2.rm(tmpIndex, { force: true }).catch(() => {
    });
    await fs2.rm(`${tmpIndex}.lock`, { force: true }).catch(() => {
    });
  }
}

// ../../plugins/cross-model-advisor/src/session/constants.mjs
var CONTROL_COMMANDS = Object.freeze([
  "cross-model-advisor:on",
  "cross-model-advisor:off",
  "cross-model-advisor:status",
  "cross-model-advisor:doctor",
  "cross-model-advisor:setup",
  "cross-model-advisor:login",
  "cross-model-advisor:logout"
]);
var SEVERITY_ORDER = Object.freeze({ blocker: 0, concern: 1, nit: 2 });
var USER_TEXT_CAP = 8 * 1024;
var MAX_STDIN_BYTES = 1048576;
var SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var ERROR_LOG_MAX_BYTES = 64 * 1024;
var DIR_MODE = 448;
var FILE_MODE = 384;
var STATE_VERSION = 2;

// ../../plugins/cross-model-advisor/src/session/classifier.mjs
var CONTROL_SET = new Set(CONTROL_COMMANDS);
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

// ../../plugins/cross-model-advisor/src/session/paths.mjs
import fs3 from "node:fs/promises";
import os2 from "node:os";
import path3 from "node:path";
var SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
function validateSessionId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!SESSION_ID_RE.test(id)) {
    throw new Error("invalid session id");
  }
  return id;
}
function explicitPluginData(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.includes("${") || !path3.isAbsolute(text)) {
    throw new Error("invalid --plugin-data");
  }
  return path3.resolve(text);
}
function sessionDir(pluginData, sessionId) {
  return path3.join(pluginData, "sessions", validateSessionId(sessionId));
}
var statePath = (dir) => path3.join(dir, "state.json");
async function ensurePrivateDir(dir) {
  await fs3.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs3.chmod(dir, DIR_MODE).catch(() => {
  });
}
async function atomicWriteFile(file, body) {
  const dir = path3.dirname(file);
  await ensurePrivateDir(dir);
  const tmp = path3.join(dir, `.${path3.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const data = typeof body === "string" ? body : body;
  await fs3.writeFile(tmp, data, { mode: FILE_MODE, flag: "wx" });
  await fs3.chmod(tmp, FILE_MODE).catch(() => {
  });
  await fs3.rename(tmp, file);
}
async function atomicWriteJson(file, value) {
  await atomicWriteFile(file, `${JSON.stringify(value)}
`);
}
function readIdentity(env = process.env, payload = {}) {
  const sessionId = env.CLAUDE_CODE_SESSION_ID?.trim() || env.CLAUDE_SESSION_ID?.trim() || (typeof payload.session_id === "string" ? payload.session_id.trim() : "");
  const projectRoot = env.CLAUDE_PROJECT_DIR?.trim() || "";
  const pluginData = env.CLAUDE_PLUGIN_DATA?.trim() || "";
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT?.trim() || "";
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path3.join(os2.homedir(), ".claude");
  return { sessionId, projectRoot, pluginData, pluginRoot, configDir };
}

// ../../plugins/cross-model-advisor/src/session/sanitize.mjs
var CREDENTIAL_ASSIGNMENT = /\b(?:api[_-]?key|token|password|secret|authorization|bearer)\b\s*[:=]\s*([^\s,;]+)/gi;
var ENV_CREDENTIAL_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*[:=]\s*["']?)([^\s"'`,;=][^\s"'`,;]*)/g;
var ENV_CREDENTIAL_NAME_END = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|SECRET_KEY|CREDENTIALS?)$/;
var KNOWN_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g;
var CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
function redactCredentials(text) {
  return text.replace(KNOWN_TOKEN, "[redacted]").replace(CREDENTIAL_ASSIGNMENT, (match, value) => match.replace(value, "[redacted]")).replace(
    ENV_CREDENTIAL_ASSIGNMENT,
    (match, name, sep, value) => ENV_CREDENTIAL_NAME_END.test(name) || value.length >= 8 && /[A-Za-z]/.test(value) ? `${name}${sep}[redacted]` : match
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

// ../../plugins/cross-model-advisor/src/session/state.mjs
import fs4 from "node:fs/promises";
var MAX_REVIEWED = 64;
function emptyState(overrides = {}) {
  return {
    version: STATE_VERSION,
    enabled: false,
    projectRoot: null,
    /** @type {Turn | null} */
    turn: null,
    rounds: { promptId: null, count: 0 },
    /** @type {string[]} base..head pairs already reviewed */
    reviewed: [],
    /** @type {LastReview | null} the last review that ran */
    last: null,
    /** @type {LastReview | null} the last Stop that did not review, and why */
    lastSkip: null,
    /** @type {Record<string, { reviews: number, usage: object | null, lastError: string | null }>} */
    advisors: {},
    ...overrides
  };
}
async function loadState(dir) {
  let raw;
  try {
    raw = await fs4.readFile(statePath(dir), "utf8");
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_VERSION) return emptyState();
    return emptyState(parsed);
  } catch {
    return emptyState();
  }
}
async function saveState(dir, state) {
  const reviewed = Array.isArray(state.reviewed) ? state.reviewed.slice(-MAX_REVIEWED) : [];
  await atomicWriteJson(statePath(dir), { ...state, reviewed });
}

// ../../plugins/cross-model-advisor/src/control.mjs
var USAGE = "usage: control.mjs hook | session-start | off|status --plugin-data <path>";
function sessionFrom(env, payload = {}) {
  const identity = readIdentity(env, payload);
  if (typeof payload.session_id === "string" && identity.sessionId && payload.session_id !== identity.sessionId) {
    throw new Error("hook session id does not match the Claude session environment");
  }
  if (!identity.sessionId || !identity.pluginData) throw new Error("missing session identity");
  const sessionId = validateSessionId(identity.sessionId);
  return { ...identity, sessionId, dir: sessionDir(identity.pluginData, sessionId) };
}
async function recordPrompt(payload, { env = process.env, snapshot = snapshotTree, now = Date.now } = {}) {
  if (!payload || typeof payload !== "object" || payload.agent_id) return;
  const session = sessionFrom(env, payload);
  const state = await loadState(session.dir);
  if (!state.enabled || !state.projectRoot) return;
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (classifyPrompt(prompt).kind === "control") {
    state.turn = null;
    await saveState(session.dir, state);
    return;
  }
  const turn = {
    promptId: typeof payload.prompt_id === "string" ? payload.prompt_id : null,
    baseTree: (
      /** @type {string | null} */
      null
    ),
    request: truncateLabeled(sanitizeText(prompt), USER_TEXT_CAP),
    at: now()
  };
  try {
    turn.baseTree = await snapshot(state.projectRoot, session.dir, { env });
  } catch (error) {
    turn.error = error instanceof Error ? error.message : "snapshot failed";
  }
  state.turn = turn;
  await saveState(session.dir, state);
}
async function runOff(env) {
  const session = sessionFrom(env);
  await ensurePrivateDir(session.dir);
  const state = await loadState(session.dir);
  state.enabled = false;
  state.optedOut = true;
  state.turn = null;
  await saveState(session.dir, state);
  return { ok: true, enabled: false };
}
async function runSessionStart(payload, { env = process.env } = {}) {
  if (!payload || typeof payload !== "object" || payload.agent_id) return "";
  const session = sessionFrom(env, payload);
  const state = await loadState(session.dir);
  if (state.enabled || state.optedOut) return "";
  const config = await loadConfig({ env });
  const listed = config.gate.autoOn ?? [];
  if (listed.length === 0) return "";
  const start = env.CLAUDE_PROJECT_DIR?.trim() || (typeof payload.cwd === "string" ? payload.cwd : "");
  const top = start ? await gitTopLevel(start, { env }) : null;
  if (!top) return "";
  const projectRoot = await validateRoot(top);
  let match = false;
  for (const entry of listed) {
    const resolved = await fs5.promises.realpath(entry).catch(() => null);
    if (resolved === projectRoot) match = true;
  }
  if (!match) return "";
  await ensurePrivateDir(session.dir);
  state.enabled = true;
  state.projectRoot = projectRoot;
  state.turn = null;
  state.rounds = { promptId: null, count: 0 };
  await saveState(session.dir, state);
  const notice = `cross-model-advisor: review gate on for ${projectRoot} (gate.autoOn). Changed turns go to your configured advisors; /cross-model-advisor:off stops it for this session.`;
  return `${JSON.stringify({ systemMessage: notice })}
`;
}
async function runStatus(env) {
  const session = sessionFrom(env);
  const state = await loadState(session.dir);
  return {
    ok: true,
    enabled: state.enabled,
    projectRoot: state.projectRoot,
    lastReview: state.last,
    lastSkip: state.lastSkip,
    advisors: state.advisors
  };
}
async function readStdin(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) throw new Error("stdin too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const op = argv[0];
  if (op === "hook" && argv.length === 1) {
    try {
      const raw = await readStdin(process.stdin);
      if (raw.trim()) await recordPrompt(JSON.parse(raw), { env });
    } catch {
    }
    process.exitCode = 0;
    return;
  }
  if (op === "session-start" && argv.length === 1) {
    try {
      const raw = await readStdin(process.stdin);
      const out = raw.trim() ? await runSessionStart(JSON.parse(raw), { env }) : "";
      if (out) process.stdout.write(out);
    } catch {
    }
    process.exitCode = 0;
    return;
  }
  if ((op === "off" || op === "status") && argv.length === 3 && argv[1] === "--plugin-data") {
    let scoped;
    try {
      scoped = { ...env, CLAUDE_PLUGIN_DATA: explicitPluginData(argv[2]) };
    } catch {
      process.stderr.write("cross-model-advisor: identity: invalid --plugin-data; run this through the plugin's skill\n");
      process.exitCode = 1;
      return;
    }
    try {
      const result = op === "off" ? await runOff(scoped) : await runStatus(scoped);
      process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
    } catch (error) {
      const message = sanitizeText(error instanceof Error ? error.message : "command failed");
      process.stdout.write(`${JSON.stringify({ ok: false, error: "identity", message }, null, 2)}
`);
    }
    return;
  }
  process.stderr.write(`${USAGE}
`);
  process.exitCode = 1;
}
var realPath = (value) => {
  try {
    return fs5.realpathSync(value);
  } catch {
    return path4.resolve(value);
  }
};
var invokedDirectly = process.argv[1] && path4.basename(fileURLToPath(import.meta.url)) === "control.mjs" && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
export {
  main,
  recordPrompt,
  runOff,
  runSessionStart,
  runStatus
};
