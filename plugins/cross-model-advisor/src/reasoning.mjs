/**
 * Offline reasoning-effort choices and semantic validation. Catalog support
 * comes from the pinned SDK's getSupportedThinkingLevels/thinkingLevelMap,
 * then intersected with the actual transport: Copilot Chat Completions with
 * supportsReasoningEffort false and no thinking format stay Default-only,
 * and documented Google level/budget gaps are excluded. Off is offered only
 * when the matching transport can actually disable. Compatible endpoints stay
 * Default-only until paired thinking metadata exists. Neither helper reads
 * credentials or contacts the network.
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { MIN_ANSWER_TOKENS, thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options";
import {
  compatibleThinkingPair,
  resolveOfflineModel
} from "./providers.mjs";

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

const EFFORT_SET = new Set(REASONING_EFFORTS);
const LEVEL_LABELS = Object.freeze({
  default: "Default",
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max"
});

const ERROR_INVALID = "reasoning effort is invalid";
const ERROR_UNSUPPORTED = "reasoning effort is not supported for this model";
const ERROR_METADATA = "compatible model thinking metadata is invalid";
const ERROR_BUDGET = "reasoning budget exceeds the configured output limit";

const DEFAULT_CHOICE = Object.freeze({ value: "default", label: "Default" });
const DEFAULT_ONLY = Object.freeze({
  configurable: false,
  choices: [DEFAULT_CHOICE]
});

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} advisor
 */
export function readReasoningEffort(advisor) {
  if (!isObject(advisor) || advisor.reasoningEffort == null) return "default";
  return advisor.reasoningEffort;
}

/**
 * @param {unknown} model
 */
function usesAnthropicBudget(model) {
  return model?.api === "anthropic-messages" && model?.compat?.forceAdaptiveThinking !== true;
}

/**
 * @param {unknown} model
 */
function usesGoogleLevel(model) {
  if (model?.api !== "google-generative-ai") return false;
  const id = String(model.id ?? "").toLowerCase();
  return (
    /gemini-3(?:\.\d+)?-pro/.test(id) ||
    /gemini-3(?:\.\d+)?-flash/.test(id) ||
    id === "gemini-flash-latest" ||
    id === "gemini-flash-lite-latest" ||
    /gemma-?4/.test(id)
  );
}

/**
 * @param {unknown} model
 */
function usesGoogleBudget(model) {
  return model?.api === "google-generative-ai" && !usesGoogleLevel(model);
}

/**
 * Token budgets from the pinned Google adapter, not a universal table.
 *
 * @param {{ id?: string }} model
 * @param {string} level
 */
function googleBudgetForLevel(model, level) {
  const id = String(model.id ?? "");
  if (id.includes("2.5-pro")) {
    return { minimal: 128, low: 2048, medium: 8192, high: 32768 }[level];
  }
  if (id.includes("2.5-flash-lite")) {
    return { minimal: 512, low: 2048, medium: 8192, high: 24576 }[level];
  }
  if (id.includes("2.5-flash")) {
    return { minimal: 128, low: 2048, medium: 8192, high: 24576 }[level];
  }
  return -1;
}

/**
 * @param {string} value
 */
function displayNative(value) {
  const lower = value.toLowerCase();
  if (LEVEL_LABELS[lower]) return LEVEL_LABELS[lower];
  if (lower === "none") return "None";
  if (lower === "disabled") return "Disabled";
  if (lower === "enabled") return "Enabled";
  return value;
}

/** Documented Google gaps the SDK catalog still lists. Exact model ids only. */
const GOOGLE_UNSUPPORTED_LEVELS = Object.freeze({
  "gemini-2.5-pro": Object.freeze(["off"]),
  "gemini-3.7-flash": Object.freeze(["minimal"]),
  "gemini-3.8-flash": Object.freeze(["minimal"]),
  "gemini-3.1-flash-lite-image": Object.freeze(["low", "medium"])
});

/**
 * @param {import("@earendil-works/pi-ai").Model} model
 * @param {string} level
 */
