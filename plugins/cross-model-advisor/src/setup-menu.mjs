/**
 * Terminal settings menu. Drafts stay in memory until an explicit Save. The
 * review gate reads the saved file at every Stop, so a save applies from the
 * next reviewed turn in every session. OAuth login/logout spawn the existing
 * auth helper after Save.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_VERSION,
  DEFAULT_LIMITS,
  THINKING_FORMATS,
  THINKING_LEVELS,
  validateConfig
} from "./config.mjs";
import { getReasoningChoices } from "./reasoning.mjs";
import { sanitizeText } from "./session/sanitize.mjs";
import {
  DEFAULT_MODEL_LIMIT,
  MAX_MODEL_LIMIT,
  SetupError,
  getModels,
  getProviderCatalog,
  readConfigState,
  saveConfig
} from "./setup-store.mjs";
import { formatMenuCommand, resolvedPath } from "./terminal-command.mjs";

const IDENTIFIER_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ACTION_ADD = "Add advisor";
const ACTION_PROVIDERS = "Provider accounts";
const ACTION_GATE = "Gate settings";
const ACTION_SAVE = "Save";
const ACTION_QUIT = "Quit";
const AUTH_CHILD_KILL_MS = 2000;

/**
 * @param {unknown} error
 */
function isAbortError(error) {
  return Boolean(
    error && (error.code === "abort" || error.name === "AbortError" || error.code === "ABORT_ERR")
  );
}

/**
 * @param {unknown} reason
 */
function abortError(reason) {
  if (isAbortError(reason) && reason instanceof Error) return reason;
  const error = new Error("aborted");
  error.name = "AbortError";
  error.code = "abort";
  if (reason instanceof Error) error.cause = reason;
  return error;
}

/**
 * @param {unknown} value
 */
function display(value) {
  return sanitizeText(String(value ?? "")).slice(0, 500);
}

/**
 * @param {unknown} value
 */
function clone(value) {
  return structuredClone(value);
}

function emptyConfig() {
  return {
    version: CONFIG_VERSION,
    providers: {},
    advisors: [],
    exclude: [],
    limits: { ...DEFAULT_LIMITS }
  };
}

/**
 * @param {string} name
 * @param {string} fromUrl
 */
function siblingExecutable(name, fromUrl = import.meta.url) {
  const here = path.dirname(fileURLToPath(fromUrl));
  if (path.basename(here) === "modules") return path.join(here, "..", name);
  return path.join(here, name);
}

/**
 * Helper labels already include aliases. Treat SDK -1 as dynamic, never as a
 * negative token allocation.
 *
 * @param {{ value: string, label: string, effective?: string }[]} choices
 * @param {string} value
 */
function effortLabel(choices, value) {
  const found = choices.find((choice) => choice.value === value);
  if (found?.label) return found.label;
  return value || "default";
}

/**
 * @param {object} ctx
 */
function isDirty(ctx) {
  if (!ctx.saved) {
    return (
      ctx.draft.advisors.length > 0 || Object.keys(ctx.draft.providers).length > 0 || gateKey(ctx.draft.gate) !== gateKey(undefined)
    );
  }
  return (
    JSON.stringify({ providers: ctx.draft.providers, advisors: ctx.draft.advisors, gate: gateKey(ctx.draft.gate) }) !==
    JSON.stringify({ providers: ctx.saved.providers, advisors: ctx.saved.advisors, gate: gateKey(ctx.saved.gate) })
  );
}

/**
 * Gate settings in a fixed key order, missing ones as their defaults, so an
 * unedited gate compares equal however it was built.
 *
 * @param {any} gate
 */
function gateKey(gate) {
  return JSON.stringify({
    mode: gate?.mode ?? "block",
    maxRounds: gate?.maxRounds ?? 2,
    autoOn: gate?.autoOn ?? [],
    skipWhenOnly: gate?.skipWhenOnly ?? []
  });
}

/**
 * @param {object} ctx
 * @param {string} slotId
 */
function slotOnDisk(ctx, slotId) {
  return Boolean(ctx.saved?.providers?.[slotId]);
}

/**
 * @param {Record<string, unknown>} providers
 * @param {string} slotId
 * @param {string} kind
 */
function suggestedSlot(providerId, kind, used) {
  const stems = {
    "openai-codex": "codex",
    "github-copilot": "copilot",
    "openai-compatible": "compatible"
  };
  const stem = stems[providerId] || providerId;
  const base = kind === "oauth" ? `${stem}-login` : `${stem}-api`;
  if (IDENTIFIER_RE.test(base) && !used.has(base) && !FORBIDDEN_KEYS.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const id = `${base}-${n}`;
    if (IDENTIFIER_RE.test(id) && !used.has(id) && !FORBIDDEN_KEYS.has(id)) return id;
  }
  return "";
}

/**
 * @param {object} ctx
 */
function usedSlotIds(ctx) {
  return new Set(Object.keys(ctx.draft.providers));
}

/**
 * @param {object} ctx
 */
function usedAdvisorNames(ctx) {
  return new Set(ctx.draft.advisors.map((advisor) => advisor.name));
}

/**
 * @param {object} ctx
 */
function homeTitle(ctx) {
  const dirty = isDirty(ctx) ? "Unsaved changes" : "Saved";
  return `Cross-model advisors\nSettings (${dirty}): ${display(ctx.configPath)}\nSaved settings apply from the next reviewed turn in every session.`;
}

/**
 * @param {object} ctx
 * @param {object} advisor
 */
function advisorDescription(ctx, advisor) {
  const lines = [
    `Configured: ${advisor.provider} · ${advisor.model} · ${advisor.reasoningEffort}`
  ];
  if (ctx.staleEffort.has(advisor.name)) {
    lines.push("Reasoning effort needs reselection before save.");
  }
  return lines.join("\n");
}

