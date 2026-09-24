import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/setup-store.mjs
import { createHash, randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  API_PROVIDERS,
  OAUTH_PROVIDERS,
  configFilePath,
  validateConfig
} from "./config.mjs";
import { FILE_MODE, MAX_STDIN_BYTES } from "./session/constants.mjs";
import { sanitizeText } from "./session/sanitize.mjs";
var USAGE = "usage: setup-control.mjs catalog|models <provider-id>|save";
var SAVE_KEYS = Object.freeze(["revision", "config"]);
var DEFAULT_MODEL_LIMIT = 20;
var MAX_MODEL_LIMIT = 40;
var MAX_QUERY_CHARS = 128;
var MAX_ERROR_CHARS = 500;
var SUGGESTED_API_KEY_ENV = Object.freeze({
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  zai: "ZAI_API_KEY",
  xai: "XAI_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "kimi-coding": "KIMI_API_KEY"
});
var COMPATIBLE_HINT = "openai-compatible has no offline SDK catalog. Reuse model metadata from the current config or collect contextWindow, maxTokens, reasoning, and input from the user. Optional paired thinkingFormat (openai|openrouter|zai) and thinkingLevelMap covering off/minimal/low/medium/high/xhigh/max; reasoning true alone is not tunable.";
var NOFOLLOW = fsSync.constants.O_NOFOLLOW || 0;
var O_CLOEXEC = fsSync.constants.O_CLOEXEC ?? 0;
var OPEN_WRITE = fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | NOFOLLOW | O_CLOEXEC;
var STATIC_ERRORS = Object.freeze({
  usage: USAGE,
  overflow: "Save input is too large.",
  input: "Save input is invalid.",
  revision: "Configuration revision does not match.",
  config: "Configuration is invalid.",
  symlink: "Configuration file must not be a symlink.",
  storage: "Configuration storage is unavailable.",
  busy: "Config save is locked. If an earlier save was interrupted, verify no setup save is running before removing cross-model-advisor.json.lock from the Claude config directory.",
  catalog: "Offline model catalog is unavailable. Rebuild or reinstall the plugin.",
  provider: "Unknown provider id."
});
var SetupError = class extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SetupError";
    this.code = code;
  }
};
function fail(code, message) {
  throw new SetupError(code, message);
}
async function defaultCreateBuiltinProvider(id) {
  const { createBuiltinProvider } = await import("./providers.mjs");
  return createBuiltinProvider(id);
}
async function defaultValidateReasoning(providerSlot, advisor, maxOutputTokens) {
  const { validateReasoning } = await import("./reasoning.mjs");
  return validateReasoning(providerSlot, advisor, maxOutputTokens);
}
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function isSupportedProviderId(id) {
  return API_PROVIDERS.includes(id) || OAUTH_PROVIDERS.includes(id);
}
function authKinds(id) {
  const auth = [];
  if (API_PROVIDERS.includes(id)) auth.push("api");
  if (OAUTH_PROVIDERS.includes(id)) auth.push("oauth");
  return auth;
}
function supportedProviderIds() {
  const ids = [];
  const seen = /* @__PURE__ */ new Set();
  for (const id of API_PROVIDERS) {
    seen.add(id);
    ids.push(id);
  }
  for (const id of OAUTH_PROVIDERS) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
function revisionOf(body) {
  return createHash("sha256").update(body).digest("hex");
}
function parseCount(raw, label) {
  if (typeof raw !== "string" || !/^[0-9]{1,10}$/.test(raw)) {
    fail("usage", `${label} must be a non-negative integer.`);
  }
  return Number(raw);
}
function parseSetupArgv(argv) {
  const command = argv[0];
  if (command === "catalog" || command === "save") {
    if (argv.length !== 1) fail("usage", USAGE);
    return { command };
  }
  if (command !== "models") fail("usage", USAGE);
  const providerId = argv[1];
  if (typeof providerId !== "string" || providerId.length === 0) fail("usage", USAGE);
  if (!isSupportedProviderId(providerId)) fail("provider", STATIC_ERRORS.provider);
  let q = null;
  let offset = 0;
  let limit = DEFAULT_MODEL_LIMIT;
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--q") {
      if (typeof value !== "string" || value.startsWith("--")) fail("usage", USAGE);
      if (value.length > MAX_QUERY_CHARS) fail("usage", "Search query is too long.");
      q = value;
      i += 1;
      continue;
    }
    if (flag === "--offset") {
      if (typeof value !== "string") fail("usage", USAGE);
      offset = parseCount(value, "offset");
      i += 1;
      continue;
    }
    if (flag === "--limit") {
      if (typeof value !== "string") fail("usage", USAGE);
      const parsed = parseCount(value, "limit");
      if (parsed < 1 || parsed > MAX_MODEL_LIMIT) {
        fail("usage", `limit must be an integer from 1 to ${MAX_MODEL_LIMIT}.`);
      }
      limit = parsed;
      i += 1;
      continue;
    }
    fail("usage", USAGE);
  }
  return { command: "models", providerId, q, offset, limit };
}
async function readBoundedStdin(stream, max = MAX_STDIN_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > max) fail("overflow", STATIC_ERRORS.overflow);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}
function refuseSymlink(st, label) {
  if (st?.isSymbolicLink()) fail("symlink", `${label} must not be a symlink.`);
}
function mapFsError(error) {
  if (error instanceof SetupError) return error;
  if (error && (error.code === "ELOOP" || error.code === "EMLINK")) {
    return new SetupError("symlink", STATIC_ERRORS.symlink);
  }
  return new SetupError("storage", STATIC_ERRORS.storage);
}
async function withSaveLock(file, fn) {
  const lockPath = `${file}.lock`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 448 });
    await fs.mkdir(lockPath, { mode: 448 });
  } catch (error) {
    if (error && error.code === "EEXIST") fail("busy", STATIC_ERRORS.busy);
    throw mapFsError(error);
  }
  try {
    return await fn(await readConfigStateFromPath(file));
  } finally {
    await fs.rmdir(lockPath).catch(() => {
    });
  }
}
function parseConfigText(raw) {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const stripped = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { config: null, configError: "Configuration file is not valid JSON." };
  }
  try {
    return { config: validateConfig(parsed), configError: null };
  } catch {
    return { config: null, configError: STATIC_ERRORS.config };
  }
}
async function readConfigStateFromPath(file) {
  const st = await lstatOrNull(file);
  if (!st) {
    return { path: file, revision: null, config: null, configError: null };
  }
  refuseSymlink(st, "Configuration file");
  if (!st.isFile()) fail("storage", "Configuration path is not a file.");
  if (st.size > MAX_STDIN_BYTES) fail("storage", "Configuration file is too large.");
  let handle;
  let raw;
  try {
    handle = await fs.open(file, fsSync.constants.O_RDONLY | NOFOLLOW | O_CLOEXEC);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_STDIN_BYTES) fail("storage", STATIC_ERRORS.storage);
    const buffer = Buffer.allocUnsafe(opened.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > opened.size) fail("storage", "Configuration changed while reading. Run catalog again.");
    raw = buffer.subarray(0, size);
  } catch (error) {
    throw mapFsError(error);
  } finally {
    await handle?.close();
  }
  const parsed = parseConfigText(raw);
  return {
    path: file,
    revision: revisionOf(raw),
    config: parsed.config,
    configError: parsed.configError
  };
}
async function readConfigState({ env = process.env } = {}) {
  return readConfigStateFromPath(configFilePath(env));
}
async function atomicWriteConfig(file, body) {
  const dir = path.dirname(file);
  const dest = await lstatOrNull(file);
  if (dest) {
    refuseSymlink(dest, "Configuration file");
    if (!dest.isFile()) fail("storage", "Configuration path is not a file.");
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmp, OPEN_WRITE, FILE_MODE);
    await handle.writeFile(body);
    await handle.chmod(FILE_MODE);
    await handle.close();
    handle = void 0;
    const latest = await lstatOrNull(file);
    if (latest) {
      refuseSymlink(latest, "Configuration file");
      if (!latest.isFile()) fail("storage", "Configuration path is not a file.");
    }
    await fs.rename(tmp, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => {
    });
    await fs.unlink(tmp).catch(() => {
    });
    throw mapFsError(error);
  }
}
function offlineCatalogModels(sdk) {
  if (!sdk || typeof sdk.getModels !== "function") fail("catalog", STATIC_ERRORS.catalog);
  const listed = sdk.getModels();
  if (!Array.isArray(listed)) fail("catalog", STATIC_ERRORS.catalog);
  return listed;
}
async function summarizeProvider(createProviderFn, id) {
  const summary = {
    id,
    name: id === "openai-compatible" ? "OpenAI-compatible" : id,
    auth: authKinds(id),
    modelCount: 0
  };
  if (summary.auth.includes("api") && SUGGESTED_API_KEY_ENV[id]) {
    summary.suggestedApiKeyEnv = SUGGESTED_API_KEY_ENV[id];
  }
  if (id === "openai-compatible") return summary;
  try {
    const sdk = await createProviderFn(id);
    if (sdk && typeof sdk.name === "string" && sdk.name) summary.name = sdk.name;
    summary.modelCount = offlineCatalogModels(sdk).length;
  } catch {
    fail("catalog", STATIC_ERRORS.catalog);
  }
  return summary;
}
async function getProviderCatalog(options = {}) {
  const createProviderFn = options.createBuiltinProvider ?? defaultCreateBuiltinProvider;
  return Promise.all(supportedProviderIds().map((id) => summarizeProvider(createProviderFn, id)));
}
function modelMatches(value, needle) {
  if (!needle) return true;
  const id = typeof value?.id === "string" ? value.id : "";
  const name = typeof value?.name === "string" ? value.name : "";
  return `${id}
${name}`.toLowerCase().includes(needle);
}
async function getModels(providerId, options = {}) {
  if (typeof providerId !== "string" || !isSupportedProviderId(providerId)) {
    fail("provider", STATIC_ERRORS.provider);
  }
  const q = options.q ?? null;
  if (q !== null && (typeof q !== "string" || q.length > MAX_QUERY_CHARS)) {
    fail("usage", "Search query is too long.");
  }
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_MODEL_LIMIT;
  if (!Number.isInteger(offset) || offset < 0) fail("usage", "offset must be a non-negative integer.");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MODEL_LIMIT) {
    fail("usage", `limit must be an integer from 1 to ${MAX_MODEL_LIMIT}.`);
  }
  const createBuiltinProvider = options.createBuiltinProvider ?? defaultCreateBuiltinProvider;
  if (providerId === "openai-compatible") {
    return {
      ok: true,
      provider: providerId,
      q,
      offset,
      limit,
      total: 0,
      models: [],
      hint: COMPATIBLE_HINT
    };
  }
  let sdk;
  try {
    sdk = await createBuiltinProvider(providerId);
  } catch {
    fail("catalog", STATIC_ERRORS.catalog);
  }
  const needle = typeof q === "string" && q.trim().length > 0 ? q.trim().toLowerCase() : "";
  const filtered = offlineCatalogModels(sdk).filter((entry) => modelMatches(entry, needle)).sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: true,
    provider: providerId,
    q,
    offset,
    limit,
    total: filtered.length,
    models: filtered.slice(offset, offset + limit).map(({ id, name }) => ({ id, name: name || id }))
  };
}
function parseSavePayload(raw) {
  const text = raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
  if (text.trim().length === 0) fail("input", "Save input is empty.");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("input", "Save input is not valid JSON.");
  }
  if (!isPlainObject(parsed)) fail("input", "Save input must be an object.");
  for (const key of Object.keys(parsed)) {
    if (!SAVE_KEYS.includes(key)) fail("input", "Save input has unknown keys.");
  }
  if (!("revision" in parsed) || !("config" in parsed)) {
    fail("input", "Save input requires revision and config.");
  }
  if (parsed.revision !== null && (typeof parsed.revision !== "string" || parsed.revision.length === 0 || parsed.revision.length > 128)) {
    fail("revision", "revision must be a catalog revision string or null.");
  }
  return { revision: parsed.revision, config: parsed.config };
}
function assertRevision(expected, provided) {
  if (expected === null) {
    if (provided !== null) {
      fail("revision", "revision must be null when no configuration file exists.");
    }
    return;
  }
  if (provided === null) {
    fail("revision", "revision is required because a configuration file already exists. Run catalog and retry.");
  }
  if (provided !== expected) {
    fail("revision", "Configuration changed since catalog. Run catalog again and retry save.");
  }
}
async function assertAdvisorReasoning(config, validateReasoningFn) {
  const maxOutputTokens = config.limits.maxOutputTokens;
  for (const advisor of config.advisors) {
    const providerSlot = config.providers[advisor.provider];
    let result;
    try {
      result = await validateReasoningFn(providerSlot, advisor, maxOutputTokens);
    } catch {
      fail("config", STATIC_ERRORS.config);
    }
    if (!result || result.ok !== true) {
      const message = typeof result?.error === "string" && result.error ? result.error : STATIC_ERRORS.config;
      fail("config", message);
    }
  }
}
async function saveConfig(payload, options = {}) {
  if (!isPlainObject(payload)) fail("input", "Save input must be an object.");
  const revision = payload.revision;
  if (revision !== null && (typeof revision !== "string" || revision.length === 0 || revision.length > 128)) {
    fail("revision", "revision must be a catalog revision string or null.");
  }
  if (!("config" in payload)) fail("input", "Save input requires revision and config.");
  let validated;
  try {
    validated = validateConfig(payload.config);
  } catch {
    fail("config", STATIC_ERRORS.config);
  }
  const validateReasoningFn = options.validateReasoning ?? defaultValidateReasoning;
  await assertAdvisorReasoning(validated, validateReasoningFn);
  const env = options.env ?? process.env;
  const file = configFilePath(env);
  return withSaveLock(file, async (state) => {
    assertRevision(state.revision, revision);
    const body = `${JSON.stringify(validated, null, 2)}
`;
    if (Buffer.byteLength(body) > MAX_STDIN_BYTES) fail("overflow", "Formatted configuration is too large.");
    await atomicWriteConfig(file, body);
    return {
      ok: true,
      path: file,
      revision: revisionOf(body)
    };
  });
}
function writeJson(stdout, value) {
  stdout.write(`${JSON.stringify(value)}
`);
}
async function runSetup(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const argv = options.argv ?? [];
  const createProviderFn = options.createBuiltinProvider ?? defaultCreateBuiltinProvider;
  const parsed = parseSetupArgv(argv);
  if (parsed.command === "catalog") {
    const state = await readConfigState({ env });
    writeJson(stdout, {
      ok: true,
      path: state.path,
      revision: state.revision,
      config: state.config,
      configError: state.configError,
      providers: await getProviderCatalog({ createBuiltinProvider: createProviderFn })
    });
    return 0;
  }
  if (parsed.command === "models") {
    writeJson(
      stdout,
      await getModels(parsed.providerId, {
        q: parsed.q,
        offset: parsed.offset,
        limit: parsed.limit,
        createBuiltinProvider: createProviderFn
      })
    );
    return 0;
  }
  const raw = await readBoundedStdin(options.stdin ?? process.stdin);
  const payload = parseSavePayload(raw);
  const saved = await saveConfig(payload, {
    env,
    validateReasoning: options.validateReasoning
  });
  writeJson(stdout, saved);
  return 0;
}
function writeFailure(stderr, error) {
  if (error instanceof SetupError) {
    const message = sanitizeText(error.message).slice(0, MAX_ERROR_CHARS);
    stderr.write(`${message || STATIC_ERRORS[error.code] || STATIC_ERRORS.storage}
`);
    return;
  }
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "ELOOP" || code === "EMLINK") {
    stderr.write(`${STATIC_ERRORS.symlink}
`);
    return;
  }
  stderr.write(`${STATIC_ERRORS.storage}
`);
}
async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    await runSetup({ argv, env });
  } catch (error) {
    writeFailure(process.stderr, error);
    process.exitCode = 1;
  }
}
export {
  DEFAULT_MODEL_LIMIT,
  MAX_MODEL_LIMIT,
  SetupError,
  getModels,
  getProviderCatalog,
  main,
  parseSetupArgv,
  readBoundedStdin,
  readConfigState,
  revisionOf,
  runSetup,
  saveConfig
};
