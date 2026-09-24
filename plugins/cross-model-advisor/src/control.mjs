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
import { snapshotTree } from "./snapshot.mjs";
import { classifyPrompt } from "./session/classifier.mjs";
import { MAX_STDIN_BYTES, USER_TEXT_CAP } from "./session/constants.mjs";
import {
  ensurePrivateDir,
  explicitPluginData,
  readIdentity,
  sessionDir,
  validateSessionId
} from "./session/paths.mjs";
import { sanitizeText, truncateLabeled } from "./session/sanitize.mjs";
import { loadState, saveState } from "./session/state.mjs";

const USAGE = "usage: control.mjs hook | off|status --plugin-data <path>";

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
 * UserPromptSubmit. Returns nothing: this hook never adds context.
 *
 * @param {any} payload
 * @param {{ env?: NodeJS.ProcessEnv, snapshot?: typeof snapshotTree, now?: () => number }} [options]
 */
export async function recordPrompt(payload, { env = process.env, snapshot = snapshotTree, now = Date.now } = {}) {
  if (!payload || typeof payload !== "object" || payload.agent_id) return;
  const session = sessionFrom(env, payload);
  const state = await loadState(session.dir);
  if (!state.enabled || !state.projectRoot) return;
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (classifyPrompt(prompt).kind === "control") {
    state.turn = null;
    await saveState(session.dir, state);
    return;
  }
  const turn = {
    promptId: typeof payload.prompt_id === "string" ? payload.prompt_id : null,
    baseTree: /** @type {string | null} */ (null),
    request: truncateLabeled(sanitizeText(prompt), USER_TEXT_CAP),
    at: now()
  };
  try {
    turn.baseTree = await snapshot(state.projectRoot, session.dir, { env });
  } catch (error) {
    turn.error = error instanceof Error ? error.message : "snapshot failed";
  }
  state.turn = turn;
  await saveState(session.dir, state);
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
export async function runOff(env) {
  const session = sessionFrom(env);
  await ensurePrivateDir(session.dir);
  const state = await loadState(session.dir);
  state.enabled = false;
  state.turn = null;
  await saveState(session.dir, state);
  return { ok: true, enabled: false };
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
      if (raw.trim()) await recordPrompt(JSON.parse(raw), { env });
    } catch {
      // Fail open: an unsnapshotted turn is skipped by the gate, not blocked.
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