/**
 * @param {object} ctx
 */
function homeItems(ctx) {
  /** @type {{ value: string, label: string, description?: string }[]} */
  const items = ctx.draft.advisors.map((advisor) => ({
    value: advisor.name,
    label: `${advisor.enabled ? "[x]" : "[ ]"}  ${advisor.name}`,
    description: advisorDescription(ctx, advisor)
  }));
  items.push({ value: ACTION_ADD, label: ACTION_ADD });
  items.push({ value: ACTION_PROVIDERS, label: ACTION_PROVIDERS });
  items.push({ value: ACTION_GATE, label: ACTION_GATE, description: gateSummary(ctx) });
  items.push({ value: ACTION_SAVE, label: ACTION_SAVE });
  items.push({ value: ACTION_QUIT, label: ACTION_QUIT });
  return items;
}

/**
 * @param {object} ctx
 * @param {string} name
 */
function toggleAdvisor(ctx, name) {
  const advisor = ctx.draft.advisors.find((entry) => entry.name === name);
  if (!advisor) return;
  advisor.enabled = advisor.enabled !== true;
}

/**
 * @param {object} ctx
 */
async function confirmDiscard(ctx) {
  if (!isDirty(ctx)) return true;
  const picked = await ctx.ui.choose({
    title: "Unsaved changes",
    items: [
      { value: "discard", label: "Discard" },
      { value: "return", label: "Return" }
    ]
  });
  return picked?.action === "select" && picked.value === "discard";
}

/**
 * @param {object} ctx
 */
async function reloadFromDisk(ctx) {
  const state = await ctx.readConfigState({ env: ctx.env });
  ctx.configPath = state.path;
  ctx.revision = state.revision;
  ctx.configError = state.configError;
  if (state.config) {
    ctx.saved = clone(state.config);
    ctx.draft = clone(state.config);
  } else {
    ctx.saved = null;
    ctx.draft = emptyConfig();
  }
  ctx.staleEffort.clear();
}

/**
 * @param {object} ctx
 */
async function handleRevisionConflict(ctx) {
  const picked = await ctx.ui.choose({
    title: "Configuration changed on disk",
    items: [
      { value: "reload", label: "Reload from disk" },
      { value: "discard", label: "Discard" },
      { value: "return", label: "Return" }
    ]
  });
  if (picked == null || picked.value === "return") return;
  await reloadFromDisk(ctx);
}

/**
 * @param {object} ctx
 * @returns {Promise<{ ok: true, path: string, revision: string } | null>}
 */
async function saveDraft(ctx) {
  if (ctx.staleEffort.size > 0) {
    const names = [...ctx.staleEffort].join(", ");
    await ctx.ui.notice({
      title: "Not saved",
      text: `Not saved: reselect reasoning effort for ${names} before save.`
    });
    return null;
  }
  let validated;
  try {
    validated = validateConfig(ctx.draft);
  } catch (error) {
    await ctx.ui.notice({
      title: "Not saved",
      text: `Not saved: ${display(error?.message || "invalid configuration")}`
    });
    return null;
  }
  try {
    const saved = await ctx.saveConfig({ revision: ctx.revision, config: validated }, { env: ctx.env });
    ctx.saved = clone(validated);
    ctx.draft = clone(validated);
    ctx.revision = saved.revision;
    ctx.configError = null;
    ctx.staleEffort.clear();
    return saved;
  } catch (error) {
    if (error instanceof SetupError && error.code === "revision") {
      await ctx.ui.notice({
        title: "Not saved",
        text: "Not saved: configuration changed on disk."
      });
      await handleRevisionConflict(ctx);
      return null;
    }
    await ctx.ui.notice({
      title: "Not saved",
      text: `Not saved: ${display(error?.message || "save failed")}`
    });
    return null;
  }
}

/**
 * @param {object} ctx
 */
async function saveDefaults(ctx) {
  const saved = await saveDraft(ctx);
  if (!saved) return;
  await ctx.ui.notice({ title: "Saved", text: "Saved. Applies from the next reviewed turn." });
}

/**
 * @param {object} ctx
 * @param {{ title: string, value?: string, multiline?: boolean, maxBytes?: number, validate?: (text: string) => string | null }} spec
 * @returns {Promise<string | null>}
 */
async function promptText(ctx, spec) {
  const raw = await ctx.ui.text({
    title: spec.title,
    value: spec.value ?? "",
    multiline: spec.multiline === true,
    maxBytes: spec.maxBytes
  });
  if (raw == null) return null;
  if (!spec.validate) return raw;
  const error = spec.validate(raw);
  if (!error) return raw;
  await ctx.ui.notice({ title: spec.title, text: error });
  return promptText(ctx, spec);
}

/**
 * @param {object} ctx
 * @param {string} title
 * @param {number | undefined} current
 * @returns {Promise<number | null>}
 */
async function promptInteger(ctx, title, current) {
  const raw = await promptText(ctx, {
    title,
    value: current == null ? "" : String(current),
    validate: (value) => (/^[0-9]{1,8}$/.test(value.trim()) && Number(value.trim()) >= 1 ? null : "Enter a positive integer.")
  });
  if (raw == null) return null;
  return Number(raw.trim());
}

/**
 * @param {string} value
 */
function identifierError(value) {
  const text = value.trim();
  if (!IDENTIFIER_RE.test(text) || FORBIDDEN_KEYS.has(text)) {
    return "Use a restricted identifier: lowercase letter, then letters, digits, or dashes (max 64).";
  }
  return null;
}

/**
 * @param {object} ctx
 * @param {object} advisor
 */
