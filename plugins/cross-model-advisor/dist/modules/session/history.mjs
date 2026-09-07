import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/session/history.mjs
import { HISTORY_CHAR_BOUND } from "./constants.mjs";
function measure(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}
function groupHistory(history) {
  const groups = [];
  let current = [];
  const isAssistant = (msg) => {
    const role = msg?.role ?? msg?.type;
    return role === "assistant" || role === "model";
  };
  for (const msg of Array.isArray(history) ? history : []) {
    if (isAssistant(msg) && current.length > 0) {
      groups.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
  }
  if (current.length) groups.push(current);
  return groups;
}
function boundHistory(history, { maxChars = HISTORY_CHAR_BOUND, required } = {}) {
  const groups = groupHistory(history);
  const requiredChars = measure(required);
  if (requiredChars > maxChars) {
    return { history: [], fit: false, chars: requiredChars };
  }
  const budget = Math.max(0, maxChars - requiredChars);
  const kept = [];
  let used = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    const size = measure(groups[i]);
    if (used + size > budget) continue;
    kept.unshift(groups[i]);
    used += size;
  }
  return { history: kept.flat(), fit: true, chars: used + requiredChars };
}
function currentContextFits(current, maxChars = HISTORY_CHAR_BOUND) {
  return measure(current) <= maxChars;
}
export {
  boundHistory,
  currentContextFits,
  groupHistory
};
