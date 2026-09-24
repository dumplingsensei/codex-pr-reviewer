/**
 * Direct API and OAuth advisors via pinned pi-ai. Only the selected provider
 * is registered. API auth is explicit: empty credential store, sealed ambient
 * lookups, and the configured key variable passed on the request. OAuth uses
 * a slot+upstream credential store, never an API-key fallback. Review may
 * refresh; validation does not. The backend never publishes findings.
 */

import {
  InMemoryCredentialStore,
  Type,
  createModels,
  createProvider,
  isContextOverflow,
  validateToolCall
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createCredentialStore } from "../auth.mjs";
import { createBuiltinProvider, createCompatibleModel } from "../providers.mjs";
import { planReasoningCompletion, validateReasoning } from "../reasoning.mjs";
import { groupHistory } from "../session/history.mjs";
import { toolSchemas } from "../tools.mjs";
import { API_PROVIDERS, OAUTH_PROVIDERS } from "../config.mjs";

/** @typedef {"rate"|"auth"|"config"|"context-limit"|"unsupported-tools"|"cancel"|"timeout"|"provider"|"audit"|"unavailable"} ApiErrorCode */

const HOST_TOOL_NAMES = new Set(toolSchemas.map((tool) => tool.name));
const CONTEXT_CHAR_BOUND = 60_000;
const TOOL_RESULT_HEADROOM_TOKENS = 2_048;
const DEFAULT_MAX_TOOL_CALLS = 8;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_500;

const SEALED_AUTH = Object.freeze({
  env: async () => undefined,
  fileExists: async () => false
});

const OAUTH_STATIC = Object.freeze({
  rate: "provider rate limited",
  auth: "OAuth authentication failed",
  config: "provider rejected the model or request",
  "context-limit": "required review context exceeds the model or character bound",
  "unsupported-tools": "provider does not support tools",
  cancel: "review aborted",
  timeout: "review aborted",
  provider: "provider request failed",
  audit: "review failed an audit check",
  unavailable: "OAuth credentials are not configured"
});

const OAUTH_SANITIZE_CODES = new Set(["rate", "auth", "config", "provider", "unavailable"]);

export class ApiBackendError extends Error {
  /**
   * @param {ApiErrorCode} code
   * @param {string} message
   * @param {{ inputTokens: number, outputTokens: number, totalTokens: number, costUsd: number | "unknown" } | null} [usage]
   */
  constructor(code, message, usage = null) {
    super(message);
    this.name = "ApiBackendError";
    /** @type {ApiErrorCode} */
    this.code = code;
    if (usage) this.usage = usage;
  }
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  throw new ApiBackendError(code, message);
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 */
function issue(code, message) {
  return { code, message };
}

/**
 * @param {boolean} available
 * @param {{ code: ApiErrorCode, message: string } | null} [error]
 */
function diagnostic(available, error = null) {
  return error ? { available, error } : { available };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string | undefined} baseUrl
 */
function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? "").trim().replace(/\/+$/, "");
}

/**
 * @param {unknown} env
 * @param {string} name
 */
