/**
 * Shared session limits and identifiers. Keep these numeric so worker,
 * control, and tests agree without re-deriving them from the plan.
 */

/** Exact namespaced commands that never become reviewer observations. */
export const CONTROL_COMMANDS = Object.freeze([
  "cross-model-advisor:on",
  "cross-model-advisor:off",
  "cross-model-advisor:status",
  "cross-model-advisor:doctor",
  "cross-model-advisor:setup",
  "cross-model-advisor:login",
  "cross-model-advisor:logout"
]);

export const CONTROL_OPS = Object.freeze(["on", "off", "status", "doctor", "hook", "ack"]);

export const DRAIN_EVENTS = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure"
]);

export const SILENT_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptExpansion",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "SessionEnd"
]);

export const SEVERITY_ORDER = Object.freeze({ blocker: 0, concern: 1, nit: 2 });

export const WARM_IPC_MS = 200;
export const COLD_START_MS = 1_000;
export const HOOK_TIMEOUT_MS = 2_000;
export const SESSION_END_TIMEOUT_MS = 1_000;
export const DEBOUNCE_MS = 750;
export const IDLE_EXIT_MS = 120_000;
export const CLAIM_LEASE_MS = 2_000;
export const DEFAULT_REVIEW_TIMEOUT_MS = 90_000;
export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_MAX_REVIEWS = 40;
export const DEFAULT_MAX_TOOL_CALLS = 8;
export const DEFAULT_MAX_OUTPUT_TOKENS = 1_500;

export const USER_TEXT_CAP = 8 * 1024;
export const TOOL_SUMMARY_CAP = 1_024;
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
export const HISTORY_CHAR_BOUND = 60_000;
export const MAX_DRAIN_FINDINGS = 3;
export const MAX_ENVELOPE_CHARS = 8_000;
export const MAX_STDIN_BYTES = 1_048_576;
export const MAX_DEDUPE = 8_192;
export const MAX_FINGERPRINTS = 4_096;
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ERROR_LOG_INTERVAL_MS = 5_000;
export const ERROR_LOG_MAX_BYTES = 64 * 1024;

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
export const WORKER_UMASK = 0o077;

export const STATE_VERSION = 1;
export const PLUGIN_NAME = "cross-model-advisor";
