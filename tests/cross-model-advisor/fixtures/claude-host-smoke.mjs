#!/usr/bin/env node
/**
 * Opt-in authenticated Claude host acceptance for plan runtime proof #2.
 *
 * Throws a prerequisite error instead of a fake pass when a host interaction
 * cannot be driven through the noninteractive stream interface. Captures stay
 * in a temporary directory and are removed on exit unless --keep-captures.
 * Never copies or prints credentials. Never uses the production repository as
 * the Claude project root.
 *
 * Usage:
 *   CROSS_MODEL_ADVISOR_HOST_SMOKE=1 node tests/cross-model-advisor/fixtures/claude-host-smoke.mjs --run
 *
 * Optional:
 *   --phase <all|parallel-read|delayed-stop|off|interrupt|compact|resume|fork>
 *   --claude <path>          default: claude on PATH
 *   --plugin-dir <path>      default: <repo>/plugins/cross-model-advisor
 *   --timeout-ms <n>         per host process, default 180000
 *   --keep-captures          leave the temp tree (still not the production repo)
 *
 * Noninteractive surface (Claude Code >= 2.1.252):
 *   claude -p --input-format stream-json --output-format stream-json --verbose \
 *     --include-hook-events --plugin-dir <plugin> --permission-mode bypassPermissions \
 *     --allowedTools Read --session-id <uuid>
 *
 * Interrupt control (stream-json stdin, when system/init.capabilities includes
 * interrupt_receipt_v1):
 *   {"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}
 *
 *   cd "$PROJECT"
 *   claude --plugin-dir "$PLUGIN" --settings "$SETTINGS" --setting-sources project --debug-file "$DEBUG"
 *   After /cross-model-advisor:on and a Read turn has started, press Esc.
 *
 * Compact: send "/compact" as a user prompt on the same stream. If PreCompact
 * and PostCompact never appear, this harness errors with:
 *   cd "$PROJECT"
 *   claude --plugin-dir "$PLUGIN" --settings "$SETTINGS" --setting-sources project --debug-file "$DEBUG"
 *   Invoke /cross-model-advisor:on, then /compact, then a real follow-up prompt.
 *
 * Resume / fork:
 *   claude -p --resume "$SESSION" --plugin-dir "$PLUGIN" ...
 *   claude -p --resume "$SESSION" --fork-session --plugin-dir "$PLUGIN" ...
 *
 * Exit 0 on success, 1 on assertion failure, 2 on missing prerequisite.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const FINDING_NOTE =
  "items[items.length] reads past the last index; use items.length - 1.";
const ALPHA_LINE = 2;
const DRAIN_EVENTS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure"
]);
const CONTROL_COMMANDS = new Set([
  "/cross-model-advisor:on",
  "/cross-model-advisor:off",
  "/cross-model-advisor:status",
  "/cross-model-advisor:doctor",
  "/cross-model-advisor:login",
  "/cross-model-advisor:logout"
]);
const MIN_HOST = [2, 1, 252];
const DEFAULT_TIMEOUT_MS = 180_000;
const API_KEY_ENV = "CMA_SMOKE_ADVISOR_KEY";
const API_KEY_VALUE = "sk-cma-smoke-loopback-not-a-secret";
const MODEL_ID = "cma-smoke";
const ADVISOR_NAME = "correctness";
const PHASES = [
  "parallel-read",
  "delayed-stop",
  "off",
  "interrupt",
  "compact",
  "resume",
  "fork"
];

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
  process.stderr.write(
    "prerequisite: set CROSS_MODEL_ADVISOR_HOST_SMOKE=1 and pass --run\n"
  );
  process.exit(2);
}

await main(args).then(
  () => {
    process.exitCode = 0;
  },
  (error) => {
    const code = error?.exitCode === 2 || error instanceof PrerequisiteError ? 2 : 1;
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = code;
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
    if (token === "--help" || token === "-h") out.help = true;
    else if (token === "--run") out.run = true;
    else if (token === "--keep-captures") out.keepCaptures = true;
    else if (token === "--phase") out.phase = needValue(argv, ++i, token);
    else if (token === "--claude") out.claude = needValue(argv, ++i, token);
    else if (token === "--plugin-dir") out.pluginDir = path.resolve(needValue(argv, ++i, token));
    else if (token === "--timeout-ms") {
      out.timeoutMs = Number(needValue(argv, ++i, token));
      if (!Number.isInteger(out.timeoutMs) || out.timeoutMs <= 0) {
        throw new PrerequisiteError("--timeout-ms must be a positive integer");
      }
    } else {
      throw new PrerequisiteError(`unknown argument: ${token}`);
    }
  }
  if (out.phase !== "all" && !PHASES.includes(out.phase)) {
    throw new PrerequisiteError(`unknown --phase ${out.phase}`);
  }
  return out;
}

function needValue(argv, index, flag) {
  if (index >= argv.length) throw new PrerequisiteError(`${flag} requires a value`);
  return argv[index];
}

function printHelp() {
  const text = `Opt-in Claude host smoke (plan runtime proof #2)

CROSS_MODEL_ADVISOR_HOST_SMOKE=1 node tests/cross-model-advisor/fixtures/claude-host-smoke.mjs --run

Requires an authenticated Claude Code >= 2.1.252 host. Creates a throwaway
trusted project with synthetic files, a loopback OpenAI-compatible advisor,
and loads the plugin via --plugin-dir. Observes stream-json hook_response
and the session transcript. Does not read production repository content.

Phases: ${PHASES.join(", ")}

Interrupt TTY fallback (only if stream-json interrupt is unavailable):
  cd "$PROJECT"
  claude --plugin-dir "$PLUGIN" --settings "$SETTINGS" --setting-sources project --debug-file "$DEBUG"
  After /cross-model-advisor:on and a Read turn has started, press Esc.

Compact TTY fallback (only if /compact in -p emits no PreCompact/PostCompact):
  cd "$PROJECT"
  claude --plugin-dir "$PLUGIN" --settings "$SETTINGS" --setting-sources project --debug-file "$DEBUG"
  Invoke /cross-model-advisor:on, then /compact, then a real follow-up prompt.

Exit 2 unless CROSS_MODEL_ADVISOR_HOST_SMOKE=1 and --run are both present.
`;
  process.stdout.write(text);
}

function ttyRecipe(ctx, kind) {
  const debug = path.join(ctx.capturesDir, `${kind}.debug`);
  const launch = `cd ${ctx.projectDir}\n  ${ctx.claudePath} --plugin-dir ${ctx.pluginDir} --settings ${ctx.settingsFile} --setting-sources project --debug-file ${debug}`;
  if (kind === "interrupt") {
    return `stream-json interrupt is unavailable (missing interrupt_receipt_v1).\nUse this terminal invocation instead of treating the phase as pass:\n  ${launch}\n  After /cross-model-advisor:on and a Read turn has started, press Esc.`;
  }
  return `/compact in noninteractive stream-json did not emit PreCompact/PostCompact.\nUse this terminal invocation instead of treating the phase as pass:\n  ${launch}\n  Invoke /cross-model-advisor:on, then /compact, then a real follow-up prompt.`;
}

async function main(options) {
  const sourcePlugin = options.pluginDir;
  const sourceControl = path.join(sourcePlugin, "dist", "control.mjs");
  if (!fs.existsSync(path.join(sourcePlugin, ".claude-plugin", "plugin.json"))) {
    throw new PrerequisiteError(`plugin manifest missing: ${sourcePlugin}`);
  }
  if (!fs.existsSync(sourceControl)) {
    throw new PrerequisiteError(
      `bundled control missing: ${sourceControl} (build dist/control.mjs first)`
    );
  }

  const claudePath = resolveClaude(options.claude);
  assertHostVersion(claudePath);
  const hostEnv = { ...process.env };
  assertHostAuth(claudePath, hostEnv);

  let root;
  let loopback;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (loopback) {
      try {
        await loopback.close();
      } catch {
        /* still delete the temp tree */
      }
    }
    if (root && options.keepCaptures) {
      process.stdout.write(`captures kept at ${root}\n`);
      return;
    }
    if (root) {
      purgeHostProject(claudePath, path.join(root, "project"), hostEnv);
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  try {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cma-host-smoke-")));
    const projectDir = path.join(root, "project");
    const configDir = path.join(root, "plugin-config");
    const pluginData = path.join(root, "plugin-data");
    const capturesDir = path.join(root, "captures");
    const outsideDir = path.join(root, "outside");
    const pluginDir = path.join(root, "plugin");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(path.join(projectDir, "src"));
    fs.mkdirSync(path.join(projectDir, ".claude"));
    fs.mkdirSync(configDir);
    fs.mkdirSync(pluginData, { recursive: true });
    fs.mkdirSync(capturesDir);
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(
      path.join(projectDir, "src", "alpha.js"),
      "export function first(items) {\n  return items[items.length];\n}\n"
    );
    fs.writeFileSync(
      path.join(projectDir, "src", "beta.js"),
      "export function second(items) {\n  return items[0];\n}\n"
    );
    fs.writeFileSync(
      path.join(projectDir, "src", "gamma.js"),
      "export const gamma = 3;\n"
    );
    fs.writeFileSync(path.join(projectDir, ".env"), "PRODUCTION_SECRET=should-never-be-read\n");
    fs.writeFileSync(path.join(outsideDir, "sentinel.txt"), "OUTSIDE_SENTINEL\n");
    fs.writeFileSync(path.join(projectDir, ".claude", "settings.json"), `${JSON.stringify({ hasTrustDialogAccepted: true }, null, 2)}\n`);
    const settingsFile = path.join(root, "session-settings.json");
    fs.writeFileSync(
      settingsFile,
      `${JSON.stringify({ hasTrustDialogAccepted: true }, null, 2)}\n`
    );
    const mcpFile = path.join(root, "mcp.json");
    fs.writeFileSync(mcpFile, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);

    clonePlugin(sourcePlugin, pluginDir, { configDir, pluginData, projectDir });
    const controlPath = path.join(pluginDir, "dist", "control.mjs");

    loopback = await startLoopback();
    writeAdvisorConfig(configDir, loopback.baseUrl);

    const pluginEnv = {
      ...hostEnv,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_PLUGIN_DATA: pluginData,
      [API_KEY_ENV]: API_KEY_VALUE
    };

    const selected = options.phase === "all" ? PHASES : [options.phase];
    const outcomes = [];
    const ctx = {
      claudePath,
      pluginDir,
      controlPath,
      projectDir,
      configDir,
      pluginData,
      capturesDir,
      outsideDir,
      settingsFile,
      mcpFile,
      hostEnv,
      pluginEnv,
      env: pluginEnv,
      loopback,
      timeoutMs: options.timeoutMs
    };
    for (const phase of selected) {
      loopback.reset(phase === "delayed-stop" ? "after-stop" : "immediate");
      process.stdout.write(`phase ${phase}\n`);
      try {
        await runPhase(phase, ctx);
        outcomes.push({ phase, ok: true });
        process.stdout.write(`  ok   ${phase}\n`);
      } catch (error) {
        const kind = error instanceof PrerequisiteError ? "prerequisite" : "assert";
        outcomes.push({ phase, ok: false, kind, message: error.message });
        process.stdout.write(`  ${kind === "prerequisite" ? "need" : "fail"} ${phase}: ${error.message}\n`);
      }
    }
    const failed = outcomes.filter((row) => !row.ok);
    if (failed.length) {
      const text = failed.map((row) => `${row.phase} (${row.kind}): ${row.message}`).join("\n");
      if (failed.every((row) => row.kind === "prerequisite")) throw new PrerequisiteError(text);
      throw new AssertionError(text);
    }
  } finally {
    await cleanup();
  }
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function pluginEnvPrefix(configDir, pluginData, projectDir) {
  return [
    `CLAUDE_CONFIG_DIR=${shQuote(configDir)}`,
    `CLAUDE_PLUGIN_DATA=${shQuote(pluginData)}`,
    `CLAUDE_PROJECT_DIR=${shQuote(projectDir)}`,
    `${API_KEY_ENV}=${shQuote(API_KEY_VALUE)}`
  ].join(" ");
}

function clonePlugin(sourcePlugin, destPlugin, { configDir, pluginData, projectDir }) {
  fs.cpSync(sourcePlugin, destPlugin, { recursive: true });
  const prefix = pluginEnvPrefix(configDir, pluginData, projectDir);
  const control = 'node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs"';
  const prefixed = `${prefix} ${control}`;
  const hooksPath = path.join(destPlugin, "hooks", "hooks.json");
  const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  for (const groups of Object.values(hooks.hooks || {})) {
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        if (typeof hook.command === "string" && hook.command.includes("dist/control.mjs")) {
          hook.command = hook.command.replace(control, prefixed);
        }
      }
    }
  }
  fs.writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  const skillsDir = path.join(destPlugin, "skills");
  if (!fs.existsSync(skillsDir)) return;
  for (const name of fs.readdirSync(skillsDir)) {
    const skill = path.join(skillsDir, name, "SKILL.md");
    if (!fs.existsSync(skill)) continue;
    const text = fs.readFileSync(skill, "utf8");
    const parts = text.split("---");
    if (parts.length >= 3) {
      const body = parts.slice(2).join("---").split(control).join(prefixed);
      fs.writeFileSync(skill, `---${parts[1]}---${body}`);
    } else {
      fs.writeFileSync(skill, text.split(control).join(prefixed));
    }
  }
}

function hostConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function purgeHostProject(claudePath, projectDir, env) {
  spawnSync(claudePath, ["project", "purge", projectDir, "--yes"], {
    encoding: "utf8",
    env,
    timeout: 15_000
  });
}

function resolveClaude(bin) {
  if (bin.includes(path.sep) || path.isAbsolute(bin)) {
    if (!fs.existsSync(bin)) throw new PrerequisiteError(`claude binary missing: ${bin}`);
    return bin;
  }
  const found = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    encoding: "utf8"
  });
  const resolved = (found.stdout || "").split("\n").map((line) => line.trim()).find(Boolean);
  if (found.status !== 0 || !resolved) {
    throw new PrerequisiteError(`claude not on PATH: ${bin}`);
  }
  return resolved;
}

function assertHostVersion(claudePath) {
  const result = spawnSync(claudePath, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new PrerequisiteError(`claude --version failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const text = `${result.stdout || ""} ${result.stderr || ""}`;
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new PrerequisiteError(`cannot parse claude version from: ${sanitize(text)}`);
  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i += 1) {
    if (version[i] > MIN_HOST[i]) return;
    if (version[i] < MIN_HOST[i]) {
      throw new PrerequisiteError(
        `Claude Code ${version.join(".")} is older than required ${MIN_HOST.join(".")}`
      );
    }
  }
}

function assertHostAuth(claudePath, env = process.env) {
  const result = spawnSync(claudePath, ["auth", "status"], { encoding: "utf8", env });
  if (result.status !== 0) {
    throw new PrerequisiteError(
      "claude auth status failed (host must already be authenticated under the real config dir; this harness does not set CLAUDE_CONFIG_DIR on the Claude process, copy tokens, or print them)"
    );
  }
}

function writeAdvisorConfig(configDir, baseUrl) {
  const config = {
    version: 1,
    providers: {
      loopback: {
        kind: "api",
        provider: "openai-compatible",
        apiKeyEnv: API_KEY_ENV,
        baseUrl,
        models: {
          [MODEL_ID]: {
            contextWindow: 8192,
            maxTokens: 1024,
            reasoning: false,
            input: ["text"]
          }
        }
      }
    },
    advisors: [
      {
        name: ADVISOR_NAME,
        provider: "loopback",
        model: MODEL_ID,
        instructions: "Look for observable correctness failures in src/alpha.js."
      }
    ],
    exclude: [],
    limits: {
      maxConcurrentAdvisors: 1,
      reviewTimeoutSeconds: 90,
      maxToolCallsPerReview: 8,
      maxOutputTokens: 400,
      maxReviewsPerAdvisorPerSession: 40
    }
  };
  fs.writeFileSync(
    path.join(configDir, "cross-model-advisor.json"),
    `${JSON.stringify(config, null, 2)}\n`
  );
}

function startLoopback() {
  let mode = "immediate";
  let releaseAdvise = null;
  let released = false;
  const gate = () =>
    new Promise((resolve) => {
      if (mode !== "after-stop" || released) {
        resolve();
        return;
      }
      releaseAdvise = resolve;
    });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (req.method === "GET" && (url.pathname === "/models" || url.pathname === "/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: MODEL_ID, object: "model" }] }));
      return;
    }
    if (
      req.method !== "POST" ||
      (url.pathname !== "/chat/completions" && url.pathname !== "/v1/chat/completions")
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    const raw = await readRequest(req);
    let body = {};
    try {
      body = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      body = {};
    }
    const record = {
      at: Date.now(),
      path: url.pathname,
      model: body.model,
      messages: body.messages || [],
      tools: (body.tools || []).map((tool) => tool?.function?.name || tool?.name)
    };
    requests.push(record);
    const stream = Boolean(body.stream);
    const toolNames = new Set(record.tools.filter(Boolean));
    const readName = toolNames.has("read") ? "read" : [...toolNames].find((name) => /read$/i.test(name)) || "read";
    const adviseName =
      toolNames.has("advise") ? "advise" : [...toolNames].find((name) => /advise$/i.test(name)) || "advise";
    const messages = body.messages || [];
    const sawReadResult = messages.some((message) => {
      if (message.role !== "tool") return false;
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
      return text.includes("items.length") || text.includes("alpha.js");
    });
    const payload = sawReadResult
      ? await (async () => {
          await gate();
          return completionPayload({
            toolName: adviseName,
            toolId: "call_advise_1",
            args: {
              severity: "concern",
              note: FINDING_NOTE,
              evidence: [
                {
                  kind: "file",
                  path: "src/alpha.js",
                  line: ALPHA_LINE,
                  detail: "off-by-one index"
                }
              ]
            }
          });
        })()
      : completionPayload({
          toolName: readName,
          toolId: "call_read_1",
          args: { path: "src/alpha.js" }
        });
    if (stream) writeSse(res, payload);
    else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    }
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requests,
        reset(nextMode) {
          mode = nextMode;
          released = false;
          releaseAdvise = null;
          requests.length = 0;
        },
        release() {
          released = true;
          if (releaseAdvise) {
            const done = releaseAdvise;
            releaseAdvise = null;
            done();
          }
        },
        close() {
          this.release();
          for (const socket of sockets) {
            try {
              socket.destroy();
            } catch {
              /* ignore */
            }
          }
          sockets.clear();
          if (typeof server.closeAllConnections === "function") server.closeAllConnections();
          return new Promise((done) => {
            const timer = setTimeout(done, 2000);
            server.close(() => {
              clearTimeout(timer);
              done();
            });
          });
        }
      });
    });
    server.on("error", reject);
  });
}

function completionPayload({ toolName, toolId, args }) {
  return {
    id: `chatcmpl-${crypto.randomBytes(4).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: toolId,
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(args) }
            }
          ]
        },
        finish_reason: "tool_calls"
      }
    ]
  };
}

