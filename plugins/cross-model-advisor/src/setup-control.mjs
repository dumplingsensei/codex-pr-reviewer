#!/usr/bin/env node
/**
 * Offline setup helper. Catalogs supported providers, lists one provider's
 * SDK models with bounded pagination, and atomically saves a full validated
 * config. No login, no network, no credential reads, no session activation.
 */

import { createHash, randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_PROVIDERS,
  OAUTH_PROVIDERS,
  configFilePath,
  validateConfig
} from "./config.mjs";
import { FILE_MODE, MAX_STDIN_BYTES } from "./session/constants.mjs";
import { sanitizeText } from "./session/sanitize.mjs";

const USAGE = "usage: setup-control.mjs catalog|models <provider-id>|save";
const SAVE_KEYS = Object.freeze(["revision", "config"]);
const DEFAULT_MODEL_LIMIT = 20;
const MAX_MODEL_LIMIT = 40;
const MAX_QUERY_CHARS = 128;
const MAX_ERROR_CHARS = 500;
const SUGGESTED_API_KEY_ENV = Object.freeze({
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  zai: "ZAI_API_KEY",
  xai: "XAI_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "kimi-coding": "KIMI_API_KEY"
});
const COMPATIBLE_HINT =
  "openai-compatible has no offline SDK catalog. Reuse model metadata from the current config or collect contextWindow, maxTokens, reasoning, and input from the user.";

const NOFOLLOW = fsSync.constants.O_NOFOLLOW || 0;
const O_CLOEXEC = fsSync.constants.O_CLOEXEC ?? 0;
const OPEN_WRITE =
  fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | NOFOLLOW | O_CLOEXEC;

