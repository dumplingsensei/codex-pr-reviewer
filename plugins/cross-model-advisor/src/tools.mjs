/**
 * Shared read-only review tools. The gate decides what happens to findings;
 * this module only stages evidence-checked candidates and never follows links
 * out of the frozen root.
 */

import { Buffer, isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import ignoreFactory from "ignore";
import { validateRoot } from "./config.mjs";
import { redactCredentials } from "./session/sanitize.mjs";

const ignore = typeof ignoreFactory === "function" ? ignoreFactory : ignoreFactory.default;

const MAX_READ_FILE_BYTES = 1024 * 1024;
const MAX_READ_LINES_DEFAULT = 200;
const MAX_READ_LINES = 500;
const MAX_READ_RETURN_BYTES = 64 * 1024;
const MAX_LIST_DEPTH = 3;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_MATCHES = 50;
const MAX_SEARCH_RETURN_BYTES = 64 * 1024;
const MAX_SEARCH_SCAN_BYTES = 10 * 1024 * 1024;
const MAX_SEARCH_FILES = 10_000;
const MAX_NOTE_CHARS = 2_000;
const MAX_DETAIL_CHARS = 500;
const MAX_EVIDENCE = 5;
const MAX_WATCHDOG_BYTES = 8 * 1024;
const MAX_IGNORE_BYTES = 256 * 1024;
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_CLOEXEC ?? 0);
const HARD_DIR_NAMES = new Set([".git", ".claude", ".codex", ".gemini", "node_modules", ".ssh", ".aws", ".gnupg"]);
const HARD_FILE_NAMES = new Set([".npmrc", ".netrc", "_netrc", ".pypirc", ".envrc", ".pgpass", ".git-credentials"]);
const HARD_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];
const SSH_KEY_RE = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/;
const SEVERITIES = new Set(["nit", "concern", "blocker"]);
const PRAISE_RE =
  /^(?:thanks|thank you|thx|ty|tysm|looks good(?: to me)?|lgtm|sgtm|ack(?:nowledged)?|ok(?:ay)?|got it|sounds good|great(?: work)?|nice(?: work)?|well done|cheers)(?:[.!])*$/i;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const PROJECT_IGNORE = ".cross-model-advisorignore";
const WATCHDOG_NAME = "WATCHDOG.md";
const TRUNCATED_MARKER = "[truncated]";

/**
 * @param {string} note
 */
export function normalizeFinding(note) {
  // Markdown and sentence punctuation only: `i < n` and `i > n` stay distinct.
  return String(note ?? "")
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[.,;:!?]+(?=\s|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} text
 * @param {string[]} secrets
 */
function sanitizeText(text, secrets = []) {
  if (typeof text !== "string" || text.length === 0) return "";
  let out = text.replace(CONTROL_CHARS, "");
  const ordered = secrets
    .filter((secret) => typeof secret === "string" && secret.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of ordered) out = out.split(secret).join("[redacted]");
  return redactCredentials(out);
}

function denied(message = "access denied") {
  return `Error: ${message}`;
}

function posixRel(rel) {
  if (!rel) return "";
  return rel.split(path.sep).join("/");
}

function isOutside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

function sameIdent(a, b) {
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}

/**
 * @param {string} relPosix
 */
function hardExcluded(relPosix) {
  if (!relPosix) return false;
  for (const part of relPosix.split("/")) {
    if (!part) continue;
    const lower = part.toLowerCase();
    if (HARD_DIR_NAMES.has(lower) || HARD_FILE_NAMES.has(lower) || SSH_KEY_RE.test(lower)) return true;
    if (lower === ".env" || lower.startsWith(".env.")) return true;
    if (HARD_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  }
  return false;
}

/**
 * @param {unknown} args
 * @param {string[]} allowed
 */
function objectArgs(args, allowed) {
  if (args == null) return {};
  if (typeof args !== "object" || Array.isArray(args)) return null;
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) return null;
  }
  return args;
}

function contentFree(note) {
  const normalized = normalizeFinding(note);
  if (!normalized) return true;
  if (PRAISE_RE.test(normalized)) return true;
  return !/[a-z0-9]/i.test(normalized);
}

function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}

