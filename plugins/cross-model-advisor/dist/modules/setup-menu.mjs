import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/setup-menu.mjs
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
var IDENTIFIER_RE = /^[a-z][a-z0-9-]{0,63}$/;
var ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var ACTION_ADD = "Add advisor";
var ACTION_PROVIDERS = "Provider accounts";
var ACTION_SAVE = "Save";
var ACTION_QUIT = "Quit";
var AUTH_CHILD_KILL_MS = 2e3;
function isAbortError(error) {
  return Boolean(
    error && (error.code === "abort" || error.name === "AbortError" || error.code === "ABORT_ERR")
  );
}
function abortError(reason) {
  if (isAbortError(reason) && reason instanceof Error) return reason;
  const error = new Error("aborted");
  error.name = "AbortError";
  error.code = "abort";
  if (reason instanceof Error) error.cause = reason;
  return error;
}
function display(value) {
  return sanitizeText(String(value ?? "")).slice(0, 500);
}
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
function siblingExecutable(name, fromUrl = import.meta.url) {
  const here = path.dirname(fileURLToPath(fromUrl));
  if (path.basename(here) === "modules") return path.join(here, "..", name);
  return path.join(here, name);
}
function effortLabel(choices, value) {
  const found = choices.find((choice) => choice.value === value);
  if (found?.label) return found.label;
  return value || "default";
}
function isDirty(ctx) {
  if (!ctx.saved) {
    return ctx.draft.advisors.length > 0 || Object.keys(ctx.draft.providers).length > 0;
  }
  return JSON.stringify({ providers: ctx.draft.providers, advisors: ctx.draft.advisors }) !== JSON.stringify({ providers: ctx.saved.providers, advisors: ctx.saved.advisors });
}
function slotOnDisk(ctx, slotId) {
  return Boolean(ctx.saved?.providers?.[slotId]);
}
function suggestedSlot(providerId, kind, used) {
  const stems = {
    "openai-codex": "codex",
    "github-copilot": "copilot",
    "openai-compatible": "compatible"
  };
  const stem = stems[providerId] || providerId;
  const base = kind === "oauth" ? `${stem}-login` : `${stem}-api`;
  if (IDENTIFIER_RE.test(base) && !used.has(base) && !FORBIDDEN_KEYS.has(base)) return base;
  for (let n = 2; n < 1e3; n += 1) {
    const id = `${base}-${n}`;
    if (IDENTIFIER_RE.test(id) && !used.has(id) && !FORBIDDEN_KEYS.has(id)) return id;
  }
  return "";
}
function usedSlotIds(ctx) {
  return new Set(Object.keys(ctx.draft.providers));
}
function usedAdvisorNames(ctx) {
  return new Set(ctx.draft.advisors.map((advisor) => advisor.name));
}
function homeTitle(ctx) {
  const dirty = isDirty(ctx) ? "Unsaved changes" : "Saved";
  return `Cross-model advisors
Settings (${dirty}): ${display(ctx.configPath)}
Saved settings apply from the next reviewed turn in every session.`;
}
function advisorDescription(ctx, advisor) {
  const lines = [
    `Configured: ${advisor.provider} · ${advisor.model} · ${advisor.reasoningEffort}`
  ];
  if (ctx.staleEffort.has(advisor.name)) {
    lines.push("Reasoning effort needs reselection before save.");
  }
  return lines.join("\n");
}
function homeItems(ctx) {
  const items = ctx.draft.advisors.map((advisor) => ({
    value: advisor.name,
    label: `${advisor.enabled ? "[x]" : "[ ]"}  ${advisor.name}`,
    description: advisorDescription(ctx, advisor)
  }));
  items.push({ value: ACTION_ADD, label: ACTION_ADD });
  items.push({ value: ACTION_PROVIDERS, label: ACTION_PROVIDERS });
  items.push({ value: ACTION_SAVE, label: ACTION_SAVE });
  items.push({ value: ACTION_QUIT, label: ACTION_QUIT });
  return items;
}
function toggleAdvisor(ctx, name) {
  const advisor = ctx.draft.advisors.find((entry) => entry.name === name);
  if (!advisor) return;
  advisor.enabled = advisor.enabled !== true;
}
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
async function saveDefaults(ctx) {
  const saved = await saveDraft(ctx);
  if (!saved) return;
  await ctx.ui.notice({ title: "Saved", text: "Saved. Applies from the next reviewed turn." });
}
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
async function promptInteger(ctx, title, current) {
  const raw = await promptText(ctx, {
    title,
    value: current == null ? "" : String(current),
    validate: (value) => /^[0-9]{1,8}$/.test(value.trim()) && Number(value.trim()) >= 1 ? null : "Enter a positive integer."
  });
  if (raw == null) return null;
  return Number(raw.trim());
}
function identifierError(value) {
  const text = value.trim();
  if (!IDENTIFIER_RE.test(text) || FORBIDDEN_KEYS.has(text)) {
    return "Use a restricted identifier: lowercase letter, then letters, digits, or dashes (max 64).";
  }
  return null;
}
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
    const picked2 = await ctx.ui.choose({
      title: "Model",
      search: true,
      initial: current,
      items: ids.map((id) => ({
        value: id,
        label: id === current ? `${id} (current)` : id
      }))
    });
    if (picked2 == null) return null;
    return picked2.value;
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
async function editAdvisor(ctx, advisor) {
  while (true) {
    const slot = ctx.draft.providers[advisor.provider];
    let effortText = advisor.reasoningEffort;
    try {
      const choices = await ctx.getReasoningChoices(slot, advisor.model);
      effortText = choices.configurable ? effortLabel(choices.choices, advisor.reasoningEffort) : "Not configurable";
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
          const name2 = value.trim();
          if (name2 !== advisor.name && usedAdvisorNames(ctx).has(name2)) {
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
        text: last ? `Remove the last advisor ${advisor.name}? Empty configurations are valid and start no reviews.` : `Remove advisor ${advisor.name}?`
      });
      if (ok !== true) continue;
      ctx.draft.advisors = ctx.draft.advisors.filter((entry) => entry !== advisor);
      ctx.staleEffort.delete(advisor.name);
      return;
    }
  }
}
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
    await ctx.ui.suspend(
      () => ctx.login({
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
function defaultSupportsReasoningEffort(format) {
  return format !== "zai";
}
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
        description: meta.thinkingFormat ? `${meta.thinkingFormat}${meta.supportsReasoningEffort === false ? " · supportsReasoningEffort false" : ""}` : "Not set"
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
        validate: (value) => /^[0-9]{1,8}$/.test(value.trim()) ? null : "Enter a positive integer."
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
        selected: [...meta.input || ["text"]],
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
      const mapped = {};
      let cancelled = false;
      for (const level of THINKING_LEVELS) {
        const current = meta.thinkingLevelMap && Object.hasOwn(meta.thinkingLevelMap, level) ? meta.thinkingLevelMap[level] === null ? "null" : String(meta.thinkingLevelMap[level]) : "";
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
        initial: meta.supportsReasoningEffort == null ? supportDefault ? "true" : "false" : meta.supportsReasoningEffort ? "true" : "false",
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
          const id2 = value.trim();
          if (!id2 || id2.length > 256 || FORBIDDEN_KEYS.has(id2)) return "Enter a model id.";
          if (Object.hasOwn(slot.models, id2)) return "That model id already exists on this slot.";
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
async function editSlot(ctx, slotId) {
  const slot = ctx.draft.providers[slotId];
  if (!slot) return;
  while (true) {
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
        validate: (value) => ENV_NAME_RE.test(value.trim()) ? null : "Enter an environment variable name, never a key value."
      });
      if (next != null) slot.apiKeyEnv = next.trim();
      continue;
    }
    if (picked.value === "baseUrl") {
      const next = await promptText(ctx, {
        title: "baseUrl",
        value: slot.baseUrl,
        validate: (value) => value.trim().length > 0 ? null : "Enter a URL."
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
    validate: (value) => ENV_NAME_RE.test(value.trim()) ? null : "Enter an environment variable name, never a key value."
  });
  if (envName == null) return null;
  if (summary.id === "openai-compatible") {
    const baseUrl = await promptText(ctx, {
      title: "baseUrl",
      validate: (value) => value.trim().length > 0 ? null : "Enter a URL."
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
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
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
async function runSetupMenu(options = {}) {
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
        stderr.write(`${formatMenuCommand({ env, helperPath })}
`);
        return 1;
      }
      throw error;
    }
  }
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
    staleEffort: /* @__PURE__ */ new Set(),
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
export {
  runSetupMenu
};
