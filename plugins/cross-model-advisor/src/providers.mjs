/**
 * Selected pi-ai provider factories. Literal imports only; no providers/all
 * barrel and no ambient credential discovery. Callers receive a fresh SDK
 * Provider each time. Auth kind (api vs oauth) is applied by the caller.
 *
 * The pinned SDK hides OAuth implementations behind variable imports. Our
 * build resolves the four private flow imports below so cold installs contain
 * them. Replace lazy handlers explicitly; unsupported OAuth is not exposed.
 */

import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { openaiCodexOAuth } from "@earendil-works/pi-ai/auth/oauth/openai-codex";
import { githubCopilotOAuth } from "@earendil-works/pi-ai/auth/oauth/github-copilot";
import { xaiOAuth } from "@earendil-works/pi-ai/auth/oauth/xai";
import { kimiCodingOAuth } from "@earendil-works/pi-ai/auth/oauth/kimi-coding";

const OAUTH_FLOWS = Object.freeze({
  "openai-codex": openaiCodexOAuth,
  "github-copilot": githubCopilotOAuth,
  xai: xaiOAuth,
  "kimi-coding": kimiCodingOAuth
});

const FACTORIES = Object.freeze({
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  openrouter: openrouterProvider,
  zai: zaiProvider,
  xai: xaiProvider,
  moonshotai: moonshotaiProvider,
  "kimi-coding": kimiCodingProvider,
  "openai-codex": openaiCodexProvider,
  "github-copilot": githubCopilotProvider
});

/**
 * @param {string} id
 * @returns {import("@earendil-works/pi-ai").Provider}
 */
export function createBuiltinProvider(id) {
  const factory = FACTORIES[id];
  if (typeof factory !== "function") {
    throw new Error(`unsupported provider ${id}`);
  }
  const provider = factory();
  return {
    ...provider,
    auth: {
      ...(provider.auth.apiKey ? { apiKey: provider.auth.apiKey } : {}),
      ...(OAUTH_FLOWS[id] ? { oauth: OAUTH_FLOWS[id] } : {})
    }
  };
}

export const THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

export const COMPATIBLE_THINKING_FORMATS = Object.freeze(["openai", "openrouter", "zai"]);

const NATIVE_STRING_MAX = 64;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compatible reasoning controls are optional and paired. `reasoning: true`
 * alone does not establish tunability. `supportsReasoningEffort` is valid
 * only with a complete thinkingFormat+thinkingLevelMap pair.
 *
 * @param {unknown} meta
 * @returns {{ pair: { thinkingFormat: "openai"|"openrouter"|"zai", thinkingLevelMap: Record<string, string|null>, supportsReasoningEffort?: boolean } | null, error?: string }}
 */
export function compatibleThinkingPair(meta) {
  if (!isObject(meta)) return { pair: null };
  const hasFormat = Object.prototype.hasOwnProperty.call(meta, "thinkingFormat");
  const hasMap = Object.prototype.hasOwnProperty.call(meta, "thinkingLevelMap");
  const hasEffort = Object.prototype.hasOwnProperty.call(meta, "supportsReasoningEffort");
  if (!hasFormat && !hasMap && !hasEffort) return { pair: null };
  if (!hasFormat || !hasMap) {
    return { pair: null, error: "compatible model thinking metadata is invalid" };
  }
  const format = meta.thinkingFormat;
  if (format !== "openai" && format !== "openrouter" && format !== "zai") {
    return { pair: null, error: "compatible model thinking metadata is invalid" };
  }
  const map = meta.thinkingLevelMap;
  if (!isObject(map)) return { pair: null, error: "compatible model thinking metadata is invalid" };
  const keys = Object.keys(map);
  if (keys.length !== THINKING_LEVELS.length || THINKING_LEVELS.some((level) => !Object.prototype.hasOwnProperty.call(map, level))) {
    return { pair: null, error: "compatible model thinking metadata is invalid" };
  }
  /** @type {Record<string, string|null>} */
  const thinkingLevelMap = {};
  for (const level of THINKING_LEVELS) {
    const mapped = map[level];
    if (mapped === null) {
      thinkingLevelMap[level] = null;
      continue;
    }
    if (typeof mapped !== "string" || mapped.length === 0 || mapped.length > NATIVE_STRING_MAX) {
      return { pair: null, error: "compatible model thinking metadata is invalid" };
    }
    thinkingLevelMap[level] = mapped;
  }
  if (hasEffort && typeof meta.supportsReasoningEffort !== "boolean") {
    return { pair: null, error: "compatible model thinking metadata is invalid" };
  }
  /** @type {{ thinkingFormat: "openai"|"openrouter"|"zai", thinkingLevelMap: Record<string, string|null>, supportsReasoningEffort?: boolean }} */
  const pair = { thinkingFormat: format, thinkingLevelMap };
  if (hasEffort) pair.supportsReasoningEffort = meta.supportsReasoningEffort;
  return { pair };
}

