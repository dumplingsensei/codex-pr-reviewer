/**
 * Shared session limits and identifiers, kept numeric so control, gate, and
 * tests agree.
 */

/** Exact namespaced commands whose turns are never reviewed. */
export const CONTROL_COMMANDS = Object.freeze([
  "cross-model-advisor:on",
  "cross-model-advisor:off",
  "cross-model-advisor:status",
  "cross-model-advisor:doctor",
  "cross-model-advisor:setup",
  "cross-model-advisor:login",
  "cross-model-advisor:logout"
]);

export const SEVERITY_ORDER = Object.freeze({ blocker: 0, concern: 1, nit: 2 });

/** Findings one advisor may report for one turn. */
export const MAX_FINDINGS_PER_REVIEW = 5;
/** Characters of the user's request and Claude's final message sent to advisors. */
export const USER_TEXT_CAP = 8 * 1024;
/** Characters of provider context kept during one review's tool loop. */
export const HISTORY_CHAR_BOUND = 60_000;
/** Characters of findings handed back to Claude in a block reason. */
export const MAX_REASON_CHARS = 8_000;
export const MAX_STDIN_BYTES = 1_048_576;
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ERROR_LOG_INTERVAL_MS = 5_000;
export const ERROR_LOG_MAX_BYTES = 64 * 1024;

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export const STATE_VERSION = 2;
export const PLUGIN_NAME = "cross-model-advisor";
