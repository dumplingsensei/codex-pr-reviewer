#!/usr/bin/env node
/**
 * Real PTY proof for the bundled terminal settings menu.
 *
 *   node tests/cross-model-advisor/fixtures/terminal-smoke.mjs
 *
 * Spawns dist/setup-control.mjs menu through tests/cross-model-advisor/fixtures/terminal-driver.py.
 * Isolated directories only. Fake/scripted credentials and loopback HTTP. No production providers.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DRIVER_PATH = path.join(here, "terminal-driver.py");
export const REPO_ROOT = path.resolve(here, "../../..");
export const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "cross-model-advisor");
export const SETUP_HELPER = path.join(PLUGIN_ROOT, "dist", "setup-control.mjs");
export const CONTROL_HELPER = path.join(PLUGIN_ROOT, "dist", "control.mjs");
export const DIST_MODULES = path.join(PLUGIN_ROOT, "dist", "modules");

const STRIP_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_PROFILE",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "NODE_PATH",
  "NODE_OPTIONS"
];

const LIMITS = Object.freeze({
  maxConcurrentAdvisors: 2,
  reviewTimeoutSeconds: 30,
  maxToolCallsPerReview: 8,
  maxOutputTokens: 1500,
  maxReviewsPerAdvisorPerSession: 40
});

const HOME_RE = /Cross-model advisors/;
const SAVE_APPLY_RE = /Save & Apply/;
const SAVE_DEFAULTS_RE = /Save defaults/;
const QUIT_RE = /\bQuit\b/;
const ADD_ADVISOR_RE = /Add advisor/;
const PROVIDERS_RE = /Provider accounts/;
const DISCARD_RE = /\bDiscard\b/;

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stripAnsi(text) {
  return String(text ?? "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

export function posixQuote(value) {
  const text = String(value);
  if (text.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function fileRevision(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function defaultLimits() {
  return { ...LIMITS };
}

export function smokeEnv(world, extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of STRIP_ENV) delete env[key];
  env.TERM = extra.TERM ?? "xterm-256color";
  env.HOME = world.home;
  env.CLAUDE_CONFIG_DIR = extra.CLAUDE_CONFIG_DIR ?? world.configDir;
  env.CLAUDE_PLUGIN_DATA = extra.CLAUDE_PLUGIN_DATA ?? world.data;
  env.CLAUDE_PROJECT_DIR = extra.CLAUDE_PROJECT_DIR ?? world.project;
  env.CLAUDE_CODE_SESSION_ID = extra.CLAUDE_CODE_SESSION_ID ?? world.sessionId;
  env.CLAUDE_SESSION_ID = extra.CLAUDE_SESSION_ID ?? extra.CLAUDE_CODE_SESSION_ID ?? world.sessionId;
  env.CMA_SMOKE_API_KEY = extra.CMA_SMOKE_API_KEY ?? "sk-smoke-not-a-real-key";
  env.PATH = extra.PATH ?? process.env.PATH ?? "";
  delete env.CLAUDE_PLUGIN_ROOT;
  if (typeof extra.CLAUDE_PLUGIN_ROOT === "string" && extra.CLAUDE_PLUGIN_ROOT) {
    env.CLAUDE_PLUGIN_ROOT = extra.CLAUDE_PLUGIN_ROOT;
  }
  return env;
}

export async function makeSmokeWorld(prefix = "cma-term-") {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const project = path.join(root, "project");
  const data = path.join(root, "plugin data");
  const configDir = path.join(root, "claude-config");
  const home = path.join(root, "home");
  await fsPromises.mkdir(project, { recursive: true });
  await fsPromises.mkdir(data, { recursive: true });
  await fsPromises.mkdir(configDir, { recursive: true });
  await fsPromises.mkdir(home, { recursive: true });
  const world = {
    root,
    project: fs.realpathSync(project),
    data: fs.realpathSync(data),
    configDir: fs.realpathSync(configDir),
    home: fs.realpathSync(home),
    sessionId: `menu-${randomUUID().slice(0, 8)}`,
    closed: false
  };
  world.configFile = path.join(world.configDir, "cross-model-advisor.json");
  world.close = async () => {
    if (world.closed) return;
    world.closed = true;
    await shutdownSession(world).catch(() => {});
    await fsPromises.rm(root, { recursive: true, force: true });
  };
  return world;
}

export function writeJsonConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(file, body, { mode: 0o600 });
  return createHash("sha256").update(body).digest("hex");
}

export function readJsonConfig(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function configV2(overrides = {}) {
  return {
    version: 2,
    providers: {
      "codex-login": { kind: "oauth", provider: "openai-codex" },
      loopback: {
        kind: "api",
        provider: "openai-compatible",
        apiKeyEnv: "CMA_SMOKE_API_KEY",
        baseUrl: "http://127.0.0.1:9/v1",
        models: {
          "smoke-model": {
            contextWindow: 16_000,
            maxTokens: 2_048,
            reasoning: false,
            input: ["text"]
          }
        }
      }
    },
    advisors: [
      {
        name: "architecture",
        provider: "codex-login",
        model: "gpt-5",
        instructions: "Look for avoidable complexity.",
        enabled: true,
        reasoningEffort: "default"
      },
      {
        name: "correctness",
        provider: "loopback",
        model: "smoke-model",
        instructions: "Look for observable correctness failures.",
        enabled: true,
        reasoningEffort: "default"
      }
    ],
    exclude: ["tmp/**"],
    limits: defaultLimits(),
    ...overrides
  };
}

export function thinkingMap(overrides = {}) {
  return {
    off: "none",
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
    ...overrides
  };
}

export function writeAuthStub(dir, markerFile) {
  const file = path.join(dir, "auth-stub.mjs");
  const body = `#!/usr/bin/env node
import fs from "node:fs";
const marker = ${JSON.stringify(markerFile)};
if (marker) {
  fs.writeFileSync(marker, process.argv.slice(2).join(" ") + "\\n");
}
process.stdout.write("CMA_AUTH_STUB\\n");
try {
  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
} catch {}
process.stdin.resume();
const timer = setTimeout(() => process.exit(0), 4000);
process.stdin.on("data", () => {
  clearTimeout(timer);
  process.exit(0);
});
`;
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

export function writeMenuHarness(dir, { menuModule, authHelperPath }) {
  const file = path.join(dir, "menu-harness.mjs");
  const body = `#!/usr/bin/env node
import { pathToFileURL } from "node:url";
const menu = await import(${JSON.stringify(pathToFileURL(menuModule).href)});
const code = await menu.runSetupMenu({
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  authHelperPath: ${JSON.stringify(authHelperPath)}
});
if (typeof code === "number" && code !== 0) process.exitCode = code;
`;
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

export async function startHitServer() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.statusCode = 500;
    res.end('{"error":"smoke-no-review"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: address.port,
    hits: () => hits,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function pythonBin() {
  return process.env.PYTHON ?? "python3";
}

export class OwnedPty {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.pending = new Map();
    this.nextId = 1;
    this.dead = false;
    this.closing = false;
    this.stderr = "";
    this.last = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 64_000) this.stderr = this.stderr.slice(-32_000);
    });
    child.on("error", (error) => this._rejectAll(error));
    child.on("exit", (code, signal) => {
      this.dead = true;
      if (!this.closing) {
        this._rejectAll(
          new Error(`pty driver exited code=${code} signal=${signal}\n${this.stderr}`)
        );
      }
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let index;
    while ((index = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, index);
      this.buf = this.buf.slice(index + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (error) {
        this._rejectAll(new Error(`pty driver sent invalid JSON: ${line}\n${error}`));
        return;
      }
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok === false) pending.reject(new Error(msg.error || "pty driver error"));
      else pending.resolve(msg);
    }
  }

  _rejectAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  request(payload, timeoutMs = 20_000) {
    if (this.dead) return Promise.reject(new Error(`pty driver is dead\n${this.stderr}`));
    const id = this.nextId++;
    const wait = Number(payload.timeoutMs ?? timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `pty ${payload.op} timed out after ${wait}ms\n${this.last?.screen ?? ""}\n${this.stderr}`
          )
        );
      }, wait + 2_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    }).then((msg) => {
      this.last = msg;
      return msg;
    });
  }

  spawnChild(options) {
    return this.request({ op: "spawn", timeoutMs: 8_000, ...options }, 8_000);
  }

  keys(names) {
    return this.request({ op: "keys", keys: names });
  }

  write(data) {
    return this.request({ op: "write", data });
  }

  paste(text, bracketed = true) {
    return this.request({ op: "paste", text, bracketed: Boolean(bracketed) });
  }

  resize(cols, rows) {
    return this.request({ op: "resize", cols, rows });
  }

  signal(name) {
    return this.request({ op: "signal", name });
  }

  snapshot() {
    return this.request({ op: "snapshot" });
  }

  async wait(needle, timeoutMs = 8_000) {
    if (typeof needle === "string") {
      return this.request({ op: "wait", contains: needle, timeoutMs }, timeoutMs);
    }
    const source = needle.ignoreCase ? `(?i)${needle.source}` : needle.source;
    return this.request({ op: "wait", regex: source, timeoutMs }, timeoutMs);
  }

  async waitExit(timeoutMs = 5_000) {
    const ended = await this.request({ op: "wait_exit", timeoutMs }, timeoutMs);
    if (!ended?.exited) {
      throw new Error(`menu did not exit\n${ended?.screen ?? this.last?.screen ?? ""}\n${this.stderr}`);
    }
    return ended;
  }

  termios() {
    return this.request({ op: "termios" });
  }

  async close() {
    this.closing = true;
    try {
      return await this.request({ op: "close", timeoutMs: 8_000 }, 8_000);
    } catch {
      try {
        return await this.request({ op: "kill", timeoutMs: 4_000 }, 4_000);
      } catch {
        return this.last;
      }
    }
  }

  async dispose() {
    this.closing = true;
    try {
      if (!this.dead) await this.close();
    } catch {
      /* always finish */
    }
    try {
      this.child.stdin.end();
    } catch {
      /* closed */
    }
    try {
      this.child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
}

