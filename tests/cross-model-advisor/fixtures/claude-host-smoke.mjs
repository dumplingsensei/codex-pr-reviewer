#!/usr/bin/env node
/**
 * Opt-in authenticated Claude host acceptance for the review gate.
 *
 * Drives a real Claude Code session (stream-json) in a throwaway git project
 * with the plugin loaded via --plugin-dir and a loopback OpenAI-compatible
 * advisor, then checks what only the real host can show:
 *
 *   block-then-continue  a turn that edits a file is reviewed at Stop, the
 *                        concern comes back as a block decision, and Claude
 *                        keeps working instead of stopping
 *   no-change            a turn that edits nothing makes no advisor request
 *   off                  after /cross-model-advisor:off, edits are not reviewed
 *
 * Every phase runs with a decoy CLAUDE_PLUGIN_DATA in Claude's environment, the
 * way openai/codex-plugin-cc exports its own into every Bash command, and
 * fails if any state lands there. Throws a prerequisite error instead of a
 * fake pass. Captures stay in a temporary directory, removed on exit unless
 * --keep-captures. Never copies or prints credentials; never uses the
 * production repository as the project.
 *
 * Usage:
 *   CROSS_MODEL_ADVISOR_HOST_SMOKE=1 node tests/cross-model-advisor/fixtures/claude-host-smoke.mjs --run
 *
 * Optional:
 *   --phase <all|block-then-continue|no-change|off>
 *   --claude <path>          default: claude on PATH
 *   --plugin-dir <path>      default: <repo>/plugins/cross-model-advisor
 *   --timeout-ms <n>         per host process, default 240000
 *   --keep-captures          leave the temp tree (still not the production repo)
 *
 * Exit 0 on success, 1 on assertion failure, 2 on missing prerequisite.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const FINDING_NOTE = "first() returns undefined for an empty array without saying so; guard or document it.";
const MIN_HOST = [2, 1, 252];
const DEFAULT_TIMEOUT_MS = 240_000;
const API_KEY_ENV = "CMA_SMOKE_ADVISOR_KEY";
const API_KEY_VALUE = "sk-cma-smoke-loopback-not-a-secret";
const MODEL_ID = "cma-smoke";
const PHASES = ["block-then-continue", "no-change", "off"];
const ALPHA = "export function last(items) {\n  return items[items.length - 1];\n}\n";
const EDIT_PROMPT =
  "Add an exported function first(items) to src/alpha.js that returns items[0]. Edit the file directly with the Edit or Write tool. Do not run commands or tests. Then reply in one sentence.";

class PrerequisiteError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrerequisiteError";
    this.exitCode = 2;
  }
}

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
    this.exitCode = 1;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.run) {
  printHelp();
  process.exit(args.help ? 0 : 2);
}
if (process.env.CROSS_MODEL_ADVISOR_HOST_SMOKE !== "1") {
  printHelp();
  process.stderr.write("prerequisite: set CROSS_MODEL_ADVISOR_HOST_SMOKE=1 and pass --run\n");
  process.exit(2);
}
await main(args).then(
  () => {
    process.exitCode = 0;
  },
  (error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = error?.exitCode === 2 || error instanceof PrerequisiteError ? 2 : 1;
  }
);

function parseArgs(argv) {
  const out = {
    help: false,
    run: false,
    keepCaptures: false,
    phase: "all",
    claude: process.env.CLAUDE_HOST_BIN || "claude",
    pluginDir: path.join(repoRoot, "plugins", "cross-model-advisor"),
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new PrerequisiteError(`${token} requires a value`);
      return argv[++i];
    };
    if (token === "--help" || token === "-h") out.help = true;
    else if (token === "--run") out.run = true;
    else if (token === "--keep-captures") out.keepCaptures = true;
    else if (token === "--phase") out.phase = value();
    else if (token === "--claude") out.claude = value();
    else if (token === "--plugin-dir") out.pluginDir = path.resolve(value());
    else if (token === "--timeout-ms") {
      out.timeoutMs = Number(value());
      if (!Number.isInteger(out.timeoutMs) || out.timeoutMs <= 0) {
        throw new PrerequisiteError("--timeout-ms must be a positive integer");
      }
    } else throw new PrerequisiteError(`unknown argument: ${token}`);
  }
  if (out.phase !== "all" && !PHASES.includes(out.phase)) throw new PrerequisiteError(`unknown --phase ${out.phase}`);
  return out;
}

function printHelp() {
  process.stdout.write(`Opt-in Claude host smoke for the cross-model review gate

CROSS_MODEL_ADVISOR_HOST_SMOKE=1 node tests/cross-model-advisor/fixtures/claude-host-smoke.mjs --run

Requires an authenticated Claude Code >= ${MIN_HOST.join(".")} host and git. Creates a
throwaway git project, a loopback OpenAI-compatible advisor, and loads the
plugin via --plugin-dir. Does not read production repository content.

Phases: ${PHASES.join(", ")}

Exit 2 unless CROSS_MODEL_ADVISOR_HOST_SMOKE=1 and --run are both present.
`);
}

async function main(options) {
  if (!fs.existsSync(path.join(options.pluginDir, "dist", "gate.mjs"))) {
    throw new PrerequisiteError(`plugin bundle missing: build it first (${options.pluginDir}/dist/gate.mjs)`);
  }
  const claudePath = resolveClaude(options.claude);
  assertHostVersion(claudePath);
  const hostEnv = { ...process.env };
  const auth = spawnSync(claudePath, ["auth", "status"], { encoding: "utf8", env: hostEnv });
  if (auth.status !== 0) {
    throw new PrerequisiteError("claude auth status failed; the host must already be authenticated");
  }

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cma-host-smoke-")));
  const loopback = await startLoopback();
  const outcomes = [];
  try {
    const ctx = {
      claudePath,
      hostEnv,
      loopback,
      timeoutMs: options.timeoutMs,
      capturesDir: path.join(root, "captures"),
      root
    };
    fs.mkdirSync(ctx.capturesDir);
    for (const phase of options.phase === "all" ? PHASES : [options.phase]) {
      process.stdout.write(`phase ${phase}\n`);
      try {
        await runPhase(phase, ctx, options.pluginDir);
        outcomes.push({ phase, ok: true });
        process.stdout.write(`  ok   ${phase}\n`);
      } catch (error) {
        const kind = error instanceof PrerequisiteError ? "need" : "fail";
        outcomes.push({ phase, ok: false, error });
        process.stdout.write(`  ${kind} ${phase}: ${error.message}\n`);
      }
    }
  } finally {
    await loopback.close();
    if (!options.keepCaptures) fs.rmSync(root, { recursive: true, force: true });
    else process.stdout.write(`captures kept at ${root}\n`);
  }
  const failed = outcomes.filter((row) => !row.ok);
  if (failed.length) {
    throw failed.every((row) => row.error instanceof PrerequisiteError)
      ? new PrerequisiteError(`${failed.length} phase(s) lacked prerequisites`)
      : new AssertionError(`${failed.length} phase(s) failed`);
  }
}

/**
 * One fresh project, plugin copy, and Claude session per phase.
 */
