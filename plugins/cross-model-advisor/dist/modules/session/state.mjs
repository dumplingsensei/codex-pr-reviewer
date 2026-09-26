import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/session/state.mjs
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FILE_MODE, NOTICE_CONTEXT_CHARS, STATE_VERSION, USER_SUMMARY_CHARS } from "./constants.mjs";
import { truncateLabeled } from "./sanitize.mjs";
import { atomicWriteJson, ensurePrivateDir, statePath } from "./paths.mjs";
var MAX_REVIEWED = 64;
var LOCK_WAIT_MS = 1e4;
var LOCK_STALE_MS = 3e4;
function emptyState(overrides = {}) {
  return {
    version: STATE_VERSION,
    enabled: false,
    projectRoot: null,
    /** @type {Turn | null} */
    turn: null,
    rounds: { promptId: null, count: 0 },
    /** @type {string[]} base..head pairs already reviewed */
    reviewed: [],
    /** @type {LastReview | null} the last review that ran */
    last: null,
    /** @type {LastReview | null} the last Stop that did not review, and why */
    lastSkip: null,
    /** @type {Record<string, { reviews: number, usage: object | null, lastError: string | null }>} */
    advisors: {},
    /**
     * Advise mode. `stops`: turns the Stop gate measured for the background
     * review, keyed by Stop. `notices`: background results not yet shown to
     * the user (`user`) or given to Claude (`context`). `wakes`: times the
     * background review has woken Claude since the user's last prompt.
     *
     * @type {{ stops: AdviseStop[], notices: { id: string, at: number, user: string | null, context: string | null }[], wakes: number }}
     */
    advise: { stops: [], notices: [], wakes: 0 },
    ...overrides
  };
}
async function loadState(dir) {
  let raw;
  try {
    raw = await fs.readFile(statePath(dir), "utf8");
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_VERSION) return emptyState();
    return emptyState(parsed);
  } catch {
    return emptyState();
  }
}
async function saveState(dir, state) {
  const reviewed = Array.isArray(state.reviewed) ? state.reviewed.slice(-MAX_REVIEWED) : [];
  await atomicWriteJson(statePath(dir), { ...state, reviewed });
}
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function processAlive(pid) {
  if (!Number.isInteger(pid) || /** @type {number} */
  pid <= 0) return false;
  try {
    process.kill(
      /** @type {number} */
      pid,
      0
    );
    return true;
  } catch (error) {
    return (
      /** @type {NodeJS.ErrnoException} */
      error?.code === "EPERM"
    );
  }
}
async function readLock(file) {
  try {
    const [raw, st] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    let owner = null;
    try {
      owner = JSON.parse(raw);
    } catch {
    }
    return { owner, age: Date.now() - st.mtimeMs };
  } catch {
    return null;
  }
}
async function acquireStateLock(dir) {
  const file = path.join(dir, "state.lock");
  const token = randomUUID();
  const started = Date.now();
  for (; ; ) {
    try {
      await fs.writeFile(file, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: FILE_MODE });
      return { file, token };
    } catch (error) {
      if (
        /** @type {NodeJS.ErrnoException} */
        error?.code !== "EEXIST"
      ) throw error;
    }
    const held = await readLock(file);
    if (!held) continue;
    if (held.owner && !processAlive(held.owner.pid) || held.age > LOCK_STALE_MS) {
      const again = await readLock(file);
      if (again && again.owner?.token === held.owner?.token) await fs.rm(file, { force: true });
      continue;
    }
    if (Date.now() - started > LOCK_WAIT_MS) throw new Error("session state is locked");
    await sleep(10 + Math.floor(Math.random() * 20));
  }
}
async function releaseStateLock(lock) {
  const held = await readLock(lock.file);
  if (held?.owner?.token === lock.token) await fs.rm(lock.file, { force: true });
}
async function updateState(dir, mutate) {
  await ensurePrivateDir(dir);
  const lock = await acquireStateLock(dir);
  try {
    const state = await loadState(dir);
    const result = await mutate(state);
    await saveState(dir, state);
    return result;
  } finally {
    await releaseStateLock(lock);
  }
}
function takeNotices(state, { context }) {
  const notices = Array.isArray(state.advise?.notices) ? state.advise.notices : [];
  const user = notices.map((notice) => notice.user).filter(Boolean);
  const forClaude = context ? notices.map((notice) => notice.context).filter(Boolean) : [];
  state.advise.notices = notices.map((notice) => ({ ...notice, user: null, context: context ? null : notice.context })).filter((notice) => notice.user || notice.context);
  const out = {};
  if (user.length) out.systemMessage = truncateLabeled(user.join("\n"), USER_SUMMARY_CHARS);
  if (forClaude.length) {
    out.hookSpecificOutput = {
      hookEventName: "UserPromptSubmit",
      additionalContext: truncateLabeled(forClaude.join("\n\n"), NOTICE_CONTEXT_CHARS)
    };
  }
  return Object.keys(out).length ? `${JSON.stringify(out)}
` : "";
}
export {
  emptyState,
  loadState,
  saveState,
  takeNotices,
  updateState
};