function googleLevelAllowed(model, level) {
  if (model?.api !== "google-generative-ai") return true;
  const blocked = GOOGLE_UNSUPPORTED_LEVELS[String(model.id ?? "").toLowerCase()];
  return !blocked || !blocked.includes(level);
}

/**
 * Chat Completions serialize thinking only with supportsReasoningEffort or a
 * non-openai thinkingFormat. Copilot Gemini has neither.
 *
 * @param {import("@earendil-works/pi-ai").Model} model
 */
function openaiCompletionsTransmitsThinking(model) {
  if (model?.api !== "openai-completions") return true;
  if (model.compat?.supportsReasoningEffort === true) return true;
  const format = model.compat?.thinkingFormat;
  return typeof format === "string" && format.length > 0 && format !== "openai";
}

/**
 * Enable-only transports (ZAI / Moonshot deepseek) send thinking.type only.
 *
 * @param {import("@earendil-works/pi-ai").Model} model
 */
function isEnableOnlyThinking(model) {
  if (model?.compat?.supportsReasoningEffort === true) return false;
  const format = model?.compat?.thinkingFormat;
  return format === "zai" || format === "deepseek";
}

/**
 * Anthropic adaptive native effort. Minimal is Low on the wire.
 *
 * @param {string} level
 */
function anthropicAdaptiveEffort(level) {
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium") return "medium";
  if (level === "high") return "high";
  return "high";
}

/**
 * Google thinkingLevel sent by streamSimple for Gemini 3 / Gemma 4.
 *
 * @param {import("@earendil-works/pi-ai").Model} model
 * @param {string} level
 */
function googleNativeLevel(model, level) {
  const id = String(model.id ?? "").toLowerCase();
  if (/gemini-3(?:\.\d+)?-pro/.test(id)) {
    if (level === "minimal" || level === "low") return "LOW";
    if (level === "medium" || level === "high") return "HIGH";
    return undefined;
  }
  if (/gemma-?4/.test(id)) {
    if (level === "minimal" || level === "low") return "MINIMAL";
    if (level === "medium" || level === "high") return "HIGH";
    return undefined;
  }
  if (level === "minimal") return "MINIMAL";
  if (level === "low") return "LOW";
  if (level === "medium") return "MEDIUM";
  if (level === "high") return "HIGH";
  return undefined;
}

/**
 * @param {{ value: string, label: string, effective?: string }} choice
 * @param {string} title
 * @param {string} wire
 */
function applyAlias(choice, title, wire) {
  choice.effective = wire;
  if (wire.toLowerCase() !== choice.value) {
    choice.label = `${title} — sent as ${displayNative(wire)}`;
  }
}

/**
 * Off is a verified disable, not merely an omitted option. Codex completeSimple
 * maps off to an omitted reasoning field, which does not disable; the adapter
 * does disable when complete() sends reasoningEffort "none". Google 2.5 Pro
 * cannot disable despite the SDK listing Off.
 *
 * @param {import("@earendil-works/pi-ai").Model} model
 */
function offIsDisableable(model) {
  if (!model?.reasoning) return false;
  if (model.thinkingLevelMap?.off === null) return false;
  if (!googleLevelAllowed(model, "off")) return false;
  return getSupportedThinkingLevels(model).includes("off");
}

/**
 * @param {import("@earendil-works/pi-ai").Model} model
 * @param {string} level
 */
