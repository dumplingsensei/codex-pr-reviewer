/**
 * Per-session gate state. Small, non-secret, and written atomically: on/off,
 * the frozen project root, this prompt's baseline snapshot, how many times the
 * prompt has been sent back, which diffs were already reviewed, and the last
 * review for /status. Never stores provider conversations, source, or keys.
 */

import fs from "node:fs/promises";
import { STATE_VERSION } from "./constants.mjs";
import { atomicWriteJson, statePath } from "./paths.mjs";

const MAX_REVIEWED = 64;

/**
 * @typedef {{
 *   promptId: string | null,
 *   baseTree: string | null,
 *   request: string,
 *   at: number,
 *   error?: string
 * }} Turn
 *
 * @typedef {{
 *   at: number,
 *   promptId: string | null,
 *   outcome: "blocked" | "reported" | "passed" | "skipped" | "failed",
 *   reason: string,
 *   round?: number,
 *   findings?: { advisor: string, severity: string, note: string, evidence: object[] }[],
 *   advisors?: { name: string, provider: string, model: string, ok: boolean, findings: number, error?: string }[]
 * }} LastReview
 */

/**
 * @param {object} [overrides]
 */
export function emptyState(overrides = {}) {
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
    ...overrides
  };
}

/**
 * Missing or unreadable state is a fresh disabled session.
 *
 * @param {string} dir
 */
export async function loadState(dir) {
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

/**
 * @param {string} dir
 * @param {ReturnType<typeof emptyState>} state
 */
export async function saveState(dir, state) {
  const reviewed = Array.isArray(state.reviewed) ? state.reviewed.slice(-MAX_REVIEWED) : [];
  await atomicWriteJson(statePath(dir), { ...state, reviewed });
}
