import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/progress.mjs
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeText } from "./session/sanitize.mjs";
var MAX_TAIL_BYTES = 4 * 1024 * 1024;
var MAX_PROGRESS_CHARS = 6e3;
var MAX_TEXT_CHARS = 600;
var MAX_DESCRIPTION_CHARS = 200;
var OMITTED = "[earlier steps omitted]";
var MASKED = "[a path outside the review]";
var FILE_TOOLS = /* @__PURE__ */ new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead"]);
function oneLine(text, cap) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}
async function readTail(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return "";
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const buf = Buffer.alloc(stat.size - start);
    await handle.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}
async function shownPath(value, { projectRoot, isExcluded }) {
  if (typeof value !== "string" || !value || value.includes("\0")) return MASKED;
  const abs = path.resolve(projectRoot, value);
  const rel = path.relative(projectRoot, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return MASKED;
  const relPosix = rel.split(path.sep).join("/");
  return await isExcluded(relPosix) ? MASKED : relPosix;
}
async function describeCall(name, input, filters) {
  const args = input && typeof input === "object" ? input : {};
  if (FILE_TOOLS.has(name)) return `${name} ${await shownPath(args.file_path ?? args.notebook_path, filters)}`;
  if (name === "Bash") {
    if (typeof args.description === "string" && args.description.trim()) return `Bash: ${oneLine(args.description, MAX_DESCRIPTION_CHARS)}`;
    const program = /^\s*([A-Za-z0-9._-]{1,40})(?:\s|$)/.exec(String(args.command ?? ""))?.[1];
    return program ? `Bash: runs ${program}` : "Bash";
  }
  if (name === "Grep" || name === "Glob") return args.path ? `${name} in ${await shownPath(args.path, filters)}` : name;
  return oneLine(name, 60);
}
async function readProgress(transcriptPath, { since, projectRoot, isExcluded, secrets = [] }) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath) || !transcriptPath.endsWith(".jsonl")) return "";
  let text;
  try {
    text = await readTail(transcriptPath);
  } catch {
    return "";
  }
  const lines = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant" || entry.isSidechain) continue;
    const at = Date.parse(entry.timestamp ?? "");
    if (!Number.isFinite(at) || at < since) continue;
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        lines.push(`Claude: ${oneLine(block.text, MAX_TEXT_CHARS)}`);
      } else if (block?.type === "tool_use" && typeof block.name === "string") {
        lines.push(`- ${await describeCall(block.name, block.input, { projectRoot, isExcluded })}`);
      }
    }
  }
  let kept = lines;
  let length = kept.reduce((sum, line) => sum + line.length + 1, 0);
  while (kept.length > 1 && length > MAX_PROGRESS_CHARS) {
    length -= kept[0].length + 1;
    kept = kept.slice(1);
  }
  const body = kept.length < lines.length ? [OMITTED, ...kept] : kept;
  return sanitizeText(body.join("\n"), secrets);
}
export {
  readProgress
};