async function runPhase(phase, ctx, sourcePlugin) {
  const dir = path.join(ctx.root, phase);
  const projectDir = path.join(dir, "project");
  const configDir = path.join(dir, "plugin-config");
  const pluginData = path.join(dir, "plugin-data");
  const decoyData = path.join(dir, "other-plugin-data");
  const pluginDir = path.join(dir, "plugin");
  for (const item of [projectDir, configDir, pluginData, decoyData]) fs.mkdirSync(item, { recursive: true });
  fs.mkdirSync(path.join(projectDir, "src"));
  fs.writeFileSync(path.join(projectDir, "src", "alpha.js"), ALPHA);
  const git = (...gitArgs) =>
    execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", ...gitArgs], {
      cwd: projectDir,
      stdio: "ignore"
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeAdvisorConfig(configDir, ctx.loopback.baseUrl);
  clonePlugin(sourcePlugin, pluginDir, { configDir, pluginData });
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, `${JSON.stringify({ hasTrustDialogAccepted: true })}\n`);
  const mcpFile = path.join(dir, "mcp.json");
  fs.writeFileSync(mcpFile, `${JSON.stringify({ mcpServers: {} })}\n`);
  // Another plugin exporting its CLAUDE_PLUGIN_DATA into every Bash command.
  const env = { ...ctx.hostEnv, CLAUDE_PLUGIN_DATA: decoyData };
  const run = { ...ctx, projectDir, pluginDir, settingsFile, mcpFile, env, name: phase };
  ctx.loopback.reset();

  try {
    if (phase === "block-then-continue") await phaseBlockThenContinue(run, pluginData);
    else if (phase === "no-change") await phaseNoChange(run, pluginData);
    else if (phase === "off") await phaseOff(run);
    if (fs.existsSync(path.join(decoyData, "sessions"))) {
      throw new AssertionError("session state landed in another plugin's exported CLAUDE_PLUGIN_DATA");
    }
  } finally {
    spawnSync(ctx.claudePath, ["project", "purge", projectDir, "--yes"], { env: ctx.hostEnv, stdio: "ignore" });
  }
}