function envValue(env, name) {
  if (!env || typeof env !== "object") return undefined;
  const value = /** @type {Record<string, unknown>} */ (env)[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {string} text
 * @param {string | undefined} secret
 */
function redactSecret(text, secret) {
  if (typeof text !== "string") return "";
  if (typeof secret !== "string" || secret.length < 4) return text;
  return text.split(secret).join("[redacted]");
}

/**
 * @param {unknown} provider
 */
function apiKeyEnvName(provider) {
  return isObject(provider) && typeof provider.apiKeyEnv === "string" ? provider.apiKeyEnv : "";
}

/**
 * @param {unknown} provider
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {{ key?: string, error?: { code: ApiErrorCode, message: string } }}
 */
function configuredKey(provider, env) {
  const name = apiKeyEnvName(provider);
  if (!name) return { error: issue("config", "API provider requires apiKeyEnv") };
  const key = envValue(env, name);
  if (typeof key !== "string" || key.trim().length === 0) {
    return { error: issue("unavailable", `API key variable ${name} is not set`) };
  }
  return { key };
}

function anthropicOatAsApiKey(id, kind, key) {
  return kind === "api" && id === "anthropic" && typeof key === "string" && key.includes("sk-ant-oat");
}

/**
 * @param {unknown} provider
 */
function providerKind(provider) {
  return isObject(provider) && typeof provider.kind === "string" ? provider.kind : "";
}

/**
 * @param {unknown} provider
 */
function providerId(provider) {
  return isObject(provider) && typeof provider.provider === "string" ? provider.provider : "";
}

/**
 * @param {unknown} advisor
 */
function advisorModelId(advisor) {
  return isObject(advisor) && typeof advisor.model === "string" ? advisor.model : "";
}

function advisorSlot(advisor) {
  return isObject(advisor) && typeof advisor.provider === "string" ? advisor.provider : "";
}

/**
 * @param {unknown} meta
 * @returns {{ code: ApiErrorCode, message: string } | null}
 */
function compatibleModelIssues(meta) {
  if (!isObject(meta)) return issue("config", "openai-compatible model metadata is missing");
  if (!Number.isInteger(meta.contextWindow) || /** @type {number} */ (meta.contextWindow) <= 0) {
    return issue("config", "openai-compatible model requires a positive integer contextWindow");
  }
  if (!Number.isInteger(meta.maxTokens) || /** @type {number} */ (meta.maxTokens) <= 0) {
    return issue("config", "openai-compatible model requires a positive integer maxTokens");
  }
  if (typeof meta.reasoning !== "boolean") {
    return issue("config", "openai-compatible model requires boolean reasoning");
  }
  if (
    !Array.isArray(meta.input) ||
    meta.input.length === 0 ||
    !meta.input.every((item) => item === "text" || item === "image")
  ) {
    return issue("config", "openai-compatible model input must be an array of text and/or image");
  }
  return null;
}

/**
 * @param {unknown} pricing
 */
function mapCost(pricing) {
  if (!isObject(pricing)) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const input = Number(pricing.prompt ?? pricing.input ?? 0);
  const output = Number(pricing.completion ?? pricing.output ?? 0);
  const cacheRead = Number(pricing.cacheRead ?? 0);
  const cacheWrite = Number(pricing.cacheWrite ?? 0);
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    cacheRead: Number.isFinite(cacheRead) ? cacheRead : 0,
    cacheWrite: Number.isFinite(cacheWrite) ? cacheWrite : 0
  };
}

function listedRate(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Compatible cost is known only when both prompt and completion rates are listed.
 * A missing side must not be treated as $0.
 *
 * @param {unknown} pricing
 */
function compatiblePricingKnown(pricing) {
  if (!isObject(pricing)) return false;
  const prompt = pricing.prompt ?? pricing.input;
  const completion = pricing.completion ?? pricing.output;
  return listedRate(prompt) && listedRate(completion);
}

/**
 * @param {unknown} provider
 * @param {unknown} advisor
 */
function compatibleMeta(provider, advisor) {
  const modelId = advisorModelId(advisor);
  if (!isObject(provider) || !isObject(provider.models) || Array.isArray(provider.models)) {
    return { error: issue("config", "openai-compatible provider requires a models map") };
  }
  if (!modelId) return { error: issue("config", "advisor model is required") };
  const meta = /** @type {Record<string, unknown>} */ (provider.models)[modelId];
  const problems = compatibleModelIssues(meta);
  if (problems) {
    if (!isObject(meta)) return { error: issue("config", `unknown model ${modelId}`) };
    return { error: problems };
  }
  return { meta: /** @type {Record<string, any>} */ (meta), modelId };
}

function createSealedModels(credentials = new InMemoryCredentialStore()) {
  return createModels({
    credentials,
    authContext: SEALED_AUTH
  });
}

/**
 * Restrict the SDK provider to the configured auth kind so the unused method
 * cannot be used as fallback (API key vs OAuth, including Copilot bearer).
 * @param {import("@earendil-works/pi-ai").Provider} sdkProvider
 * @param {"api" | "oauth"} kind
 * @param {string} modelId
 */
function selectProviderAuth(sdkProvider, kind, modelId) {
  if (kind === "oauth") {
    if (!sdkProvider.auth?.oauth) {
      return { error: issue("config", "provider does not support OAuth") };
    }
    return {
      provider: {
        ...sdkProvider,
        auth: {
          oauth: {
            ...sdkProvider.auth.oauth,
            async toAuth(credential) {
              // Refresh may revoke a model that was locally available at prepare.
              const allowed = sdkProvider.filterModels?.(sdkProvider.getModels(), credential);
              if (allowed && !allowed.some((model) => model.id === modelId)) {
                throw new Error("model is not available for this account");
              }
              return sdkProvider.auth.oauth.toAuth(credential);
            }
          }
        }
      }
    };
  }
  if (!sdkProvider.auth?.apiKey) {
    return { error: issue("config", "provider does not support API keys") };
  }
  return {
    provider: {
      ...sdkProvider,
      auth: { apiKey: sdkProvider.auth.apiKey }
    }
  };
}

/**
 * Register only the selected built-in provider. Offline catalog only.
 * @param {import("@earendil-works/pi-ai").MutableModels} models
 * @param {string} id
 * @param {"api" | "oauth"} kind
 * @param {string} modelId
 */
function registerBuiltin(models, id, kind, modelId) {
  let sdk;
  try {
    sdk = createBuiltinProvider(id);
  } catch {
    return { error: issue("config", `unsupported provider ${id || "(missing)"}`) };
  }
  const selected = selectProviderAuth(sdk, kind, modelId);
  if (selected.error) return selected;
  models.setProvider(selected.provider);
  return { provider: selected.provider };
}

function subscriptionAuth(kind, sdkProvider) {
  return kind === "oauth" && sdkProvider?.auth?.oauth?.isSubscription === true;
}

function catalogPricingKnown(model, subscription) {
  if (subscription) return false;
  const cost = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return listedRate(cost.input) && listedRate(cost.output);
}

function oauthStore(env, slot, providerId) {
  try {
    return { store: createCredentialStore({ env, slot, provider: providerId }) };
  } catch {
    return { error: issue("unavailable", "OAuth credentials are not configured") };
  }
}

/**
 * @param {unknown} provider
 * @param {unknown} advisor
 */
function compatiblePiModel(provider, advisor) {
  const resolved = compatibleMeta(provider, advisor);
  if (resolved.error) return resolved;
  const { meta, modelId } = resolved;
  const cost = mapCost(meta.pricing);
  const baseUrl = normalizeBaseUrl(/** @type {{ baseUrl?: string }} */ (provider).baseUrl);
  if (!baseUrl) return { error: issue("config", "openai-compatible provider requires baseUrl") };
  return {
    model: createCompatibleModel({ id: modelId, baseUrl, meta, cost }),
    pricingKnown: compatiblePricingKnown(meta.pricing)
  };
}

/**
 * @param {unknown} provider
 * @param {unknown} advisor
 */
function registerCompatible(models, provider, advisor) {
  const resolved = compatiblePiModel(provider, advisor);
  if (resolved.error) return resolved;
  const { model, pricingKnown } = resolved;
  models.setProvider(
    createProvider({
      id: "openai-compatible",
      name: "OpenAI-compatible",
      baseUrl: model.baseUrl,
      auth: {
        apiKey: {
          name: "OpenAI-compatible API key",
          resolve: async ({ credential }) => {
            if (credential?.key) return { auth: { apiKey: credential.key }, source: "request" };
            return undefined;
          }
        }
      },
      models: [model],
      api: openAICompletionsApi()
    })
  );
  return { model, pricingKnown };
}

/**
 * Offline model and auth resolution. Never refreshes OAuth or calls a provider.
 * @param {unknown} provider
 * @param {unknown} advisor
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
async function prepareApi(provider, advisor, env) {
  const kind = providerKind(provider);
  if (kind !== "api" && kind !== "oauth") {
    return { error: issue("config", "API backend requires kind api or oauth") };
  }
  const id = providerId(provider);
  const modelId = advisorModelId(advisor);
  if (!modelId) return { error: issue("config", "advisor model is required") };
  if (kind === "oauth") {
    if (!OAUTH_PROVIDERS.includes(id)) {
      return { error: issue("config", "provider does not support OAuth") };
    }
  } else if (!API_PROVIDERS.includes(id)) {
    return { error: issue("config", `unsupported provider ${id || "(missing)"}`) };
  }

  if (kind === "api" && !apiKeyEnvName(provider)) {
    return { error: issue("config", "API provider requires apiKeyEnv") };
  }

  const slot = advisorSlot(advisor);
  /** @type {import("@earendil-works/pi-ai").CredentialStore} */
  let credentials = new InMemoryCredentialStore();
  /** @type {{ code: ApiErrorCode, message: string } | null} */
  let storeError = null;
  /** @type {{ key?: string, error?: { code: ApiErrorCode, message: string } } | null} */
  let keyResult = null;

  if (kind === "oauth") {
    if (!slot) return { error: issue("config", "advisor provider slot is required") };
    const stored = oauthStore(env, slot, id);
    if (stored.error) {
      storeError = stored.error;
    } else {
      credentials = stored.store;
    }
  } else {
    keyResult = configuredKey(provider, env);
  }

  const models = createSealedModels(credentials);
  if (kind === "api" && id === "openai-compatible") {
    const registered = registerCompatible(models, provider, advisor);
    if (registered.error) return registered;
    if (keyResult?.error) return { error: keyResult.error };
    return {
      models,
      model: registered.model,
      pricingKnown: registered.pricingKnown,
      kind,
      apiKey: keyResult?.key
    };
  }

  const registered = registerBuiltin(models, id, kind, modelId);
  if (registered.error) return registered;
  const model = models.getModel(id, modelId);
  if (!model) return { error: issue("config", `unknown model ${modelId}`) };
  const pricingKnown = catalogPricingKnown(model, subscriptionAuth(kind, registered.provider));

  if (kind === "api") {
    if (keyResult?.error) return { error: keyResult.error };
    if (anthropicOatAsApiKey(id, kind, keyResult?.key)) {
      return { error: issue("auth", "Anthropic subscription OAuth tokens are not supported") };
    }
    return { models, model, pricingKnown, kind, apiKey: keyResult?.key };
  }

  if (storeError) return { error: storeError };

  let check;
  try {
    check = await models.checkAuth(id);
  } catch {
    return { error: issue("auth", "OAuth authentication failed") };
  }
  if (!check || check.type !== "oauth") {
    return { error: issue("unavailable", "OAuth credentials are not configured") };
  }

  let available;
  try {
    available = await models.getAvailable(id);
  } catch {
    return { error: issue("auth", "OAuth authentication failed") };
  }
  if (!available.some((entry) => entry.id === modelId)) {
    return { error: issue("config", "model is not available for this account") };
  }

  return { models, model, pricingKnown, kind };
}

/**
 * @param {unknown} schema
 */
function asTypeBoxSchema(schema) {
  const raw = schema && typeof schema === "object" ? structuredClone(schema) : { type: "object", properties: {} };
  return Type.Unsafe(raw);
}

/**
 * @param {unknown[]} schemas
 */
function toPiTools(schemas) {
  return schemas.map((entry) => {
    const name = isObject(entry) && typeof entry.name === "string" ? entry.name : "";
    const description = isObject(entry) && typeof entry.description === "string" ? entry.description : "";
    const parameters = isObject(entry) ? entry.parameters ?? entry.inputSchema : undefined;
    return {
      name,
      description,
      parameters: asTypeBoxSchema(parameters)
    };
  }).filter((tool) => tool.name);
}

/**
 * @param {unknown} observation
 */
function renderOneObservation(observation) {
  if (typeof observation === "string") return observation;
  if (!isObject(observation)) return "";
  const lines = [];
  const field = (label, value) => {
    if (value == null || value === "") return;
    if (Array.isArray(value) && value.length === 0) return;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    lines.push(`${label}: ${text}`);
  };
  field("eventId", observation.eventId);
  field("phase", observation.phase);
  field("user", observation.userText);
  field("assistant", observation.assistantText);
  field("tool", observation.toolName);
  field("targets", observation.targets);
  field("command", observation.command);
  field("outcome", observation.outcome);
  field("error", observation.error);
  if (observation.gap) field("gap", observation.gap);
  if (observation.queued) field("queued", observation.queued);
  if (observation.interrupted) lines.push("interrupted: true");
  return lines.join("\n");
}

/**
 * @param {unknown} observations
 * @param {string | undefined} secret
 */
function renderObservations(observations, secret) {
  const items = Array.isArray(observations) ? observations : [];
  const body = items.map(renderOneObservation).filter(Boolean).join("\n\n");
  const text = body.length > 0 ? `Session observations:\n${body}` : "No new session observations.";
  return redactSecret(text, secret);
}

/**
 * @param {{ observations?: unknown, latestTask?: unknown, compactSummary?: unknown }} parts
 * @param {string | undefined} secret
 */
function renderTaskContext({ observations, latestTask, compactSummary }, secret) {
  const parts = [];
  const compactText = compactSummary && typeof compactSummary === "object" ? compactSummary.text : compactSummary;
  if (typeof compactText === "string" && compactText.trim()) {
    parts.push(`Compact summary:\n${redactSecret(compactText, secret)}`);
  }
  const taskText = latestTask && typeof latestTask === "object" ? latestTask.text : latestTask;
  if (typeof taskText === "string" && taskText.trim()) {
    parts.push(`Current user request:\n${redactSecret(taskText, secret)}`);
  }
  parts.push(renderObservations(observations, secret));
  return parts.join("\n\n");
}

/**
 * @param {unknown} history
 */
function copyHistory(history) {
  return Array.isArray(history) ? history.slice() : [];
}

/**
 * @param {unknown} value
 */
function measureChars(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * @param {unknown[]} messages
 * @param {string} systemPrompt
 * @param {{ contextWindow: number, maxTokens: number }} model
 * @param {number} maxOutputTokens
 */
function contextFits(messages, systemPrompt, model, maxOutputTokens) {
  const chars = measureChars(systemPrompt) + measureChars(messages);
  if (chars > CONTEXT_CHAR_BOUND) return false;
  const estimatedTokens = Math.ceil(chars / 4);
  const outputRoom = Math.min(maxOutputTokens, model.maxTokens);
  const available = model.contextWindow - outputRoom - TOOL_RESULT_HEADROOM_TOKENS;
  return estimatedTokens <= Math.max(1, available);
}

/**
 * Drop oldest prior-review complete groups until the request fits. The current
 * review's user turn and its tool-result groups are never discarded.
 *
 * @param {unknown[]} messages
 * @param {unknown} currentUser
 * @param {string} systemPrompt
 * @param {{ contextWindow: number, maxTokens: number }} model
 * @param {number} maxOutputTokens
 */
function evictUntilFits(messages, currentUser, systemPrompt, model, maxOutputTokens) {
  if (contextFits(messages, systemPrompt, model, maxOutputTokens)) return true;
  const index = messages.indexOf(currentUser);
  if (index < 0) return false;
  const current = messages.slice(index);
  const groups = groupHistory(messages.slice(0, index));
  while (groups.length) {
    groups.shift();
    const candidate = [...groups.flat(), ...current];
    if (contextFits(candidate, systemPrompt, model, maxOutputTokens)) {
      messages.length = 0;
      messages.push(...candidate);
      return true;
    }
  }
  messages.length = 0;
  messages.push(...current);
  return contextFits(messages, systemPrompt, model, maxOutputTokens);
}

/**
 * @param {unknown} tools
 */
function stagedCandidate(tools) {
  if (!tools) return null;
  if (typeof tools.candidate === "function") return tools.candidate();
  return tools.candidate ?? null;
}

/**
 * @param {unknown} signal
 * @returns {ApiErrorCode}
 */
function abortCode(signal) {
  const reason = signal?.reason;
  if (reason === "timeout" || reason === "TimeoutError") return "timeout";
  if (isObject(reason) && (reason.code === "timeout" || reason.name === "TimeoutError")) return "timeout";
  if (reason instanceof Error && (/timeout/i.test(reason.name) || /timeout/i.test(reason.message))) {
    return "timeout";
  }
  if (typeof reason === "string" && /timeout/i.test(reason)) return "timeout";
  return "cancel";
}

/**
 * @param {unknown} error
 */
function httpStatusOf(error) {
  if (typeof error?.status === "number") return error.status;
  if (typeof error?.statusCode === "number") return error.statusCode;
  const match = String(error?.message ?? "").match(/\b(401|403|404|429)\b/);
  return match ? Number(match[1]) : undefined;
}

/**
 * @param {string} text
 * @returns {ApiErrorCode | null}
 */
function classifyText(text) {
  const value = text ?? "";
  if (/\b429\b|rate.?limit|too many requests|resource.?exhausted/i.test(value)) return "rate";
  if (
    /\b401\b|\b403\b|\bauth\b|\boauth\b|unauthorized|forbidden|invalid[_ ]?api[_ ]?key|authentication|credential store|permission denied|incorrect api key/i.test(
      value
    )
  ) {
    return "auth";
  }
  if (
    /unsupported.?tools|tools? (?:is |are )?not supported|does not support (?:tool|function)|function calling is not|tool(?:s)? (?:are|is) not enabled|unknown tool type/i.test(
      value
    )
  ) {
    return "unsupported-tools";
  }
  if (
    /\b404\b|model_not_found|invalid_model|unknown model|invalid model|model does not exist|does not have access to (?:the )?model|not a valid model/i.test(
      value
    )
  ) {
    return "config";
  }
  return null;
}

/**
 * @param {import("@earendil-works/pi-ai").AssistantMessage | undefined} message
 * @param {{ contextWindow?: number } | undefined} model
 * @param {AbortSignal | undefined} signal
 * @returns {ApiErrorCode}
 */
function classifyMessage(message, model, signal) {
  if (signal?.aborted || message?.stopReason === "aborted") return abortCode(signal);
  if (message && isContextOverflow(message, model?.contextWindow)) return "context-limit";
  const fromText = classifyText(`${message?.errorMessage ?? ""} ${message?.rawStopReason ?? ""}`);
  if (fromText) return fromText;
  if (message?.stopReason === "error" || message?.stopReason === "length") return "provider";
  return "provider";
}

/**
 * @param {unknown} error
 * @param {AbortSignal | undefined} signal
 * @param {string | undefined} secret
 * @param {"api" | "oauth" | ""} [kind]
 */
function wrapThrown(error, signal, secret, kind = "api") {
  const oauth = kind === "oauth";
  if (error instanceof ApiBackendError) {
    if (oauth && OAUTH_SANITIZE_CODES.has(error.code)) {
      error.message = OAUTH_STATIC[error.code];
    } else if (!oauth) {
      error.message = redactSecret(error.message, secret);
    }
    return error;
  }
  if (signal?.aborted) {
    const code = abortCode(signal);
    return new ApiBackendError(code, oauth ? OAUTH_STATIC[code] : "review aborted");
  }
  const err = error instanceof Error ? error : new Error(String(error ?? "provider error"));
  if (err.name === "AbortError" || /aborted|AbortError/i.test(err.message)) {
    const code = abortCode(signal);
    return new ApiBackendError(code, oauth ? OAUTH_STATIC[code] : redactSecret(err.message, secret));
  }
  if (oauth) {
    const status = httpStatusOf(err);
    let code = "provider";
    if (status === 429) code = "rate";
    else if (status === 401 || status === 403) code = "auth";
    else if (status === 404) code = "config";
    else if (isObject(error) && typeof error.code === "string" && (error.code === "oauth" || error.code === "auth")) {
      code = "auth";
    } else {
      const fromText = classifyText(String(err.message ?? ""));
      if (fromText === "rate" || fromText === "auth" || fromText === "config" || fromText === "unsupported-tools") {
        code = fromText;
      }
    }
    return new ApiBackendError(code, OAUTH_STATIC[code] ?? OAUTH_STATIC.provider);
  }
  const status = httpStatusOf(err);
  const text = redactSecret(err.message, secret);
  if (status === 429) return new ApiBackendError("rate", text);
  if (status === 401 || status === 403) return new ApiBackendError("auth", text);
  if (status === 404) return new ApiBackendError("config", text);
  const fromText = classifyText(text);
  if (fromText) return new ApiBackendError(fromText, text);
  if (isObject(error) && typeof error.code === "string" && error.code === "auth") {
    return new ApiBackendError("auth", text);
  }
  return new ApiBackendError("provider", text);
}

/**
 * @param {{ inputTokens?: number, outputTokens?: number, totalTokens?: number, costUsd?: number | "unknown" | null } | null | undefined} usage
 */
function snapshotUsage(usage) {
  const num = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const cost = usage?.costUsd;
  return {
    inputTokens: num(usage?.inputTokens),
    outputTokens: num(usage?.outputTokens),
    totalTokens: num(usage?.totalTokens),
    costUsd: cost === "unknown" || (typeof cost === "number" && Number.isFinite(cost)) ? cost : "unknown"
  };
}

/**
 * @param {{ inputTokens: number, outputTokens: number, totalTokens: number, costUsd: number | "unknown" | null }} usage
 * @param {import("@earendil-works/pi-ai").AssistantMessage} message
 * @param {boolean} pricingKnown
 */
function accumulateUsage(usage, message, pricingKnown) {
  const reported = message?.usage;
  const input = (reported?.input ?? 0) + (reported?.cacheRead ?? 0) + (reported?.cacheWrite ?? 0);
  const output = reported?.output ?? 0;
  const total = reported?.totalTokens ?? input + output;
  const reportedCounts = input + output + total;
  if (reportedCounts > 0) {
    usage.inputTokens += input;
    usage.outputTokens += output;
    usage.totalTokens += total;
  }
  if (!pricingKnown) {
    usage.costUsd = "unknown";
    return;
  }
  if (!reported || reportedCounts === 0) {
    usage.costUsd = "unknown";
    return;
  }
  if (usage.costUsd === "unknown") return;
  const cost = reported.cost?.total;
  if (typeof cost !== "number" || !Number.isFinite(cost)) {
    usage.costUsd = "unknown";
    return;
  }
  usage.costUsd = (typeof usage.costUsd === "number" ? usage.costUsd : 0) + cost;
}

/**
 * @param {import("@earendil-works/pi-ai").ToolCall} call
 * @param {unknown} result
 * @param {boolean} isError
 */
function toolResultMessage(call, result, isError) {
  const text =
    typeof result === "string"
      ? result
      : result == null
        ? isError
          ? "tool failed"
          : "ok"
        : JSON.stringify(result);
  return {
    role: /** @type {const} */ ("toolResult"),
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: /** @type {const} */ ("text"), text: text || (isError ? "tool failed" : "ok") }],
    isError,
    timestamp: Date.now()
  };
}

