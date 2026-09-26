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
var USAGE = "usage: setup-control.mjs catalog|summary|providers|models <provider-id>|efforts <provider-id> <api|oauth> <model>|save|apply [--dry-run]";
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
  if (command === "catalog" || command === "save" || command === "summary" || command === "providers") {
    if (argv.length !== 1) fail("usage", USAGE);
    return { command };
  }
  if (command === "apply") {
    if (argv.length === 1) return { command, dryRun: false };
    if (argv.length === 2 && argv[1] === "--dry-run") return { command, dryRun: true };
    fail("usage", USAGE);
  }
  if (command === "efforts") {
    const [, providerId2, kind, model] = argv;
    if (argv.length !== 4 || !isSupportedProviderId(providerId2 ?? "") || kind !== "api" && kind !== "oauth") {
      fail("usage", USAGE);
    }
    if (typeof model !== "string" || model.length === 0 || model.length > MAX_QUERY_CHARS) fail("usage", USAGE);
    return { command, providerId: providerId2, kind, model };
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
var ROLE_PRESETS = Object.freeze([
  Object.freeze({
    role: "correctness",
    instructions: "Look for observable correctness failures and missed edge cases."
  }),
  Object.freeze({
    role: "security",
    instructions: "Focus only on security and trust boundaries; another advisor covers general correctness. Treat anything from outside the user's control as hostile: repository and pull request contents (including .gitattributes and config files), model output, environment variables, and network responses. Look for untrusted data reaching a shell, subprocess, git command, file path, or model prompt; secrets or credentials leaving the machine or landing in logs, errors, or loosely permissioned files; checks that run after the risky step or can be raced; and failure paths that fail open where they should fail closed. Report only what a concrete input could exploit, not hardening wishes or style."
  }),
  Object.freeze({
    role: "tests-and-claims",
    instructions: "Focus on whether the change is proven, not on finding new bugs. Check that each behavior change has a test that would fail without it, that tests cover the edge the change is about, and that claims in Claude's final message (tests added, cases handled, versions bumped) match the diff. A test that passes whether or not the fix is present is a concern."
  })
]);
var APPLY_KEYS = Object.freeze(["revision", "change"]);
var ADVISOR_SET_KEYS = Object.freeze(["model", "reasoningEffort", "instructions", "enabled"]);
var GATE_SET_KEYS = Object.freeze(["mode", "maxRounds", "autoOn", "skipWhenOnly"]);
var TERMINAL_ONLY = "Custom OpenAI-compatible endpoints are set up in the terminal menu, where the URL and model metadata are entered.";
var SHORT_REVISION = 16;
function summarizeSetup(state) {
  const config = state.config;
  const roleOf = (text) => ROLE_PRESETS.find((preset) => preset.instructions === text)?.role;
  return {
    ok: true,
    revision: state.revision ? state.revision.slice(0, SHORT_REVISION) : null,
    ...state.configError ? { configError: state.configError } : {},
    advisors: (config?.advisors ?? []).map((advisor) => {
      const role = roleOf(advisor.instructions);
      return {
        name: advisor.name,
        slot: advisor.provider,
        model: advisor.model,
        effort: advisor.reasoningEffort,
        on: advisor.enabled !== false,
        ...role ? { role } : { instructions: advisor.instructions.length > 60 ? `${advisor.instructions.slice(0, 57)}...` : advisor.instructions }
      };
    }),
    slots: config ? Object.entries(config.providers).map(([slot, entry]) => ({
      slot,
      provider: entry.provider,
      kind: entry.kind,
      ...entry.apiKeyEnv ? { env: entry.apiKeyEnv } : {}
    })) : [],
    gate: config?.gate ?? { mode: "block", maxRounds: 2 }
  };
}
function parseApplyPayload(raw) {
  const text = raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("input", "Apply input is not valid JSON.");
  }
  if (!isPlainObject(parsed) || Object.keys(parsed).some((key) => !APPLY_KEYS.includes(key))) {
    fail("input", "Apply input must be { revision, change }.");
  }
  if (!("revision" in parsed) || !isPlainObject(parsed.change)) fail("input", "Apply input must be { revision, change }.");
  return { revision: parsed.revision, change: parsed.change };
}
function assertOnlyKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail("input", `${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("input", `${label} has an unknown key: ${sanitizeText(key).slice(0, 64)}.`);
  }
}
function resolvePreset(fields) {
  if (!("instructionsPreset" in fields)) return;
  if ("instructions" in fields) fail("input", "Give instructions or instructionsPreset, not both.");
  const preset = ROLE_PRESETS.find((entry) => entry.role === fields.instructionsPreset);
  if (!preset) fail("input", `instructionsPreset must be one of ${ROLE_PRESETS.map((entry) => entry.role).join(", ")}.`);
  fields.instructions = preset.instructions;
  delete fields.instructionsPreset;
}
function withChange(config, change) {
  const next = config ? structuredClone(config) : { version: 2, providers: {}, advisors: [], exclude: [], limits: {} };
  next.version = 2;
  const advisorNamed = (name) => next.advisors.find((advisor) => advisor.name === name);
  switch (change.op) {
    case "add-advisor": {
      assertOnlyKeys(change, ["op", "advisor", "slot"], "add-advisor");
      assertOnlyKeys(change.advisor, ["name", "provider", "model", "instructions", "instructionsPreset", "reasoningEffort", "enabled"], "advisor");
      resolvePreset(change.advisor);
      if (advisorNamed(change.advisor.name)) fail("config", `An advisor named ${sanitizeText(String(change.advisor.name))} already exists.`);
      if (change.slot !== void 0) {
        assertOnlyKeys(change.slot, ["id", "kind", "provider", "apiKeyEnv"], "slot");
        if (change.slot.provider === "openai-compatible") fail("config", TERMINAL_ONLY);
        if (Object.hasOwn(next.providers, change.slot.id)) fail("config", `Provider slot ${sanitizeText(String(change.slot.id))} already exists; use it instead.`);
        if (change.advisor.provider !== change.slot.id) fail("input", "advisor.provider must name the new slot.");
        const { id, ...entry } = change.slot;
        next.providers[id] = entry;
      }
      next.advisors.push({ enabled: true, reasoningEffort: "default", ...change.advisor });
      break;
    }
    case "update-advisor": {
      assertOnlyKeys(change, ["op", "name", "set"], "update-advisor");
      assertOnlyKeys(change.set, [...ADVISOR_SET_KEYS, "instructionsPreset"], "set");
      resolvePreset(change.set);
      const advisor = advisorNamed(change.name);
      if (!advisor) fail("config", `No advisor named ${sanitizeText(String(change.name))}.`);
      Object.assign(advisor, change.set);
      break;
    }
    case "remove-advisor": {
      assertOnlyKeys(change, ["op", "name"], "remove-advisor");
      if (!advisorNamed(change.name)) fail("config", `No advisor named ${sanitizeText(String(change.name))}.`);
      next.advisors = next.advisors.filter((advisor) => advisor.name !== change.name);
      break;
    }
    case "set-gate": {
      assertOnlyKeys(change, ["op", "gate"], "set-gate");
      assertOnlyKeys(change.gate, GATE_SET_KEYS, "gate");
      next.gate = { ...next.gate ?? { mode: "block", maxRounds: 2 }, ...change.gate };
      for (const key of ["autoOn", "skipWhenOnly"]) {
        if (next.gate[key] === null || Array.isArray(next.gate[key]) && next.gate[key].length === 0) delete next.gate[key];
      }
      break;
    }
    default:
      fail("input", "change.op must be add-advisor, update-advisor, remove-advisor, or set-gate.");
  }
  return next;
}
function describeChange(before, after) {
  const lines = [];
  const show = (value) => JSON.stringify(value);
  for (const [slot, entry] of Object.entries(after.providers)) {
    if (!before?.providers?.[slot]) {
      lines.push(`add provider slot ${slot}: ${entry.provider} (${entry.kind}${entry.apiKeyEnv ? `, key from $${entry.apiKeyEnv}` : ""})`);
    }
  }
  const was = new Map((before?.advisors ?? []).map((advisor) => [advisor.name, advisor]));
  for (const advisor of after.advisors) {
    const old = was.get(advisor.name);
    if (!old) {
      lines.push(`add advisor ${advisor.name}: ${advisor.provider} · ${advisor.model} · effort ${advisor.reasoningEffort}${advisor.enabled ? "" : " · disabled"}`);
      lines.push(`  instructions: ${show(advisor.instructions)}`);
      continue;
    }
    for (const key of ADVISOR_SET_KEYS) {
      if (JSON.stringify(old[key]) !== JSON.stringify(advisor[key])) {
        lines.push(`advisor ${advisor.name}: ${key} ${show(old[key])} → ${show(advisor[key])}`);
      }
    }
    was.delete(advisor.name);
  }
  for (const name of was.keys()) lines.push(`remove advisor ${name}`);
  const gateBefore = before?.gate ?? { mode: "block", maxRounds: 2 };
  for (const key of GATE_SET_KEYS) {
    if (JSON.stringify(gateBefore[key]) !== JSON.stringify(after.gate?.[key])) {
      lines.push(`gate.${key}: ${show(gateBefore[key] ?? null)} → ${show(after.gate?.[key] ?? null)}`);
    }
  }
  return lines;
}
async function applyChange(payload, options = {}) {
  const env = options.env ?? process.env;
  const state = await readConfigState({ env });
  if (state.configError) fail("config", `${state.configError} Fix it in the terminal menu first.`);
  const matches = payload.revision === state.revision || typeof payload.revision === "string" && typeof state.revision === "string" && payload.revision.length >= SHORT_REVISION && state.revision.startsWith(payload.revision);
  if (!matches) fail("revision", "The configuration changed since summary. Run summary again and retry.");
  const next = withChange(state.config, payload.change);
  let validated;
  try {
    validated = validateConfig(next);
  } catch (error) {
    fail("config", sanitizeText(error instanceof Error ? error.message : "invalid configuration"));
  }
  const createProviderFn = options.createBuiltinProvider ?? defaultCreateBuiltinProvider;
  const before = new Map((state.config?.advisors ?? []).map((advisor) => [advisor.name, advisor]));
  const selected = validated.advisors.filter(
    (advisor) => before.get(advisor.name)?.model !== advisor.model || before.get(advisor.name)?.provider !== advisor.provider
  );
  for (const advisor of selected) {
    const slot = validated.providers[advisor.provider];
    if (!slot || slot.provider === "openai-compatible") continue;
    let known = false;
    try {
      known = offlineCatalogModels(await createProviderFn(slot.provider)).some((model) => model.id === advisor.model);
    } catch {
      fail("catalog", STATIC_ERRORS.catalog);
    }
    if (!known) fail("config", `${sanitizeText(advisor.model)} is not a ${slot.provider} model. Search with models ${slot.provider} --q <text>.`);
  }
  const validateFn = options.validateReasoning ?? defaultValidateReasoning;
  const touched = new Set(
    validated.advisors.filter((advisor) => {
      const old = before.get(advisor.name);
      return !old || old.model !== advisor.model || old.provider !== advisor.provider || old.reasoningEffort !== advisor.reasoningEffort;
    }).map((advisor) => advisor.name)
  );
  const scopedReasoning = (slot, advisor, maxOutputTokens) => touched.has(advisor.name) ? validateFn(slot, advisor, maxOutputTokens) : { ok: true };
  await assertAdvisorReasoning(validated, scopedReasoning);
  const changes = describeChange(state.config, validated);
  if (changes.length === 0) fail("input", "That change leaves the configuration as it is.");
  if (options.dryRun) return { ok: true, dryRun: true, changes };
  const saved = await saveConfig({ revision: state.revision, config: validated }, { env, validateReasoning: scopedReasoning });
  return { ok: true, dryRun: false, revision: saved.revision.slice(0, SHORT_REVISION), changes };
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
  if (parsed.command === "summary") {
    writeJson(stdout, summarizeSetup(await readConfigState({ env })));
    return 0;
  }
  if (parsed.command === "providers") {
    const providers = await getProviderCatalog({ createBuiltinProvider: createProviderFn });
    writeJson(stdout, {
      ok: true,
      providers: providers.filter((entry) => entry.id !== "openai-compatible").map((entry) => ({ id: entry.id, name: entry.name, auth: entry.auth, ...entry.suggestedApiKeyEnv ? { env: entry.suggestedApiKeyEnv } : {} }))
    });
    return 0;
  }
  if (parsed.command === "efforts") {
    const { getReasoningChoices } = await import("./reasoning.mjs");
    const slot = { kind: parsed.kind, provider: parsed.providerId, ...parsed.kind === "api" ? { apiKeyEnv: "UNUSED" } : {} };
    const { choices } = await getReasoningChoices(slot, parsed.model);
    const aliases = Object.fromEntries(
      choices.filter((choice) => choice.effective && choice.effective !== choice.value).map((choice) => [choice.value, choice.effective])
    );
    writeJson(stdout, { ok: true, choices: choices.map((choice) => choice.value), ...Object.keys(aliases).length ? { aliases } : {} });
    return 0;
  }
  if (parsed.command === "apply") {
    const raw2 = await readBoundedStdin(options.stdin ?? process.stdin);
    writeJson(
      stdout,
      await applyChange(parseApplyPayload(raw2), {
        env,
        dryRun: parsed.dryRun,
        createBuiltinProvider: createProviderFn,
        validateReasoning: options.validateReasoning
      })
    );
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
  ROLE_PRESETS,
  SetupError,
  applyChange,
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