async function phaseBlockThenContinue(ctx, pluginData) {
  const host = await runHost(ctx, ["/cross-model-advisor:on", EDIT_PROMPT]);
  const enabled = readState(pluginData, host.sessionId);
  if (!enabled?.enabled) throw new AssertionError(`on did not enable the gate: ${JSON.stringify(enabled)}`);
  const stops = hookResponses(host, "Stop");
  const blockIndex = stops.findIndex((event) => parseHookOutput(event)?.decision === "block");
  if (blockIndex === -1) {
    throw new AssertionError(`no Stop hook blocked; outputs: ${stops.map((event) => hookText(event)).join(" | ")}`);
  }
  const block = parseHookOutput(stops[blockIndex]);
  if (!block.reason.includes(FINDING_NOTE)) throw new AssertionError(`block reason lacks the finding: ${block.reason}`);
  if (!/not the user/.test(block.reason)) throw new AssertionError("block reason does not mark the finding as unverified");
  const blockAt = host.events.indexOf(stops[blockIndex]);
  const continued = host.events.slice(blockAt + 1).some((event) => event.type === "assistant" && !event.parent_tool_use_id);
  if (!continued) throw new AssertionError("Claude did not continue after the gate blocked");
  const reviews = ctx.loopback.reviews();
  if (reviews.length < 1 || reviews.length > 2) throw new AssertionError(`expected 1-2 reviews, saw ${reviews.length}`);
  const first = reviews[0];
  if (!first.includes("Add an exported function first(items)")) throw new AssertionError("the advisor did not receive the request");
  if (!/\[eventId: diff:src\/alpha\.js\]/.test(first)) throw new AssertionError("the advisor did not receive the turn's diff");
  const state = readState(pluginData, host.sessionId);
  if (!state?.last?.findings?.some((item) => item.note === FINDING_NOTE)) {
    throw new AssertionError(`status lost the finding: ${JSON.stringify(state?.last)}`);
  }
  const final = host.events.filter((event) => event.type === "result").at(-1);
  if (final?.is_error) throw new AssertionError(`the turn ended in error: ${final.result}`);
}

async function phaseNoChange(ctx, pluginData) {
  const host = await runHost(ctx, [
    "/cross-model-advisor:on",
    "In one sentence, what does src/alpha.js export? Read it if you need to, but do not edit anything."
  ]);
  if (ctx.loopback.requests.length !== 0) {
    throw new AssertionError(`a turn without edits made ${ctx.loopback.requests.length} advisor request(s)`);
  }
  const state = readState(pluginData, host.sessionId);
  if (state?.lastSkip?.reason !== "no file changes this turn") {
    throw new AssertionError(`expected a no-change skip, got ${JSON.stringify(state?.lastSkip)}`);
  }
}

