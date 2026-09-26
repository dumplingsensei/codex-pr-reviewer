#!/usr/bin/env node
/**
 * Lightweight session helper; loads no provider SDK.
 *
 *   control.mjs hook                       UserPromptSubmit; payload on stdin
 *   control.mjs off|status --plugin-data <path>
 *
 * On each real prompt of an enabled session, the hook snapshots the working
 * tree so the Stop gate can diff exactly what Claude changed during the turn.
 * Plugin control commands clear the snapshot so their turns are never
 * reviewed. The hook fails open: any error prints nothing and the turn simply
 * goes unreviewed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, validateRoot } from "./config.mjs";
import { gitTopLevel, snapshotTree } from "./snapshot.mjs";
import { classifyPrompt } from "./session/classifier.mjs";
import { MAX_STDIN_BYTES, USER_TEXT_CAP, WAKE_MARKER } from "./session/constants.mjs";
import {
  explicitPluginData,
  readIdentity,
  sessionDir,
  validateSessionId
} from "./session/paths.mjs";
import { sanitizeText, truncateLabeled } from "./session/sanitize.mjs";
import { loadState, sweepAdviseStops, takeNotices, updateState } from "./session/state.mjs";

const USAGE = "usage: control.mjs hook | session-start | off|status --plugin-data <path>";

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ session_id?: unknown }} [payload]
 */
function sessionFrom(env, payload = {}) {
  const identity = readIdentity(env, payload);
  if (typeof payload.session_id === "string" && identity.sessionId && payload.session_id !== identity.sessionId) {
    throw new Error("hook session id does not match the Claude session environment");
  }
  if (!identity.sessionId || !identity.pluginData) throw new Error("missing session identity");
  const sessionId = validateSessionId(identity.sessionId);
  return { ...identity, sessionId, dir: sessionDir(identity.pluginData, sessionId) };
}

/**
 * UserPromptSubmit. Records this prompt's turn, and hands over what advise
 * mode's background review left: a card for the user and, for findings it did
 * not wake Claude for, context for Claude. Returns hook stdout.
 *
 * @param {any} payload
 * @param {{ env?: NodeJS.ProcessEnv, snapshot?: typeof snapshotTree, now?: () => number }} [options]
 * @returns {Promise<string>}
 */