async function shutdownSession(world) {
  const sessionId = world.sessionId;
  const data = world.data;
  if (!sessionId || !data) return;
  const locatorFile = path.join(data, "sessions", sessionId, "locator.json");
  let locator = null;
  try {
    locator = JSON.parse(fs.readFileSync(locatorFile, "utf8"));
  } catch {
    locator = null;
  }
  if (locator?.pid) killPidTree(locator.pid);
}

function killPidTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-n, sig);
    } catch {
      /* group missing */
    }
    try {
      process.kill(n, sig);
    } catch {
      /* gone */
    }
  }
}

export { shutdownSession };

export async function openOwnedPty({
  execPath = process.execPath,
  args,
  env,
  cwd,
  cols = 80,
  rows = 24
}) {
  if (!fs.existsSync(DRIVER_PATH)) {
    throw new Error(`missing PTY driver at ${DRIVER_PATH}`);
  }
  const child = spawn(pythonBin(), ["-u", DRIVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" }
  });
  const pty = new OwnedPty(child);
  try {
    await pty.spawnChild({ execPath, args, env, cwd, cols, rows });
  } catch (error) {
    await pty.dispose();
    throw error;
  }
  return pty;
}

export function requireBundledMenu(pluginDir = PLUGIN_ROOT) {
  const helper = path.join(pluginDir, "dist", "setup-control.mjs");
  if (!fs.existsSync(helper)) {
    throw new Error(`missing ${helper}; rebuild plugins/cross-model-advisor`);
  }
  const menu = path.join(pluginDir, "dist", "modules", "setup-menu.mjs");
  const ui = path.join(pluginDir, "dist", "modules", "terminal-ui.mjs");
  if (!fs.existsSync(menu) || !fs.existsSync(ui)) {
    throw new Error(
      `bundled menu modules missing under ${path.join(pluginDir, "dist", "modules")}; rebuild after setup-menu.mjs and terminal-ui.mjs land`
    );
  }
  return helper;
}

