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
var MAX_REASON_CHARS = 8e3;
var MAX_STDIN_BYTES = 1048576;
var SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var ERROR_LOG_INTERVAL_MS = 5e3;
var ERROR_LOG_MAX_BYTES = 64 * 1024;
var DIR_MODE = 448;
var FILE_MODE = 384;
var STATE_VERSION = 2;
var PLUGIN_NAME = "cross-model-advisor";
export {
  CONTROL_COMMANDS,
  DIR_MODE,
  ERROR_LOG_INTERVAL_MS,
  ERROR_LOG_MAX_BYTES,
  FILE_MODE,
  HISTORY_CHAR_BOUND,
  MAX_FINDINGS_PER_REVIEW,
  MAX_REASON_CHARS,
  MAX_STDIN_BYTES,
  PLUGIN_NAME,
  SESSION_RETENTION_MS,
  SEVERITY_ORDER,
  STATE_VERSION,
  USER_TEXT_CAP
};