function utf8Len(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

function capUtf8(text, maxBytes) {
  const buf = Buffer.from(String(text ?? ""), "utf8");
  if (buf.length <= maxBytes) return { text: buf.toString("utf8"), truncated: false };
  let end = Math.max(0, Math.min(maxBytes, buf.length));
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * Keep complete items under a UTF-8 byte budget. The truncated marker fits in the budget.
 * @param {string[]} items
 * @param {number} maxBytes
 * @param {string[]} secrets
 */
function boundItems(items, maxBytes, secrets) {
  const marker = items.length ? `\n${TRUNCATED_MARKER}` : TRUNCATED_MARKER;
  const markerBytes = utf8Len(marker);
  const kept = [];
  let used = 0;
  for (let i = 0; i < items.length; i += 1) {
    const text = sanitizeText(items[i], secrets);
    const piece = (kept.length ? "\n" : "") + text;
    const n = utf8Len(piece);
    const more = i < items.length - 1;
    if (used + n > maxBytes) break;
    if (more && used + n + markerBytes > maxBytes) break;
    kept.push(text);
    used += n;
  }
  const truncated = kept.length < items.length;
  let text = kept.join("\n");
  if (truncated) {
    const suffix = text ? `\n${TRUNCATED_MARKER}` : TRUNCATED_MARKER;
    if (utf8Len(text) + utf8Len(suffix) <= maxBytes) text += suffix;
    else {
      const room = Math.max(0, maxBytes - utf8Len(suffix));
      const capped = capUtf8(text, room);
      text = `${capped.text}${suffix}`;
      if (capped.truncated && kept.length) kept.pop();
    }
  }
  return { text, kept, truncated };
}

/**
 * @param {string} abs
 * @param {{ maxBytes: number, allowPartial?: boolean, onSymlink?: "denyAll" | "skip" }} opts
 */
async function readPolicyFile(abs, { maxBytes, allowPartial = false, onSymlink = "denyAll" } = {}) {
  let lstat;
  try {
    lstat = await fs.lstat(abs);
  } catch (error) {
    if (error && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "denyAll" };
  }
  if (lstat.isSymbolicLink()) return { kind: onSymlink === "skip" ? "missing" : "denyAll" };
  if (!lstat.isFile()) return { kind: "denyAll" };
  if (!allowPartial && lstat.size > maxBytes) return { kind: "denyAll" };
  let handle;
  try {
    handle = await fs.open(abs, OPEN_FLAGS);
    const stat = await handle.stat();
    if (stat.dev !== lstat.dev || stat.ino !== lstat.ino || !stat.isFile()) {
      await handle.close().catch(() => {});
      return { kind: "denyAll" };
    }
    const size = Number(stat.size);
    const take = Math.min(size, maxBytes);
    const buf = Buffer.alloc(take);
    let offset = 0;
    while (offset < take) {
      const got = await handle.read(buf, offset, take - offset, offset);
      if (got.bytesRead === 0) break;
      offset += got.bytesRead;
    }
    await handle.close().catch(() => {});
    const bytes = offset === take ? buf : buf.subarray(0, offset);
    if (bytes.includes(0) || !isUtf8(bytes)) return { kind: "denyAll" };
    return { kind: "text", bytes, truncated: size > bytes.length };
  } catch {
    if (handle) await handle.close().catch(() => {});
    return { kind: "denyAll" };
  }
}

function ignoreFrom(text) {
  const ig = ignore();
  const kept = [];
  for (const line of splitLines(String(text ?? ""))) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("!")) continue;
    kept.push(line);
  }
  if (kept.length) ig.add(kept);
  return ig;
}

function gitignoreFrom(text) {
  const ig = ignore();
  ig.add(String(text ?? ""));
  return ig;
}

function ignoredBy(ig, relPosix, isDir) {
  if (!ig || !relPosix) return false;
  if (ig.ignores(relPosix)) return true;
  if (isDir && ig.ignores(`${relPosix}/`)) return true;
  return false;
}

function testIgnore(ig, local, isDir) {
  if (!ig || !local) return { ignored: false, unignored: false };
  const t = ig.test(isDir ? `${local.replace(/\/$/, "")}/` : local);
  return { ignored: Boolean(t.ignored), unignored: Boolean(t.unignored) };
}

