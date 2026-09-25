#!/usr/bin/env node
import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/control.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, validateRoot } from "./config.mjs";
import { gitTopLevel, snapshotTree } from "./snapshot.mjs";
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
var USAGE = "usage: control.mjs hook | session-start | off|status --plugin-data <path>";
function sessionFrom(env, payload = {}) {
  const identity = readIdentity(env, payload);
  if (typeof payload.session_id === "string" && identity.sessionId && payload.session_id !== identity.sessionId) {
    throw new Error("hook session id does not match the Claude session environment");
  }
  if (!identity.sessionId || !identity.pluginData) throw new Error("missing session identity");
  const sessionId = validateSessionId(identity.sessionId);
  return { ...identity, sessionId, dir: sessionDir(identity.pluginData, sessionId) };
}
async function recordPrompt(payload, { env = process.env, snapshot = snapshotTree, now = Date.now } = {}) {
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
    baseTree: (
      /** @type {string | null} */
      null
    ),
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
async function runOff(env) {
  const session = sessionFrom(env);
  await ensurePrivateDir(session.dir);
  const state = await loadState(session.dir);
  state.enabled = false;
  state.optedOut = true;
  state.turn = null;
  await saveState(session.dir, state);
  return { ok: true, enabled: false };
}
async function runSessionStart(payload, { env = process.env } = {}) {
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
  await ensurePrivateDir(session.dir);
  state.enabled = true;
  state.projectRoot = projectRoot;
  state.turn = null;
  state.rounds = { promptId: null, count: 0 };
  await saveState(session.dir, state);
  const notice = `cross-model-advisor: review gate on for ${projectRoot} (gate.autoOn). Changed turns go to your configured advisors; /cross-model-advisor:off stops it for this session.`;
  return `${JSON.stringify({ systemMessage: notice })}
`;
}
async function runStatus(env) {
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
async function main(argv = process.argv.slice(2), env = process.env) {
  const op = argv[0];
  if (op === "hook" && argv.length === 1) {
    try {
      const raw = await readStdin(process.stdin);
      if (raw.trim()) await recordPrompt(JSON.parse(raw), { env });
    } catch {
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
      process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
    } catch (error) {
      const message = sanitizeText(error instanceof Error ? error.message : "command failed");
      process.stdout.write(`${JSON.stringify({ ok: false, error: "identity", message }, null, 2)}
`);
    }
    return;
  }
  process.stderr.write(`${USAGE}
`);
  process.exitCode = 1;
}
var realPath = (value) => {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};
var invokedDirectly = process.argv[1] && path.basename(fileURLToPath(import.meta.url)) === "control.mjs" && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(() => {
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
export {
  main,
  recordPrompt,
  runOff,
  runSessionStart,
  runStatus
};