export function focusedLine(screen, pattern) {
  const rawLines = String(screen ?? "").split(/\r?\n/);
  for (const raw of rawLines) {
    const vis = stripAnsi(raw);
    const label = vis.replace(/^\s*>\s*/, "").trim();
    const hit = typeof pattern === "string" ? label.includes(pattern) : pattern.test(label);
    if (!hit) continue;
    if (/^\s*>\s/.test(vis) || raw.includes("\x1b[7m")) return vis;
  }
  return null;
}

export async function focusLabel(pty, pattern, { timeoutMs = 6_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  await pty.keys(Array.from({ length: 16 }, () => "UP"));
  let snap;
  do {
    snap = await pty.snapshot();
    const first = (snap.screen ?? "").split("\n").find((line) => /^(?:> |  )\S/.test(line));
    if (first?.startsWith("> ")) break;
    await delay(5);
  } while (Date.now() < deadline);
  while (Date.now() < deadline) {
    if (focusedLine(snap.screen, pattern)) return snap;
    const previous = (snap.highlighted ?? []).join("\n");
    await pty.keys(["DOWN"]);
    do {
      snap = await pty.snapshot();
      if ((snap.highlighted ?? []).join("\n") !== previous) break;
      await delay(5);
    } while (Date.now() < deadline);
  }
  throw new Error(`could not focus ${pattern}\n${snap?.screen ?? ""}`);
}

export async function waitScreen(pty, pattern, timeoutMs = 8_000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const snap = await pty.snapshot();
    last = snap.screen ?? "";
    const hit = typeof pattern === "string" ? last.includes(pattern) : pattern.test(last);
    if (hit) return snap;
    if (snap.exited) throw new Error(`process exited before ${pattern}\n${last}`);
    await delay(25);
  }
  throw new Error(`timeout waiting for ${pattern} on current screen\n${last}`);
}

export async function waitHome(pty, timeoutMs = 8_000) {
  return waitScreen(pty, HOME_RE, timeoutMs);
}

function isDiscardPrompt(screen) {
  const text = String(screen ?? "");
  return DISCARD_RE.test(text) && !HOME_RE.test(text);
}

async function leaveMenu(pty) {
  await pty.keys(["ESCAPE"]);
  await delay(80);
  let snap = await pty.snapshot();
  if (snap.exited) return snap;
  if (isDiscardPrompt(snap.screen)) {
    await focusLabel(pty, DISCARD_RE);
    await pty.keys(["ENTER"]);
    snap = await pty.snapshot();
    if (snap.exited) return snap;
  }
  if (QUIT_RE.test(snap.screen ?? "") || HOME_RE.test(snap.screen ?? "")) {
    await focusLabel(pty, QUIT_RE);
    await pty.keys(["ENTER"]);
    snap = await pty.snapshot();
    if (snap.exited) return snap;
    if (isDiscardPrompt(snap.screen)) {
      await focusLabel(pty, DISCARD_RE);
      await pty.keys(["ENTER"]);
    }
  }
  return pty.waitExit(4_000);
}

export async function openMenuPty({
  pluginDir = PLUGIN_ROOT,
  env,
  cwd,
  cols = 80,
  rows = 24,
  execPath = process.execPath
}) {
  const helper = requireBundledMenu(pluginDir);
  return openOwnedPty({
    execPath,
    args: [helper, "menu"],
    env,
    cwd: cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    cols,
    rows
  });
}