/**
 * Offline validation of the registered API/OAuth model. Never refreshes
 * OAuth or calls a provider. Semantic effort/budget checks use the configured
 * output limit before the snapshot is treated as available.
 *
 * @param {{
 *   provider: unknown,
 *   advisor: unknown,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   maxOutputTokens?: number
 * }} args
 * @returns {Promise<{ available: boolean, reasoningInvalid?: true, error?: { code: ApiErrorCode, message: string } }>}
 */
export async function validateApi({
  provider,
  advisor,
  env = process.env,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS
}) {
  const prepared = await prepareApi(provider, advisor, env);
  if (prepared.error) return diagnostic(false, prepared.error);
  const requested = Number.isInteger(maxOutputTokens) ? maxOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS;
  const ceiling = Math.min(
    requested,
    Number.isInteger(prepared.model.maxTokens) ? prepared.model.maxTokens : requested
  );
  const reasoning = await validateReasoning(provider, advisor, ceiling);
  if (!reasoning.ok) {
    return {
      available: false,
      reasoningInvalid: true,
      error: issue("config", reasoning.error)
    };
  }
  return diagnostic(true);
}

/**
 * Run one API review. Success is returned only after the full tool batch is
 * validated and dispatched. Findings stay staged on `tools` until the worker
 * publishes.
 *
 * @param {{
 *   provider: unknown,
 *   advisor: unknown,
 *   observations?: unknown,
 *   history?: unknown[],
 *   latestTask?: { text?: string, promptId?: unknown, at?: unknown, generation?: unknown },
 *   compactSummary?: { text?: string, promptId?: unknown, at?: unknown, generation?: unknown },
 *   systemPrompt?: string,
 *   tools: { call: Function, candidate?: unknown, isFresh?: Function, guidance?: string },
 *   limits?: { maxToolCallsPerReview?: number, maxOutputTokens?: number, reviewTimeoutSeconds?: number },
 *   signal?: AbortSignal,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>
 * }} args
 * @returns {Promise<{ usage: { inputTokens: number, outputTokens: number, totalTokens: number, costUsd: number | "unknown" }, history: unknown[] }>}
 */