function choiceForLevel(model, level) {
  const title = LEVEL_LABELS[level] ?? level;
  const mapped = model.thinkingLevelMap?.[level];
  /** @type {{ value: string, label: string, effective?: string }} */
  const choice = { value: level, label: title };
  if (isEnableOnlyThinking(model)) {
    applyAlias(choice, title, level === "off" ? "disabled" : "enabled");
    return choice;
  }
  if (typeof mapped === "string") {
    applyAlias(choice, title, mapped);
    return choice;
  }
  if (model.api === "anthropic-messages" && model.compat?.forceAdaptiveThinking === true) {
    applyAlias(choice, title, level === "off" ? "disabled" : anthropicAdaptiveEffort(level));
    return choice;
  }
  if (level !== "off" && usesAnthropicBudget(model)) {
    const budget = thinkingBudgetForLevel(/** @type {import("@earendil-works/pi-ai").ThinkingLevel} */ (level));
    choice.label = `${title} — ${budget} tokens`;
    choice.effective = String(budget);
    return choice;
  }
  if (level !== "off" && usesGoogleBudget(model)) {
    const budget = googleBudgetForLevel(model, level);
    if (budget === -1) {
      choice.effective = "-1";
      choice.label = `${title} — dynamic`;
      return choice;
    }
    if (typeof budget === "number" && budget > 0) {
      choice.label = `${title} — ${budget} tokens`;
      choice.effective = String(budget);
    }
    return choice;
  }
  if (level !== "off" && usesGoogleLevel(model)) {
    const native = googleNativeLevel(model, level);
    if (native) applyAlias(choice, title, native);
    return choice;
  }
  if (level === "off") {
    if (model.api === "openai-codex-responses") applyAlias(choice, title, "none");
    else if (model.api === "anthropic-messages") applyAlias(choice, title, "disabled");
    else if (model.api === "google-generative-ai") applyAlias(choice, title, "disabled");
  }
  return choice;
}

/**
 * @param {import("@earendil-works/pi-ai").Model} model
 */
function modelChoices(model) {
  if (!model?.reasoning) return DEFAULT_ONLY;
  if (!openaiCompletionsTransmitsThinking(model)) return DEFAULT_ONLY;
  const levels = getSupportedThinkingLevels(model).filter((level) => {
    if (!googleLevelAllowed(model, level)) return false;
    if (level === "off") return offIsDisableable(model);
    return true;
  });
  const choices = [DEFAULT_CHOICE, ...levels.map((level) => choiceForLevel(model, level))];
  return { configurable: choices.length > 1, choices };
}

/**
 * @param {unknown} providerSlot
 * @param {unknown} modelId
 */
function resolveForChoices(providerSlot, modelId) {
  const resolved = resolveOfflineModel(providerSlot, modelId);
  if (resolved.thinkingError) {
    return { ...DEFAULT_ONLY, thinkingError: resolved.thinkingError };
  }
  if (!resolved.model) return DEFAULT_ONLY;
  if (isObject(providerSlot) && providerSlot.provider === "openai-compatible") {
    const meta = isObject(providerSlot.models) ? providerSlot.models[String(modelId)] : undefined;
    const thinking = compatibleThinkingPair(meta);
    if (thinking.error) return { ...DEFAULT_ONLY, thinkingError: thinking.error };
    if (!thinking.pair || !resolved.model.reasoning) return DEFAULT_ONLY;
  }
  return modelChoices(resolved.model);
}

/**
 * @param {unknown} providerSlot
 * @param {unknown} modelId
 * @returns {Promise<{ configurable: boolean, choices: Array<{ value: string, label: string, effective?: string }> }>}
 */
export async function getReasoningChoices(providerSlot, modelId) {
  const result = resolveForChoices(providerSlot, modelId);
  return { configurable: result.configurable, choices: result.choices };
}

/**
 * @param {import("@earendil-works/pi-ai").Model} model
 * @param {string} effort
 * @param {unknown} maxOutputTokens
 */
function budgetError(model, effort, maxOutputTokens) {
  if (effort === "default" || effort === "off") return null;
  const requested = Number.isInteger(maxOutputTokens) ? /** @type {number} */ (maxOutputTokens) : 1_500;
  const ceiling = Math.min(requested, Number.isInteger(model.maxTokens) ? model.maxTokens : requested);
  if (usesAnthropicBudget(model)) {
    const budget = thinkingBudgetForLevel(/** @type {import("@earendil-works/pi-ai").ThinkingLevel} */ (effort));
    if (budget + MIN_ANSWER_TOKENS > ceiling) return ERROR_BUDGET;
  }
  if (usesGoogleBudget(model)) {
    const budget = googleBudgetForLevel(model, effort);
    if (typeof budget === "number" && budget > 0 && budget + MIN_ANSWER_TOKENS > ceiling) {
      return ERROR_BUDGET;
    }
  }
  return null;
}