async function syncEffortAfterModelChange(ctx, advisor) {
  const slot = ctx.draft.providers[advisor.provider];
  let choices;
  try {
    choices = await ctx.getReasoningChoices(slot, advisor.model);
  } catch {
    choices = { configurable: false, choices: [{ value: "default", label: "Default" }] };
  }
  const allowed = new Set(choices.choices.map((choice) => choice.value));
  if (!allowed.has(advisor.reasoningEffort)) {
    ctx.staleEffort.add(advisor.name);
  } else {
    ctx.staleEffort.delete(advisor.name);
  }
  return choices;
}

/**
 * @param {object} ctx
 * @param {string} slotId
 * @param {string} current
 */
async function pickCatalogModel(ctx, slotId, current) {
  const slot = ctx.draft.providers[slotId];
  if (!slot) return null;
  if (slot.kind === "api" && slot.provider === "openai-compatible") {
    const ids = Object.keys(slot.models || {});
    if (ids.length === 0) {
      await ctx.ui.notice({
        title: "Model",
        text: "Add a model on this compatible provider account first."
      });
      return null;
    }
    const picked = await ctx.ui.choose({
      title: "Model",
      search: true,
      initial: current,
      items: ids.map((id) => ({
        value: id,
        label: id === current ? `${id} (current)` : id
      }))
    });
    if (picked == null) return null;
    return picked.value;
  }
  const picked = await ctx.ui.choose({
    title: "Model",
    search: true,
    initial: current,
    load: async ({ query, offset, limit }) => {
      const pageLimit = Math.min(Math.max(1, limit || DEFAULT_MODEL_LIMIT), MAX_MODEL_LIMIT);
      try {
        const result = await ctx.getModels(slot.provider, {
          q: query || null,
          offset: offset || 0,
          limit: pageLimit
        });
        const items = result.models.map((model) => ({
          value: model.id,
          label: model.id === current ? `${model.name || model.id} (current)` : model.name || model.id,
          description: model.id
        }));
        return { items, total: result.total };
      } catch {
        return { items: [], total: 0 };
      }
    }
  });
  if (picked == null) return null;
  return picked.value;
}

/**
 * @param {object} ctx
 * @param {object} advisor
 */
async function pickEffort(ctx, advisor) {
  const slot = ctx.draft.providers[advisor.provider];
  let choices;
  try {
    choices = await ctx.getReasoningChoices(slot, advisor.model);
  } catch {
    choices = { configurable: false, choices: [{ value: "default", label: "Default" }] };
  }
  if (!choices.configurable && advisor.reasoningEffort === "default") {
    await ctx.ui.notice({ title: "Reasoning effort", text: "Not configurable" });
    return;
  }
  const picked = await ctx.ui.choose({
    title: "Reasoning effort",
    initial: advisor.reasoningEffort,
    items: choices.choices.map((choice) => ({
      value: choice.value,
      label: choice.label
    }))
  });
  if (picked == null) return;
  advisor.reasoningEffort = picked.value;
  ctx.staleEffort.delete(advisor.name);
}

/**
 * @param {object} ctx
 * @param {object} advisor
 */
async function editAdvisor(ctx, advisor) {
  while (true) {
    const slot = ctx.draft.providers[advisor.provider];
    let effortText = advisor.reasoningEffort;
    try {
      const choices = await ctx.getReasoningChoices(slot, advisor.model);
      effortText = choices.configurable
        ? effortLabel(choices.choices, advisor.reasoningEffort)
        : "Not configurable";
    } catch {
      effortText = advisor.reasoningEffort;
    }
    if (ctx.staleEffort.has(advisor.name)) {
      effortText = `${effortText} (reselect before save)`;
    }
    const picked = await ctx.ui.choose({
      title: `Advisor ${advisor.name}`,
      items: [
        { value: "name", label: "Name", description: advisor.name },
        { value: "provider", label: "Provider", description: advisor.provider },
        { value: "model", label: "Model", description: advisor.model },
        { value: "effort", label: "Reasoning effort", description: effortText },
        { value: "instructions", label: "Instructions", description: display(advisor.instructions).slice(0, 80) },
        { value: "remove", label: "Remove" }
      ]
    });
    if (picked == null) return;
    if (picked.value === "name") {
      const next = await promptText(ctx, {
        title: "Advisor name",
        value: advisor.name,
        validate: (value) => {
          const error = identifierError(value);
          if (error) return error;
          const name = value.trim();
          if (name !== advisor.name && usedAdvisorNames(ctx).has(name)) {
            return "Advisor names must be unique.";
          }
          return null;
        }
      });
      if (next == null) continue;
      const name = next.trim();
      if (ctx.staleEffort.has(advisor.name)) {
        ctx.staleEffort.delete(advisor.name);
        ctx.staleEffort.add(name);
      }
      advisor.name = name;
      continue;
    }
    if (picked.value === "provider") {
      const slots = Object.keys(ctx.draft.providers);
      if (slots.length === 0) {
        await ctx.ui.notice({ title: "Provider", text: "Add a provider account first." });
        continue;
      }
      const next = await ctx.ui.choose({
        title: "Provider slot",
        initial: advisor.provider,
        items: slots.map((id) => ({
          value: id,
          label: id,
          description: `${ctx.draft.providers[id].kind} · ${ctx.draft.providers[id].provider}`
        }))
      });
      if (next == null) continue;
      if (next.value !== advisor.provider) {
        advisor.provider = next.value;
        const model = await pickCatalogModel(ctx, advisor.provider, advisor.model);
        if (model) advisor.model = model;
        await syncEffortAfterModelChange(ctx, advisor);
      }
      continue;
    }
    if (picked.value === "model") {
      const model = await pickCatalogModel(ctx, advisor.provider, advisor.model);
      if (model && model !== advisor.model) {
        advisor.model = model;
        await syncEffortAfterModelChange(ctx, advisor);
      }
      continue;
    }
    if (picked.value === "effort") {
      await pickEffort(ctx, advisor);
      continue;
    }
    if (picked.value === "instructions") {
      const next = await promptText(ctx, {
        title: "Instructions",
        value: advisor.instructions,
        multiline: true,
        maxBytes: 8192,
        validate: (value) => {
          if (value.length === 0 || value.length > 8192) return "Instructions must be a nonempty literal string.";
          return null;
        }
      });
      if (next != null) advisor.instructions = next;
      continue;
    }
    if (picked.value === "remove") {
      const last = ctx.draft.advisors.length === 1;
      const ok = await ctx.ui.confirm({
        title: "Remove advisor",
        text: last
          ? `Remove the last advisor ${advisor.name}? Empty configurations are valid and start no reviews.`
          : `Remove advisor ${advisor.name}?`
      });
      if (ok !== true) continue;
      ctx.draft.advisors = ctx.draft.advisors.filter((entry) => entry !== advisor);
      ctx.staleEffort.delete(advisor.name);
      return;
    }
  }
}