export async function reviewApi({
  provider,
  advisor,
  observations = [],
  history = [],
  latestTask,
  compactSummary,
  systemPrompt = "",
  tools,
  limits = {},
  signal,
  env = process.env
}) {
  if (signal?.aborted) fail(abortCode(signal), "review aborted");
  if (!tools || typeof tools.call !== "function") fail("config", "review tools are required");

  const prepared = await prepareApi(provider, advisor, env);
  if (prepared.error) fail(prepared.error.code, prepared.error.message);
  const { models, model, pricingKnown, kind } = prepared;
  const apiKey = kind === "api" ? /** @type {string} */ (prepared.apiKey) : undefined;
  const oauth = kind === "oauth";

  const maxToolCalls = Number.isInteger(limits.maxToolCallsPerReview)
    ? /** @type {number} */ (limits.maxToolCallsPerReview)
    : DEFAULT_MAX_TOOL_CALLS;
  const maxOutputTokens = Math.min(
    Number.isInteger(limits.maxOutputTokens) ? /** @type {number} */ (limits.maxOutputTokens) : DEFAULT_MAX_OUTPUT_TOKENS,
    model.maxTokens
  );
  const reasoning = await validateReasoning(provider, advisor, maxOutputTokens);
  if (!reasoning.ok) fail("config", reasoning.error);
  const piTools = toPiTools(toolSchemas);
  if (piTools.length === 0) fail("config", "host tool schemas are missing");
  const allowed = HOST_TOOL_NAMES;

  const guidance = typeof tools.guidance === "string" ? tools.guidance : "";
  const system = [systemPrompt, guidance].filter((part) => typeof part === "string" && part.length > 0).join("\n\n");
  const currentUser = {
    role: "user",
    content: renderTaskContext({ observations, latestTask, compactSummary }, apiKey),
    timestamp: Date.now()
  };
  const messages = [...copyHistory(history), currentUser];
  if (!evictUntilFits(messages, currentUser, system, model, maxOutputTokens)) {
    fail("context-limit", "required review context exceeds the model or character bound");
  }

  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: /** @type {number | "unknown" | null} */ (null)
  };

  /** @type {import("@earendil-works/pi-ai").Context} */
  const context = {
    systemPrompt: system,
    messages,
    tools: piTools
  };

  const requestOptions = {
    signal,
    maxTokens: maxOutputTokens,
    maxRetries: 0,
    cacheRetention: /** @type {const} */ ("none"),
    transport: /** @type {const} */ ("sse"),
    env: {}
  };
  if (kind === "api") requestOptions.apiKey = apiKey;
  const completion = planReasoningCompletion(model, advisor, requestOptions);
  const requestModel = completion.model ?? model;

  let toolCalls = 0;
  try {
    for (;;) {
      if (signal?.aborted) fail(abortCode(signal), "review aborted");
      if (toolCalls >= maxToolCalls) fail("audit", "max tool calls per review exceeded");
      if (!evictUntilFits(messages, currentUser, system, model, maxOutputTokens)) {
        fail("context-limit", "required review context exceeds the model or character bound");
      }

      const message =
        completion.method === "completeSimple"
          ? await models.completeSimple(requestModel, context, completion.options)
          : await models.complete(requestModel, context, completion.options);
      accumulateUsage(usage, message, pricingKnown);
      if (message.stopReason === "aborted" || message.stopReason === "error" || message.stopReason === "length") {
        const code = classifyMessage(message, model, signal);
        fail(
          code,
          oauth ? OAUTH_STATIC[code] : redactSecret(message.errorMessage || `provider stopReason ${message.stopReason}`, apiKey)
        );
      }
      if (message.stopReason === "deferred") {
        fail("provider", "deferred provider responses are not used");
      }

      messages.push(message);

      if (message.stopReason === "stop") break;
      if (message.stopReason !== "toolUse") {
        fail("provider", `unexpected stopReason ${message.stopReason}`);
      }

      const calls = message.content.filter((block) => block.type === "toolCall");
      if (calls.length === 0) fail("audit", "provider requested tools without tool calls");
      for (const call of calls) {
        if (!allowed.has(call.name)) {
          fail("audit", `model called unknown tool ${call.name}`);
        }
      }
      if (toolCalls + calls.length > maxToolCalls) {
        fail("audit", "max tool calls per review exceeded");
      }

      for (const call of calls) {
        if (signal?.aborted) fail(abortCode(signal), "review aborted");
        let args;
        try {
          args = validateToolCall(piTools, call);
        } catch (error) {
          const text = error instanceof Error ? error.message : "invalid tool arguments";
          messages.push(toolResultMessage(call, redactSecret(text, apiKey), true));
          toolCalls += 1;
          continue;
        }
        try {
          const result = await tools.call(call.name, args);
          messages.push(toolResultMessage(call, result, false));
        } catch (error) {
          if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
            fail(abortCode(signal), "review aborted");
          }
          const text = error instanceof Error ? error.message : "tool failed";
          messages.push(toolResultMessage(call, redactSecret(text, apiKey), true));
        }
        toolCalls += 1;
      }

      if (signal?.aborted) fail(abortCode(signal), "review aborted");
      if (stagedCandidate(tools)) break;
    }
  } catch (error) {
    const wrapped = wrapThrown(error, signal, apiKey, kind);
    wrapped.usage = snapshotUsage(usage);
    throw wrapped;
  }

  if (signal?.aborted) {
    const code = abortCode(signal);
    throw new ApiBackendError(code, oauth ? OAUTH_STATIC[code] : "review aborted", snapshotUsage(usage));
  }
  return { usage: snapshotUsage(usage), history: messages };
}