export const toolSchemas = Object.freeze([
  Object.freeze({
    name: "read",
    description:
      "Read numbered UTF-8 text from a project-relative path. Default 200 lines; at most 500 lines and 64 KiB returned. Refuses files over 1 MiB, binary content, excluded paths, and symlinks.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: Object.freeze({
        path: { type: "string", description: "Project-relative or in-root path." },
        offset: { type: "integer", minimum: 1, description: "1-based start line." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Number of lines to return." }
      })
    })
  }),
  Object.freeze({
    name: "list",
    description:
      "List project-relative entries. Depth 1 by default, maximum depth 3 and 200 entries, deterministic order. Does not follow symlinks or show excluded names.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        path: { type: "string", description: "Project-relative directory. Defaults to the project root." },
        depth: { type: "integer", minimum: 1, maximum: 3 }
      })
    })
  }),
  Object.freeze({
    name: "search",
    description:
      "Literal text search (not regex) under the project. Maximum 50 matches and 64 KiB returned, 10 MiB scanned. Reports incomplete coverage when a bound is reached.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: Object.freeze({
        query: { type: "string" },
        path: { type: "string" },
        caseSensitive: { type: "boolean" }
      })
    })
  }),
  Object.freeze({
    name: "advise",
    description:
      "Record one evidence-backed finding; call once per distinct problem. severity is nit, concern, or blocker. note at most 2000 characters. evidence is 1-5 references: a file line you read with the read tool, or an observation eventId from the review context (request, final, or diff:<path>). Findings are reported when the review ends, including any filed before a timeout or tool-limit cutoff.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["severity", "note", "evidence"],
      properties: Object.freeze({
        severity: { type: "string", enum: ["nit", "concern", "blocker"] },
        note: { type: "string", maxLength: 2000 },
        evidence: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "detail"],
            properties: {
              kind: { type: "string", enum: ["file", "observation"] },
              path: { type: "string" },
              line: { type: "integer", minimum: 1 },
              detail: { type: "string" },
              eventId: { type: "string" }
            }
          }
        }
      })
    })
  })
]);

/**
 * @param {{
 *   root: string,
 *   rootIdent?: { dev: number|bigint, ino: number|bigint },
 *   exclude?: string[],
 *   observations?: object[],
 *   advisor?: { name?: string, fingerprints?: string[] },
 *   signal?: AbortSignal,
 *   pluginData?: string,
 *   credentialDir?: string,
 *   secrets?: string[],
 *   maxFindings?: number,
 *   ignoredPaths?: string[]
 * }} options
 */