/**
 * @param {object} ctx
 */
async function addAdvisor(ctx) {
  const slots = Object.keys(ctx.draft.providers);
  if (slots.length === 0) {
    await ctx.ui.notice({ title: ACTION_ADD, text: "Add a provider account first." });
    return;
  }
  const nameRaw = await promptText(ctx, {
    title: "Advisor name",
    validate: (value) => {
      const error = identifierError(value);
      if (error) return error;
      if (usedAdvisorNames(ctx).has(value.trim())) return "Advisor names must be unique.";
      return null;
    }
  });
  if (nameRaw == null) return;
  const name = nameRaw.trim();
  const slotPick = await ctx.ui.choose({
    title: "Provider slot",
    items: slots.map((id) => ({
      value: id,
      label: id,
      description: `${ctx.draft.providers[id].kind} · ${ctx.draft.providers[id].provider}`
    }))
  });
  if (slotPick == null) return;
  const model = await pickCatalogModel(ctx, slotPick.value, "");
  if (!model) return;
  const instructions = await promptText(ctx, {
    title: "Instructions",
    multiline: true,
    maxBytes: 8192,
    validate: (value) => {
      if (value.length === 0 || value.length > 8192) return "Instructions must be a nonempty literal string.";
      return null;
    }
  });
  if (instructions == null) return;
  const advisor = {
    name,
    provider: slotPick.value,
    model,
    instructions,
    enabled: true,
    reasoningEffort: "default"
  };
  await syncEffortAfterModelChange(ctx, advisor);
  if (ctx.staleEffort.has(advisor.name)) ctx.staleEffort.delete(advisor.name);
  let choices;
  try {
    choices = await ctx.getReasoningChoices(ctx.draft.providers[advisor.provider], advisor.model);
  } catch {
    choices = { configurable: false, choices: [] };
  }
  if (choices.configurable) {
    await pickEffort(ctx, advisor);
  }
  ctx.draft.advisors.push(advisor);
  await editAdvisor(ctx, advisor);
}

/**
 * @param {object} ctx
 * @param {"login" | "logout"} command
 * @param {string} slot
 */
