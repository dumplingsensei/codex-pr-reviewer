import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// node_modules/@earendil-works/pi-ai/dist/models.js
var EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function getSupportedThinkingLevels(model) {
  if (!model.reasoning)
    return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null)
      return false;
    if (level === "xhigh" || level === "max")
      return mapped !== void 0;
    return true;
  });
}

// node_modules/@earendil-works/pi-ai/dist/api/simple-options.js
var MIN_ANSWER_TOKENS = 1024;
var DEFAULT_THINKING_BUDGETS = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384
};
function clampReasoning(effort) {
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}
function thinkingBudgetForLevel(reasoningLevel, customBudgets) {
  const budgets = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets };
  const level = clampReasoning(reasoningLevel);
  return budgets[level];
}

// ../../plugins/cross-model-advisor/src/reasoning.mjs
import {
  compatibleThinkingPair,
  resolveOfflineModel
} from "./providers.mjs";
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
var EFFORT_SET = new Set(REASONING_EFFORTS);
var LEVEL_LABELS = Object.freeze({
  default: "Default",
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max"
});
var ERROR_INVALID = "reasoning effort is invalid";
var ERROR_UNSUPPORTED = "reasoning effort is not supported for this model";
var ERROR_METADATA = "compatible model thinking metadata is invalid";
var ERROR_BUDGET = "reasoning budget exceeds the configured output limit";
var DEFAULT_CHOICE = Object.freeze({ value: "default", label: "Default" });
var DEFAULT_ONLY = Object.freeze({
  configurable: false,
  choices: [DEFAULT_CHOICE]
});
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readReasoningEffort(advisor) {
  if (!isObject(advisor) || advisor.reasoningEffort == null) return "default";
  return advisor.reasoningEffort;
}
function usesAnthropicBudget(model) {
  return model?.api === "anthropic-messages" && model?.compat?.forceAdaptiveThinking !== true;
}
function usesGoogleLevel(model) {
  if (model?.api !== "google-generative-ai") return false;
  const id = String(model.id ?? "").toLowerCase();
  return /gemini-3(?:\.\d+)?-pro/.test(id) || /gemini-3(?:\.\d+)?-flash/.test(id) || id === "gemini-flash-latest" || id === "gemini-flash-lite-latest" || /gemma-?4/.test(id);
}
function usesGoogleBudget(model) {
  return model?.api === "google-generative-ai" && !usesGoogleLevel(model);
}
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
function displayNative(value) {
  const lower = value.toLowerCase();
  if (LEVEL_LABELS[lower]) return LEVEL_LABELS[lower];
  if (lower === "none") return "None";
  if (lower === "disabled") return "Disabled";
  if (lower === "enabled") return "Enabled";
  return value;
}
var GOOGLE_UNSUPPORTED_LEVELS = Object.freeze({
  "gemini-2.5-pro": Object.freeze(["off"]),
  "gemini-3.7-flash": Object.freeze(["minimal"]),
  "gemini-3.8-flash": Object.freeze(["minimal"]),
  "gemini-3.1-flash-lite-image": Object.freeze(["low", "medium"])
});
function googleLevelAllowed(model, level) {
  if (model?.api !== "google-generative-ai") return true;
  const blocked = GOOGLE_UNSUPPORTED_LEVELS[String(model.id ?? "").toLowerCase()];
  return !blocked || !blocked.includes(level);
}
function openaiCompletionsTransmitsThinking(model) {
  if (model?.api !== "openai-completions") return true;
  if (model.compat?.supportsReasoningEffort === true) return true;
  const format = model.compat?.thinkingFormat;
  return typeof format === "string" && format.length > 0 && format !== "openai";
}
function isEnableOnlyThinking(model) {
  if (model?.compat?.supportsReasoningEffort === true) return false;
  const format = model?.compat?.thinkingFormat;
  return format === "zai" || format === "deepseek";
}
function anthropicAdaptiveEffort(level) {
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium") return "medium";
  if (level === "high") return "high";
  return "high";
}
function googleNativeLevel(model, level) {
  const id = String(model.id ?? "").toLowerCase();
  if (/gemini-3(?:\.\d+)?-pro/.test(id)) {
    if (level === "minimal" || level === "low") return "LOW";
    if (level === "medium" || level === "high") return "HIGH";
    return void 0;
  }
  if (/gemma-?4/.test(id)) {
    if (level === "minimal" || level === "low") return "MINIMAL";
    if (level === "medium" || level === "high") return "HIGH";
    return void 0;
  }
  if (level === "minimal") return "MINIMAL";
  if (level === "low") return "LOW";
  if (level === "medium") return "MEDIUM";
  if (level === "high") return "HIGH";
  return void 0;
}
function applyAlias(choice, title, wire) {
  choice.effective = wire;
  if (wire.toLowerCase() !== choice.value) {
    choice.label = `${title} — sent as ${displayNative(wire)}`;
  }
}
function offIsDisableable(model) {
  if (!model?.reasoning) return false;
  if (model.thinkingLevelMap?.off === null) return false;
  if (!googleLevelAllowed(model, "off")) return false;
  return getSupportedThinkingLevels(model).includes("off");
}
function choiceForLevel(model, level) {
  const title = LEVEL_LABELS[level] ?? level;
  const mapped = model.thinkingLevelMap?.[level];
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
    const budget = thinkingBudgetForLevel(
      /** @type {import("@earendil-works/pi-ai").ThinkingLevel} */
      level
    );
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
function resolveForChoices(providerSlot, modelId) {
  const resolved = resolveOfflineModel(providerSlot, modelId);
  if (resolved.thinkingError) {
    return { ...DEFAULT_ONLY, thinkingError: resolved.thinkingError };
  }
  if (!resolved.model) return DEFAULT_ONLY;
  if (isObject(providerSlot) && providerSlot.provider === "openai-compatible") {
    const meta = isObject(providerSlot.models) ? providerSlot.models[String(modelId)] : void 0;
    const thinking = compatibleThinkingPair(meta);
    if (thinking.error) return { ...DEFAULT_ONLY, thinkingError: thinking.error };
    if (!thinking.pair || !resolved.model.reasoning) return DEFAULT_ONLY;
  }
  return modelChoices(resolved.model);
}
async function getReasoningChoices(providerSlot, modelId) {
  const result = resolveForChoices(providerSlot, modelId);
  return { configurable: result.configurable, choices: result.choices };
}
function budgetError(model, effort, maxOutputTokens) {
  if (effort === "default" || effort === "off") return null;
  const requested = Number.isInteger(maxOutputTokens) ? (
    /** @type {number} */
    maxOutputTokens
  ) : 1500;
  const ceiling = Math.min(requested, Number.isInteger(model.maxTokens) ? model.maxTokens : requested);
  if (usesAnthropicBudget(model)) {
    const budget = thinkingBudgetForLevel(
      /** @type {import("@earendil-works/pi-ai").ThinkingLevel} */
      effort
    );
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
async function validateReasoning(providerSlot, advisor, maxOutputTokens) {
  const effort = readReasoningEffort(advisor);
  if (typeof effort !== "string" || !EFFORT_SET.has(effort)) {
    return { ok: false, error: ERROR_INVALID };
  }
  const modelId = isObject(advisor) && typeof advisor.model === "string" ? advisor.model : "";
  const resolved = resolveOfflineModel(providerSlot, modelId);
  if (resolved.thinkingError) return { ok: false, error: ERROR_METADATA };
  if (isObject(providerSlot) && providerSlot.provider === "openai-compatible") {
    const meta = isObject(providerSlot.models) ? providerSlot.models[modelId] : void 0;
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
function modelForDefaultGeneration(model) {
  if (model?.api === "openai-codex-responses" && model.reasoning) {
    return { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } };
  }
  if (model?.provider !== "openai-compatible") return model;
  if (!model.compat?.thinkingFormat && model.thinkingLevelMap == null) return model;
  const compat = { ...model.compat, supportsReasoningEffort: false };
  delete compat.thinkingFormat;
  const next = { ...model, compat };
  delete next.thinkingLevelMap;
  return next;
}
function planReasoningCompletion(model, advisor, baseOptions) {
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
          /** @type {import("@earendil-works/pi-ai").ThinkingLevel} */
          effort
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
export {
  REASONING_EFFORTS,
  getReasoningChoices,
  planReasoningCompletion,
  readReasoningEffort,
  validateReasoning
};
