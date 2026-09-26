import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/session/constants.mjs
var CONTROL_COMMANDS = Object.freeze([
  "cross-model-advisor:on",
  "cross-model-advisor:off",
  "cross-model-advisor:status",
  "cross-model-advisor:doctor",
  "cross-model-advisor:setup",
  "cross-model-advisor:login",
  "cross-model-advisor:logout"
]);
var SEVERITY_ORDER = Object.freeze({ blocker: 0, concern: 1, nit: 2 });
var MAX_FINDINGS_PER_REVIEW = 5;
var USER_TEXT_CAP = 8 * 1024;
var HISTORY_CHAR_BOUND = 6e4;
var REVIEW_CONTEXT_CHARS = 24e4;
var MAX_REASON_CHARS = 8e3;
var MAX_STDIN_BYTES = 1048576;
var STOP_REVIEW_BUDGET_MS = 27e4;
var SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var ERROR_LOG_INTERVAL_MS = 5e3;
var ERROR_LOG_MAX_BYTES = 64 * 1024;
var DIR_MODE = 448;
var FILE_MODE = 384;
var STATE_VERSION = 2;
var PLUGIN_NAME = "cross-model-advisor";
var WAKE_MARKER = "[cross-model-advisor background review]";
var STEER_MARKER = "[cross-model-advisor step review]";
var USER_SUMMARY_CHARS = 2e3;
var NOTICE_CONTEXT_CHARS = 8e3;
var ADVISE_WAIT_MS = 12e4;
var ADVISE_HOOK_TIMEOUT_MS = 3e5;
export {
  ADVISE_HOOK_TIMEOUT_MS,
  ADVISE_WAIT_MS,
  CONTROL_COMMANDS,
  DIR_MODE,
  ERROR_LOG_INTERVAL_MS,
  ERROR_LOG_MAX_BYTES,
  FILE_MODE,
  HISTORY_CHAR_BOUND,
  MAX_FINDINGS_PER_REVIEW,
  MAX_REASON_CHARS,
  MAX_STDIN_BYTES,
  NOTICE_CONTEXT_CHARS,
  PLUGIN_NAME,
  REVIEW_CONTEXT_CHARS,
  SESSION_RETENTION_MS,
  SEVERITY_ORDER,
  STATE_VERSION,
  STEER_MARKER,
  STOP_REVIEW_BUDGET_MS,
  USER_SUMMARY_CHARS,
  USER_TEXT_CAP,
  WAKE_MARKER
};