async function runAuthHelper(ctx, command, slot) {
  if (!slotOnDisk(ctx, slot) || ctx.saved?.providers?.[slot]?.kind !== "oauth") {
    await ctx.ui.notice({
      title: command === "login" ? "Login" : "Logout",
      text: "Save this provider slot before login or logout. Discarding later menu edits does not undo a completed login or logout."
    });
    return;
  }
  await ctx.ui.notice({
    title: command === "login" ? "Login" : "Logout",
    text: "This uses the saved slot. Discarding later menu edits does not undo a completed login or logout."
  });
  try {
    await ctx.ui.suspend(() =>
      ctx.login({
        command,
        slot,
        env: ctx.env,
        stdin: ctx.stdin,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        authHelperPath: ctx.authHelperPath,
        signal: ctx.signal
      })
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    await ctx.ui.notice({
      title: command === "login" ? "Login" : "Logout",
      text: display(error?.message || "Auth helper failed.")
    });
  }
}

/**
 * @param {object} meta
 */
function defaultSupportsReasoningEffort(format) {
  return format !== "zai";
}

/**
 * @param {object} ctx
 * @param {object} meta
 * @param {string} modelId
 */
async function editCompatibleMeta(ctx, meta, modelId) {
  while (true) {
    const items = [
      { value: "contextWindow", label: "contextWindow", description: String(meta.contextWindow) },
      { value: "maxTokens", label: "maxTokens", description: String(meta.maxTokens) },
      { value: "reasoning", label: "reasoning", description: meta.reasoning ? "true" : "false" },
      { value: "input", label: "input", description: (meta.input || []).join(", ") },
      {
        value: "thinking",
        label: "Reasoning format",
        description: meta.thinkingFormat
          ? `${meta.thinkingFormat}${meta.supportsReasoningEffort === false ? " · supportsReasoningEffort false" : ""}`
          : "Not set"
      }
    ];
    const picked = await ctx.ui.choose({
      title: `Model ${modelId}`,
      items
    });
    if (picked == null) return meta;
    if (picked.value === "contextWindow" || picked.value === "maxTokens") {
      const next = await promptText(ctx, {
        title: picked.value,
        value: String(meta[picked.value]),
        validate: (value) => (/^[0-9]{1,8}$/.test(value.trim()) ? null : "Enter a positive integer.")
      });
      if (next == null) continue;
      const parsed = Number(next.trim());
      if (parsed < 1) continue;
      meta[picked.value] = parsed;
      continue;
    }
    if (picked.value === "reasoning") {
      const next = await ctx.ui.choose({
        title: "reasoning",
        initial: meta.reasoning ? "true" : "false",
        items: [
          { value: "true", label: "true" },
          { value: "false", label: "false" }
        ]
      });
      if (next == null) continue;
      meta.reasoning = next.value === "true";
      continue;
    }
    if (picked.value === "input") {
      const next = await ctx.ui.choose({
        title: "input",
        multiple: true,
        selected: [...(meta.input || ["text"])],
        items: [
          { value: "text", label: "text" },
          { value: "image", label: "image" }
        ]
      });
      if (next == null) continue;
      const values = next.values || [];
      if (values.length === 0) {
        await ctx.ui.notice({ title: "input", text: "Select at least one of text or image." });
        continue;
      }
      meta.input = values;
      continue;
    }
    if (picked.value === "thinking") {
      const action = await ctx.ui.choose({
        title: "Reasoning format",
        items: [
          { value: "set", label: "Set thinkingFormat and thinkingLevelMap" },
          { value: "clear", label: "Clear optional reasoning metadata" }
        ]
      });
      if (action == null) continue;
      if (action.value === "clear") {
        delete meta.thinkingFormat;
        delete meta.thinkingLevelMap;
        delete meta.supportsReasoningEffort;
        continue;
      }
      const format = await ctx.ui.choose({
        title: "thinkingFormat",
        initial: meta.thinkingFormat,
        items: THINKING_FORMATS.map((value) => ({ value, label: value }))
      });
      if (format == null) continue;
      /** @type {Record<string, string | null>} */
      const mapped = {};
      let cancelled = false;
      for (const level of THINKING_LEVELS) {
        const current =
          meta.thinkingLevelMap && Object.hasOwn(meta.thinkingLevelMap, level)
            ? meta.thinkingLevelMap[level] === null
              ? "null"
              : String(meta.thinkingLevelMap[level])
            : "";
        const raw = await promptText(ctx, {
          title: `thinkingLevelMap.${level}`,
          value: current,
          validate: (value) => {
            const text = value.trim();
            if (text === "null") return null;
            if (text.length === 0 || text.length > 64) return "Enter a native level string or null.";
            for (let i = 0; i < text.length; i += 1) {
              const code = text.charCodeAt(i);
              if (code < 32 || code === 127) return "Enter a native level string or null.";
            }
            return null;
          }
        });
        if (raw == null) {
          cancelled = true;
          break;
        }
        mapped[level] = raw.trim() === "null" ? null : raw.trim();
      }
      if (cancelled) continue;
      meta.thinkingFormat = format.value;
      meta.thinkingLevelMap = mapped;
      const supportDefault = defaultSupportsReasoningEffort(format.value);
      const support = await ctx.ui.choose({
        title: "supportsReasoningEffort",
        initial: meta.supportsReasoningEffort == null ? (supportDefault ? "true" : "false") : meta.supportsReasoningEffort ? "true" : "false",
        items: [
          { value: "true", label: "true" },
          { value: "false", label: "false" }
        ]
      });
      if (support == null) {
        meta.supportsReasoningEffort = supportDefault;
      } else {
        meta.supportsReasoningEffort = support.value === "true";
      }
    }
  }
}

/**
 * @param {object} ctx
 * @param {object} slot
 * @param {string} slotId
 */
async function editCompatibleModels(ctx, slot, slotId) {
  while (true) {
    const ids = Object.keys(slot.models || {});
    const items = ids.map((id) => ({ value: id, label: id }));
    items.push({ value: "add", label: "Add model" });
    const picked = await ctx.ui.choose({
      title: `${slotId} models`,
      items
    });
    if (picked == null) return;
    if (picked.value === "add") {
      const idRaw = await promptText(ctx, {
        title: "Model id",
        validate: (value) => {
          const id = value.trim();
          if (!id || id.length > 256 || FORBIDDEN_KEYS.has(id)) return "Enter a model id.";
          if (Object.hasOwn(slot.models, id)) return "That model id already exists on this slot.";
          return null;
        }
      });
      if (idRaw == null) continue;
      const id = idRaw.trim();
      const contextWindow = await promptInteger(ctx, "contextWindow");
      if (contextWindow == null) continue;
      const maxTokens = await promptInteger(ctx, "maxTokens");
      if (maxTokens == null) continue;
      const reasoningPick = await ctx.ui.choose({
        title: "reasoning",
        items: [
          { value: "true", label: "true" },
          { value: "false", label: "false" }
        ]
      });
      if (reasoningPick == null) continue;
      const inputPick = await ctx.ui.choose({
        title: "input",
        multiple: true,
        items: [
          { value: "text", label: "text" },
          { value: "image", label: "image" }
        ]
      });
      if (inputPick == null) continue;
      const input = inputPick.values || [];
      if (input.length === 0) {
        await ctx.ui.notice({ title: "input", text: "Select at least one of text or image." });
        continue;
      }
      const created = {
        contextWindow,
        maxTokens,
        reasoning: reasoningPick.value === "true",
        input
      };
      slot.models[id] = await editCompatibleMeta(ctx, created, id);
      continue;
    }
    const modelId = picked.value;
    const action = await ctx.ui.choose({
      title: modelId,
      items: [
        { value: "edit", label: "Edit metadata" },
        { value: "remove", label: "Remove model" }
      ]
    });
    if (action == null) continue;
    if (action.value === "remove") {
      const used = ctx.draft.advisors.filter((advisor) => advisor.provider === slotId && advisor.model === modelId);
      if (used.length > 0) {
        await ctx.ui.notice({
          title: "Remove model",
          text: `Advisors still use this model: ${used.map((advisor) => advisor.name).join(", ")}.`
        });
        continue;
      }
      const ok = await ctx.ui.confirm({
        title: "Remove model",
        text: `Remove model ${modelId} from ${slotId}?`
      });
      if (ok === true) delete slot.models[modelId];
      continue;
    }
    slot.models[modelId] = await editCompatibleMeta(ctx, { ...slot.models[modelId], input: [...slot.models[modelId].input] }, modelId);
  }
}

/**
 * @param {object} ctx
 * @param {string} slotId
 */
async function editSlot(ctx, slotId) {
  const slot = ctx.draft.providers[slotId];
  if (!slot) return;
  while (true) {
    /** @type {{ value: string, label: string, description?: string }[]} */
    const items = [
      { value: "identity", label: slotId, description: `${slot.kind} · ${slot.provider}` }
    ];
    if (slot.kind === "api") {
      items.push({ value: "apiKeyEnv", label: "apiKeyEnv", description: slot.apiKeyEnv });
      if (slot.provider === "openai-compatible") {
        items.push({ value: "baseUrl", label: "baseUrl", description: slot.baseUrl });
        items.push({ value: "models", label: "Models", description: `${Object.keys(slot.models || {}).length} configured` });
      }
    } else {
      items.push({ value: "login", label: "Login" });
      items.push({ value: "logout", label: "Logout" });
    }
    items.push({ value: "remove", label: "Remove" });
    const picked = await ctx.ui.choose({
      title: `Provider ${slotId}`,
      items
    });
    if (picked == null) return;
    if (picked.value === "apiKeyEnv") {
      const next = await promptText(ctx, {
        title: "apiKeyEnv",
        value: slot.apiKeyEnv,
        validate: (value) => (ENV_NAME_RE.test(value.trim()) ? null : "Enter an environment variable name, never a key value.")
      });
      if (next != null) slot.apiKeyEnv = next.trim();
      continue;
    }
    if (picked.value === "baseUrl") {
      const next = await promptText(ctx, {
        title: "baseUrl",
        value: slot.baseUrl,
        validate: (value) => (value.trim().length > 0 ? null : "Enter a URL.")
      });
      if (next != null) slot.baseUrl = next.trim();
      continue;
    }
    if (picked.value === "models") {
      await editCompatibleModels(ctx, slot, slotId);
      continue;
    }
    if (picked.value === "login") {
      await runAuthHelper(ctx, "login", slotId);
      continue;
    }
    if (picked.value === "logout") {
      await runAuthHelper(ctx, "logout", slotId);
      continue;
    }
    if (picked.value === "remove") {
      const used = ctx.draft.advisors.filter((advisor) => advisor.provider === slotId);
      if (used.length > 0) {
        await ctx.ui.notice({
          title: "Remove",
          text: `Cannot remove ${slotId} while advisors ${used.map((advisor) => advisor.name).join(", ")} still reference it.`
        });
        continue;
      }
      const ok = await ctx.ui.confirm({
        title: "Remove",
        text: `Remove provider slot ${slotId}? OAuth credentials are not deleted; logout separately.`
      });
      if (ok === true) {
        delete ctx.draft.providers[slotId];
        return;
      }
    }
  }
}

/**
 * @param {object} ctx
 * @param {object} summary
 * @param {"api" | "oauth"} kind
 */
async function createSlot(ctx, summary, kind) {
  const used = usedSlotIds(ctx);
  const suggested = suggestedSlot(summary.id, kind, used);
  const idRaw = await promptText(ctx, {
    title: "Slot id",
    value: suggested,
    validate: (value) => {
      const error = identifierError(value);
      if (error) return error;
      if (used.has(value.trim())) return "That slot id already exists.";
      return null;
    }
  });
  if (idRaw == null) return null;
  const id = idRaw.trim();
  if (kind === "oauth") {
    ctx.draft.providers[id] = { kind: "oauth", provider: summary.id };
    return id;
  }
  const suggestedEnv = typeof summary.suggestedApiKeyEnv === "string" ? summary.suggestedApiKeyEnv : "";
  const envName = await promptText(ctx, {
    title: "apiKeyEnv (variable name only)",
    value: suggestedEnv,
    validate: (value) => (ENV_NAME_RE.test(value.trim()) ? null : "Enter an environment variable name, never a key value.")
  });
  if (envName == null) return null;
  if (summary.id === "openai-compatible") {
    const baseUrl = await promptText(ctx, {
      title: "baseUrl",
      validate: (value) => (value.trim().length > 0 ? null : "Enter a URL.")
    });
    if (baseUrl == null) return null;
    ctx.draft.providers[id] = {
      kind: "api",
      provider: "openai-compatible",
      apiKeyEnv: envName.trim(),
      baseUrl: baseUrl.trim(),
      models: {}
    };
    await editCompatibleModels(ctx, ctx.draft.providers[id], id);
    if (Object.keys(ctx.draft.providers[id].models).length === 0) {
      delete ctx.draft.providers[id];
      await ctx.ui.notice({
        title: "Provider accounts",
        text: "A compatible slot needs at least one model. Slot was not added."
      });
      return null;
    }
    return id;
  }
  ctx.draft.providers[id] = {
    kind: "api",
    provider: summary.id,
    apiKeyEnv: envName.trim()
  };
  return id;
}

/**
 * @param {object} ctx
 */
async function addProviders(ctx) {
  if (!ctx.catalog.length) {
    try {
      ctx.catalog = await ctx.getProviderCatalog();
    } catch (error) {
      await ctx.ui.notice({
        title: ACTION_PROVIDERS,
        text: display(error?.message || "Offline model catalog is unavailable.")
      });
      return;
    }
  }
  const selected = await ctx.ui.choose({
    title: "Upstream providers",
    search: true,
    multiple: true,
    items: ctx.catalog.map((entry) => ({
      value: entry.id,
      label: entry.name || entry.id,
      description: `${entry.id} · ${(entry.auth || []).join("/")}`
    }))
  });
  if (selected == null) return;
  const ids = selected.values || (selected.value ? [selected.value] : []);
  for (const providerId of ids) {
    const summary = ctx.catalog.find((entry) => entry.id === providerId);
    if (!summary) continue;
    const existing = Object.entries(ctx.draft.providers).filter(([, slot]) => slot.provider === providerId);
    if (existing.length > 0) {
      const reuse = await ctx.ui.choose({
        title: summary.name || providerId,
        items: [
          ...existing.map(([id, slot]) => ({
            value: `keep:${id}`,
            label: `Keep ${id}`,
            description: `${slot.kind} · ${slot.provider}`
          })),
          { value: "add", label: "Add another account" }
        ]
      });
      if (reuse == null || reuse.value.startsWith("keep:")) continue;
    }
    const kinds = summary.auth || [];
    let kind = kinds[0];
    if (kinds.length > 1) {
      const picked = await ctx.ui.choose({
        title: `${summary.name || providerId} auth`,
        items: kinds.map((value) => ({ value, label: value === "api" ? "API key" : "OAuth" }))
      });
      if (picked == null) continue;
      kind = picked.value;
    }
    if (!kind) continue;
    await createSlot(ctx, summary, kind);
  }
}

/**
 * @param {object} ctx
 */
async function editProviders(ctx) {
  while (true) {
    const ids = Object.keys(ctx.draft.providers);
    const items = ids.map((id) => {
      const slot = ctx.draft.providers[id];
      return {
        value: id,
        label: id,
        description: `${slot.kind} · ${slot.provider}`
      };
    });
    items.push({ value: "add", label: "Add providers" });
    const picked = await ctx.ui.choose({
      title: ACTION_PROVIDERS,
      items
    });
    if (picked == null) return;
    if (picked.value === "add") {
      await addProviders(ctx);
      continue;
    }
    await editSlot(ctx, picked.value);
  }
}

/**
 * The draft's gate settings, created with the defaults when the file has none.
 *
 * @param {object} ctx
 */
function gateOf(ctx) {
  ctx.draft.gate ??= { mode: "block", maxRounds: 2 };
  return ctx.draft.gate;
}

/**
 * @param {object} ctx
 */
function gateSummary(ctx) {
  const gate = gateOf(ctx);
  const count = (list, noun) => `${list?.length ?? 0} ${noun}${list?.length === 1 ? "" : "s"}`;
  return `${gate.mode} · up to ${gate.maxRounds} round${gate.maxRounds === 1 ? "" : "s"} · auto-on in ${count(gate.autoOn, "project")} · ${count(gate.skipWhenOnly, "skip pattern")}`;
}

/**
 * One entry per line; an emptied list removes the key rather than saving [].
 *
 * @param {object} ctx
 * @param {"autoOn" | "skipWhenOnly"} key
 * @param {string} title
 * @param {(line: string) => string | null} lineError
 */
async function editGateList(ctx, key, title, lineError) {
  const gate = gateOf(ctx);
  const raw = await promptText(ctx, {
    title,
    value: (gate[key] ?? []).join("\n"),
    multiline: true,
    maxBytes: 16 * 1024,
    validate: (text) => {
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length > 64) return "At most 64 entries.";
      for (const line of lines) {
        const error = lineError(line);
        if (error) return `${display(line)}: ${error}`;
      }
      return null;
    }
  });
  if (raw == null) return;
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length) gate[key] = lines;
  else delete gate[key];
}