/**
 * Build the same openai-compatible Model the API backend registers.
 * Optional thinking fields are applied only when the paired metadata is valid.
 * `supportsReasoningEffort` defaults true for openai/openrouter and false for
 * zai (enable-only). Explicit booleans win. Omitted stays omitted on meta.
 *
 * @param {{
 *   id: string,
 *   baseUrl: string,
 *   meta: Record<string, any>,
 *   cost?: { input: number, output: number, cacheRead: number, cacheWrite: number }
 * }} args
 * @returns {import("@earendil-works/pi-ai").Model<"openai-completions">}
 */
export function createCompatibleModel({ id, baseUrl, meta, cost }) {
  const thinking = compatibleThinkingPair(meta);
  /** @type {import("@earendil-works/pi-ai").Model<"openai-completions">} */
  const model = {
    id,
    name: id,
    api: /** @type {const} */ ("openai-completions"),
    provider: "openai-compatible",
    baseUrl,
    reasoning: Boolean(meta?.reasoning),
    input: Array.isArray(meta?.input) ? meta.input : ["text"],
    cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: meta?.contextWindow,
    maxTokens: meta?.maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false
    }
  };
  if (model.reasoning && thinking.pair) {
    model.thinkingLevelMap = thinking.pair.thinkingLevelMap;
    model.compat.thinkingFormat = thinking.pair.thinkingFormat;
    if (typeof thinking.pair.supportsReasoningEffort === "boolean") {
      model.compat.supportsReasoningEffort = thinking.pair.supportsReasoningEffort;
    } else {
      model.compat.supportsReasoningEffort = thinking.pair.thinkingFormat !== "zai";
    }
  }
  return model;
}

/**
 * Resolve a catalog or compatible model without credentials or network.
 *
 * @param {unknown} providerSlot
 * @param {unknown} modelId
 * @returns {{ model?: import("@earendil-works/pi-ai").Model, error?: string, thinkingError?: string }}
 */
export function resolveOfflineModel(providerSlot, modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) {
    return { error: "advisor model is required" };
  }
  if (!isObject(providerSlot) || typeof providerSlot.provider !== "string") {
    return { error: "unsupported provider" };
  }
  const id = providerSlot.provider;
  if (providerSlot.kind === "api" && id === "openai-compatible") {
    if (!isObject(providerSlot.models) || Array.isArray(providerSlot.models)) {
      return { error: "unknown model" };
    }
    const meta = providerSlot.models[modelId];
    if (!isObject(meta)) return { error: "unknown model" };
    const thinking = compatibleThinkingPair(meta);
    const baseUrl = typeof providerSlot.baseUrl === "string" ? providerSlot.baseUrl.replace(/\/+$/, "") : "";
    return {
      model: createCompatibleModel({ id: modelId, baseUrl, meta }),
      ...(thinking.error ? { thinkingError: thinking.error } : {})
    };
  }
  try {
    const provider = createBuiltinProvider(id);
    const model = provider.getModels().find((entry) => entry.id === modelId);
    if (!model) return { error: "unknown model" };
    return { model };
  } catch {
    return { error: "unsupported provider" };
  }
}