const STATIC_ERRORS = Object.freeze({
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

export class SetupError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SetupError";
    this.code = code;
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  throw new SetupError(code, message);
}

async function defaultCreateBuiltinProvider(id) {
  const { createBuiltinProvider } = await import("./providers.mjs");
  return createBuiltinProvider(id);
}

/**
 * @param {string} value
 */
function resolvedPath(value) {
  try {
    return fsSync.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {string} id
 */
function isSupportedProviderId(id) {
  return API_PROVIDERS.includes(id) || OAUTH_PROVIDERS.includes(id);
}

/**
 * @param {string} id
 * @returns {("api" | "oauth")[]}
 */
function authKinds(id) {
  /** @type {("api" | "oauth")[]} */
  const auth = [];
  if (API_PROVIDERS.includes(id)) auth.push("api");
  if (OAUTH_PROVIDERS.includes(id)) auth.push("oauth");
  return auth;
}

/**
 * @returns {string[]}
 */
function supportedProviderIds() {
  const ids = [];
  const seen = new Set();
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

/**
 * @param {Buffer | string} body
 */
export function revisionOf(body) {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * @param {string} raw
 * @param {string} label
 */
function parseCount(raw, label) {
  if (typeof raw !== "string" || !/^[0-9]{1,10}$/.test(raw)) {
    fail("usage", `${label} must be a non-negative integer.`);
  }
  return Number(raw);
}

/**
 * @param {string[]} argv
 */
export function parseSetupArgv(argv) {
  const command = argv[0];
  if (command === "catalog" || command === "save") {
    if (argv.length !== 1) fail("usage", USAGE);
    return { command };
  }
  if (command !== "models") fail("usage", USAGE);
  const providerId = argv[1];
  if (typeof providerId !== "string" || providerId.length === 0) fail("usage", USAGE);
  if (!isSupportedProviderId(providerId)) fail("provider", STATIC_ERRORS.provider);
  /** @type {string | null} */
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

/**
 * @param {NodeJS.ReadableStream} stream
 * @param {number} [max]
 */
export async function readBoundedStdin(stream, max = MAX_STDIN_BYTES) {
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

/**
 * @param {string} file
 */
async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * @param {import("node:fs").Stats | null | undefined} st
 * @param {string} label
 */
function refuseSymlink(st, label) {
  if (st?.isSymbolicLink()) fail("symlink", `${label} must not be a symlink.`);
}

/**
 * @param {unknown} error
 */
function mapFsError(error) {
  if (error instanceof SetupError) return error;
  if (error && (error.code === "ELOOP" || error.code === "EMLINK")) {
    return new SetupError("symlink", STATIC_ERRORS.symlink);
  }
  return new SetupError("storage", STATIC_ERRORS.storage);
}

/**
 * @param {string} file
 * @param {(current: Awaited<ReturnType<typeof readConfigState>>) => Promise<unknown>} fn
 */
async function withSaveLock(file, fn) {
  const lockPath = `${file}.lock`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error && error.code === "EEXIST") fail("busy", STATIC_ERRORS.busy);
    throw mapFsError(error);
  }
  try {
    return await fn(await readConfigStateFromPath(file));
  } finally {
    await fs.rmdir(lockPath).catch(() => {});
  }
}

/**
 * @param {Buffer | string} raw
 */
function parseConfigText(raw) {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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

/**
 * @param {string} file
 */
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

/**
 * @param {NodeJS.ProcessEnv} env
 */
async function readConfigState(env) {
  return readConfigStateFromPath(configFilePath(env));
}

/**
 * @param {string} file
 * @param {string} body
 */
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
    handle = undefined;
    const latest = await lstatOrNull(file);
    if (latest) {
      refuseSymlink(latest, "Configuration file");
      if (!latest.isFile()) fail("storage", "Configuration path is not a file.");
    }
    await fs.rename(tmp, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw mapFsError(error);
  }
}


/**
 * Offline SDK catalog used by backend activation: `createBuiltinProvider`
 * then `getModels()`. Never refreshModels, getAvailable, or credentials.
 * @param {object | undefined} sdk
 */
function offlineCatalogModels(sdk) {
  if (!sdk || typeof sdk.getModels !== "function") fail("catalog", STATIC_ERRORS.catalog);
  const listed = sdk.getModels();
  if (!Array.isArray(listed)) fail("catalog", STATIC_ERRORS.catalog);
  return listed;
}

/**
 * @param {(id: string) => object} createProviderFn
 * @param {string} id
 */
async function summarizeProvider(createProviderFn, id) {
  /** @type {{ id: string, name: string, auth: ("api"|"oauth")[], suggestedApiKeyEnv?: string, modelCount: number }} */
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

/**
 * @param {unknown} value
 * @param {string} needle
 */
function modelMatches(value, needle) {
  if (!needle) return true;
  const id = typeof value?.id === "string" ? value.id : "";
  const name = typeof value?.name === "string" ? value.name : "";
  return `${id}\n${name}`.toLowerCase().includes(needle);
}

/**
 * @param {{
 *   providerId: string,
 *   q: string | null,
 *   offset: number,
 *   limit: number,
 *   createBuiltinProvider: (id: string) => object
 * }} options
 */
async function listModels(options) {
  const { providerId, q, offset, limit, createBuiltinProvider } = options;
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
  const filtered = offlineCatalogModels(sdk)
    .filter((entry) => modelMatches(entry, needle))
    .sort((a, b) => a.id.localeCompare(b.id));
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

/**
 * @param {string} raw
 */
function parseSavePayload(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
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
  let config;
  try {
    config = validateConfig(parsed.config);
  } catch {
    fail("config", STATIC_ERRORS.config);
  }
  return { revision: parsed.revision, config };
}

/**
 * @param {string | null} expected
 * @param {string | null} provided
 */
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

/**
 * @param {NodeJS.WritableStream} stdout
 * @param {unknown} value
 */
function writeJson(stdout, value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   stdin?: NodeJS.ReadableStream,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream,
 *   createBuiltinProvider?: typeof defaultCreateBuiltinProvider
 * }} [options]
 */
export async function runSetup(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const argv = options.argv ?? [];
  const createProviderFn = options.createBuiltinProvider ?? defaultCreateBuiltinProvider;
  const parsed = parseSetupArgv(argv);

  if (parsed.command === "catalog") {
    const state = await readConfigState(env);
    writeJson(stdout, {
      ok: true,
      path: state.path,
      revision: state.revision,
      config: state.config,
      configError: state.configError,
      providers: await Promise.all(supportedProviderIds().map((id) => summarizeProvider(createProviderFn, id)))
    });
    return 0;
  }

  if (parsed.command === "models") {
    writeJson(
      stdout,
      await listModels({
        providerId: parsed.providerId,
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
  const file = configFilePath(env);
  const saved = await withSaveLock(file, async (state) => {
    assertRevision(state.revision, payload.revision);
    const body = `${JSON.stringify(payload.config, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_STDIN_BYTES) fail("overflow", "Formatted configuration is too large.");
    await atomicWriteConfig(file, body);
    return {
      ok: true,
      path: file,
      revision: revisionOf(body)
    };
  });
  writeJson(stdout, saved);
  return 0;
}

/**
 * @param {NodeJS.WritableStream} stderr
 * @param {unknown} error
 */
function writeFailure(stderr, error) {
  if (error instanceof SetupError) {
    const message = sanitizeText(error.message).slice(0, MAX_ERROR_CHARS);
    stderr.write(`${message || STATIC_ERRORS[error.code] || STATIC_ERRORS.storage}\n`);
    return;
  }
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "ELOOP" || code === "EMLINK") {
    stderr.write(`${STATIC_ERRORS.symlink}\n`);
    return;
  }
  stderr.write(`${STATIC_ERRORS.storage}\n`);
}

/**
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    await runSetup({ argv, env });
  } catch (error) {
    writeFailure(process.stderr, error);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] && resolvedPath(process.argv[1]) === resolvedPath(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

export { DEFAULT_MODEL_LIMIT, MAX_MODEL_LIMIT };