function writeSse(res, payload) {
  const call = payload.choices[0].message.tool_calls[0];
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache"
  });
  writeEvent(res, {
    id: payload.id,
    object: "chat.completion.chunk",
    created: payload.created,
    model: payload.model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: call.id,
              type: "function",
              function: { name: call.function.name, arguments: "" }
            }
          ]
        },
        finish_reason: null
      }
    ]
  });
  writeEvent(res, {
    id: payload.id,
    object: "chat.completion.chunk",
    created: payload.created,
    model: payload.model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }]
        },
        finish_reason: null
      }
    ]
  });
  writeEvent(res, {
    id: payload.id,
    object: "chat.completion.chunk",
    created: payload.created,
    model: payload.model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function runPhase(phase, ctx) {
  switch (phase) {
    case "parallel-read":
      return phaseParallelRead(ctx);
    case "delayed-stop":
      return phaseDelayedStop(ctx);
    case "off":
      return phaseOff(ctx);
    case "interrupt":
      return phaseInterrupt(ctx);
    case "compact":
      return phaseCompact(ctx);
    case "resume":
      return phaseResume(ctx);
    case "fork":
      return phaseFork(ctx);
    default:
      throw new PrerequisiteError(`unhandled phase ${phase}`);
  }
}

async function phaseParallelRead(ctx) {
  const session = await runHost(ctx, {
    name: "parallel-read",
    prompts: [
      "/cross-model-advisor:on",
      "Read src/alpha.js and src/beta.js in parallel in one turn using two Read tool calls together. Then read src/gamma.js. Then stop. Do not edit files. Do not run shell commands. Do not mention secrets."
    ],
    afterPrompt: async (host, index) => {
      if (index === 0) assertEnabled(ctx, host.sessionId);
    }
  });
  assertPluginLoaded(session);
  assertParallelReads(session);
  assertFindingViaAdditionalContext(session, { beforeFinish: true });
  assertFindingNotUserMessage(session);
  assertNoProductionLeak(session, ctx);
  assertLoopbackRead(ctx.loopback);
}

async function phaseDelayedStop(ctx) {
  const session = await runHost(ctx, {
    name: "delayed-stop",
    prompts: ["/cross-model-advisor:on"],
    afterPrompt: async (host, index) => {
      void index;
      assertEnabled(ctx, host.sessionId);
      const beforeWork = host.primaryRequests;
      const stopsBefore = hookEvents(host, "Stop").length;
      host.send(
        "Read src/alpha.js only, then finish immediately without further tools. Do not edit."
      );
      await host.waitFor((state) => hookEvents(state, "Stop").length > stopsBefore, "Stop after read");
      const stopHooks = hookEvents(host, "Stop");
      for (const hook of stopHooks) {
        assertStopSilent(hook);
      }
      const requestsAtStop = host.primaryRequests;
      if (requestsAtStop < beforeWork) {
        throw new AssertionError("primary model requests went backwards");
      }
      ctx.loopback.release();
      await waitFor(
        () => peekStatus(ctx, host.sessionId).inbox.some((item) => item.status === "pending"),
        "inbox pending after delayed advise",
        20_000
      );
      const pending = controlStatus(ctx, host.sessionId);
      if (pending.inbox.some((item) => item.status === "emitted")) {
        throw new AssertionError("finding emitted before the next real user prompt");
      }
      const requestsBeforeNext = host.primaryRequests;
      if (requestsBeforeNext !== requestsAtStop) {
        throw new AssertionError(
          `advisor completion caused ${requestsBeforeNext - requestsAtStop} extra primary model request(s) after Stop`
        );
      }
      const resultsBeforeNext = resultCount(host);
      await host.send("Confirm you are still in the same session. Do not read files.");
      await host.waitFor((state) => resultCount(state) > resultsBeforeNext, "next real prompt result");
    }
  });
  assertPluginLoaded(session);
  const stopHooks = hookEvents(session, "Stop");
  if (!stopHooks.length) throw new AssertionError("delayed-stop: no Stop hook_response");
  for (const hook of stopHooks) assertStopSilent(hook);
  const drained = drainContexts(session).filter((item) => item.afterStop);
  if (!drained.length) {
    throw new AssertionError("delayed finding never entered additionalContext on the next real prompt");
  }
  assertFindingNotUserMessage(session);
  const status = controlStatus(ctx, session.sessionId);
  if (!status.inbox.some((item) => item.status === "emitted" || item.status === "claimed")) {
    throw new AssertionError(`expected emitted/claimed inbox after next prompt, got ${JSON.stringify(redact(status.inbox))}`);
  }
}

async function phaseOff(ctx) {
  const session = await runHost(ctx, {
    name: "off",
    prompts: [
      "/cross-model-advisor:on",
      "Read src/alpha.js. Then stop.",
      "/cross-model-advisor:off",
      "Read src/beta.js. Then stop."
    ],
    afterPrompt: async (host, index) => {
      if (index === 0) assertEnabled(ctx, host.sessionId);
      if (index === 2) {
        const status = controlStatus(ctx, host.sessionId);
        if (status.enabled) throw new AssertionError("off left the session enabled");
      }
    }
  });
  const offIndex = firstPromptIndex(session, "/cross-model-advisor:off");
  const laterDrains = drainContexts(session).filter((item) => item.order > offIndex);
  if (laterDrains.length) {
    throw new AssertionError("off drained additionalContext after disable");
  }
}

async function phaseInterrupt(ctx) {
  const session = await runHost(ctx, {
    name: "interrupt",
    prompts: ["/cross-model-advisor:on"],
    afterPrompt: async (host, index) => {
      void index;
      assertEnabled(ctx, host.sessionId);
      if (!host.capabilities.includes("interrupt_receipt_v1")) {
        throw new PrerequisiteError(ttyRecipe(ctx, "interrupt"));
      }
      const resultsBefore = resultCount(host);
      host.send("Read src/alpha.js then src/beta.js then src/gamma.js slowly. Do not finish yet.");
      await host.waitFor((state) => toolUses(state, "Read").length > 0, "Read tool");
      host.interrupt();
      await host.waitFor(
        (state) => resultCount(state) > resultsBefore || assistantAborted(state),
        "interrupted result"
      );
    }
  });
  if (!assistantAborted(session) && !session.events.some((event) => event.type === "result")) {
    throw new AssertionError("interrupt produced neither an aborted assistant nor a result");
  }
}

async function phaseCompact(ctx) {
  const session = await runHost(ctx, {
    name: "compact",
    timeoutMs: Math.max(ctx.timeoutMs, 180_000),
    prompts: [
      "/cross-model-advisor:on",
      "Read src/alpha.js in full and quote every line. Do not edit.",
      "Read src/beta.js in full and quote every line. Do not edit.",
      "Read src/gamma.js in full and quote every line. Do not edit.",
      "Explain in two short paragraphs why items[items.length] in src/alpha.js is an off-by-one. Do not edit files.",
      "/compact",
      "Read src/gamma.js and stop."
    ],
    afterPrompt: async (host, index) => {
      if (index === 0) assertEnabled(ctx, host.sessionId);
      if (index === 5) {
        if (compactRejected(host)) {
          throw new PrerequisiteError(
            "host refused /compact (not enough messages) after padded synthetic turns; stream-json compact did not run"
          );
        }
        if (!compactFinished(host)) {
          throw new PrerequisiteError(
            "stream-json /compact never emitted PostCompact or compact_boundary within 90s while stdin stayed open"
          );
        }
        if (!controlStatus(ctx, host.sessionId).enabled) {
          throw new AssertionError("compact cleared activation; compact-source must preserve it");
        }
      }
    }
  });
  if (!compactFinished(session)) {
    throw new PrerequisiteError(
      "stream-json /compact never emitted PostCompact or compact_boundary"
    );
  }
}

async function phaseResume(ctx) {
  const first = await runHost(ctx, {
    name: "resume-seed",
    prompts: ["/cross-model-advisor:on", "Read src/alpha.js and stop."],
    afterPrompt: async (host, index) => {
      if (index === 0) assertEnabled(ctx, host.sessionId);
    }
  });
  const parentId = first.sessionId;
  await runHost(ctx, {
    name: "resume",
    resume: parentId,
    prompts: ["Name one file you already read. Do not call tools unless required."],
    afterPrompt: async (host, index) => {
      if (index !== 0) return;
      if (controlStatus(ctx, host.sessionId).enabled) {
        throw new AssertionError("resumed host process must start disabled");
      }
    }
  });
}

async function phaseFork(ctx) {
  const parent = await runHost(ctx, {
    name: "fork-parent",
    prompts: ["/cross-model-advisor:on", "Read src/alpha.js and stop."]
  });
  ctx.loopback.release();
  await waitFor(
    () => acceptedInbox(ctx, parent.sessionId).length > 0,
    "parent accepted finding",
    20_000
  );
  const parentInbox = acceptedInbox(ctx, parent.sessionId);
  const forked = await runHost(ctx, {
    name: "fork",
    resume: parent.sessionId,
    fork: true,
    prompts: ["This is a forked session. Do not call tools."],
    afterPrompt: async (host, index) => {
      if (index !== 0) return;
      const forkStatus = controlStatus(ctx, host.sessionId);
      if (forkStatus.enabled) throw new AssertionError("fork must start disabled");
      const parentIds = new Set(parentInbox.map((item) => item.id).filter(Boolean));
      if (!parentIds.size) throw new AssertionError("parent finding has no id");
      if (forkStatus.inbox.some((item) => parentIds.has(item.id))) {
        throw new AssertionError("fork inherited parent inbox ids");
      }
    }
  });
  if (forked.sessionId === parent.sessionId) {
    throw new AssertionError("fork reused the parent session id");
  }
}

async function runHost(ctx, spec) {
  const sessionId = crypto.randomUUID();
  const debugFile = path.join(ctx.capturesDir, `${spec.name}.debug`);
  const streamFile = path.join(ctx.capturesDir, `${spec.name}.ndjson`);
  const argv = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    "--include-partial-messages",
    "--plugin-dir",
    ctx.pluginDir,
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    "Read,Bash",
    "--replay-user-messages",
    "--debug-file",
    debugFile,
    "--settings",
    ctx.settingsFile,
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    ctx.mcpFile
  ];
  if (spec.resume) {
    argv.push("--resume", spec.resume);
    if (spec.fork) argv.push("--fork-session");
  } else {
    argv.push("--session-id", sessionId);
  }
  const child = spawn(ctx.claudePath, argv, {
    cwd: ctx.projectDir,
    env: ctx.hostEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true
  });
  const host = {
    sessionId,
    capabilities: [],
    events: [],
    primaryRequests: 0,
    child,
    closed: false,
    send(text) {
      child.stdin.write(`${JSON.stringify(userMessage(text))}\n`);
    },
    interrupt() {
      const requestId = crypto.randomUUID();
      child.stdin.write(
        `${JSON.stringify({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "interrupt" }
        })}\n`
      );
    },
    waitFor(predicate, label, ms = ctx.timeoutMs) {
      return waitFor(() => predicate(host), label, ms);
    }
  };
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  const stream = fs.createWriteStream(streamFile);
  child.on("close", () => {
    host.closed = true;
    stream.end();
  });
  const lines = splitLines(child.stdout);
  const consume = (async () => {
    for await (const line of lines) {
      stream.write(`${line}\n`);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      host.events.push(event);
      if (event.type === "system" && event.subtype === "init") {
        host.sessionId = event.session_id || host.sessionId;
        host.capabilities = Array.isArray(event.capabilities) ? event.capabilities : [];
      }
      if (event.session_id) host.sessionId = event.session_id;
      if (event.type === "assistant" && !event.parent_tool_use_id && !event.aborted) {
        host.primaryRequests += 1;
      }
    }
  })();

  const timeoutMs = spec.timeoutMs || ctx.timeoutMs;
  const timeout = setTimeout(() => stopChild(child), timeoutMs);

  try {
    for (let i = 0; i < spec.prompts.length; i += 1) {
      const resultsBefore = resultCount(host);
      host.send(spec.prompts[i]);
      if (/^\/compact\b/.test(spec.prompts[i])) {
        try {
          await host.waitFor(
            (state) => compactFinished(state) || compactRejected(state),
            "/compact completion",
            90_000
          );
        } catch (error) {
          if (!compactFinished(host) && !compactRejected(host)) {
            throw new PrerequisiteError(
              "stream-json /compact never emitted PostCompact or compact_boundary within 90s while stdin stayed open"
            );
          }
          throw error;
        }
      } else {
        await host.waitFor(
          (state) => resultCount(state) > resultsBefore,
          `result after ${spec.prompts[i]}`,
          timeoutMs
        );
      }
      if (spec.afterPrompt) await spec.afterPrompt(host, i);
    }
    if (!child.killed && child.stdin.writable) child.stdin.end();
    await Promise.race([
      Promise.all([consume.catch(() => {}), waitExit(child)]),
      sleep(5000)
    ]);
  } finally {
    clearTimeout(timeout);
    stopChild(child);
    await Promise.race([
      Promise.all([consume.catch(() => {}), waitExit(child)]),
      sleep(2000)
    ]);
    if (!host.closed) stopChild(child, "SIGKILL");
  }

  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  fs.writeFileSync(path.join(ctx.capturesDir, `${spec.name}.stderr`), sanitize(stderr));
  if (fs.existsSync(debugFile)) {
    fs.writeFileSync(debugFile, sanitize(fs.readFileSync(debugFile, "utf8")));
  }
  host.transcript = readTranscript(hostConfigDir(), ctx.projectDir, host.sessionId);
  host.stderr = stderr;
  if (!host.events.length) {
    throw new AssertionError(`${spec.name}: host produced no stream-json events`);
  }
  return host;
}

function userMessage(text) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null
  };
}