export function runProcess(command, args, { env, cwd, timeoutMs = 8_000, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      finish(
        reject,
        new Error(
          `${command} ${args.join(" ")} timed out\n${Buffer.concat(stdout)}\n${Buffer.concat(stderr)}`
        )
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(reject, error));
    child.on("close", (status, signal) => {
      finish(resolve, {
        status: status ?? (signal ? 1 : 0),
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    child.stdin.on("error", () => {});
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export function runSetupCli(args, env, { cwd, timeoutMs = 8_000, helperPath = SETUP_HELPER, stdin } = {}) {
  return runProcess(process.execPath, [helperPath, ...args], { env, cwd, timeoutMs, stdin });
}

export function runControlCli(args, env, { cwd, timeoutMs = 8_000, pluginDir = PLUGIN_ROOT, stdin } = {}) {
  const helper = path.join(pluginDir, "dist", "control.mjs");
  const body = stdin == null ? undefined : typeof stdin === "string" ? stdin : `${JSON.stringify(stdin)}\n`;
  return runProcess(process.execPath, [helper, ...args], {
    env,
    cwd: cwd ?? env.CLAUDE_PROJECT_DIR,
    timeoutMs,
    stdin: body
  });
}

function hookPayload({ sessionId, transcriptPath, cwd, ...rest }) {
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    permission_mode: "default",
    ...rest
  };
}

export async function bootBundledSession(world, env, { pluginDir = PLUGIN_ROOT } = {}) {
  const transcriptPath = path.join(world.root, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "");
  const start = await runControlCli(
    ["hook"],
    env,
    {
      pluginDir,
      stdin: hookPayload({
        sessionId: world.sessionId,
        transcriptPath,
        cwd: world.project,
        hook_event_name: "SessionStart",
        source: "startup"
      }),
      timeoutMs: 8_000
    }
  );
  assert.equal(start.status, 0, `SessionStart failed\n${start.stderr}\n${start.stdout}`);
  const on = await runControlCli(["on"], env, { pluginDir, timeoutMs: 12_000 });
  return { start, on, transcriptPath };
}


export async function loadSessionSettings(env) {
  const mod = await import(pathToFileURL(path.join(DIST_MODULES, "control.mjs")).href);
  return mod.getSessionSettings({ env });
}

export function assertTermiosRestored(termios, label = "termios") {
  assert.ok(termios && termios.available !== false, `${label} unavailable`);
  assert.equal(termios.icanon, true, `${label} ICANON\n${JSON.stringify(termios)}`);
  assert.equal(termios.echo, true, `${label} ECHO\n${JSON.stringify(termios)}`);
  assert.equal(termios.restored, true, `${label} not restored\n${JSON.stringify(termios)}`);
}

export async function openAndQuitMenu({ pluginDir = PLUGIN_ROOT, env, cwd, cols = 80, rows = 24 }) {
  const pty = await openMenuPty({ pluginDir, env, cwd, cols, rows });
  try {
    await waitHome(pty);
    const closed = await leaveMenu(pty);
    return {
      screen: closed?.screen ?? pty.last?.screen ?? "",
      termios: closed?.termios,
      transcript: closed?.transcript ?? ""
    };
  } finally {
    await pty.dispose();
  }
}

async function confirmIfAsked(pty) {
  const snap = await pty.snapshot();
  if (/\[Y\/n\]|Yes|Confirm|\bY\b.*\bN\b/i.test(snap.screen) && !HOME_RE.test(stripAnsi(snap.screen).split("\n")[0] ?? "")) {
    await pty.keys(["TEXT:y"]);
  }
}

async function dismissNotice(pty) {
  await pty.keys(["ENTER"]);
  await delay(50);
}

async function saveApply(pty) {
  await focusLabel(pty, SAVE_APPLY_RE);
  await pty.keys(["ENTER"]);
  const notice = await pty.wait(/Saved and applied|Saved; not applied|Not saved/, 12_000);
  await dismissNotice(pty);
  return notice;
}

async function saveDefaults(pty) {
  await focusLabel(pty, SAVE_DEFAULTS_RE);
  await pty.keys(["ENTER"]);
  const notice = await pty.wait(/Saved defaults|Not saved/, 12_000);
  await dismissNotice(pty);
  return notice;
}

async function editFirstAdvisor(pty) {
  await waitHome(pty);
  await focusLabel(pty, /architecture|correctness/);
  await pty.keys(["ENTER"]);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function chooseModel(pty, query, idPattern) {
  await focusLabel(pty, /Model/);
  await pty.keys(["ENTER"]);
  await waitScreen(pty, /Search:/, 8_000);
  if (query) {
    await pty.write(query);
    await waitScreen(pty, new RegExp(`Search:\\s*${escapeRegExp(query)}`), 8_000);
    await waitScreen(pty, /(^|\n)1–1 of 1(\n|$)/, 8_000);
  } else {
    await waitScreen(pty, /\d+–\d+ of \d+/, 8_000);
  }
  const snap = await waitScreen(pty, idPattern, 8_000);
  const screen = snap.screen ?? "";
  const onScreen = typeof idPattern === "string" ? screen.includes(idPattern) : idPattern.test(screen);
  if (!onScreen) {
    throw new Error(`model ${idPattern} not on current screen\n${screen}`);
  }
  await pty.keys(["ENTER"]);
  await waitScreen(pty, /Advisor /, 8_000);
}

async function chooseEffort(pty, label) {
  const editor = await pty.snapshot();
  if (/Not configurable/.test(editor.screen ?? "")) {
    throw new Error(`reasoning effort not configurable after model selection\n${editor.screen}`);
  }
  await focusLabel(pty, /Reasoning effort/);
  await pty.keys(["ENTER"]);
  await waitScreen(pty, label, 8_000);
  await focusLabel(pty, label);
  await pty.keys(["ENTER"]);
}

async function backToHome(pty) {
  for (let i = 0; i < 6; i += 1) {
    const snap = await pty.snapshot();
    if (HOME_RE.test(snap.screen)) return snap;
    await pty.keys(["ESCAPE"]);
    await delay(60);
  }
  return waitHome(pty);
}

async function scenarioLunaAndNoReview() {
  const world = await makeSmokeWorld("cma-luna-");
  const probe = await startHitServer();
  try {
    const config = configV2({
      providers: {
        "codex-login": { kind: "oauth", provider: "openai-codex" },
        loopback: {
          kind: "api",
          provider: "openai-compatible",
          apiKeyEnv: "CMA_SMOKE_API_KEY",
          baseUrl: `http://127.0.0.1:${probe.port}/v1`,
          models: {
            "smoke-model": {
              contextWindow: 16_000,
              maxTokens: 2_048,
              reasoning: false,
              input: ["text"]
            }
          }
        }
      }
    });
    writeJsonConfig(world.configFile, config);
    const env = smokeEnv(world);
    const { createCredentialStore } = await import(pathToFileURL(path.join(DIST_MODULES, "auth.mjs")).href);
    await createCredentialStore({ env, slot: "codex-login", provider: "openai-codex" }).modify(
      "openai-codex",
      async () => ({
        type: "oauth",
        access: "offline-smoke-access",
        refresh: "offline-smoke-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "offline-smoke-account"
      })
    );
    await bootBundledSession(world, env);
    const beforeHits = probe.hits();
    const pty = await openMenuPty({ env, cwd: world.project });
    try {
      await waitHome(pty);
      await focusLabel(pty, /architecture/);
      await pty.keys(["ENTER"]);
      await chooseModel(pty, "luna", /gpt-5\.6-luna/);
      await chooseEffort(pty, /\bHigh\b/);
      await backToHome(pty);
      const notice = await saveApply(pty);
      assert.match(notice.screen, /Saved and applied/);
      const ended = await leaveMenu(pty);
      assertTermiosRestored(ended.termios);
    } finally {
      await pty.dispose();
    }
    const written = readJsonConfig(world.configFile);
    const architecture = written.advisors.find((row) => row.name === "architecture");
    assert.equal(architecture.model, "gpt-5.6-luna");
    assert.equal(architecture.reasoningEffort, "high");
    assert.deepEqual(written.exclude, ["tmp/**"]);
    assert.equal(written.limits.maxOutputTokens, 1500);
    assert.equal(written.providers.loopback.apiKeyEnv, "CMA_SMOKE_API_KEY");
    const settings = await loadSessionSettings(env);
    assert.equal(settings.ok, true, JSON.stringify(settings));
    const live = settings.advisors.find((row) => row.name === "architecture");
    assert.equal(live?.model, "gpt-5.6-luna");
    assert.equal(live?.reasoningEffort, "high");
    assert.equal(live?.available, true);
    assert.equal(settings.enabled, true);
    await delay(400);
    assert.equal(probe.hits(), beforeHits, "Save & Apply started a provider review");
  } finally {
    await probe.close();
    await world.close();
  }
}

function noticeText(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function scenarioSavedNotApplied() {
  const world = await makeSmokeWorld("cma-notapplied-");
  try {
    writeJsonConfig(world.configFile, configV2());
    const env = smokeEnv(world);
    await bootBundledSession(world, env);
    const pty = await openMenuPty({ env, cwd: world.project });
    try {
      await waitHome(pty);
      await focusLabel(pty, /architecture/);
      await pty.keys(["ENTER"]);
      await chooseModel(pty, "luna", /gpt-5\.6-luna/);
      await backToHome(pty);
      await focusLabel(pty, SAVE_APPLY_RE);
      await shutdownSession(world);
      await pty.keys(["ENTER"]);
      const notice = await pty.wait(/Saved; not applied/, 12_000);
      assert.doesNotMatch(notice.screen, /Saved and applied/);
      await dismissNotice(pty);
      const ended = await leaveMenu(pty);
      assertTermiosRestored(ended.termios);
    } finally {
      await pty.dispose();
    }
    const written = readJsonConfig(world.configFile);
    assert.equal(written.advisors.find((row) => row.name === "architecture").model, "gpt-5.6-luna");
  } finally {
    await world.close();
  }
}

async function scenarioCancel() {
  const world = await makeSmokeWorld("cma-cancel-");
  try {
    const revision = writeJsonConfig(world.configFile, configV2());
    const env = smokeEnv(world);
    const pty = await openMenuPty({ env, cwd: world.project });
    try {
      await waitHome(pty);
      await focusLabel(pty, /architecture/);
      await pty.keys(["ENTER"]);
      await chooseModel(pty, "luna", /gpt-5\.6-luna/);
      await pty.keys(["ESCAPE"]);
      await delay(80);
      await pty.keys(["ESCAPE"]);
      await pty.wait(DISCARD_RE, 4_000);
      await focusLabel(pty, DISCARD_RE);
      await pty.keys(["ENTER"]);
      const ended = await leaveMenu(pty);
      assertTermiosRestored(ended.termios);
    } finally {
      await pty.dispose();
    }
    assert.equal(fileRevision(world.configFile), revision);
    assert.equal(readJsonConfig(world.configFile).advisors[0].model, "gpt-5");
  } finally {
    await world.close();
  }
}

async function scenarioNoTty() {
  const world = await makeSmokeWorld("cma-notty-");
  try {
    const revision = writeJsonConfig(world.configFile, configV2());
    const env = smokeEnv(world);
    const result = await runSetupCli(["menu"], env, { cwd: world.project, timeoutMs: 6_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Open this menu in your own terminal/);
    assert.match(result.stderr, /CLAUDE_CONFIG_DIR=/);
    assert.doesNotMatch(result.stderr, /menu-command/);
    assert.equal(fileRevision(world.configFile), revision);
  } finally {
    await world.close();
  }
}

async function scenarioToggleProvidersRemove() {
  const world = await makeSmokeWorld("cma-add-");
  try {
    writeJsonConfig(
      world.configFile,
      configV2({
        advisors: [
          {
            name: "architecture",
            provider: "codex-login",
            model: "gpt-5",
            instructions: "Look for avoidable complexity.",
            enabled: true,
            reasoningEffort: "default"
          }
        ]
      })
    );
    const env = smokeEnv(world);
    const pty = await openMenuPty({ env, cwd: world.project });
    try {
      await waitHome(pty);
      await focusLabel(pty, /architecture/);
      await pty.keys(["SPACE"]);
      await focusLabel(pty, PROVIDERS_RE);
      await pty.keys(["ENTER"]);
      await focusLabel(pty, /Add providers/);
      await pty.keys(["ENTER"]);
      await pty.wait(/Upstream providers/, 8_000);
      await pty.write("google");
      await delay(80);
      await focusLabel(pty, /google/i);
      await pty.keys(["SPACE", "ENTER"]);
      await pty.wait(/Slot id|apiKeyEnv|google/i, 8_000);
      await pty.keys(["ENTER"]);
      await delay(80);
      await pty.keys(["ENTER"]);
      await backToHome(pty);
      await saveDefaults(pty);
      const ended = await leaveMenu(pty);
      assertTermiosRestored(ended.termios);
    } finally {
      await pty.dispose();
    }
    const written = readJsonConfig(world.configFile);
    assert.equal(written.version, 2);
    assert.equal(written.advisors[0].enabled, false);
    assert.ok(written.providers["codex-login"]);
    const googleSlot = Object.values(written.providers).find((slot) => slot.provider === "google");
    assert.ok(googleSlot, `missing google slot: ${JSON.stringify(Object.keys(written.providers))}`);
    assert.equal(googleSlot.kind, "api");
    assert.equal(googleSlot.apiKeyEnv, "GEMINI_API_KEY");
    assert.deepEqual(written.exclude, ["tmp/**"]);
    assert.equal(written.limits.maxReviewsPerAdvisorPerSession, 40);
  } finally {
    await world.close();
  }
}

async function scenarioLastAdvisorAndMultiline() {
  const world = await makeSmokeWorld("cma-last-");
  const literal = "line1\nline2 café 你好\nkeep <raw> & \\paths";
  try {
    writeJsonConfig(
      world.configFile,
      configV2({
        advisors: [
          {
            name: "architecture",
            provider: "codex-login",
            model: "gpt-5",
            instructions: "old instructions",
            enabled: true,
            reasoningEffort: "default"
          }
        ]
      })
    );
    const env = smokeEnv(world);
    const pty = await openMenuPty({ env, cwd: world.project });
    try {
      await waitHome(pty);
      await focusLabel(pty, /architecture/);
      await pty.keys(["ENTER"]);
      await focusLabel(pty, /Instructions/);
      await pty.keys(["ENTER"]);
      await delay(50);
      await pty.keys(["CTRL_U"]);
      await pty.paste(literal, true);
      await pty.keys(["CTRL_S"]);
      await backToHome(pty);
      await saveDefaults(pty);
      assert.equal(readJsonConfig(world.configFile).advisors[0].instructions, literal);
      await focusLabel(pty, /architecture/);
      await pty.keys(["ENTER"]);
      await focusLabel(pty, /Remove/);
      await pty.keys(["ENTER"]);
      await pty.wait(/Remove the last advisor/, 4_000);
      await pty.keys(["TEXT:y"]);
      await backToHome(pty);
      await saveDefaults(pty);
      const ended = await leaveMenu(pty);
      assertTermiosRestored(ended.termios);
    } finally {
      await pty.dispose();
    }
    const written = readJsonConfig(world.configFile);
    assert.deepEqual(written.advisors, []);
    assert.ok(written.providers["codex-login"]);
    assert.deepEqual(written.exclude, ["tmp/**"]);
  } finally {
    await world.close();
  }
}

async function scenarioSearchPagingAndEffort() {
  const world = await makeSmokeWorld("cma-page-");
  try {
    const noOffMap = thinkingMap({ off: null });
    const config = configV2({
      providers: {
        loopback: {
          kind: "api",
          provider: "openai-compatible",
          apiKeyEnv: "CMA_SMOKE_API_KEY",
          baseUrl: "http://127.0.0.1:9/v1",
          models: {
            "model-off": {
              contextWindow: 16_000,
              maxTokens: 2_048,
              reasoning: true,
              input: ["text"],
              thinkingFormat: "openai",
              thinkingLevelMap: thinkingMap()
            },
            "model-no-off": {
              contextWindow: 16_000,
              maxTokens: 2_048,
              reasoning: true,
              input: ["text"],
              thinkingFormat: "openai",
              thinkingLevelMap: noOffMap
            }
          }
        },
        "codex-login": { kind: "oauth", provider: "openai-codex" }
      },
      advisors: [
        {
          name: "architecture",
          provider: "codex-login",
          model: "gpt-5",
          instructions: "Look for avoidable complexity.",
          enabled: true,
          reasoningEffort: "default"
        },
        {
          name: "correctness",
          provider: "loopback",
          model: "model-off",
          instructions: "Look for correctness failures.",
          enabled: true,
          reasoningEffort: "off"
        }
      ]
    });
    writeJsonConfig(world.configFile, config);
    const env = smokeEnv(world);
    const pty = await openMenuPty({ env, cwd: world.project, rows: 16 });
    try {
      await waitHome(pty);
      await focusLabel(pty, /architecture/);
      await pty.keys(["ENTER"]);
      await focusLabel(pty, /Model/);
      await pty.keys(["ENTER"]);
      await waitScreen(pty, /Search:/, 8_000);
      await waitScreen(pty, /\d+–\d+ of \d+/, 8_000);
      await pty.keys(["PGDN"]);
      await delay(80);
      await waitScreen(pty, /\d+–\d+ of \d+/, 8_000);
      await pty.keys(["PGUP"]);
      await pty.write("luna");
      await waitScreen(pty, /Search:\s*luna/, 8_000);
      await waitScreen(pty, /(^|\n)1–1 of 1(\n|$)/, 8_000);
      const filtered = await waitScreen(pty, /gpt-5\.6-luna/, 8_000);
      if (!/gpt-5\.6-luna/.test(filtered.screen ?? "")) {
        throw new Error(`luna missing after filter\n${filtered.screen}`);
      }
      await pty.keys(["ENTER"]);
      await waitScreen(pty, /Advisor /, 8_000);
      await backToHome(pty);
      await focusLabel(pty, /correctness/);
      await pty.keys(["ENTER"]);
      await focusLabel(pty, /Model/);
      await pty.keys(["ENTER"]);
      await pty.write("model-no-off");
      await pty.wait(/model-no-off/, 8_000);
      await focusLabel(pty, /model-no-off/);
      await pty.keys(["ENTER"]);
      await backToHome(pty);
      const refused = await saveDefaults(pty);
      assert.match(refused.screen, /Not saved/);
      assert.match(refused.screen, /reselect reasoning effort/i);
      await focusLabel(pty, /correctness/);
      await pty.keys(["ENTER"]);
      await chooseEffort(pty, /Default/);
      await backToHome(pty);
      await saveDefaults(pty);
      const ended = await leaveMenu(pty);
      assertTermiosRestored(ended.termios);
    } finally {
      await pty.dispose();
    }
    const written = readJsonConfig(world.configFile);
    assert.equal(written.advisors.find((row) => row.name === "architecture").model, "gpt-5.6-luna");
    const correctness = written.advisors.find((row) => row.name === "correctness");
    assert.equal(correctness.model, "model-no-off");
    assert.equal(correctness.reasoningEffort, "default");
  } finally {
    await world.close();
  }
}

async function scenarioRevisionConflict() {
  const world = await makeSmokeWorld("cma-rev-");
  try {
    writeJsonConfig(world.configFile, configV2());
    const env = smokeEnv(world);
    const pty = await openMenuPty({ env, cwd: world.project });
    try {
      await waitHome(pty);
      await focusLabel(pty, /architecture/);
      await pty.keys(["ENTER"]);
      await chooseModel(pty, "luna", /gpt-5\.6-luna/);
      await backToHome(pty);
      const outsider = configV2({
        advisors: [
          {
            name: "architecture",
            provider: "codex-login",
            model: "gpt-5",
            instructions: "intervening editor",
            enabled: true,
            reasoningEffort: "default"
          },
          {
            name: "correctness",
            provider: "loopback",
            model: "smoke-model",
            instructions: "Look for observable correctness failures.",
            enabled: true,
            reasoningEffort: "default"
          }
        ]
      });
      writeJsonConfig(world.configFile, outsider);
      const notice = await saveDefaults(pty);
      assert.match(notice.screen, /Not saved/);
      await pty.wait(/Reload from disk|Discard|Return/, 4_000);
      await focusLabel(pty, /\bReturn\b/);
      await pty.keys(["ENTER"]);
      const ended = await leaveMenu(pty);
      assertTermiosRestored(ended.termios);
    } finally {
      await pty.dispose();
    }
    const written = readJsonConfig(world.configFile);
    assert.equal(written.advisors[0].instructions, "intervening editor");
    assert.equal(written.advisors[0].model, "gpt-5");
  } finally {
    await world.close();
  }
}

async function scenarioQuoting() {
  const world = await makeSmokeWorld("cma-quote-");
  try {
    const configDir = path.join(world.root, "Ada's config dir");
    const pluginData = path.join(world.root, "plugin's data");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(pluginData, { recursive: true });
    const secret = "sk-live-secret-must-not-appear-in-menu-command";
    fs.writeFileSync(
      path.join(configDir, "cross-model-advisor.json"),
      `${JSON.stringify(
        configV2({
          advisors: [
            {
              name: "architecture",
              provider: "codex-login",
              model: "gpt-5",
              instructions: secret,
              enabled: true,
              reasoningEffort: "default"
            }
          ]
        }),
        null,
        2
      )}\n`
    );
    const credDir = path.join(configDir, "cross-model-advisor", "credentials");
    fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(credDir, "codex-login.json"), `${JSON.stringify({ token: secret })}\n`, {
      mode: 0o600
    });
    const locatorDir = path.join(pluginData, "sessions", "sess-quote");
    fs.mkdirSync(locatorDir, { recursive: true });
    fs.writeFileSync(
      path.join(locatorDir, "locator.json"),
      `${JSON.stringify({ controlCapability: "cap-secret-value", socketPath: "/tmp/cma.sock" })}\n`
    );
    const env = smokeEnv(world, {
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_PLUGIN_DATA: pluginData,
      CLAUDE_CODE_SESSION_ID: "sess-quote",
      CLAUDE_SESSION_ID: "sess-quote",
      CLAUDE_PROJECT_DIR: world.project
    });
    const result = await runSetupCli(["menu-command"], env, { cwd: world.project });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
    assert.match(line, / menu$/);
    assert.doesNotMatch(line, /menu-command/);
    assert.ok(line.includes(`CLAUDE_CONFIG_DIR=${posixQuote(path.resolve(configDir))}`));
    assert.ok(line.includes(`CLAUDE_PLUGIN_DATA=${posixQuote(path.resolve(pluginData))}`));
    assert.ok(line.includes(`CLAUDE_CODE_SESSION_ID=${posixQuote("sess-quote")}`));
    assert.ok(line.includes(`CLAUDE_SESSION_ID=${posixQuote("")}`));
    assert.ok(line.includes(`CLAUDE_PROJECT_DIR=${posixQuote("")}`));
    const helper = posixQuote(fs.existsSync(SETUP_HELPER) ? fs.realpathSync(SETUP_HELPER) : path.resolve(SETUP_HELPER));
    assert.ok(line.includes(`node ${helper} menu`));
    assert.doesNotMatch(line, /sk-live-secret|cap-secret-value|controlCapability|gpt-5|architecture/);
    assert.equal(result.stderr.includes(secret), false);
    const noSession = await runSetupCli(
      ["menu-command"],
      smokeEnv(world, {
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_PLUGIN_DATA: "",
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_SESSION_ID: "stale-session",
        CLAUDE_PROJECT_DIR: world.project
      }),
      { cwd: world.project }
    );
    const defaults = noSession.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
    assert.ok(defaults.includes(`CLAUDE_CODE_SESSION_ID=${posixQuote("")}`));
    assert.ok(defaults.includes(`CLAUDE_PLUGIN_DATA=${posixQuote("")}`));
    assert.ok(defaults.includes(`CLAUDE_SESSION_ID=${posixQuote("")}`));
    assert.ok(defaults.includes(`CLAUDE_PROJECT_DIR=${posixQuote("")}`));
    assert.doesNotMatch(defaults, /stale-session/);
  } finally {
    await world.close();
  }
}

async function scenarioUnicodeResizeSignals() {
  const world = await makeSmokeWorld("cma-tty-");
  try {
    writeJsonConfig(world.configFile, configV2());
    const env = smokeEnv(world);
    const revision = fileRevision(world.configFile);

    const unicode = await openMenuPty({ env, cwd: world.project, cols: 80, rows: 24 });
    try {
      await waitHome(unicode);
      await unicode.resize(40, 12);
      await delay(80);
      await unicode.wait(HOME_RE, 4_000);
      await unicode.resize(100, 30);
      await delay(80);
      await focusLabel(unicode, /architecture/);
      await unicode.keys(["ENTER"]);
      await focusLabel(unicode, /Instructions/);
      await unicode.keys(["ENTER"]);
      const paste = "café 你好 🎯 paste";
      await unicode.paste(paste, true);
      await unicode.wait(/café|你好/, 4_000);
      await unicode.keys(["ESCAPE"]);
      const ended = await leaveMenu(unicode);
      assertTermiosRestored(ended.termios);
    } finally {
      await unicode.dispose();
    }
    assert.equal(fileRevision(world.configFile), revision);

    const sigint = await openMenuPty({ env, cwd: world.project });
    try {
      await waitHome(sigint);
      await sigint.keys(["CTRL_C"]);
      const ended = await sigint.waitExit(5_000);
      assertTermiosRestored(ended.termios);
    } finally {
      await sigint.dispose();
    }
    assert.equal(fileRevision(world.configFile), revision);

    const sigterm = await openMenuPty({ env, cwd: world.project });
    try {
      await waitHome(sigterm);
      await sigterm.signal("SIGTERM");
      const ended = await sigterm.waitExit(5_000);
      assertTermiosRestored(ended.termios);
    } finally {
      await sigterm.dispose();
    }
    assert.equal(fileRevision(world.configFile), revision);

    const eof = await openMenuPty({ env, cwd: world.project });
    try {
      await waitHome(eof);
      await eof.keys(["CTRL_D"]);
      const ended = await eof.waitExit(5_000);
      assertTermiosRestored(ended.termios);
    } finally {
      await eof.dispose();
    }
    assert.equal(fileRevision(world.configFile), revision);
  } finally {
    await world.close();
  }
}

async function scenarioOauthHandoff() {
  const world = await makeSmokeWorld("cma-auth-");
  try {
    writeJsonConfig(world.configFile, configV2());
    const marker = path.join(world.root, "auth-marker.txt");
    const stub = writeAuthStub(world.root, marker);
    const harness = writeMenuHarness(world.root, {
      menuModule: path.join(DIST_MODULES, "setup-menu.mjs"),
      authHelperPath: stub
    });
    const env = smokeEnv(world);
    const pty = await openOwnedPty({
      execPath: process.execPath,
      args: [harness],
      env,
      cwd: world.project
    });
    try {
      await waitHome(pty);
      await focusLabel(pty, PROVIDERS_RE);
      await pty.keys(["ENTER"]);
      await focusLabel(pty, /codex-login/);
      await pty.keys(["ENTER"]);
      await focusLabel(pty, /^Login$/);
      await pty.keys(["ENTER"]);
      await pty.wait(/uses the saved slot|Save this provider slot|Login/, 8_000);
      await pty.keys(["ENTER"]);
      await pty.wait(/CMA_AUTH_STUB/, 8_000);
      assert.equal(fs.existsSync(marker), true, "scripted auth helper did not run");
      await pty.keys(["ENTER"]);
      await pty.wait(/Provider codex-login|Login|Logout/, 8_000);
      await backToHome(pty);
      const ended = await leaveMenu(pty);
      assertTermiosRestored(ended.termios);
    } finally {
      await pty.dispose();
    }
    const markerBody = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
    assert.match(markerBody, /login/);
    assert.doesNotMatch(fs.readFileSync(world.configFile, "utf8"), /CMA_AUTH_STUB|access_token/);
  } finally {
    await world.close();
  }
}

const SCENARIOS = [
  ["luna-save-apply-no-review", scenarioLunaAndNoReview],
  ["saved-not-applied", scenarioSavedNotApplied],
  ["cancel-discard", scenarioCancel],
  ["no-tty", scenarioNoTty],
  ["toggle-providers-remove", scenarioToggleProvidersRemove],
  ["last-advisor-multiline", scenarioLastAdvisorAndMultiline],
  ["search-paging-unsupported-effort", scenarioSearchPagingAndEffort],
  ["revision-conflict", scenarioRevisionConflict],
  ["menu-command-quoting", scenarioQuoting],
  ["unicode-paste-resize-signals", scenarioUnicodeResizeSignals],
  ["oauth-handoff", scenarioOauthHandoff]
];

export async function runTerminalSmoke() {
  requireBundledMenu(PLUGIN_ROOT);
  for (const [name, fn] of SCENARIOS) {
    process.stdout.write(`${name}...\n`);
    await fn();
    process.stdout.write(`ok ${name}\n`);
  }
}

const launchedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (launchedDirectly) {
  runTerminalSmoke().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : error}\n`);
    process.exitCode = 1;
  });
}
