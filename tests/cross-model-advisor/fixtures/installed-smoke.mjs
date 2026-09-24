#!/usr/bin/env node
/**
 * Cold-install acceptance for the bundled plugin.
 *
 * Two proofs, both against trees that have no `src/` and no `node_modules`:
 *   1. Isolated `claude plugin marketplace add/install` with an npm/bun/yarn
 *      trap on PATH — Claude must not bootstrap dependencies, and the cached
 *      copy must ship LICENSE plus the four dist executables.
 *   2. doctor, on, a prompt snapshot, and a Stop review of a real git change
 *      by a loopback OpenAI-compatible advisor that reads the file and sends
 *      Claude back with an evidence-backed concern; then cold resolution of
 *      provider/auth/menu modules and the real bundled menu in a PTY.
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
import { assertTermiosRestored, openAndQuitMenu } from "./terminal-smoke.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const pluginSource = path.join(repoRoot, "plugins", "cross-model-advisor");

const EXECUTABLES = ["control.mjs", "gate.mjs", "auth-control.mjs", "setup-control.mjs"];
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
const APP_BEFORE = APP_SOURCE.replace("i <= items.length", "i < items.length");
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
  loopback.releaseAdvise();
  try {
    const pluginDir = path.join(world.root, "plugin");
    copyColdPlugin(pluginSource, pluginDir);
    assertColdTree(pluginDir);
    assertLicense(pluginDir);

    const projectDir = fs.realpathSync(fs.mkdirSync(path.join(world.root, "project"), { recursive: true }));
    const pluginData = fs.realpathSync(fs.mkdirSync(path.join(world.root, "plugin-data"), { recursive: true }));
    const configDir = fs.realpathSync(fs.mkdirSync(path.join(world.root, "claude-config"), { recursive: true }));
    const homeDir = fs.realpathSync(fs.mkdirSync(path.join(world.root, "home"), { recursive: true }));
    fs.mkdirSync(path.join(projectDir, "src"));
    fs.writeFileSync(path.join(projectDir, "src", "app.mjs"), APP_BEFORE);
    const gitArgs = ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false"];
    for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "init"]]) {
      const done = await runProcess("git", [...gitArgs, ...args], { env: process.env, cwd: projectDir, timeoutMs: 10_000 });
      assert.equal(done.status, 0, done.stderr);
    }

    const { port, close: closeLoopback } = await loopback.listen();
    world.defer(closeLoopback);

    const apiKeyEnv = "CMA_SMOKE_API_KEY";
    fs.writeFileSync(
      path.join(configDir, "cross-model-advisor.json"),
      `${JSON.stringify(
        {
          version: 2,
          providers: {
            loopback: {
              kind: "api",
              provider: "openai-compatible",
              apiKeyEnv,
              baseUrl: `http://127.0.0.1:${port}/v1`,
              models: {
                "smoke-model": { contextWindow: 16_000, maxTokens: 2_048, reasoning: false, input: ["text"] }
              }
            }
          },
          advisors: [
            {
              name: "correctness",
              provider: "loopback",
              model: "smoke-model",
              instructions: "Look for observable correctness failures and missed edge cases.",
              enabled: true,
              reasoningEffort: "default"
            }
          ],
          exclude: [],
          limits: {
            maxConcurrentAdvisors: 1,
            reviewTimeoutSeconds: 30,
            maxToolCallsPerReview: 8,
            maxOutputTokens: 1_500,
            maxReviewsPerAdvisorPerSession: 40
          },
          gate: { mode: "block", maxRounds: 2 }
        },
        null,
        2
      )}\n`
    );

    const sessionId = "cma-installed-smoke";
    // Hooks get CLAUDE_PLUGIN_DATA from the host. Skills name it with
    // --plugin-data, so their environment carries a decoy that must lose.
    const hookEnv = isolatedPluginEnv({
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PLUGIN_DATA: pluginData,
      CLAUDE_CONFIG_DIR: configDir,
      HOME: homeDir,
      [apiKeyEnv]: "sk-smoke-not-a-real-key"
    });
    const skillEnv = { ...hookEnv, CLAUDE_PLUGIN_DATA: path.join(world.root, "other-plugin-data") };
    const skill = (script, op) =>
      runProcess(process.execPath, [path.join(pluginDir, "dist", script), op, "--plugin-data", pluginData], {
        env: skillEnv,
        cwd: projectDir,
        timeoutMs: 15_000,
        label: `${script} ${op}`
      });

    const doctor = await skill("gate.mjs", "doctor");
    assert.equal(doctor.status, 0, `doctor failed:\n${doctor.stderr}\n${doctor.stdout}`);
    const doctorJson = parseJsonOutput(doctor.stdout);
    assertDoctorBundleHealthy(doctorJson, doctor.stderr);
    assert.equal(doctorJson?.git?.ok, true, fmt(doctorJson));
    assert.equal((doctorJson?.keys ?? []).find((item) => item?.name === apiKeyEnv)?.present, true, fmt(doctorJson));

    const on = parseJsonOutput((await skill("gate.mjs", "on")).stdout);
    assert.equal(on?.enabled, true, `on did not enable:\n${fmt(on)}`);
    assert.equal(on?.projectRoot, projectDir);
    assert.equal(fs.existsSync(path.join(world.root, "other-plugin-data", "sessions")), false);

    const promptId = "11111111-1111-4111-8111-111111111111";
    const submit = await runControl(pluginDir, hookEnv, ["hook"], {
      stdin: hookPayload({
        sessionId,
        cwd: projectDir,
        hook_event_name: "UserPromptSubmit",
        prompt_id: promptId,
        prompt: "Make total() sum every item."
      }),
      timeoutMs: 15_000
    });
    assert.equal(submit.status, 0, submit.stderr);
    assert.equal(submit.stdout.trim(), "", "the prompt hook never adds context");

    fs.writeFileSync(path.join(projectDir, "src", "app.mjs"), APP_SOURCE);

    const stop = await runProcess(process.execPath, [path.join(pluginDir, "dist", "gate.mjs"), "stop"], {
      env: hookEnv,
      cwd: projectDir,
      timeoutMs: 60_000,
      stdin: `${JSON.stringify(
        hookPayload({
          sessionId,
          cwd: projectDir,
          hook_event_name: "Stop",
          prompt_id: promptId,
          stop_hook_active: false,
          last_assistant_message: "total() now sums every item."
        })
      )}\n`,
      label: "gate stop"
    });
    assert.equal(stop.status, 0, stop.stderr);
    const decision = parseJsonOutput(stop.stdout);
    assert.equal(decision?.decision, "block", `Stop did not send Claude back:\n${stop.stdout}\n${stop.stderr}`);
    assert.ok(decision.reason.includes(FINDING_NOTE), decision.reason);
    assert.ok(decision.reason.includes(`src/app.mjs:${APP_BUG_LINE}`), decision.reason);
    assert.match(decision.reason, /not the user/);

    const names = loopback.toolNamesFromFirstRequest();
    assert.ok(names.includes("read") && names.includes("advise"), `tools: ${names.join(",")}`);
    assert.ok(loopback.sawFileContents(), "the advisor never received the file it read");
    const firstUser = JSON.stringify(loopback.requests[0]?.messages ?? []);
    assert.ok(firstUser.includes("i <= items.length"), "the advisor never received the turn's diff");
    assert.ok(firstUser.includes("Make total() sum every item."), "the advisor never received the request");

    const status = parseJsonOutput((await skill("control.mjs", "status")).stdout);
    assert.equal(status?.lastReview?.outcome, "blocked", fmt(status));
    assert.equal(status?.lastReview?.findings?.[0]?.note, FINDING_NOTE);

    await assertModulesResolve(pluginDir);
    const configBefore = fs.readFileSync(path.join(configDir, "cross-model-advisor.json"), "utf8");
    const opened = await openAndQuitMenu({ pluginDir, env: hookEnv, cwd: projectDir });
    assertTermiosRestored(opened.termios);
    assert.match(opened.screen || opened.transcript, /Cross-model advisors/);
    assert.equal(
      fs.readFileSync(path.join(configDir, "cross-model-advisor.json"), "utf8"),
      configBefore,
      "opening the cold menu must not write config"
    );
  } finally {
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
  delete env.CLAUDE_PLUGIN_ROOT;
  if (typeof overrides?.CLAUDE_PLUGIN_ROOT === "string" && overrides.CLAUDE_PLUGIN_ROOT) {
    env.CLAUDE_PLUGIN_ROOT = overrides.CLAUDE_PLUGIN_ROOT;
  }
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
    CLAUDE_PLUGIN_DATA: pluginData,
    CLAUDE_CONFIG_DIR: configDir,
    HOME: homeDir,
    CMA_SMOKE_API_KEY: "sk-smoke-not-a-real-key"
  });
  delete env.CLAUDE_PROJECT_DIR;
  const result = await runProcess(
    process.execPath,
    [path.join(pluginDir, "dist", "gate.mjs"), "doctor", "--plugin-data", pluginData],
    { env, cwd: projectDir, timeoutMs: 8_000 }
  );
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(
    combined,
    /Cannot find module|ERR_MODULE_NOT_FOUND/,
    `marketplace-installed doctor could not resolve runtime imports:\n${combined}`
  );
  assert.equal(result.status, 0, combined);
  const doctorJson = parseJsonOutput(result.stdout);
  assert.equal(doctorJson?.bundle?.ok, true, `doctor bundle:\n${fmt(doctorJson)}`);
  assert.equal(doctorJson?.config?.ok, true, `doctor config:\n${fmt(doctorJson)}`);
  const status = await runProcess(
    process.execPath,
    [path.join(pluginDir, "dist", "control.mjs"), "status", "--plugin-data", pluginData],
    { env, cwd: homeDir, timeoutMs: 8_000 }
  );
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).ok, true);
  const authControl = path.join(pluginDir, "dist", "auth-control.mjs");
  const listed = await runProcess(process.execPath, [authControl, "list"], {
    env, cwd: projectDir, timeoutMs: 8_000
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).slots.find((slot) => slot.slot === "copilot")?.kind, "oauth");
  const catalog = await runProcess(process.execPath, [path.join(pluginDir, "dist", "setup-control.mjs"), "catalog"], {
    env, cwd: projectDir, timeoutMs: 8_000
  });
  assert.equal(catalog.status, 0, catalog.stderr);
  assert.deepEqual(JSON.parse(catalog.stdout).providers.find((provider) => provider.id === "openai-codex")?.auth, ["oauth"]);
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
  const dir = path.join(pluginDir, "dist", "modules");
  const names = [
    "session/constants.mjs",
    "setup-menu.mjs",
    "terminal-ui.mjs",
    "terminal-command.mjs",
    "reasoning.mjs",
    "setup-store.mjs"
  ];
  for (const name of names) {
    const file = path.join(dir, name);
    const nested = path.join(pluginDir, "dist", "modules", "src", name);
    const resolved = fs.existsSync(file) ? file : nested;
    assert.ok(fs.existsSync(resolved), `cold plugin missing ${name} under ${dir}`);
    await import(pathToFileURL(resolved).href);
  }
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





function hookPayload({ sessionId, cwd, ...rest }) {
  return {
    session_id: sessionId,
    cwd,
    permission_mode: "default",
    ...rest
  };
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

function assertDoctorBundleHealthy(doctorJson, stderr = "") {
  assert.equal(doctorJson?.ok, true, `doctor ok:\n${fmt(doctorJson)}\n${stderr}`);
  assert.equal(doctorJson?.bundle?.ok, true, `doctor bundle:\n${fmt(doctorJson?.bundle)}\n${stderr}`);
  assert.deepEqual(doctorJson?.bundle?.missing, [], `doctor missing:\n${fmt(doctorJson?.bundle)}`);
}

async function runControl(pluginDir, env, args, { stdin, timeoutMs = 5_000, cwd = env.CLAUDE_PROJECT_DIR } = {}) {
  const control = path.join(pluginDir, "dist", "control.mjs");
  return runProcess(process.execPath, [control, ...args], {
    env,
    cwd,
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