export async function createReviewTools({
  root,
  rootIdent,
  exclude = [],
  observations = [],
  advisor,
  signal,
  pluginData,
  credentialDir,
  secrets = [],
  maxFindings = 1,
  ignoredPaths = []
} = {}) {
  const frozenRoot = await validateRoot(root, { follow: false });
  const liveRoot = await fs.lstat(frozenRoot);
  if (liveRoot.isSymbolicLink() || !liveRoot.isDirectory()) {
    const error = new Error("project root changed");
    error.name = "ConfigError";
    throw error;
  }
  const expectedIdent =
    rootIdent && rootIdent.dev != null && rootIdent.ino != null
      ? { dev: rootIdent.dev, ino: rootIdent.ino }
      : { dev: liveRoot.dev, ino: liveRoot.ino };
  if (!sameIdent(liveRoot, expectedIdent)) {
    const error = new Error("project root changed");
    error.name = "ConfigError";
    throw error;
  }

  const secretList = Array.isArray(secrets) ? secrets.filter((item) => typeof item === "string") : [];
  const observationIds = new Set();
  for (const observation of Array.isArray(observations) ? observations : []) {
    const id = observation?.eventId ?? observation?.id;
    if (typeof id === "string" && id) observationIds.add(id);
  }
  const fingerprints = new Set(
    Array.isArray(advisor?.fingerprints) ? advisor.fingerprints.map((item) => String(item)) : []
  );

  const privateRels = [];
  for (const privateDir of [pluginData, credentialDir]) {
    if (typeof privateDir !== "string" || !privateDir) continue;
    let ancestor = path.resolve(privateDir);
    const missing = [];
    let canonical;
    for (;;) {
      try {
        canonical = path.join(await fs.realpath(ancestor), ...missing);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT" || path.dirname(ancestor) === ancestor) {
          throw new Error("unable to protect private storage path");
        }
        missing.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
    if (!isOutside(canonical, frozenRoot)) privateRels.push("");
    else if (!isOutside(frozenRoot, canonical)) {
      privateRels.push(posixRel(path.relative(frozenRoot, canonical)));
    }
  }

  const userIgnore = ignoreFrom(
    (Array.isArray(exclude) ? exclude : []).filter((pattern) => typeof pattern === "string").join("\n")
  );
  const projectPolicy = await readPolicyFile(path.join(frozenRoot, PROJECT_IGNORE), {
    maxBytes: MAX_IGNORE_BYTES
  });
  if (projectPolicy.kind === "denyAll") userIgnore.add("*");
  else if (projectPolicy.kind === "text") {
    const extra = [];
    for (const line of splitLines(projectPolicy.bytes.toString("utf8"))) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
      extra.push(line);
    }
    if (extra.length) userIgnore.add(extra);
  }

  // Paths git itself ignores (from `git ls-files --others --ignored
  // --exclude-standard --directory`), so .git/info/exclude and the global
  // excludes file count as well as .gitignore. Directories end in `/`.
  const gitIgnored = new Set(Array.isArray(ignoredPaths) ? ignoredPaths.filter((item) => typeof item === "string") : []);
  const ignoredByGit = (relPosix) => gitIgnored.has(relPosix) || gitIgnored.has(`${relPosix}/`);
  const gitignoreCache = new Map();
  /** @type {Map<string, { hash: string, lines: Set<number> }>} */
  const reads = new Map();
  const findingLimit = Number.isInteger(maxFindings) && maxFindings > 0 ? maxFindings : 1;
  /** @type {{ severity: string, note: string, evidence: object[] }[]} */
  const staged = [];

  function checkAbort() {
    if (signal?.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : new Error("aborted");
    }
  }

  async function rootStillValid() {
    try {
      const st = await fs.lstat(frozenRoot);
      return !st.isSymbolicLink() && st.isDirectory() && sameIdent(st, expectedIdent);
    } catch {
      return false;
    }
  }

  function privatePathExcluded(relPosix) {
    return privateRels.some((rel) => rel === "" || relPosix === rel || relPosix.startsWith(`${rel}/`));
  }

  async function gitignoreFor(dirRel) {
    if (gitignoreCache.has(dirRel)) return gitignoreCache.get(dirRel);
    const abs = dirRel ? path.join(frozenRoot, ...dirRel.split("/")) : frozenRoot;
    const policy = await readPolicyFile(path.join(abs, ".gitignore"), { maxBytes: MAX_IGNORE_BYTES });
    let stored = null;
    if (policy.kind === "denyAll") stored = { denyAll: true };
    else if (policy.kind === "text") stored = { ig: gitignoreFrom(policy.bytes.toString("utf8")) };
    gitignoreCache.set(dirRel, stored);
    return stored;
  }

  async function gitPathIgnored(relPosix, isDir) {
    const parts = relPosix.split("/").filter(Boolean);
    const dirs = [""];
    for (let i = 0; i < parts.length - 1; i += 1) dirs.push(parts.slice(0, i + 1).join("/"));
    let ignored = false;
    for (const dirRel of dirs) {
      const entry = await gitignoreFor(dirRel);
      if (entry?.denyAll) return true;
      if (!entry?.ig) continue;
      const local = dirRel ? relPosix.slice(dirRel.length + 1) : relPosix;
      const t = testIgnore(entry.ig, local, isDir);
      if (t.ignored) ignored = true;
      if (t.unignored) ignored = false;
    }
    return ignored;
  }

  /**
   * @param {string} relPosix
   * @param {boolean} isDir
   */
  async function isExcluded(relPosix, isDir) {
    if (privatePathExcluded(relPosix)) return true;
    if (!relPosix) return false;
    if (hardExcluded(relPosix) || ignoredByGit(relPosix)) return true;
    if (ignoredBy(userIgnore, relPosix, isDir)) return true;
    const parts = relPosix.split("/").filter(Boolean);
    for (let i = 0; i < parts.length - 1; i += 1) {
      const ancestor = parts.slice(0, i + 1).join("/");
      if (hardExcluded(ancestor) || privatePathExcluded(ancestor) || ignoredByGit(ancestor)) return true;
      if (ignoredBy(userIgnore, ancestor, true)) return true;
      if (await gitPathIgnored(ancestor, true)) return true;
    }
    return gitPathIgnored(relPosix, isDir);
  }

  /**
   * @param {unknown} userPath
   * @param {{ allowRoot?: boolean }} [opts]
   */
  async function resolveInside(userPath, { allowRoot = false } = {}) {
    if (!(await rootStillValid())) return { error: denied() };
    if (typeof userPath !== "string" || userPath.includes("\0")) return { error: denied() };
    const trimmed = userPath.trim();
    if (!trimmed) {
      if (!allowRoot) return { error: denied() };
      return { relPosix: "", abs: frozenRoot };
    }
    const joined = path.isAbsolute(trimmed)
      ? path.normalize(trimmed)
      : path.normalize(path.join(frozenRoot, trimmed));
    if (isOutside(frozenRoot, joined)) return { error: denied() };
    const relPosix = posixRel(path.relative(frozenRoot, joined));
    let abs = frozenRoot;
    if (relPosix) {
      for (const part of relPosix.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") return { error: denied() };
        abs = path.join(abs, part);
        let lstat;
        try {
          lstat = await fs.lstat(abs);
        } catch {
          return { error: denied() };
        }
        if (lstat.isSymbolicLink()) return { error: denied() };
      }
    }
    if (isOutside(frozenRoot, abs)) return { error: denied() };
    return { relPosix, abs };
  }

  async function verifyOpened(handle, abs) {
    if (!(await rootStillValid())) return false;
    const fdStat = await handle.stat();
    let resolved;
    try {
      resolved = await fs.realpath(abs);
    } catch {
      return false;
    }
    if (isOutside(frozenRoot, resolved)) return false;
    let resolvedStat;
    try {
      resolvedStat = await fs.stat(resolved);
    } catch {
      return false;
    }
    if (!sameIdent(resolvedStat, fdStat)) return false;
    let cur = frozenRoot;
    const rel = posixRel(path.relative(frozenRoot, abs));
    if (rel) {
      for (const part of rel.split("/")) {
        cur = path.join(cur, part);
        let st;
        try {
          st = await fs.lstat(cur);
        } catch {
          return false;
        }
        if (st.isSymbolicLink()) return false;
      }
    }
    let finalLst;
    try {
      finalLst = await fs.lstat(abs);
    } catch {
      return false;
    }
    if (finalLst.isSymbolicLink() || !sameIdent(finalLst, fdStat)) return false;
    return rootStillValid();
  }

  async function openFile(abs) {
    let lstat;
    try {
      lstat = await fs.lstat(abs);
    } catch {
      return { error: denied(), readBytes: 0 };
    }
    if (lstat.isSymbolicLink() || !lstat.isFile()) return { error: denied(), readBytes: 0 };
    let handle;
    try {
      handle = await fs.open(abs, OPEN_FLAGS);
      const stat = await handle.stat();
      if (!sameIdent(stat, lstat) || !stat.isFile()) {
        await handle.close().catch(() => {});
        return { error: denied(), readBytes: 0 };
      }
      if (!(await verifyOpened(handle, abs))) {
        await handle.close().catch(() => {});
        return { error: denied(), readBytes: 0 };
      }
      if (stat.size > MAX_READ_FILE_BYTES) {
        await handle.close().catch(() => {});
        return { error: denied("file too large"), readBytes: 0 };
      }
      const buf = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < buf.length) {
        const got = await handle.read(buf, offset, buf.length - offset, offset);
        if (got.bytesRead === 0) break;
        offset += got.bytesRead;
      }
      await handle.close().catch(() => {});
      const bytes = offset === buf.length ? buf : buf.subarray(0, offset);
      if (bytes.includes(0) || !isUtf8(bytes)) {
        return { error: denied("binary file"), readBytes: bytes.length };
      }
      const hash = createHash("sha256").update(bytes).digest("hex");
      return { bytes, hash, stat, readBytes: bytes.length };
    } catch {
      if (handle) await handle.close().catch(() => {});
      return { error: denied(), readBytes: 0 };
    }
  }

  async function toolRead(args) {
    const parsed = objectArgs(args, ["path", "offset", "limit"]);
    if (!parsed || typeof parsed.path !== "string") return denied("invalid arguments");
    if ("offset" in parsed && (!Number.isInteger(parsed.offset) || parsed.offset < 1)) {
      return denied("invalid arguments");
    }
    if (
      "limit" in parsed &&
      (!Number.isInteger(parsed.limit) || parsed.limit < 1 || parsed.limit > MAX_READ_LINES)
    ) {
      return denied("invalid arguments");
    }
    const located = await resolveInside(parsed.path);
    if (located.error) return located.error;
    if (await isExcluded(located.relPosix, false)) return denied();
    const opened = await openFile(located.abs);
    if (opened.error) return opened.error;
    const lines = splitLines(opened.bytes.toString("utf8"));
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const offset = parsed.offset ?? 1;
    const limit = parsed.limit ?? MAX_READ_LINES_DEFAULT;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const end = offset + slice.length - 1;
    const width = String(Math.max(end, 1)).length;
    const rows = slice.map((line, index) => `${String(offset + index).padStart(width)}|${line}`);
    const bounded = boundItems(rows, MAX_READ_RETURN_BYTES, secretList);
    const shown = new Set();
    for (let i = 0; i < bounded.kept.length; i += 1) shown.add(offset + i);
    const prev = reads.get(located.relPosix);
    if (prev && prev.hash === opened.hash) {
      for (const line of shown) prev.lines.add(line);
    } else {
      reads.set(located.relPosix, { hash: opened.hash, lines: shown });
    }
    return bounded.text;
  }

  async function readDirents(abs) {
    let lstat;
    try {
      lstat = await fs.lstat(abs);
    } catch {
      return { error: denied() };
    }
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) return { error: denied() };
    let handle;
    try {
      handle = await fs.open(abs, OPEN_FLAGS | (constants.O_DIRECTORY ?? 0));
      const stat = await handle.stat();
      if (!sameIdent(stat, lstat) || !stat.isDirectory()) {
        await handle.close().catch(() => {});
        return { error: denied() };
      }
      if (!(await verifyOpened(handle, abs))) {
        await handle.close().catch(() => {});
        return { error: denied() };
      }
      let names;
      try {
        names = await fs.readdir(abs);
      } catch {
        await handle.close().catch(() => {});
        return { error: denied() };
      }
      const later = await fs.lstat(abs);
      const fdLater = await handle.stat();
      await handle.close().catch(() => {});
      if (
        later.isSymbolicLink() ||
        !later.isDirectory() ||
        !sameIdent(later, stat) ||
        !sameIdent(fdLater, stat)
      ) {
        return { error: denied() };
      }
      names.sort((a, b) => a.localeCompare(b));
      const entries = [];
      for (const name of names) {
        if (name.includes("\0")) continue;
        const child = path.join(abs, name);
        let st;
        try {
          st = await fs.lstat(child);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (!st.isDirectory() && !st.isFile()) continue;
        entries.push({ name, directory: st.isDirectory() });
      }
      return { entries };
    } catch {
      if (handle) await handle.close().catch(() => {});
      return { error: denied() };
    }
  }

  async function toolList(args) {
    const parsed = objectArgs(args, ["path", "depth"]);
    if (!parsed) return denied("invalid arguments");
    if (
      "depth" in parsed &&
      (!Number.isInteger(parsed.depth) || parsed.depth < 1 || parsed.depth > MAX_LIST_DEPTH)
    ) {
      return denied("invalid arguments");
    }
    const located = await resolveInside(parsed.path ?? "", { allowRoot: true });
    if (located.error) return located.error;
    if (located.relPosix && (await isExcluded(located.relPosix, true))) return denied();
    let startStat;
    try {
      startStat = await fs.lstat(located.abs);
    } catch {
      return denied();
    }
    if (startStat.isSymbolicLink() || !startStat.isDirectory()) return denied();
    const depth = parsed.depth ?? 1;
    const lines = [];
    let truncated = false;

    const walk = async (relPosix, remaining) => {
      checkAbort();
      if (lines.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      const resolved = await resolveInside(relPosix, { allowRoot: true });
      if (resolved.error) return;
      const listed = await readDirents(resolved.abs);
      if (listed.error) return;
      for (const entry of listed.entries) {
        if (lines.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          return;
        }
        const childRel = relPosix ? `${relPosix}/${entry.name}` : entry.name;
        if (await isExcluded(childRel, entry.directory)) continue;
        lines.push(entry.directory ? `${childRel}/` : childRel);
        if (entry.directory && remaining > 1) await walk(childRel, remaining - 1);
      }
    };

    await walk(located.relPosix, depth);
    if (truncated) lines.push(TRUNCATED_MARKER);
    return sanitizeText(lines.join("\n"), secretList);
  }

  async function toolSearch(args) {
    const parsed = objectArgs(args, ["query", "path", "caseSensitive"]);
    if (!parsed || typeof parsed.query !== "string" || parsed.query.length === 0) {
      return denied("invalid arguments");
    }
    if ("caseSensitive" in parsed && typeof parsed.caseSensitive !== "boolean") {
      return denied("invalid arguments");
    }
    const located = await resolveInside(parsed.path ?? "", { allowRoot: true });
    if (located.error) return located.error;
    if (located.relPosix && (await isExcluded(located.relPosix, true))) return denied();
    const caseSensitive = parsed.caseSensitive === true;
    const needle = caseSensitive ? parsed.query : parsed.query.toLowerCase();
    const matches = [];
    let scanned = 0;
    let files = 0;
    let incomplete = false;

    const consider = async (relPosix, isDir) => {
      checkAbort();
      if (incomplete || matches.length >= MAX_SEARCH_MATCHES) {
        incomplete = true;
        return;
      }
      if (relPosix && (await isExcluded(relPosix, isDir))) return;
      const resolved = await resolveInside(relPosix, { allowRoot: true });
      if (resolved.error) return;
      if (isDir) {
        const listed = await readDirents(resolved.abs);
        if (listed.error) return;
        for (const entry of listed.entries) {
          if (incomplete || matches.length >= MAX_SEARCH_MATCHES) {
            incomplete = true;
            return;
          }
          const childRel = relPosix ? `${relPosix}/${entry.name}` : entry.name;
          await consider(childRel, entry.directory);
        }
        return;
      }
      files += 1;
      if (files > MAX_SEARCH_FILES) {
        incomplete = true;
        return;
      }
      let lst;
      try {
        lst = await fs.lstat(resolved.abs);
      } catch {
        return;
      }
      if (lst.isSymbolicLink() || !lst.isFile()) return;
      if (scanned >= MAX_SEARCH_SCAN_BYTES) {
        incomplete = true;
        return;
      }
      if (lst.size > MAX_READ_FILE_BYTES) {
        incomplete = true;
        return;
      }
      if (scanned + Number(lst.size) > MAX_SEARCH_SCAN_BYTES) {
        incomplete = true;
        return;
      }
      const opened = await openFile(resolved.abs);
      scanned += opened.readBytes ?? 0;
      if (scanned > MAX_SEARCH_SCAN_BYTES) incomplete = true;
      if (opened.error) return;
      const text = opened.bytes.toString("utf8");
      const lines = splitLines(text);
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      for (let i = 0; i < lines.length; i += 1) {
        const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
        if (!hay.includes(needle)) continue;
        matches.push(`${relPosix}:${i + 1}:${lines[i]}`);
        if (matches.length >= MAX_SEARCH_MATCHES) {
          incomplete = true;
          return;
        }
      }
    };

    let startStat;
    try {
      startStat = await fs.lstat(located.abs);
    } catch {
      return denied();
    }
    if (startStat.isSymbolicLink()) return denied();
    await consider(located.relPosix, startStat.isDirectory());

    const bounded = boundItems(matches, MAX_SEARCH_RETURN_BYTES, secretList);
    if (incomplete || bounded.truncated) {
      if (!bounded.text.includes(TRUNCATED_MARKER)) {
        const suffix = bounded.text ? `\n${TRUNCATED_MARKER}` : TRUNCATED_MARKER;
        const combined = `${bounded.text}${suffix}`;
        return utf8Len(combined) <= MAX_SEARCH_RETURN_BYTES ? combined : bounded.text;
      }
    }
    return bounded.text;
  }

  function validateEvidenceItem(item) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const keys = Object.keys(item);
    if (item.kind === "file") {
      if (keys.some((key) => !["kind", "path", "line", "detail"].includes(key))) return null;
      if (typeof item.path !== "string" || item.path.includes("\0")) return null;
      if (!Number.isInteger(item.line) || item.line < 1) return null;
      if (typeof item.detail !== "string" || item.detail.length === 0 || item.detail.length > MAX_DETAIL_CHARS) {
        return null;
      }
      const joined = path.isAbsolute(item.path)
        ? path.normalize(item.path)
        : path.normalize(path.join(frozenRoot, item.path));
      if (isOutside(frozenRoot, joined)) return null;
      const relPosix = posixRel(path.relative(frozenRoot, joined));
      const recorded = reads.get(relPosix);
      if (!recorded || !recorded.lines.has(item.line)) return null;
      return {
        kind: "file",
        path: relPosix,
        line: item.line,
        detail: item.detail,
        hash: recorded.hash
      };
    }
    if (item.kind === "observation") {
      if (keys.some((key) => !["kind", "eventId", "detail"].includes(key))) return null;
      if (typeof item.eventId !== "string" || !item.eventId || !observationIds.has(item.eventId)) return null;
      if (typeof item.detail !== "string" || item.detail.length === 0 || item.detail.length > MAX_DETAIL_CHARS) {
        return null;
      }
      return { kind: "observation", eventId: item.eventId, detail: item.detail };
    }
    return null;
  }

  async function toolAdvise(args) {
    const parsed = objectArgs(args, ["severity", "note", "evidence"]);
    if (!parsed) return denied("invalid arguments");
    if (staged.length >= findingLimit) return denied("finding limit reached");
    if (!SEVERITIES.has(parsed.severity)) return denied("invalid arguments");
    if (typeof parsed.note !== "string" || parsed.note.length === 0 || parsed.note.length > MAX_NOTE_CHARS) {
      return denied("invalid arguments");
    }
    if (contentFree(parsed.note)) return denied("invalid arguments");
    const normalized = normalizeFinding(parsed.note);
    if (fingerprints.has(normalized)) return denied("duplicate finding");
    if (!Array.isArray(parsed.evidence) || parsed.evidence.length < 1 || parsed.evidence.length > MAX_EVIDENCE) {
      return denied("invalid arguments");
    }
    const evidence = [];
    for (const item of parsed.evidence) {
      const valid = validateEvidenceItem(item);
      if (!valid) return denied("invalid evidence");
      evidence.push(valid);
    }
    staged.push({
      severity: parsed.severity,
      note: sanitizeText(parsed.note, secretList),
      evidence
    });
    fingerprints.add(normalized);
    return "staged";
  }

  /**
   * @param {object | object[] | undefined} target
   */
  async function isFresh(target) {
    if (!(await rootStillValid())) return false;
    const evidence = Array.isArray(target)
      ? target
      : Array.isArray(target?.evidence)
        ? target.evidence
        : [];
    for (const item of evidence) {
      if (item?.kind !== "file") continue;
      if (typeof item.path !== "string" || typeof item.hash !== "string") return false;
      if (await isExcluded(item.path, false)) return false;
      const located = await resolveInside(item.path);
      if (located.error) return false;
      const opened = await openFile(located.abs);
      if (opened.error || opened.hash !== item.hash) return false;
    }
    return true;
  }

  async function call(name, args) {
    checkAbort();
    if (!(await rootStillValid())) return denied();
    if (name === "read") return toolRead(args);
    if (name === "list") return toolList(args);
    if (name === "search") return toolSearch(args);
    if (name === "advise") return toolAdvise(args);
    throw new Error(`unknown tool: ${name}`);
  }

  let guidance = "";
  if (!(await isExcluded(WATCHDOG_NAME, false))) {
    const watchdog = await readPolicyFile(path.join(frozenRoot, WATCHDOG_NAME), {
      maxBytes: MAX_WATCHDOG_BYTES,
      allowPartial: true,
      onSymlink: "skip"
    });
    if (watchdog.kind === "text") {
      guidance = sanitizeText(watchdog.bytes.toString("utf8"), secretList);
      if (watchdog.truncated) {
        const bounded = boundItems(splitLines(guidance), MAX_WATCHDOG_BYTES, secretList);
        guidance = bounded.text;
      }
    }
  }

  return {
    call,
    isFresh,
    /** The same exclusion rules the read/list/search tools apply. */
    excluded: (relPosix) => isExcluded(relPosix, false),
    get candidate() {
      return staged.length ? structuredClone(staged[0]) : null;
    },
    get candidates() {
      return structuredClone(staged);
    },
    get done() {
      return staged.length >= findingLimit;
    },
    guidance
  };
}