/**
 * @param {object} ctx
 */
async function editGate(ctx) {
  while (true) {
    const gate = gateOf(ctx);
    const list = (items) => (items?.length ? items.join(", ").slice(0, 80) : "none");
    const picked = await ctx.ui.choose({
      title: ACTION_GATE,
      items: [
        {
          value: "mode",
          label: "Mode",
          description: gate.mode === "block" ? "block: concerns and blockers send Claude back" : "report: findings are only shown to you"
        },
        { value: "rounds", label: "Max rounds", description: String(gate.maxRounds) },
        { value: "autoOn", label: "Auto-on projects", description: list(gate.autoOn) },
        { value: "skip", label: "Skip turns that only change", description: list(gate.skipWhenOnly) }
      ]
    });
    if (picked == null) return;
    if (picked.value === "mode") {
      const mode = await ctx.ui.choose({
        title: "Mode",
        items: [
          { value: "block", label: "block", description: "Concerns and blockers send Claude back to address them." },
          { value: "report", label: "report", description: "Findings are only shown to you." },
          { value: "advise", label: "advise", description: "Claude stops at once; a background review wakes it for blockers." }
        ]
      });
      if (mode?.action === "select") gate.mode = mode.value;
    } else if (picked.value === "rounds") {
      const rounds = await promptInteger(ctx, "Max rounds (1 to 5)", gate.maxRounds);
      if (rounds != null && rounds <= 5) gate.maxRounds = rounds;
      else if (rounds != null) await ctx.ui.notice({ title: "Max rounds", text: "Max rounds is 1 to 5." });
    } else if (picked.value === "autoOn") {
      await editGateList(
        ctx,
        "autoOn",
        "Auto-on projects: one absolute git project root per line. The gate turns on at session start there; /cross-model-advisor:off still wins.",
        (line) => (path.isAbsolute(line) ? null : "must be an absolute path")
      );
    } else if (picked.value === "skip") {
      await editGateList(
        ctx,
        "skipWhenOnly",
        "Skip turns that only change: one gitignore pattern per line, such as *.md. Matching files stay visible to advisors in other turns.",
        (line) => (line.startsWith("!") ? "patterns cannot be negated" : null)
      );
    }
  }
}