export async function recordPrompt(payload, { env = process.env, snapshot = snapshotTree, now = Date.now } = {}) {
  if (!payload || typeof payload !== "object" || payload.agent_id) return "";
  const session = sessionFrom(env, payload);
  // Only this hook and the Stop gate change the turn, and Claude Code never
  // runs them at once, so the turn can be decided before taking the lock.
  const seen = await loadState(session.dir);
  if (!seen.enabled || !seen.projectRoot) return "";
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const promptId = typeof payload.prompt_id === "string" ? payload.prompt_id : null;
  const wake = prompt.includes(WAKE_MARKER);
  const current = seen.turn;
  let turn;
  // A message that arrives before the turn's Stop (typed mid-turn, a
  // notification injected at a step boundary, or a prompt after an interrupted
  // turn) extends the turn: re-snapshotting here would drop the edits made
  // before it from the review.
  if (current && !current.control && !current.stopped) {
    const addition = `\n\n[Also sent during this turn]\n${truncateLabeled(sanitizeText(prompt), USER_TEXT_CAP / 2)}`;
    turn = {
      ...current,
      request: truncateLabeled(current.request ?? "", USER_TEXT_CAP - addition.length) + addition,
      promptId: promptId ?? current.promptId
    };
  } else if (classifyPrompt(prompt).kind === "control") {
    // Recorded, so the gate can tell a control prompt from one this hook missed.
    turn = { promptId, control: true };
  } else {
    turn = {
      promptId,
      baseTree: /** @type {string | null} */ (null),
      request: truncateLabeled(sanitizeText(prompt), USER_TEXT_CAP),
      at: now(),
      ...(wake ? { wake: true } : {})
    };
    try {
      turn.baseTree = await snapshot(seen.projectRoot, session.dir, { env });
    } catch (error) {
      turn.error = error instanceof Error ? error.message : "snapshot failed";
    }
  }
  return updateState(session.dir, (state) => {
    if (!state.enabled) return "";
    state.turn = turn;
    // The user's own prompt, not a wake, lets the background review wake Claude again.
    if (!wake) state.advise.wakes = 0;
    sweepAdviseStops(state, now());
    return takeNotices(state, { context: true });
  });
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
export async function runOff(env) {
  const session = sessionFrom(env);
  await updateState(session.dir, (state) => {
    state.enabled = false;
    state.optedOut = true;
    state.turn = null;
  });
  return { ok: true, enabled: false };
}

/**
 * SessionStart. Turns the gate on when this session's git root is listed in
 * the user's own `gate.autoOn`, unless /off was run in this session. Returns
 * hook stdout: a user-visible notice, or "" (never context for Claude).
 *
 * @param {any} payload
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<string>}
 */
export async function runSessionStart(payload, { env = process.env } = {}) {
  if (!payload || typeof payload !== "object" || payload.agent_id) return "";
  const session = sessionFrom(env, payload);
  const state = await loadState(session.dir);
  if (state.enabled || state.optedOut) return "";
  const config = await loadConfig({ env });
  const listed = config.gate.autoOn ?? [];
  if (listed.length === 0) return "";
  const start = env.CLAUDE_PROJECT_DIR?.trim() || (typeof payload.cwd === "string" ? payload.cwd : "");
  const top = start ? await gitTopLevel(start, { env }) : null;
  if (!top) return "";
  const projectRoot = await validateRoot(top);
  let match = false;
  for (const entry of listed) {
    const resolved = await fs.promises.realpath(entry).catch(() => null);
    if (resolved === projectRoot) match = true;
  }
  if (!match) return "";
  const turnedOn = await updateState(session.dir, (fresh) => {
    if (fresh.enabled || fresh.optedOut) return false;
    fresh.enabled = true;
    fresh.projectRoot = projectRoot;
    fresh.turn = null;
    fresh.rounds = { promptId: null, count: 0 };
    return true;
  });
  if (!turnedOn) return "";
  const notice = `cross-model-advisor: review gate on for ${projectRoot} (gate.autoOn). Changed turns go to your configured advisors; /cross-model-advisor:off stops it for this session.`;
  return `${JSON.stringify({ systemMessage: notice })}\n`;
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
export async function runStatus(env) {
  const session = sessionFrom(env);
  const state = await loadState(session.dir);
  return {
    ok: true,
    enabled: state.enabled,
    projectRoot: state.projectRoot,
    lastReview: state.last,
    lastSkip: state.lastSkip,
    advisors: state.advisors
  };
}

/**
 * @param {NodeJS.ReadableStream} stream
 */
async function readStdin(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) throw new Error("stdin too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const op = argv[0];
  if (op === "hook" && argv.length === 1) {
    try {
      const raw = await readStdin(process.stdin);
      const out = raw.trim() ? await recordPrompt(JSON.parse(raw), { env }) : "";
      if (out) process.stdout.write(out);
    } catch {
      // Fail open: the gate lets an unsnapshotted turn stop and says it was not reviewed.
    }
    process.exitCode = 0;
    return;
  }
  if (op === "session-start" && argv.length === 1) {
    try {
      const raw = await readStdin(process.stdin);
      const out = raw.trim() ? await runSessionStart(JSON.parse(raw), { env }) : "";
      if (out) process.stdout.write(out);
    } catch {
      // Fail closed for auto-on: any doubt leaves the gate off, as without the setting.
    }
    process.exitCode = 0;
    return;
  }
  if ((op === "off" || op === "status") && argv.length === 3 && argv[1] === "--plugin-data") {
    let scoped;
    try {
      scoped = { ...env, CLAUDE_PLUGIN_DATA: explicitPluginData(argv[2]) };
    } catch {
      process.stderr.write("cross-model-advisor: identity: invalid --plugin-data; run this through the plugin's skill\n");
      process.exitCode = 1;
      return;
    }
    try {
      const result = op === "off" ? await runOff(scoped) : await runStatus(scoped);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      const message = sanitizeText(error instanceof Error ? error.message : "command failed");
      process.stdout.write(`${JSON.stringify({ ok: false, error: "identity", message }, null, 2)}\n`);
    }
    return;
  }
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 1;
}

const realPath = (value) => {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};
const invokedDirectly =
  process.argv[1] &&
  path.basename(fileURLToPath(import.meta.url)) === "control.mjs" &&
  realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
