/**
 * Bound per-advisor conversational history. API histories keep complete
 * assistant/tool-result groups; CLI histories are the same groups rendered
 * later into a fresh native session. No extra LLM summarizer.
 */

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

/**
 * Partition a history array into complete groups. A group starts at an
 * assistant/model message and includes following tool-result messages until
 * the next assistant message. Leading user/system messages form their own group.
 *
 * @param {unknown[]} history
 */
export function groupHistory(history) {
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

/**
 * Evict oldest complete groups until the rendered size fits. `fit` is false
 * only when required current context itself exceeds the bound.
 *
 * @param {unknown[]} history
 * @param {{ maxChars?: number, required?: unknown }} [options]
 */
export function boundHistory(history, { maxChars = HISTORY_CHAR_BOUND, required } = {}) {
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

/**
 * Current-task observations plus latest user request must fit or the advisor
 * pauses with a context-limit error instead of silently dropping the task.
 *
 * @param {{ latestTask?: unknown, observations?: unknown[] }} current
 * @param {number} [maxChars]
 */
export function currentContextFits(current, maxChars = HISTORY_CHAR_BOUND) {
  return measure(current) <= maxChars;
}
