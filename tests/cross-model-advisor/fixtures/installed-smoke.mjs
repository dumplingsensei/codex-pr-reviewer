#!/usr/bin/env node
/**
 * Cold-install acceptance for the bundled plugin.
 *
 * Two proofs, both against trees that have no `src/` and no `node_modules`:
 *   1. Isolated `claude plugin marketplace add/install` with an npm/bun/yarn
 *      trap on PATH — Claude must not bootstrap dependencies, and the cached
 *      copy must ship LICENSE plus the three dist executables.
 *   2. Doctor/control IPC, a loopback OpenAI-compatible read→advise review,
 *      Stop with empty stdout while that review is still in flight, drain on
 *      the next real prompt, plus cold resolution of provider/auth modules.
 *
 * Invoked by tests/cross-model-advisor/installed.test.mjs or directly:
 *   node tests/cross-model-advisor/fixtures/installed-smoke.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const pluginSource = path.join(repoRoot, "plugins", "cross-model-advisor");

const EXECUTABLES = ["control.mjs", "worker.mjs", "auth-control.mjs"];
const SKIP_COPY = new Set([
  "src",
  "node_modules",
  ".git",
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml"
]);
const MANIFEST_NAMES = [
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml"
];
const STRIP_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_PROFILE",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "NODE_PATH"
];

const APP_SOURCE = [
  "export function total(items) {",
  "  let n = 0;",
  "  for (let i = 0; i <= items.length; i++) n += items[i];",
  "  return n;",
  "}",
  ""
].join("\n");
const APP_BUG_LINE = 3;
const FINDING_NOTE = "smoke-finding: loop upper bound includes items.length";

export async function runMarketplaceInstallSmoke() {
  requireBuiltPlugin(pluginSource);
  const world = makeWorld("cma-market-");
  try {
    const pluginCopy = path.join(world.root, "plugin");
    copyColdPlugin(pluginSource, pluginCopy);
    assertColdTree(pluginCopy);

    const market = path.join(world.root, "market");
    writeMarketplace(market, pluginCopy);

    const trapLog = path.join(world.root, "bootstrap.log");
    const trapBin = path.join(world.root, "trap-bin");
    installBootstrapTrap(trapBin, trapLog);

    const claudeHome = path.join(world.root, "home");
    const configDir = path.join(world.root, "claude-config");
    const pluginRoot = path.join(configDir, "plugins");
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(pluginRoot, { recursive: true });

    const claude = resolveClaude();
    const env = claudeIsolatedEnv({
      HOME: claudeHome,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginRoot,
      PATH: `${trapBin}${path.delimiter}${process.env.PATH ?? ""}`
    });

    await runClaude(claude, ["plugin", "marketplace", "add", market], env, 60_000);
    await runClaude(
      claude,
      ["plugin", "install", "cross-model-advisor@cma-smoke-market", "--scope", "user", "--yes"],
      env,
      60_000
    );

    const trap = fs.existsSync(trapLog) ? fs.readFileSync(trapLog, "utf8") : "";
    assert.equal(trap, "", `package manager ran during marketplace install:\n${trap}`);

    const installed = findInstalledPlugin([pluginRoot, configDir]);
    assert.ok(installed, `marketplace install produced no cached plugin under ${pluginRoot}`);
    assertColdTree(installed);
    assertLicense(installed);
    assert.equal(
      fs.existsSync(path.join(installed, "src")),
      false,
      "cached install must not include source"
    );
    assert.equal(
      fs.existsSync(path.join(installed, "node_modules")),
      false,
      "cached install must not contain node_modules"
    );

    await assertExecutablesResolve(installed, world);
  } finally {
    await world.close();
  }
}

export async function runColdBundleSmoke() {
  requireBuiltPlugin(pluginSource);
  const world = makeWorld("cma-bundle-");
  const loopback = new LoopbackAdvisor();
  try {
    const pluginDir = path.join(world.root, "plugin");
    copyColdPlugin(pluginSource, pluginDir);
    assertColdTree(pluginDir);
    assertLicense(pluginDir);

    const projectDirRaw = path.join(world.root, "project");
    const pluginDataRaw = path.join(world.root, "plugin-data");
    const configDirRaw = path.join(world.root, "claude-config");
    const homeDirRaw = path.join(world.root, "home");
    fs.mkdirSync(path.join(projectDirRaw, "src"), { recursive: true });
    fs.mkdirSync(pluginDataRaw, { recursive: true });
    fs.mkdirSync(configDirRaw, { recursive: true });
    fs.mkdirSync(homeDirRaw, { recursive: true });
    const projectDir = fs.realpathSync(projectDirRaw);
    const pluginData = fs.realpathSync(pluginDataRaw);
    const configDir = fs.realpathSync(configDirRaw);
    const homeDir = fs.realpathSync(homeDirRaw);
    fs.writeFileSync(path.join(projectDir, "src", "app.mjs"), APP_SOURCE);

    const transcriptPath = path.join(world.root, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");

    const { port, close: closeLoopback } = await loopback.listen();
    world.defer(closeLoopback);

    const apiKeyEnv = "CMA_SMOKE_API_KEY";
    fs.writeFileSync(
      path.join(configDir, "cross-model-advisor.json"),
      `${JSON.stringify(
        {
          version: 1,
          providers: {
            loopback: {
              kind: "api",
              provider: "openai-compatible",
              apiKeyEnv,
              baseUrl: `http://127.0.0.1:${port}/v1`,
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
              name: "correctness",
              provider: "loopback",
              model: "smoke-model",
              instructions: "Look for observable correctness failures and missed edge cases."
            }
          ],
          exclude: [],
          limits: {
            maxConcurrentAdvisors: 1,
            reviewTimeoutSeconds: 30,
            maxToolCallsPerReview: 8,
            maxOutputTokens: 1_500,
            maxReviewsPerAdvisorPerSession: 40
          }
        },
        null,
        2
      )}\n`
    );

    const sessionId = "cma-installed-smoke";
    const env = isolatedPluginEnv({
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_SESSION_ID: sessionId,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PLUGIN_DATA: pluginData,
      CLAUDE_PLUGIN_ROOT: pluginDir,
      CLAUDE_CONFIG_DIR: configDir,
      HOME: homeDir,
      [apiKeyEnv]: "sk-smoke-not-a-real-key"
    });

    world.defer(() => shutdownSession(pluginDir, env));

    const doctor = await runControl(pluginDir, env, ["doctor"], { timeoutMs: 8_000 });
    assert.equal(doctor.status, 0, `doctor failed:\n${doctor.stderr}\n${doctor.stdout}`);
    const doctorJson = parseJsonOutput(doctor.stdout);
    assert.equal(doctorJson?.config?.ok, true, `doctor config:\n${fmt(doctorJson)}\n${doctor.stderr}`);
    assert.equal(doctorJson?.ipc?.ok, true, `doctor ipc:\n${fmt(doctorJson)}\n${doctor.stderr}`);
    const doctorKey = (doctorJson?.keys ?? []).find((item) => item?.name === apiKeyEnv);
    assert.equal(doctorKey?.present, true, `doctor keys:\n${fmt(doctorJson?.keys)}`);

    const locator = await waitFor(
      () => {
        const file = path.join(pluginData, "sessions", sessionId, "locator.json");
        if (!fs.existsSync(file)) return null;
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed?.socketPath || !parsed?.controlCapability) return null;
        if (!pidIsLive(parsed.pid)) return null;
        return parsed;
      },
      { timeoutMs: 3_000, label: "worker locator.json with live pid and socket after doctor" }
    );

    const start = await runControl(pluginDir, env, ["hook"], {
      stdin: hookPayload({
        sessionId,
        transcriptPath,
        cwd: projectDir,
        hook_event_name: "SessionStart",
        source: "startup"
      }),
      timeoutMs: 3_000
    });
    assert.equal(start.status, 0, `SessionStart failed:\n${start.stderr}`);
    assertSilentHook(start.stdout, "SessionStart");

    const on = await runControl(pluginDir, env, ["on"], { timeoutMs: 8_000 });
    assert.equal(on.status, 0, `on failed:\n${on.stderr}\n${on.stdout}`);
    const onJson = parseJsonOutput(on.stdout);
    assert.equal(onJson?.enabled, true, `on did not enable:\n${fmt(onJson)}\n${on.stderr}`);

    const statusOn = statusView(
      parseJsonOutput((await runControl(pluginDir, env, ["status"], { timeoutMs: 3_000 })).stdout)
    );
    const advisors = statusOn?.advisors;
    assert.ok(Array.isArray(advisors) && advisors.length >= 1, `status after on: ${fmt(statusOn)}`);
    assert.notEqual(advisors[0]?.state, "disabled", `advisor disabled after on: ${fmt(statusOn)}`);

    const promptId = "11111111-1111-4111-8111-111111111111";
    const submit = await runControl(pluginDir, env, ["hook"], {
      stdin: hookPayload({
        sessionId,
        transcriptPath,
        cwd: projectDir,
        hook_event_name: "UserPromptSubmit",
        prompt_id: promptId,
        prompt: "Please inspect src/app.mjs for correctness bugs."
      }),
      timeoutMs: 3_000
    });
    assert.equal(submit.status, 0, `UserPromptSubmit failed:\n${submit.stderr}`);

    await waitForLoopback(loopback.firstRequest.promise, 5_000, "loopback first chat/completions (read)", {
      pluginDir,
      env,
      sessionId
    });
    await waitForLoopback(loopback.adviseRequest.promise, 5_000, "loopback advise chat/completions", {
      pluginDir,
      env,
      sessionId
    });

    const stop = await runControl(pluginDir, env, ["hook"], {
      stdin: hookPayload({
        sessionId,
        transcriptPath,
        cwd: projectDir,
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "Finished looking at src/app.mjs."
      }),
      timeoutMs: 3_000
    });
    assert.equal(stop.status, 0, `Stop failed:\n${stop.stderr}`);
    assertSilentHook(stop.stdout, "Stop");
    assert.equal(stop.stdout.trim(), "");

    const midStatus = statusView(
      parseJsonOutput((await runControl(pluginDir, env, ["status"], { timeoutMs: 3_000 })).stdout)
    );
    assert.equal(
      inboxHasNote(midStatus, FINDING_NOTE),
      false,
      "staged advise must not be drainable before the backend turn finishes"
    );

    loopback.releaseAdvise();

    const pending = await waitFor(
      async () => {
        const raw = await runControl(pluginDir, env, ["status"], { timeoutMs: 3_000 });
        const view = statusView(parseJsonOutput(raw.stdout));
        return inboxHasNote(view, FINDING_NOTE) ? view : null;
      },
      { timeoutMs: 8_000, label: "inbox pending finding after late advise" }
    );
    const pendingItem = (pending.inbox ?? []).find((item) => String(item?.note ?? "").includes(FINDING_NOTE));
    assert.ok(pendingItem, fmt(pending));
    assert.equal(pendingItem.status, "pending");
    assert.equal(pendingItem.severity, "concern");

    const nextPrompt = await runControl(pluginDir, env, ["hook"], {
      stdin: hookPayload({
        sessionId,
        transcriptPath,
        cwd: projectDir,
        hook_event_name: "UserPromptSubmit",
        prompt_id: "22222222-2222-4222-8222-222222222222",
        prompt: "Continue with the next task in src/app.mjs."
      }),
      timeoutMs: 3_000
    });
    assert.equal(nextPrompt.status, 0, `drain prompt failed:\n${nextPrompt.stderr}`);
    const drained = parseJsonOutput(nextPrompt.stdout);
    const specific = drained?.hookSpecificOutput;
    assert.equal(specific?.hookEventName, "UserPromptSubmit");
    assert.equal(typeof specific?.additionalContext, "string");
    assert.ok(
      specific.additionalContext.includes(FINDING_NOTE),
      `drain missing finding note:\n${specific.additionalContext}`
    );
    assert.ok(
      specific.additionalContext.includes("src/app.mjs"),
      `drain missing evidence path:\n${specific.additionalContext}`
    );
    assert.ok(
      /\bconcern\b/i.test(specific.additionalContext),
      `drain missing severity:\n${specific.additionalContext}`
    );
    assert.equal(specific.permissionDecision, undefined);
    assert.notEqual(drained?.continue, false);
    assert.equal(drained?.asyncRewake, undefined);

    const names = loopback.toolNamesFromFirstRequest();
    assert.ok(names.includes("read") && names.includes("advise"), `tools: ${names.join(",")}`);
    assert.ok(
      loopback.sawFileContents(),
      "loopback never received read tool output; review did not actually read the project"
    );

    await assertModulesResolve(pluginDir);
    assert.equal(typeof locator.controlCapability, "string");
    assert.ok(locator.controlCapability.length > 0);
  } finally {
    loopback.releaseAdvise();
    await world.close();
  }
}

export async function runInstalledSmoke() {
  await runMarketplaceInstallSmoke();
  await runColdBundleSmoke();
}

function requireBuiltPlugin(dir) {
  for (const name of EXECUTABLES) {
    const file = path.join(dir, "dist", name);
    if (!fs.existsSync(file)) {
      throw new Error(
        `missing ${path.relative(repoRoot, file)}; run npm run build in tooling/cross-model-advisor`
      );
    }
  }
  const manifest = path.join(dir, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(manifest)) {
    throw new Error(`missing ${path.relative(repoRoot, manifest)}`);
  }
}

function copyColdPlugin(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => !SKIP_COPY.has(path.basename(src))
  });
}

function assertColdTree(dir) {
  for (const name of EXECUTABLES) {
    assert.ok(fs.existsSync(path.join(dir, "dist", name)), `missing dist/${name} in ${dir}`);
  }
  for (const name of MANIFEST_NAMES) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `unexpected ${name} in ${dir}`);
  }
  assert.equal(fs.existsSync(path.join(dir, "src")), false, `src/ leaked into ${dir}`);
  assert.equal(fs.existsSync(path.join(dir, "node_modules")), false, `node_modules leaked into ${dir}`);
}

function assertLicense(dir) {
  const license = path.join(dir, "LICENSE");
  assert.ok(fs.existsSync(license), `installed plugin missing LICENSE at ${dir}`);
  const body = fs.readFileSync(license, "utf8");
  assert.ok(body.trim().length > 0, "LICENSE is empty");
  const rootLicense = path.join(repoRoot, "LICENSE");
  if (fs.existsSync(rootLicense)) {
    assert.equal(body, fs.readFileSync(rootLicense, "utf8"), "installed LICENSE differs from repo LICENSE");
  }
}

function writeMarketplace(marketDir, pluginCopy) {
  const pluginJson = JSON.parse(
    fs.readFileSync(path.join(pluginCopy, ".claude-plugin", "plugin.json"), "utf8")
  );
  const dest = path.join(marketDir, "plugins", "cross-model-advisor");
  fs.mkdirSync(path.join(marketDir, ".claude-plugin"), { recursive: true });
  fs.cpSync(pluginCopy, dest, { recursive: true });
  fs.writeFileSync(
    path.join(marketDir, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify(
      {
        name: "cma-smoke-market",
        owner: { name: "cma-smoke" },
        plugins: [
          {
            name: "cross-model-advisor",
            source: "./plugins/cross-model-advisor",
            version: pluginJson.version ?? "1.0.0",
            description: pluginJson.description ?? "installed-smoke"
          }
        ]
      },
      null,
      2
    )}\n`
  );
}

function installBootstrapTrap(binDir, logFile) {
  fs.mkdirSync(binDir, { recursive: true });
  const quotedLog = JSON.stringify(logFile);
  for (const name of ["npm", "npx", "bun", "yarn", "pnpm"]) {
    fs.writeFileSync(
      path.join(binDir, name),
      `#!/bin/sh\nprintf '%s\\n' "cmd=${name} argv=$* cwd=$(pwd)" >> ${quotedLog}\nexit 1\n`,
      { mode: 0o755 }
    );
  }
}

function resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "claude");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error(
    "claude executable not found on PATH; isolated marketplace install requires the real Claude CLI (no host model)"
  );
}

function claudeIsolatedEnv(overrides) {
  const env = { ...process.env, ...overrides };
  for (const key of STRIP_ENV) delete env[key];
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

function isolatedPluginEnv(overrides) {
  const env = claudeIsolatedEnv(overrides);
  env.PATH = process.env.PATH ?? "";
  return env;
}

function runClaude(bin, args, env, timeoutMs) {
  return runProcess(bin, args, { env, cwd: env.HOME, timeoutMs });
}

async function assertExecutablesResolve(pluginDir, world) {
  const configDir = path.join(world.root, "doctor-config");
  const projectDir = path.join(world.root, "doctor-project");
  const pluginData = path.join(world.root, "doctor-data");
  const homeDir = path.join(world.root, "doctor-home");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "cross-model-advisor.json"),
    `${JSON.stringify({
      version: 1,
      providers: {
        copilot: { kind: "oauth", provider: "github-copilot" },
        loopback: {
          kind: "api",
          provider: "openai-compatible",
          apiKeyEnv: "CMA_SMOKE_API_KEY",
          baseUrl: "http://127.0.0.1:9/v1",
          models: {
            "smoke-model": {
              contextWindow: 16_000,
              maxTokens: 256,
              reasoning: false,
              input: ["text"]
            }
          }
        }
      },
      advisors: [
        {
          name: "correctness",
          provider: "loopback",
          model: "smoke-model",
          instructions: "doctor import probe"
        }
      ],
      exclude: [],
      limits: {
        maxConcurrentAdvisors: 1,
        reviewTimeoutSeconds: 5,
        maxToolCallsPerReview: 1,
        maxOutputTokens: 256,
        maxReviewsPerAdvisorPerSession: 1
      }
    })}\n`
  );
  const env = isolatedPluginEnv({
    CLAUDE_CODE_SESSION_ID: "cma-market-doctor",
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_PLUGIN_DATA: pluginData,
    CLAUDE_PLUGIN_ROOT: pluginDir,
    CLAUDE_CONFIG_DIR: configDir,
    HOME: homeDir,
    CMA_SMOKE_API_KEY: "sk-smoke-not-a-real-key"
  });
  world.defer(() => shutdownSession(pluginDir, env));
  const result = await runControl(pluginDir, env, ["doctor"], { timeoutMs: 8_000 });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(
    combined,
    /Cannot find module|ERR_MODULE_NOT_FOUND/,
    `marketplace-installed doctor could not resolve runtime imports:\n${combined}`
  );
  assert.equal(result.status, 0, combined);
  const authControl = path.join(pluginDir, "dist", "auth-control.mjs");
  for (const command of ["status", "logout", "status"]) {
    const auth = await runProcess(process.execPath, [authControl, command, "copilot"], {
      env, cwd: projectDir, timeoutMs: 8_000
    });
    assert.equal(auth.status, 0, `${command}: ${auth.stderr}`);
    if (command === "status") assert.match(auth.stdout, /status: logged-out/);
  }
  const login = await runProcess(process.execPath, [authControl, "login", "copilot"], {
    env, cwd: projectDir, timeoutMs: 8_000
  });
  assert.equal(login.status, 1, "cold helper must reject nonterminal login");
  assert.doesNotMatch(`${login.stdout}\n${login.stderr}`, /Cannot find module|ERR_MODULE_NOT_FOUND/);
  assert.equal(
    fs.existsSync(path.join(configDir, "cross-model-advisor", "credentials", "copilot.json")),
    false,
    "nonterminal login must not create credentials"
  );
  await assertModulesResolve(pluginDir);
}

async function assertModulesResolve(pluginDir) {
  const candidates = [
    path.join(pluginDir, "dist", "modules", "src", "session", "constants.mjs"),
    path.join(pluginDir, "dist", "modules", "session", "constants.mjs")
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) return;
  await import(pathToFileURL(file).href);
}

function findInstalledPlugin(roots) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const manifest = path.join(dir, ".claude-plugin", "plugin.json");
    if (fs.existsSync(manifest)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (parsed?.name === "cross-model-advisor") hits.push(dir);
      } catch {
        // ignore unreadable manifests while walking the cache
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  for (const root of roots) {
    if (fs.existsSync(root)) walk(root, 0);
  }
  hits.sort((a, b) => b.length - a.length);
  return hits[0] ?? null;
}

class LoopbackAdvisor {
  constructor() {
    this.requests = [];
    this.firstRequest = deferred();
    this.adviseRequest = deferred();
    this._hold = deferred();
    this._holding = true;
    this.server = null;
  }

  releaseAdvise() {
    if (this._holding) {
      this._holding = false;
      this._hold.resolve();
    }
  }

  toolNamesFromFirstRequest() {
    return toolNames(this.requests[0] ?? {});
  }

  sawFileContents() {
    return this.requests.some((body) => {
      const blob = JSON.stringify(body.messages ?? []);
      return blob.includes("items.length") || blob.includes("export function total");
    });
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.#handle(req, res).catch((error) => {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
          }
          res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }));
        });
      });
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        resolve({
          port: address.port,
          close: () => this.close()
        });
      });
      this.server.on("error", reject);
    });
  }

  async close() {
    this.releaseAdvise();
    const server = this.server;
    this.server = null;
    await closeServer(server);
  }

  async #handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = await readHttpBody(req);
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${url.pathname}` } }));
      return;
    }
    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid json" } }));
      return;
    }
    this.requests.push(parsed);
    if (this.requests.length === 1) this.firstRequest.resolve(parsed);

    const phase = completionPhase(parsed);
    if (phase === "advise") this.adviseRequest.resolve(parsed);
    if (phase === "advise" && this._holding) await this._hold.promise;

    const model = typeof parsed.model === "string" ? parsed.model : "smoke-model";
    const payload = this.#payload(phase, model);
    if (parsed.stream === false) {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(payload.json));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close"
    });
    res.end(payload.sse);
  }

  #payload(phase, model) {
    if (phase === "read") {
      return completionPayload({
        model,
        finish_reason: "tool_calls",
        tool_calls: [
          {
            id: "call_smoke_read",
            name: "read",
            arguments: JSON.stringify({ path: "src/app.mjs" })
          }
        ]
      });
    }
    if (phase === "advise") {
      return completionPayload({
        model,
        finish_reason: "tool_calls",
        tool_calls: [
          {
            id: "call_smoke_advise",
            name: "advise",
            arguments: JSON.stringify({
              severity: "concern",
              note: FINDING_NOTE,
              evidence: [
                {
                  kind: "file",
                  path: "src/app.mjs",
                  line: APP_BUG_LINE,
                  detail: "inclusive upper bound reads past the last item"
                }
              ]
            })
          }
        ]
      });
    }
    return completionPayload({ model, finish_reason: "stop", content: "" });
  }
}

function completionPhase(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const blobs = messages.map((message) => JSON.stringify(message));
  const sawAdvise = blobs.some((blob) => blob.includes("call_smoke_advise") || blob.includes('"name":"advise"'));
  const sawRead = blobs.some(
    (blob) => blob.includes("call_smoke_read") || /"name"\s*:\s*"read"/.test(blob)
  );
  const hasToolRole = messages.some((message) => message?.role === "tool" || message?.tool_call_id);
  if (sawAdvise && hasToolRole) return "stop";
  if (sawRead && hasToolRole) return "advise";
  return "read";
}

function toolNames(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools
    .map((tool) => tool?.function?.name || tool?.name)
    .filter((name) => typeof name === "string");
}

function completionPayload({ model, finish_reason, tool_calls, content }) {
  const id = "chatcmpl-cma-smoke";
  const created = Math.floor(Date.now() / 1000);
  const usage = { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 };
  const message = {
    role: "assistant",
    content: tool_calls ? null : content ?? ""
  };
  if (tool_calls) {
    message.tool_calls = tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments }
    }));
  }
  const json = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason }],
    usage
  };
  const deltas = [];
  if (tool_calls) {
    deltas.push({
      role: "assistant",
      content: null,
      tool_calls: message.tool_calls.map((call, index) => ({
        index,
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments }
      }))
    });
  } else {
    deltas.push({ role: "assistant", content: content ?? "" });
  }
  const chunks = deltas.map((delta) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: null }]
  }));
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason }],
    usage
  });
  const sse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return { json, sse };
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

function assertSilentHook(stdout, eventName) {
  const text = String(stdout ?? "").trim();
  if (!text) return;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    assert.fail(`${eventName} printed non-JSON: ${text}`);
  }
  assert.equal(
    parsed?.hookSpecificOutput?.additionalContext,
    undefined,
    `${eventName} must not drain advice`
  );
  assert.equal(parsed?.hookSpecificOutput?.asyncRewake, undefined);
  assert.notEqual(parsed?.continue, false);
}

function inboxHasNote(status, note) {
  return (status?.inbox ?? []).some((item) => String(item?.note ?? "").includes(note));
}

function statusView(parsed) {
  if (parsed && typeof parsed === "object" && parsed.result && typeof parsed.result === "object") {
    return parsed.result;
  }
  return parsed;
}

function parseJsonOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error(`expected JSON stdout, got: ${text.slice(0, 800)}`);
  }
}

async function runControl(pluginDir, env, args, { stdin, timeoutMs = 5_000 } = {}) {
  const control = path.join(pluginDir, "dist", "control.mjs");
  return runProcess(process.execPath, [control, ...args], {
    env,
    cwd: env.CLAUDE_PROJECT_DIR,
    timeoutMs,
    stdin: stdin == null ? undefined : `${JSON.stringify(stdin)}\n`,
    label: `control ${args.join(" ")}`
  });
}

function runProcess(command, args, { env, cwd, timeoutMs, stdin, label } = {}) {
  const display = label ?? `${command} ${args.join(" ")}`;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(`${display} requires a positive timeoutMs`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
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
        // already gone
      }
      finish(
        reject,
        new Error(
          `${display} timed out after ${timeoutMs}ms pid=${child.pid ?? "none"}\nstdout:\n${Buffer.concat(stdout).toString("utf8")}\nstderr:\n${Buffer.concat(stderr).toString("utf8")}`
        )
      );
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      finish(reject, error);
    });
    child.on("close", (status, signal) => {
      finish(resolve, {
        status: status ?? (signal ? 1 : 0),
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      if (stdin != null) child.stdin.end(stdin);
      else child.stdin.end();
    }
  });
}

async function shutdownSession(_pluginDir, env) {
  const locatorFile = path.join(
    env.CLAUDE_PLUGIN_DATA,
    "sessions",
    env.CLAUDE_CODE_SESSION_ID,
    "locator.json"
  );
  let locator = null;
  try {
    locator = JSON.parse(fs.readFileSync(locatorFile, "utf8"));
  } catch {
    locator = null;
  }
  if (locator?.pid) killTree(locator.pid);
  removeWorkerSocket(locator?.socketPath);
  const deadline = Date.now() + 400;
  while (locator?.pid && pidIsLive(locator.pid) && Date.now() < deadline) {
    killTree(locator.pid);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    const latest = JSON.parse(fs.readFileSync(locatorFile, "utf8"));
    if (latest?.pid && latest.pid !== locator?.pid) killTree(latest.pid);
    if (latest?.socketPath && latest.socketPath !== locator?.socketPath) {
      removeWorkerSocket(latest.socketPath);
    }
  } catch {
    // locator already gone
  }
}

function removeWorkerSocket(socketPath) {
  if (typeof socketPath !== "string" || !socketPath) return;
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    // gone
  }
  const dir = path.dirname(socketPath);
  const tmp = os.tmpdir();
  if (
    path.basename(dir).startsWith("cma") &&
    (dir === tmp || dir.startsWith(`${tmp}${path.sep}`))
  ) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // gone
    }
  }
}

function closeServer(server, timeoutMs = 500) {
  return new Promise((done) => {
    if (!server) {
      done();
      return;
    }
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      done();
    }, timeoutMs);
    server.close(() => {
      clearTimeout(timer);
      done();
    });
    server.closeAllConnections?.();
  });
}

function killTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-n, sig);
    } catch {
      // process group may not exist
    }
    try {
      process.kill(n, sig);
    } catch {
      // already gone
    }
  }
}

function pidIsLive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}


function makeWorld(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cleanups = [];
  return {
    root,
    defer(fn) {
      cleanups.push(fn);
    },
    async close() {
      for (const fn of [...cleanups].reverse()) {
        try {
          await waitWithTimeout(Promise.resolve(fn()), 5_000, "world cleanup");
        } catch {
          // always finish cleanup
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitWithTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(`${label} requires a positive timeoutMs`));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for ${label} after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function waitForLoopback(promise, timeoutMs, label, { pluginDir, env, sessionId }) {
  try {
    return await waitWithTimeout(promise, timeoutMs, label);
  } catch (error) {
    const dump = await sessionDiagnostics(pluginDir, env, sessionId);
    throw new Error(`${error instanceof Error ? error.message : error}\n${dump}`);
  }
}

function redactDiagnostics(text) {
  return String(text ?? "").replace(/sk-[A-Za-z0-9._-]+/g, "sk-[redacted]");
}

async function sessionDiagnostics(pluginDir, env, sessionId) {
  const dir = path.join(env.CLAUDE_PLUGIN_DATA, "sessions", sessionId);
  let status = null;
  try {
    const raw = await runControl(pluginDir, env, ["status"], { timeoutMs: 2_000 });
    status = parseJsonOutput(raw.stdout) ?? { exit: raw.status, stderr: raw.stderr };
  } catch (error) {
    status = { error: String(error?.message ?? error) };
  }
  const view = statusView(status);
  const advisor = view?.advisors?.[0];
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  } catch (error) {
    state = { error: String(error?.message ?? error) };
  }
  let errors = "";
  try {
    errors = fs.readFileSync(path.join(dir, "errors.log"), "utf8").slice(-4_000);
  } catch {
    errors = "";
  }
  return redactDiagnostics(
    [
      `status.enabled=${view?.enabled} paused=${view?.paused} reason=${view?.reason}`,
      `advisor.state=${advisor?.state} lastError=${advisor?.lastError ?? ""}`,
      `snapshot.enabled=${state?.enabled} paused=${state?.paused} pauseReason=${state?.pauseReason} cwdOutsideRoot=${state?.cwdOutsideRoot} primaryIdle=${state?.primaryIdle} contextUnavailable=${state?.contextUnavailable} latestTask=${Boolean(state?.latestTask)} projectRoot=${state?.projectRoot}`,
      errors ? `errors.log:\n${errors}` : "errors.log: (empty)"
    ].join("\n")
  );
}

async function waitFor(fn, { timeoutMs, label, intervalMs = 50 }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${label ?? "waitFor"} requires a positive timeoutMs`);
  }
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const extra = lastError ? `\n${lastError}` : "";
  throw new Error(`timeout waiting for ${label}${extra}`);
}

function readHttpBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function fmt(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const launchedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (launchedDirectly) {
  runInstalledSmoke()
    .then(() => {
      console.log("installed smoke passed");
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