async function* splitLines(stream) {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim()) yield line;
    }
  }
  if (buffer.trim()) yield buffer.replace(/\r$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopChild(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function waitExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("exit", () => resolve(child.exitCode));
  });
}

function waitFor(predicate, label, ms) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() - start > ms) {
        reject(new AssertionError(`timeout waiting for ${label}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}
function resultCount(host) {
  return host.events.filter((event) => event.type === "result").length;
}

function compactFinished(host) {
  if (hookEvents(host, "PostCompact").length) return true;
  return host.events.some(
    (event) =>
      event.subtype === "compact_boundary" ||
      event.type === "compact_boundary" ||
      (event.type === "system" && event.subtype === "compact_boundary")
  );
}

function compactRejected(host) {
  const text = host.events
    .map((event) => {
      if (event.type === "result") return String(event.result || event.errors || "");
      if (event.type === "assistant" || event.type === "user") return messageText(event);
      if (typeof event.message === "string") return event.message;
      return "";
    })
    .join("\n");
  return /not enough (?:context|messages)|conversation is too short|nothing to compact|too few messages/i.test(
    text
  );
}

function expansionSeen(host, command) {
  return host.events.some(
    (event) =>
      event.type === "system" &&
      event.subtype === "hook_response" &&
      event.hook_event === "UserPromptExpansion" &&
      JSON.stringify(event).includes(command.replace(/^\//, ""))
  );
}

function hookEvents(host, name) {
  return host.events.filter(
    (event) => event.type === "system" && event.subtype === "hook_response" && event.hook_event === name
  );
}

function parseHookStdout(hook) {
  const raw = hook.stdout || hook.output || "";
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function drainContexts(host) {
  const out = [];
  let sawStop = false;
  let order = 0;
  for (const event of host.events) {
    order += 1;
    if (event.type === "system" && event.subtype === "hook_response" && event.hook_event === "Stop") {
      sawStop = true;
    }
    if (event.type !== "system" || event.subtype !== "hook_response") continue;
    if (!DRAIN_EVENTS.has(event.hook_event)) continue;
    const parsed = parseHookStdout(event);
    const extra = parsed?.hookSpecificOutput?.additionalContext;
    if (typeof extra === "string" && extra.length) {
      out.push({
        event: event.hook_event,
        additionalContext: extra,
        hookEventName: parsed.hookSpecificOutput.hookEventName,
        afterStop: sawStop && event.hook_event === "UserPromptSubmit",
        order,
        parsed
      });
    }
  }
  return out;
}

function assertStopSilent(hook) {
  const parsed = parseHookStdout(hook);
  const extra = parsed?.hookSpecificOutput?.additionalContext;
  if (extra) throw new AssertionError("Stop returned additionalContext");
  const dumped = JSON.stringify(parsed || hook.stdout || "");
  if (/asyncRewake|permissionDecision|"decision"\s*:\s*"block"|continue"\s*:\s*false/.test(dumped)) {
    throw new AssertionError("Stop emitted a wake/block mechanism");
  }
  if (String(hook.stdout || "").trim() && parsed && Object.keys(parsed).length) {
    if (parsed.hookSpecificOutput && Object.keys(parsed.hookSpecificOutput).length > 1) {
      throw new AssertionError(`Stop stdout was not empty: ${sanitize(String(hook.stdout).slice(0, 200))}`);
    }
  }
}

function assertPluginLoaded(session) {
  const init = session.events.find((event) => event.type === "system" && event.subtype === "init");
  if (!init) throw new AssertionError("missing system/init");
  const names = (init.plugins || []).map((plugin) => plugin.name || plugin);
  if (!names.some((name) => String(name).includes("cross-model-advisor"))) {
    const errors = init.plugin_errors || [];
    throw new AssertionError(
      `plugin not loaded via --plugin-dir; plugins=${JSON.stringify(names)} errors=${JSON.stringify(redact(errors))}`
    );
  }
}

function assertEnabled(ctx, sessionId) {
  const status = controlStatus(ctx, sessionId);
  if (!status.ok || !status.enabled) {
    throw new AssertionError(`expected enabled status after on, got ${JSON.stringify(redact(status))}`);
  }
  if (status.projectRoot && path.resolve(status.projectRoot) !== path.resolve(ctx.projectDir)) {
    throw new AssertionError(`worker projectRoot ${status.projectRoot} is not the temp project`);
  }
}

function assertParallelReads(session) {
  const batches = new Map();
  for (const event of session.events) {
    if (event.type !== "assistant" || event.parent_tool_use_id) continue;
    const uses = (event.message?.content || []).filter((block) => block.type === "tool_use" && block.name === "Read");
    if (uses.length && event.message?.id) {
      const batch = batches.get(event.message.id) || [];
      batch.push(...uses);
      batches.set(event.message.id, batch);
    }
  }
  const parallelOk = [...batches.values()].some((batch) => {
    const files = batch.map((use) => String(use.input?.file_path || use.input?.path || ""));
    const hasAlpha = files.some((file) => file.endsWith("alpha.js"));
    const hasBeta = files.some((file) => file.endsWith("beta.js"));
    return batch.length >= 2 && hasAlpha && hasBeta;
  });
  if (!parallelOk) {
    throw new AssertionError("Claude did not issue parallel Read of src/alpha.js and src/beta.js in one turn");
  }
  const allFiles = toolUses(session, "Read").map((use) => String(use.input?.file_path || use.input?.path || ""));
  if (!allFiles.some((file) => file.endsWith("gamma.js"))) {
    throw new AssertionError("Claude never Read src/gamma.js");
  }
}


function toolUses(session, name) {
  const out = [];
  for (const event of session.events) {
    if (event.type !== "assistant") continue;
    for (const block of event.message?.content || []) {
      if (block.type === "tool_use" && block.name === name) out.push(block);
    }
  }
  return out;
}

function assertFindingViaAdditionalContext(session, { beforeFinish }) {
  const drains = drainContexts(session);
  const hit = drains.find((item) => item.additionalContext.includes(FINDING_NOTE));
  if (!hit) {
    throw new AssertionError("finding did not enter hookSpecificOutput.additionalContext on a drain event");
  }
  if (!DRAIN_EVENTS.has(hit.event)) {
    throw new AssertionError(`additionalContext on non-drain event ${hit.event}`);
  }
  if (hit.hookEventName && hit.hookEventName !== hit.event) {
    throw new AssertionError(`hookEventName ${hit.hookEventName} does not match ${hit.event}`);
  }
  if (beforeFinish) {
    const lastStop = [...session.events]
      .reverse()
      .find((event) => event.type === "system" && event.subtype === "hook_response" && event.hook_event === "Stop");
    if (lastStop) {
      const drainOrder = hit.order;
      const finishOrder = session.events.indexOf(lastStop) + 1;
      if (drainOrder > finishOrder) {
        throw new AssertionError("finding additionalContext arrived after the host finished the turn");
      }
    }
  }
}

function assertFindingNotUserMessage(session) {
  for (const event of session.events) {
    if (event.type !== "user") continue;
    const text = messageText(event);
    if (text.includes(FINDING_NOTE) && !text.startsWith("/")) {
      throw new AssertionError("finding appeared as a user message rather than additionalContext");
    }
  }
  for (const entry of session.transcript || []) {
    if (entry.type !== "user" && entry.role !== "user") continue;
    const text = messageText(entry);
    if (text.includes(FINDING_NOTE)) {
      throw new AssertionError("transcript stored the finding as a user message");
    }
  }
}

function assertNoProductionLeak(session, ctx) {
  const blob = `${JSON.stringify(session.events)}\n${JSON.stringify(session.transcript || [])}`;
  if (blob.includes(repoRoot) && blob.includes("plugins/codex-pr-reviewer")) {
    throw new AssertionError("capture referenced production reviewer content");
  }
  if (blob.includes("OUTSIDE_SENTINEL") || blob.includes("PRODUCTION_SECRET")) {
    throw new AssertionError("outside sentinel or project .env secret entered host capture");
  }
  const rel = path.relative(ctx.projectDir, repoRoot);
  if (!rel.startsWith("..")) {
    throw new AssertionError("temp project is not isolated from the production repo");
  }
}

function assertLoopbackRead(loopback) {
  const read = loopback.requests.some((request) => {
    const dumped = JSON.stringify(request.messages);
    return request.tools.includes("read") || dumped.includes("src/alpha.js");
  });
  if (!read && !loopback.requests.length) {
    throw new AssertionError("scripted advisor server received no Chat Completions request");
  }
  if (!loopback.requests.some((request) => JSON.stringify(request).includes("alpha.js"))) {
    throw new AssertionError("scripted advisor never requested a project read of src/alpha.js");
  }
}

function assistantAborted(session) {
  return session.events.some((event) => event.type === "assistant" && event.aborted === true);
}

function firstPromptIndex(session, text) {
  let order = 0;
  for (const event of session.events) {
    order += 1;
    if (event.type === "user" && messageText(event).includes(text)) return order;
  }
  return Number.MAX_SAFE_INTEGER;
}

function messageText(event) {
  const message = event.message || event;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (typeof block === "string" ? block : block.text || "")).join("\n");
  }
  return JSON.stringify(message);
}

function peekStatus(ctx, sessionId) {
  try {
    return controlStatus(ctx, sessionId);
  } catch {
    return { ok: false, enabled: false, inbox: [], advisors: [] };
  }
}

function acceptedInbox(ctx, sessionId) {
  return peekStatus(ctx, sessionId).inbox.filter(
    (item) => item && item.status !== "discarded" && item.status !== "stale"
  );
}

function controlStatus(ctx, sessionId) {
  const pluginData = ctx.pluginData || resolvePluginData(ctx.configDir);
  const result = spawnSync(process.execPath, [ctx.controlPath, "status"], {
    cwd: ctx.projectDir,
    env: {
      ...(ctx.pluginEnv || ctx.env),
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_PROJECT_DIR: ctx.projectDir,
      CLAUDE_PLUGIN_DATA: pluginData,
      CLAUDE_CONFIG_DIR: ctx.configDir,
      [API_KEY_ENV]: API_KEY_VALUE
    },
    encoding: "utf8",
    timeout: 5000
  });
  const raw = (result.stdout || "").trim();
  if (!raw) {
    throw new AssertionError(
      `control status produced no JSON (exit ${result.status}): ${sanitize((result.stderr || "").slice(0, 400))}`
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new AssertionError(`control status is not JSON: ${sanitize(raw.slice(0, 200))}`);
  }
}

function resolvePluginData(configDir) {
  const root = path.join(configDir, "plugins", "data");
  if (!fs.existsSync(root)) return path.join(root, "cross-model-advisor");
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const named = entries.find((entry) => entry.name.includes("cross-model-advisor"));
  if (named) return path.join(root, named.name);
  if (entries.length === 1) return path.join(root, entries[0].name);
  return path.join(root, "cross-model-advisor");
}

function readTranscript(configDir, projectDir, sessionId) {
  const projects = path.join(configDir, "projects");
  if (!fs.existsSync(projects)) return [];
  const files = [];
  for (const dir of fs.readdirSync(projects)) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) files.push(candidate);
  }
  if (!files.length) {
    const encoded = projectDir.replace(/[^A-Za-z0-9]/g, "-");
    const fallback = path.join(projects, encoded, `${sessionId}.jsonl`);
    if (fs.existsSync(fallback)) files.push(fallback);
  }
  const rows = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* incomplete trailing line */
      }
    }
  }
  return rows;
}

function sanitize(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(new RegExp(API_KEY_VALUE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[redacted]");
}

function redact(value) {
  return JSON.parse(sanitize(JSON.stringify(value)));
}