/**
 * @param {object} ctx
 */
async function homeLoop(ctx) {
  while (true) {
    const picked = await ctx.ui.choose({
      title: homeTitle(ctx),
      items: homeItems(ctx),
      toggle: true,
      footer: "Enter edit · Space enable · Esc quit"
    });
    if (picked == null) {
      if (await confirmDiscard(ctx)) return 0;
      continue;
    }
    if (picked.action === "toggle") {
      toggleAdvisor(ctx, picked.value);
      continue;
    }
    const value = picked.value;
    if (value === ACTION_ADD) {
      await addAdvisor(ctx);
      continue;
    }
    if (value === ACTION_PROVIDERS) {
      await editProviders(ctx);
      continue;
    }
    if (value === ACTION_GATE) {
      await editGate(ctx);
      continue;
    }
    if (value === ACTION_SAVE) {
      await saveDefaults(ctx);
      continue;
    }
    if (value === ACTION_QUIT) {
      if (await confirmDiscard(ctx)) return 0;
      continue;
    }
    const advisor = ctx.draft.advisors.find((entry) => entry.name === value);
    if (advisor) await editAdvisor(ctx, advisor);
  }
}

/**
 * @param {{
 *   command: "login" | "logout",
 *   slot: string,
 *   env: NodeJS.ProcessEnv,
 *   stdin: NodeJS.ReadStream | NodeJS.ReadableStream,
 *   stdout: NodeJS.WritableStream,
 *   stderr: NodeJS.WritableStream,
 *   authHelperPath: string,
 *   signal?: AbortSignal
 * }} options
 */