async function phaseOff(ctx) {
  await runHost(ctx, ["/cross-model-advisor:on", "/cross-model-advisor:off", EDIT_PROMPT]);
  if (!fs.readFileSync(path.join(ctx.projectDir, "src", "alpha.js"), "utf8").includes("first")) {
    throw new PrerequisiteError("Claude did not make the edit, so off was not exercised");
  }
  if (ctx.loopback.requests.length !== 0) {
    throw new AssertionError(`the gate reviewed ${ctx.loopback.requests.length} time(s) after off`);
  }
}

function resolveClaude(bin) {
  if (bin.includes(path.sep)) {
    if (!fs.existsSync(bin)) throw new PrerequisiteError(`claude binary missing: ${bin}`);
    return bin;
  }
  const found = spawnSync("which", [bin], { encoding: "utf8" });
  if (found.status !== 0 || !found.stdout.trim()) throw new PrerequisiteError(`claude not on PATH: ${bin}`);
  return found.stdout.trim();
}

function assertHostVersion(claudePath) {
  const result = spawnSync(claudePath, ["--version"], { encoding: "utf8" });
  const match = `${result.stdout}${result.stderr}`.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new PrerequisiteError("cannot parse claude --version");
  const version = match.slice(1).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (version[i] > MIN_HOST[i]) return;
    if (version[i] < MIN_HOST[i]) {
      throw new PrerequisiteError(`Claude Code ${version.join(".")} is older than ${MIN_HOST.join(".")}`);
    }
  }
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Copy the plugin and point it at the harness config. Hooks get the harness
 * plugin data explicitly (the host would supply its own); skills get it only
 * through their --plugin-data placeholder, exactly as installed skills do.
 */
function clonePlugin(source, dest, { configDir, pluginData }) {
  fs.cpSync(source, dest, { recursive: true });
  const hookPrefix = `CLAUDE_CONFIG_DIR=${shQuote(configDir)} CLAUDE_PLUGIN_DATA=${shQuote(pluginData)} ${API_KEY_ENV}=${shQuote(API_KEY_VALUE)}`;
  const skillPrefix = `CLAUDE_CONFIG_DIR=${shQuote(configDir)} ${API_KEY_ENV}=${shQuote(API_KEY_VALUE)}`;
  const node = 'node "${CLAUDE_PLUGIN_ROOT}/dist/';
  const hooksPath = path.join(dest, "hooks", "hooks.json");
  const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  for (const groups of Object.values(hooks.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) hook.command = hook.command.replace(node, `${hookPrefix} ${node}`);
    }
  }
  fs.writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  const skillsDir = path.join(dest, "skills");
  for (const name of fs.readdirSync(skillsDir)) {
    const file = path.join(skillsDir, name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const text = fs
      .readFileSync(file, "utf8")
      .split('"${CLAUDE_PLUGIN_DATA}"')
      .join(shQuote(pluginData))
      .split(`\`\`\`bash\n${node}`)
      .join(`\`\`\`bash\n${skillPrefix} ${node}`);
    fs.writeFileSync(file, text);
  }
}

function writeAdvisorConfig(configDir, baseUrl) {
  const config = {
    version: 2,
    providers: {
      loopback: {
        kind: "api",
        provider: "openai-compatible",
        apiKeyEnv: API_KEY_ENV,
        baseUrl,
        models: { [MODEL_ID]: { contextWindow: 16384, maxTokens: 1024, reasoning: false, input: ["text"] } }
      }
    },
    advisors: [
      {
        name: "correctness",
        provider: "loopback",
        model: MODEL_ID,
        instructions: "Look for observable correctness failures.",
        enabled: true,
        reasoningEffort: "default"
      }
    ],
    exclude: [],
    limits: {
      maxConcurrentAdvisors: 1,
      reviewTimeoutSeconds: 60,
      maxToolCallsPerReview: 8,
      maxOutputTokens: 400,
      maxReviewsPerAdvisorPerSession: 40
    },
    gate: { mode: "block", maxRounds: 2 }
  };
  fs.writeFileSync(path.join(configDir, "cross-model-advisor.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Scripted advisor. First review: read src/alpha.js, raise one concern, then
 * finish. A later round (the reviewer is told "review round 2"): finish
 * silently, so a fixed or rebutted turn passes.
 */
function startLoopback() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      body = {};
    }
    if (req.method !== "POST" || !/\/chat\/completions$/.test(req.url || "")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const text = (message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""));
    const user = messages.find((message) => message.role === "user");
    requests.push({ user: user ? text(user) : "" });
    const toolResults = messages.filter((message) => message.role === "tool");
    const laterRound = user && /review round 2/.test(text(user));
    let reply;
    if (laterRound) reply = { content: "The earlier finding is resolved." };
    else if (toolResults.length === 0) reply = { tool: "read", args: { path: "src/alpha.js" } };
    else if (toolResults.length === 1) {
      reply = {
        tool: "advise",
        args: {
          severity: "concern",
          note: FINDING_NOTE,
          evidence: [{ kind: "observation", eventId: "diff:src/alpha.js", detail: "first() added without an empty-array case" }]
        }
      };
    } else reply = { content: "Done." };
    writeSse(res, reply);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        /** User messages of distinct reviews (each review's first request). */
        reviews: () => [...new Set(requests.map((item) => item.user))],
        reset() {
          requests.length = 0;
        },
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          })
      });
    });
    server.on("error", reject);
  });
}

