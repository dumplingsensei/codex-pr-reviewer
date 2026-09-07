import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/session/constants.mjs
var CONTROL_COMMANDS = Object.freeze([
  "cross-model-advisor:on",
  "cross-model-advisor:off",
  "cross-model-advisor:status",
  "cross-model-advisor:doctor",
  "cross-model-advisor:login",
  "cross-model-advisor:logout"
]);
var CONTROL_OPS = Object.freeze(["on", "off", "status", "doctor", "hook", "ack"]);
var DRAIN_EVENTS = Object.freeze([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure"
]);
var SILENT_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptExpansion",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "SessionEnd"
]);
var SEVERITY_ORDER = Object.freeze({ blocker: 0, concern: 1, nit: 2 });
var WARM_IPC_MS = 200;
var COLD_START_MS = 1e3;
var HOOK_TIMEOUT_MS = 2e3;
var SESSION_END_TIMEOUT_MS = 1e3;
var DEBOUNCE_MS = 750;
var IDLE_EXIT_MS = 12e4;
var CLAIM_LEASE_MS = 2e3;
var DEFAULT_REVIEW_TIMEOUT_MS = 9e4;
var DEFAULT_MAX_CONCURRENT = 2;
var DEFAULT_MAX_REVIEWS = 40;
var DEFAULT_MAX_TOOL_CALLS = 8;
var DEFAULT_MAX_OUTPUT_TOKENS = 1500;
var USER_TEXT_CAP = 8 * 1024;
var TOOL_SUMMARY_CAP = 1024;
var TRANSCRIPT_TAIL_BYTES = 256 * 1024;
var HISTORY_CHAR_BOUND = 6e4;
var MAX_DRAIN_FINDINGS = 3;
var MAX_ENVELOPE_CHARS = 8e3;
var MAX_STDIN_BYTES = 1048576;
var MAX_DEDUPE = 8192;
var MAX_FINGERPRINTS = 4096;
var SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var ERROR_LOG_INTERVAL_MS = 5e3;
var ERROR_LOG_MAX_BYTES = 64 * 1024;
var DIR_MODE = 448;
var FILE_MODE = 384;
var WORKER_UMASK = 63;
var STATE_VERSION = 1;
var PLUGIN_NAME = "cross-model-advisor";
export {
  CLAIM_LEASE_MS,
  COLD_START_MS,
  CONTROL_COMMANDS,
  CONTROL_OPS,
  DEBOUNCE_MS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_REVIEWS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_REVIEW_TIMEOUT_MS,
  DIR_MODE,
  DRAIN_EVENTS,
  ERROR_LOG_INTERVAL_MS,
  ERROR_LOG_MAX_BYTES,
  FILE_MODE,
  HISTORY_CHAR_BOUND,
  HOOK_TIMEOUT_MS,
  IDLE_EXIT_MS,
  MAX_DEDUPE,
  MAX_DRAIN_FINDINGS,
  MAX_ENVELOPE_CHARS,
  MAX_FINGERPRINTS,
  MAX_STDIN_BYTES,
  PLUGIN_NAME,
  SESSION_END_TIMEOUT_MS,
  SESSION_RETENTION_MS,
  SEVERITY_ORDER,
  SILENT_EVENTS,
  STATE_VERSION,
  TOOL_SUMMARY_CAP,
  TRANSCRIPT_TAIL_BYTES,
  USER_TEXT_CAP,
  WARM_IPC_MS,
  WORKER_UMASK
};
