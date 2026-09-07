import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/session/transcript.mjs
import fs from "node:fs/promises";
import { TRANSCRIPT_TAIL_BYTES, USER_TEXT_CAP, TOOL_SUMMARY_CAP } from "./constants.mjs";
import { looksLikeControlTraffic } from "./classifier.mjs";
import { minimizeToolInput } from "./observations.mjs";
import { sanitizeText, truncateLabeled } from "./sanitize.mjs";
function visibleText(content, secrets) {
  if (typeof content === "string") {
    return truncateLabeled(sanitizeText(content, secrets), USER_TEXT_CAP);
  }
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "thinking" || block.type === "redacted_thinking") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "tool_use") continue;
    else if (block.type === "tool_result") continue;
    else if (block.type === "queued_command" && typeof block.command === "string") {
      parts.push(block.command);
    } else if (typeof block.text === "string") parts.push(block.text);
  }
  return truncateLabeled(sanitizeText(parts.join("\n"), secrets), USER_TEXT_CAP);
}
function recordUuid(record) {
  return record?.uuid ?? record?.id ?? record?.message?.id ?? null;
}
function isSidechain(record) {
  return Boolean(record?.isSidechain || record?.is_sidechain || record?.sidechain);
}
function compactSummaryOf(record) {
  if (typeof record?.compact_summary === "string") return record.compact_summary;
  if (record?.type === "compact" && typeof record?.summary === "string") return record.summary;
  if (record?.message?.type === "compact" && typeof record.message.summary === "string") {
    return record.message.summary;
  }
  const content = record?.message?.content;
  if (Array.isArray(content)) {
    const block = content.find((item) => item?.type === "compact_summary" || item?.compact_summary);
    if (typeof block?.compact_summary === "string") return block.compact_summary;
    if (typeof block?.text === "string" && record?.type === "system") return block.text;
  }
  return null;
}
function toolUses(record) {
  const content = record?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "tool_use" && block.id);
}
function toolResults(record) {
  const content = record?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "tool_result" && block.tool_use_id);
}
function queuedCommands(record) {
  const content = record?.message?.content;
  const found = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "queued_command" && typeof block.command === "string") {
        found.push(block.command);
      }
      if (Array.isArray(block?.queued_commands)) {
        for (const cmd of block.queued_commands) {
          if (typeof cmd === "string") found.push(cmd);
          else if (typeof cmd?.command === "string") found.push(cmd.command);
        }
      }
    }
  }
  if (Array.isArray(record?.queued_commands)) {
    for (const cmd of record.queued_commands) {
      if (typeof cmd === "string") found.push(cmd);
      else if (typeof cmd?.command === "string") found.push(cmd.command);
    }
  }
  return found;
}
function parseJsonlChunk(text) {
  const records = [];
  const gaps = [];
  const lines = String(text).split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") records.push(parsed);
      else gaps.push({ reason: "non-object" });
    } catch {
      gaps.push({ reason: "partial-or-invalid" });
    }
  }
  return { records, rest, gaps };
}
function interpretRecord(record, { secrets = [], hookToolIds = /* @__PURE__ */ new Set(), controlPromptIds = /* @__PURE__ */ new Set() } = {}) {
  if (isSidechain(record)) return { kind: "skip", reason: "sidechain" };
  const type = record?.type ?? record?.message?.role;
  const uuid = recordUuid(record);
  const summary = compactSummaryOf(record);
  if (summary) {
    return {
      kind: "compact",
      uuid,
      text: truncateLabeled(sanitizeText(summary, secrets), USER_TEXT_CAP)
    };
  }
  if (type === "user" || record?.message?.role === "user") {
    const results = toolResults(record);
    const queued = queuedCommands(record);
    const text = visibleText(record?.message?.content ?? record?.content, secrets);
    if (results.length) {
      return {
        kind: "tool_result",
        uuid,
        results: results.map((block) => ({
          toolUseId: block.tool_use_id,
          content: truncateLabeled(
            sanitizeText(typeof block.content === "string" ? block.content : "", secrets),
            256
          )
        })),
        queued,
        text
      };
    }
    if (looksLikeControlTraffic(text) || uuid && controlPromptIds.has(uuid)) {
      return { kind: "skip", reason: "control", uuid, text };
    }
    if (!text && queued.length === 0) return { kind: "skip", reason: "empty-user", uuid };
    return { kind: "user", uuid, text, queued, promptId: record?.prompt_id ?? record?.promptId ?? null };
  }
  if (type === "assistant" || record?.message?.role === "assistant") {
    const uses = toolUses(record);
    const text = visibleText(record?.message?.content ?? record?.content, secrets);
    const uniqueUses = uses.filter((block) => !hookToolIds.has(block.id));
    return {
      kind: "assistant",
      uuid,
      text,
      tools: uniqueUses.map((block) => {
        const input = minimizeToolInput(block.name, block.input ?? {});
        const command = typeof input.command === "string" ? input.command : null;
        return {
          id: block.id,
          name: block.name,
          targets: [input.file_path, input.path].filter(Boolean),
          command: command ? truncateLabeled(sanitizeText(command, secrets), TOOL_SUMMARY_CAP) : null
        };
      })
    };
  }
  if (type === "system" || type === "progress" || type === "attachment") {
    const queued = queuedCommands(record);
    if (queued.length) {
      return { kind: "user", uuid, text: "", queued, promptId: null };
    }
    return { kind: "skip", reason: type, uuid };
  }
  return { kind: "gap", reason: "unknown-type", type, uuid };
}
async function readTranscriptIncrement(filePath, cursor = {}) {
  if (!filePath) {
    return { records: [], rest: "", cursor, gap: null, raw: "" };
  }
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return {
      records: [],
      rest: "",
      cursor: { offset: 0, uuid: cursor.uuid ?? null, inode: null, size: 0 },
      gap: { reason: "absent" },
      raw: ""
    };
  }
  const inode = stat.ino;
  const size = stat.size;
  let offset = Number(cursor.offset) || 0;
  let gap = null;
  if (cursor.inode != null && cursor.inode !== inode) {
    gap = { reason: "replaced" };
    offset = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
  } else if (size < offset) {
    gap = { reason: "truncated" };
    offset = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
  } else if (offset === 0 && size > TRANSCRIPT_TAIL_BYTES && !cursor.uuid) {
    gap = { reason: "cursor-loss" };
    offset = size - TRANSCRIPT_TAIL_BYTES;
  }
  const available = Math.max(0, size - offset);
  const length = Math.min(available, TRANSCRIPT_TAIL_BYTES);
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    const raw = buf.subarray(0, bytesRead).toString("utf8");
    const parsed = parseJsonlChunk(raw);
    const restBytes = Buffer.byteLength(parsed.rest, "utf8");
    let consumed = bytesRead - restBytes;
    let nextGap = gap;
    if (parsed.records.length === 0 && restBytes >= TRANSCRIPT_TAIL_BYTES) {
      nextGap = nextGap ?? { reason: "oversize-line" };
      consumed = bytesRead;
    }
    const last = parsed.records.at(-1);
    return {
      records: parsed.records,
      rest: parsed.rest,
      gaps: parsed.gaps,
      cursor: {
        offset: offset + consumed,
        uuid: last ? recordUuid(last) : cursor.uuid ?? null,
        inode,
        size
      },
      gap: nextGap,
      raw
    };
  } finally {
    await handle.close();
  }
}
function recoverCompactSummary(records, secrets = []) {
  for (let i = records.length - 1; i >= 0; i--) {
    const interpreted = interpretRecord(records[i], { secrets });
    if (interpreted.kind === "compact") return interpreted.text;
  }
  return null;
}
function recoverLatestTask(records, opts = {}) {
  for (let i = records.length - 1; i >= 0; i--) {
    const interpreted = interpretRecord(records[i], opts);
    if (interpreted.kind === "user" && interpreted.text) {
      return {
        text: interpreted.text,
        promptId: interpreted.promptId,
        uuid: interpreted.uuid
      };
    }
  }
  return null;
}
export {
  interpretRecord,
  parseJsonlChunk,
  readTranscriptIncrement,
  recoverCompactSummary,
  recoverLatestTask
};