function writeSse(res, reply) {
  const id = `chatcmpl-${crypto.randomBytes(4).toString("hex")}`;
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL_ID };
  const send = (delta, finish = null) =>
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (reply.tool) {
    send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${reply.tool}`, type: "function", function: { name: reply.tool, arguments: "" } }] });
    send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }] });
    send({}, "tool_calls");
  } else {
    send({ role: "assistant", content: reply.content });
    send({}, "stop");
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Send `prompts` one at a time on one stream-json session, waiting for each
 * turn's result.
 */
async function runHost(ctx, prompts) {
  const sessionId = crypto.randomUUID();
  const streamFile = path.join(ctx.capturesDir, `${ctx.name}.ndjson`);
  const child = spawn(
    ctx.claudePath,
    [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-hook-events",
      "--plugin-dir",
      ctx.pluginDir,
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "Read,Edit,Write,Bash",
      "--settings",
      ctx.settingsFile,
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--mcp-config",
      ctx.mcpFile,
      "--session-id",
      sessionId
    ],
    { cwd: ctx.projectDir, env: ctx.env, stdio: ["pipe", "pipe", "pipe"], detached: true }
  );
  const host = { sessionId, events: [] };
  const out = fs.createWriteStream(streamFile);
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      out.write(`${line}\n`);
      try {
        host.events.push(JSON.parse(line));
      } catch {
        /* not an event */
      }
    }
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const timer = setTimeout(() => stop(child), ctx.timeoutMs);
  try {
    for (let i = 0; i < prompts.length; i += 1) {
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompts[i] }] }, parent_tool_use_id: null })}\n`);
      await waitFor(
        () => host.events.filter((event) => event.type === "result").length >= i + 1,
        `result for prompt ${i + 1} (${prompts[i].slice(0, 40)})`,
        ctx.timeoutMs,
        () => child.exitCode !== null
      );
    }
  } catch (error) {
    const tail = Buffer.concat(stderr).toString("utf8").slice(-2000);
    throw new AssertionError(`${error.message}${tail ? `\nstderr: ${tail}` : ""}`);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    await new Promise((resolve) => {
      const kill = setTimeout(() => {
        stop(child);
        resolve();
      }, 15_000);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      if (child.exitCode !== null) resolve();
    });
    out.end();
  }
  return host;
}

function stop(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }
}

function waitFor(predicate, label, ms, dead) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (dead?.()) return reject(new Error(`claude exited before ${label}`));
      if (Date.now() - start > ms) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function hookResponses(host, name) {
  return host.events.filter((event) => event.type === "system" && event.subtype === "hook_response" && event.hook_event === name);
}

function hookText(event) {
  return String(event.stdout || event.output || "").trim();
}

function parseHookOutput(event) {
  const text = hookText(event);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readState(pluginData, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginData, "sessions", sessionId, "state.json"), "utf8"));
  } catch {
    return null;
  }
}