/**
 * @param {unknown} providerSlot
 * @param {unknown} advisor
 * @param {unknown} maxOutputTokens
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function validateReasoning(providerSlot, advisor, maxOutputTokens) {
  const effort = readReasoningEffort(advisor);
  if (typeof effort !== "string" || !EFFORT_SET.has(effort)) {
    return { ok: false, error: ERROR_INVALID };
  }
  const modelId = isObject(advisor) && typeof advisor.model === "string" ? advisor.model : "";
  const resolved = resolveOfflineModel(providerSlot, modelId);
  if (resolved.thinkingError) return { ok: false, error: ERROR_METADATA };
  if (isObject(providerSlot) && providerSlot.provider === "openai-compatible") {
    const meta = isObject(providerSlot.models) ? providerSlot.models[modelId] : undefined;
    const thinking = compatibleThinkingPair(meta);
    if (thinking.error) return { ok: false, error: ERROR_METADATA };
  }
  if (effort === "default") return { ok: true };
  if (!resolved.model) return { ok: false, error: ERROR_UNSUPPORTED };
  const available = resolveForChoices(providerSlot, modelId);
  if (!available.choices.some((choice) => choice.value === effort)) {
    return { ok: false, error: ERROR_UNSUPPORTED };
  }
  const overBudget = budgetError(resolved.model, effort, maxOutputTokens);
  if (overBudget) return { ok: false, error: overBudget };
  return { ok: true };
}

/**
 * Compatible Default must not grow thinkingFormat/thinkingLevelMap onto the
 * generation model; those fields change SDK serialization even without effort.
 *
 * @param {import("@earendil-works/pi-ai").Model} model
 */
function modelForDefaultGeneration(model) {
  if (model?.provider !== "openai-compatible") return model;
  if (!model.compat?.thinkingFormat && model.thinkingLevelMap == null) return model;
  const compat = { ...model.compat, supportsReasoningEffort: false };
  delete compat.thinkingFormat;
  const next = { ...model, compat };
  delete next.thinkingLevelMap;
  return next;
}

/**
 * Map a validated effort onto complete vs completeSimple. Default keeps the
 * current raw complete() options and, for compatible models, withholds thinking
 * metadata so Default serialization matches the pre-setting body. Explicit
 * levels use completeSimple only when that adapter path will not expand
 * maxTokens. Codex Off cannot use completeSimple: omitting reasoningEffort
 * does not disable thinking. The Codex adapter also never serializes
 * maxTokens; that existing Default gap is preserved rather than inventing an
 * unsupported wire field.
 *
 * @param {import("@earendil-works/pi-ai").Model} model
 * @param {unknown} advisor
 * @param {Record<string, unknown>} baseOptions
 * @returns {{ method: "complete" | "completeSimple", options: Record<string, unknown>, model: import("@earendil-works/pi-ai").Model }}
 */
export function planReasoningCompletion(model, advisor, baseOptions) {
  const effort = readReasoningEffort(advisor);
  if (effort === "default") {
    return { method: "complete", options: baseOptions, model: modelForDefaultGeneration(model) };
  }
  if (effort === "off" && model.api === "openai-codex-responses") {
    return {
      method: "complete",
      options: { ...baseOptions, reasoningEffort: "none" },
      model
    };
  }
  if (effort !== "off" && usesAnthropicBudget(model)) {
    return {
      method: "complete",
      options: {
        ...baseOptions,
        thinkingEnabled: true,
        thinkingBudgetTokens: thinkingBudgetForLevel(
          /** @type {import("@earendil-works/pi-ai").ThinkingLevel} */ (effort)
        )
      },
      model
    };
  }
  if (effort === "off") {
    return { method: "completeSimple", options: { ...baseOptions }, model };
  }
  return {
    method: "completeSimple",
    options: { ...baseOptions, reasoning: effort },
    model
  };
}