async function defaultLogin(options) {
  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal.reason);
  const child = spawn(process.execPath, [options.authHelperPath, options.command, options.slot], {
    stdio: [options.stdin, options.stdout, options.stderr],
    env: options.env
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    let stopping = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let killTimer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const stopChild = () => {
      if (stopping) return;
      stopping = true;
      if (child.exitCode != null || child.signalCode != null) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, AUTH_CHILD_KILL_MS);
    };
    const onAbort = () => {
      stopChild();
    };
    child.on("error", (error) => finish(error));
    child.on("close", (code, exitSignal) => {
      if (signal?.aborted) {
        finish(abortError(signal.reason));
        return;
      }
      if (code === 0 && !exitSignal) {
        finish();
        return;
      }
      finish(new Error("Auth helper failed."));
    });
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

/**
 * Terminal menu. `ui` is for behavior tests only.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   stdin?: NodeJS.ReadStream | NodeJS.ReadableStream,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream,
 *   ui?: { choose: Function, text: Function, confirm: Function, notice: Function, suspend: Function, close: Function, signal?: AbortSignal },
 *   login?: typeof defaultLogin,
 *   signal?: AbortSignal,
 *   helperPath?: string,
 *   authHelperPath?: string,
 *   readConfigState?: typeof readConfigState,
 *   saveConfig?: typeof saveConfig,
 *   getModels?: typeof getModels,
 *   getProviderCatalog?: typeof getProviderCatalog,
 *   getReasoningChoices?: typeof getReasoningChoices
 * }} [options]
 */
export async function runSetupMenu(options = {}) {
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const helperPath = options.helperPath ?? resolvedPath(siblingExecutable("setup-control.mjs"));
  const authHelperPath = options.authHelperPath ?? resolvedPath(siblingExecutable("auth-control.mjs"));
  let ui = options.ui;
  let created = false;
  if (!ui) {
    const { createTerminalUI } = await import("./terminal-ui.mjs");
    try {
      ui = createTerminalUI({ stdin, stdout, signal: options.signal });
      created = true;
    } catch (error) {
      if (isAbortError(error)) return 0;
      if (error && error.code === "tty") {
        stderr.write("Open this menu in your own terminal.\n");
        stderr.write(`${formatMenuCommand({ env, helperPath })}\n`);
        return 1;
      }
      throw error;
    }
  }

  /** @type {object} */
  const ctx = {
    env,
    stdin,
    stdout,
    stderr,
    ui,
    login: options.login ?? defaultLogin,
    helperPath,
    authHelperPath,
    signal: ui.signal ?? options.signal,
    readConfigState: options.readConfigState ?? readConfigState,
    saveConfig: options.saveConfig ?? saveConfig,
    getModels: options.getModels ?? getModels,
    getProviderCatalog: options.getProviderCatalog ?? getProviderCatalog,
    getReasoningChoices: options.getReasoningChoices ?? getReasoningChoices,
    draft: emptyConfig(),
    saved: null,
    revision: null,
    configPath: "",
    configError: null,
    staleEffort: new Set(),
    catalog: []
  };

  try {
    const state = await ctx.readConfigState({ env });
    ctx.configPath = state.path;
    ctx.revision = state.revision;
    ctx.configError = state.configError;
    if (state.config) {
      ctx.saved = clone(state.config);
      ctx.draft = clone(state.config);
    }
    if (state.configError) {
      await ui.notice({
        title: "Configuration",
        text: display(state.configError)
      });
    }
    try {
      ctx.catalog = await ctx.getProviderCatalog();
    } catch {
      ctx.catalog = [];
    }
    return await homeLoop(ctx);
  } catch (error) {
    if (isAbortError(error)) return 0;
    throw error;
  } finally {
    if (created) ui.close();
  }
}
