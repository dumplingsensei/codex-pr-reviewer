import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/session/observations.mjs
import path from "node:path";
import { MAX_DEDUPE, TOOL_SUMMARY_CAP, USER_TEXT_CAP } from "./constants.mjs";
import { sanitizeText, truncateLabeled } from "./sanitize.mjs";
function dedupeKey(parts) {
  if (parts.uuid) return `uuid:${parts.sessionId}:${parts.generation}:${parts.uuid}`;
  if (parts.toolUseId) {
    return `tool:${parts.sessionId}:${parts.generation}:${parts.promptId ?? ""}:${parts.toolUseId}:${parts.phase ?? ""}`;
  }
  if (parts.promptId && parts.phase) {
    return `evt:${parts.sessionId}:${parts.generation}:${parts.promptId}:${parts.phase}`;
  }
  return null;
}
function seenDedupe(list, key) {
  if (!key) return false;
  return list.includes(key);
}
function rememberDedupe(list, key) {
  if (!key) return list;
  const next = list.concat(key);
  return next.length > MAX_DEDUPE ? next.slice(next.length - MAX_DEDUPE) : next;
}
function relativeTarget(root, filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  if (!root) return filePath;
  const rel = path.relative(root, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}
function toolTargets(root, name, input) {
  const paths = [];
  const add = (value) => {
    const rel = relativeTarget(root, value);
    if (rel) paths.push(rel);
  };
  if (!input || typeof input !== "object") return paths;
  add(input.file_path);
  add(input.path);
  if (Array.isArray(input.paths)) for (const item of input.paths) add(item);
  return paths;
}
function commandText(name, input) {
  if (!input || typeof input !== "object") return null;
  if (name === "Bash" || name === "PowerShell") {
    return typeof input.command === "string" ? input.command : null;
  }
  return null;
}
function minimizeToolInput(name, input) {
  if (!input || typeof input !== "object") return {};
  const out = {};
  if (typeof input.file_path === "string") out.file_path = input.file_path;
  if (typeof input.path === "string") out.path = input.path;
  if (Array.isArray(input.paths)) out.paths = input.paths.filter((item) => typeof item === "string").slice(0, 20);
  const command = commandText(name, input);
  if (command) out.command = command;
  return out;
}
function outcomeSummary(response, error, secrets = []) {
  const clip = (value) => value ? truncateLabeled(sanitizeText(value, secrets), TOOL_SUMMARY_CAP) : null;
  if (typeof error === "string" && error) return clip(error);
  if (typeof response === "string") return clip(response);
  if (response && typeof response === "object") {
    if (typeof response.stdout === "string") return clip(response.stdout);
    if (typeof response.stderr === "string" && response.stderr) return clip(response.stderr);
    if (response.success === false) return "tool reported failure";
    if (response.success === true) return "ok";
    const filePath = response.filePath ?? response.file_path;
    if (typeof filePath === "string") return `file ${path.basename(filePath)}`;
  }
  return null;
}
function observationFromHook(payload, ctx) {
  const event = payload?.hook_event_name;
  const secrets = ctx.secrets ?? [];
  const promptId = payload?.prompt_id ?? null;
  const toolUseId = payload?.tool_use_id ?? null;
  const toolName = payload?.tool_name ?? null;
  const input = minimizeToolInput(toolName, payload?.tool_input ?? {});
  const text = truncateLabeled(
    sanitizeText(typeof payload?.prompt === "string" ? payload.prompt : "", secrets),
    USER_TEXT_CAP
  );
  const assistant = truncateLabeled(
    sanitizeText(typeof payload?.last_assistant_message === "string" ? payload.last_assistant_message : "", secrets),
    USER_TEXT_CAP
  );
  const command = commandText(toolName, input);
  const phase = event === "PreToolUse" ? "intent" : event === "PostToolUse" ? "outcome" : event === "PostToolUseFailure" ? "failure" : event === "UserPromptSubmit" ? "prompt" : event ?? "event";
  return {
    eventId: `obs_${ctx.seq}`,
    seq: ctx.seq,
    sessionId: ctx.sessionId,
    generation: ctx.generation,
    phase,
    hookEvent: event,
    promptId,
    toolUseId,
    uuid: null,
    userText: text || null,
    assistantText: assistant || null,
    toolName,
    targets: toolTargets(ctx.root, toolName, input),
    command: command ? truncateLabeled(sanitizeText(command, secrets), TOOL_SUMMARY_CAP) : null,
    outcome: outcomeSummary(payload?.tool_response, payload?.error, secrets),
    error: typeof payload?.error === "string" ? truncateLabeled(sanitizeText(payload.error, secrets), TOOL_SUMMARY_CAP) : null,
    interrupted: Boolean(payload?.is_interrupt),
    cwd: typeof payload?.cwd === "string" ? payload.cwd : null,
    at: ctx.now ?? Date.now()
  };
}
function mergeToolObservation(existing, incoming) {
  return {
    ...existing,
    userText: existing.userText || incoming.userText,
    assistantText: existing.assistantText || incoming.assistantText,
    targets: existing.targets?.length ? existing.targets : incoming.targets,
    command: existing.command || incoming.command,
    outcome: incoming.outcome ?? existing.outcome,
    error: incoming.error ?? existing.error,
    interrupted: existing.interrupted || incoming.interrupted,
    phases: [.../* @__PURE__ */ new Set([...existing.phases ?? [existing.phase], incoming.phase])],
    eventId: existing.eventId,
    seq: existing.seq
  };
}
function observationFromTranscript(interpreted, ctx) {
  if (interpreted.kind === "gap") {
    return {
      eventId: `gap_${ctx.seq}`,
      seq: ctx.seq,
      sessionId: ctx.sessionId,
      generation: ctx.generation,
      phase: "gap",
      hookEvent: "transcript",
      uuid: interpreted.uuid ?? null,
      gap: interpreted.reason,
      at: ctx.now ?? Date.now()
    };
  }
  if (interpreted.kind === "user") {
    return {
      eventId: `obs_${ctx.seq}`,
      seq: ctx.seq,
      sessionId: ctx.sessionId,
      generation: ctx.generation,
      phase: "prompt",
      hookEvent: "transcript",
      uuid: interpreted.uuid,
      promptId: interpreted.promptId,
      userText: interpreted.text,
      queued: interpreted.queued ?? [],
      at: ctx.now ?? Date.now()
    };
  }
  if (interpreted.kind === "tool_result") {
    return {
      eventId: `obs_${ctx.seq}`,
      seq: ctx.seq,
      sessionId: ctx.sessionId,
      generation: ctx.generation,
      phase: "outcome",
      hookEvent: "transcript",
      uuid: interpreted.uuid,
      queued: interpreted.queued ?? [],
      userText: interpreted.text || null,
      results: interpreted.results ?? [],
      at: ctx.now ?? Date.now()
    };
  }
  if (interpreted.kind === "assistant") {
    return {
      eventId: `obs_${ctx.seq}`,
      seq: ctx.seq,
      sessionId: ctx.sessionId,
      generation: ctx.generation,
      phase: "assistant",
      hookEvent: "transcript",
      uuid: interpreted.uuid,
      assistantText: interpreted.text || null,
      tools: (interpreted.tools ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        targets: item.targets ?? [],
        command: item.command ?? null
      })),
      at: ctx.now ?? Date.now()
    };
  }
  return null;
}
export {
  dedupeKey,
  mergeToolObservation,
  minimizeToolInput,
  observationFromHook,
  observationFromTranscript,
  rememberDedupe,
  seenDedupe
};
