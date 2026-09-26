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
/**
 * Characters one review may send a provider: system prompt, turn, and every
 * tool result so far. The model's own context window can lower it further.
 */
export const REVIEW_CONTEXT_CHARS = 240_000;
/** Characters of findings handed back to Claude in a block reason. */
export const MAX_REASON_CHARS = 8_000;
export const MAX_STDIN_BYTES = 1_048_576;
/**
 * Time the Stop hook gives all advisors together. hooks/hooks.json allows the
 * hook 300 seconds; the rest is left for snapshots, the diff, and saving state,
 * because a hook Claude Code kills records nothing.
 */
export const STOP_REVIEW_BUDGET_MS = 270_000;
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ERROR_LOG_INTERVAL_MS = 5_000;
export const ERROR_LOG_MAX_BYTES = 64 * 1024;

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export const STATE_VERSION = 2;
export const PLUGIN_NAME = "cross-model-advisor";

/** Starts every message the background review wakes Claude with. */
export const WAKE_MARKER = "[cross-model-advisor background review]";
/** Starts every message a watch-mode step review interrupts Claude with. */
export const STEER_MARKER = "[cross-model-advisor step review]";
/** Longest user-visible notice. */
export const USER_SUMMARY_CHARS = 2_000;
/** Longest context handed to Claude with a prompt. */
export const NOTICE_CONTEXT_CHARS = 8_000;
/** How long advise mode's background hook waits for the Stop gate to measure the turn. */
export const ADVISE_WAIT_MS = 120_000;
/** The background hook's timeout in hooks.json: Claude Code kills it then. */
export const ADVISE_HOOK_TIMEOUT_MS = 300_000;
