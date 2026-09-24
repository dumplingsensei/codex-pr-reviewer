/**
 * IPC regressions: capability gating, newline framing, fail-open control,
 * Stop no-wake stdout, protocol 2 settings, and completed-write ack.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distModules = path.join(repo, "plugins", "cross-model-advisor", "dist", "modules");
const load = (rel) => import(pathToFileURL(path.join(distModules, rel)).href);

const { startWorker } = await load("worker.mjs");
const { runControl, spawnWorkerProcess, workerChildEnv } = await load("control.mjs");
const { encodeFrame, requestIpc, splitFrames } = await load("session/ipc.mjs");

function configFixture() {
  return {
    version: 1,
    providers: {
      "openai-api": { kind: "api", provider: "openai", apiKeyEnv: "OPENAI_API_KEY" }
    },
    advisors: [
      {
        name: "correctness",
        provider: "openai-api",
        model: "gpt-test",
        instructions: "check"
      }
    ],
    exclude: [],
    limits: {
      maxConcurrentAdvisors: 2,
      reviewTimeoutSeconds: 2,
      maxToolCallsPerReview: 4,
      maxOutputTokens: 1500,
      maxReviewsPerAdvisorPerSession: 40
    }
  };
}

function makeTools(calls) {
  let staged = null;
  return {
    async call(name, args) {
      calls.push({ name, args });
      if (name === "advise") {
        staged = { severity: args.severity, note: args.note, evidence: args.evidence ?? [] };
      }
      return { ok: true, name };
    },
    get candidate() {
      return staged;
    },
    async isFresh() {
      return true;
    },
    guidance: ""
  };
}

async function start(t, extra = {}) {
  const { env: extraEnv, ...rest } = extra;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-ipc-root-")));
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-ipc-data-")));
  const sessionId = extra.sessionId ?? `ipc-${Math.random().toString(16).slice(2)}`;
  const calls = [];
  const env = {
    OPENAI_API_KEY: "sk-test-secret-value",
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PROJECT_DIR: root,
    CLAUDE_CODE_SESSION_ID: sessionId,
    ...extraEnv
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  if (typeof extraEnv?.CLAUDE_PLUGIN_ROOT === "string" && extraEnv.CLAUDE_PLUGIN_ROOT) {
    env.CLAUDE_PLUGIN_ROOT = extraEnv.CLAUDE_PLUGIN_ROOT;
  }
  const worker = await startWorker({
    sessionId,
    projectRoot: root,
    pluginData: data,
    env,
    exitOnIdle: false,
    idleMs: Number.POSITIVE_INFINITY,
    debounceMs: 0,
    loadConfig: async () => configFixture(),
    validateRoot: async () => {},
    runtimeErrors: () => [],
    createReviewTools: async () => makeTools(calls),
    validateApi: async () => ({ available: true }),
    reviewApi: extra.reviewApi ?? (async () => ({ usage: { costUsd: "unknown" }, history: [] })),
    advisorSystemPrompt: "inspect",
    ...rest
  });
  t.after(async () => {
    await worker.stop({ reason: "test" });
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(data, { recursive: true, force: true });
  });
  const rpc = (body, timeoutMs = 2000) => {
    const req = { ...body };
    if (req.op === "hook" && req.client === undefined) {
      req.client = { pid: process.pid, id: randomUUID(), protocolVersion: 2 };
    }
    return requestIpc(worker.socketPath, req, { timeoutMs });
  };
  return { root, data, sessionId, worker, rpc, calls, env };
}

async function waitUntil(fn, ms = 2500) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("timeout waiting for condition");
}

const REQUIRED_BUNDLE = ["control.mjs", "worker.mjs", "auth-control.mjs", "setup-control.mjs"];

async function pluginRootFixture(t, names) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cma-bundle-root-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  for (const name of names) {
    await fs.writeFile(path.join(dir, "dist", name), "");
  }
  return dir;
}

function collectWriter() {
  let text = "";
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString();
      cb();
    }
  });
  return {
    stdout,
    get text() {
      return text;
    }
  };
}

test("splitFrames survives chunk boundaries and keeps a partial trail", () => {
  const first = encodeFrame({ ok: true, result: { a: 1 } });
  const second = encodeFrame({ ok: true, result: { b: 2 } });
  const combined = Buffer.from(first + second + '{"ok":false');
  const mid = Math.ceil(combined.length / 3);
  let rest = Buffer.alloc(0);
  const frames = [];
  for (const piece of [combined.subarray(0, mid), combined.subarray(mid)]) {
    const split = splitFrames(Buffer.concat([rest, piece]));
    frames.push(...split.frames);
    rest = split.rest;
  }
  assert.equal(frames.length, 2);
  assert.equal(frames[0].result.a, 1);
  assert.equal(frames[1].result.b, 2);
  assert.equal(rest.toString("utf8").includes('"ok":false'), true);
});

test("control capability is required and unknown ops fail", async (t) => {
  const { rpc, worker, sessionId, root } = await start(t);
  const denied = await rpc({ capability: "nope", op: "status" });
  assert.equal(denied.ok, false);
  const unknown = await rpc({ capability: worker.controlCapability, op: "shutdown-please" });
  assert.equal(unknown.ok, false);
  const ping = await rpc({ capability: worker.controlCapability, op: "ping" });
  assert.equal(ping.ok, true);
  assert.equal(ping.result.pid, process.pid);
  assert.equal(ping.result.protocolVersion, 2);
  assert.equal(ping.result.sessionId, sessionId);
  assert.equal(ping.result.projectRoot, root);
  assert.equal(typeof ping.result.workerGeneration, "number");
  assert.equal(typeof ping.result.settingsRevision, "number");
  assert.equal(typeof ping.result.configPath, "string");
});


test("Stop and SessionStart print nothing and never wake", async (t) => {
  const { rpc, worker } = await start(t);
  await rpc({ capability: worker.controlCapability, op: "on" });
  const stop = await rpc({
    capability: worker.controlCapability,
    op: "hook",
    payload: {
      hook_event_name: "Stop",
      last_assistant_message: "done",
      prompt_id: "s1"
    }
  });
  assert.equal(stop.result.stdout, "");
  const startHook = await rpc({
    capability: worker.controlCapability,
    op: "hook",
    payload: { hook_event_name: "SessionStart", source: "resume" }
  });
  assert.equal(startHook.result.stdout, "");
  const compact = await rpc({
    capability: worker.controlCapability,
    op: "hook",
    payload: { hook_event_name: "PostCompact", compact_summary: "sum" }
  });
  assert.equal(compact.result.stdout, "");
  assert.equal(worker._state().enabled, false);
});

test("runControl hook is fail-open on parse and ipc errors", async () => {
  const out = collectWriter();
  const parsed = await runControl({
    argv: ["hook"],
    stdin: Readable.from(["{not-json"]),
    stdout: out.stdout,
    env: {
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_PROJECT_DIR: "/tmp",
      CLAUDE_PLUGIN_DATA: "/tmp"
    },
    request: async () => {
      throw new Error("should not be called");
    },
    spawnImpl: () => {
      throw new Error("should not spawn");
    }
  });
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.stdout, "");
  assert.equal(out.text, "");

  const missing = collectWriter();
  const dead = await runControl({
    argv: ["hook"],
    stdin: Readable.from([
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "hi",
        session_id: "dead-sess"
      })
    ]),
    stdout: missing.stdout,
    env: {
      CLAUDE_CODE_SESSION_ID: "dead-sess",
      CLAUDE_PROJECT_DIR: os.tmpdir(),
      CLAUDE_PLUGIN_DATA: os.tmpdir()
    },
    request: async () => {
      throw new Error("ipc timeout");
    },
    spawnImpl: () => ({ unref() {} })
  });
  assert.equal(dead.exitCode, 0);
  assert.equal(dead.stdout, "");
});

test("skill --plugin-data wins over another plugin's exported CLAUDE_PLUGIN_DATA", async (t) => {
  // The Bash tool does not export this plugin's data directory, and the Codex
  // plugin's SessionStart exports its own through CLAUDE_ENV_FILE. Trusting
  // that value enabled a session the hooks never read.
  const { worker, data, root, sessionId } = await start(t);
  const decoy = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-ipc-decoy-")));
  t.after(() => fs.rm(decoy, { recursive: true, force: true }));
  const out = collectWriter();
  await runControl({
    argv: ["on", "--plugin-data", data],
    stdout: out.stdout,
    env: {
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_PROJECT_DIR: root,
      CLAUDE_PLUGIN_DATA: decoy
    },
    spawnImpl: () => {
      throw new Error("the live worker must be reused");
    }
  });
  assert.equal(JSON.parse(out.text).enabled, true);
  assert.equal(worker._state().enabled, true);
  await assert.rejects(fs.access(path.join(decoy, "sessions")));
});

test("--plugin-data must be a substituted absolute path and never applies to hooks", async () => {
  const env = { CLAUDE_CODE_SESSION_ID: "s", CLAUDE_PLUGIN_DATA: os.tmpdir() };
  const noSpawn = () => {
    throw new Error("should not spawn");
  };
  for (const value of ["${CLAUDE_PLUGIN_DATA}", "relative/data", ""]) {
    await assert.rejects(
      runControl({ argv: ["status", "--plugin-data", value], env, spawnImpl: noSpawn }),
      /Invalid --plugin-data/
    );
  }
  await assert.rejects(
    runControl({ argv: ["hook", "--plugin-data", os.tmpdir()], env, spawnImpl: noSpawn }),
    { code: "usage" }
  );
});

test("control stdout for on/status/doctor is JSON without secrets", async (t) => {
  const { worker, data, root, sessionId } = await start(t);
  const out = collectWriter();
  await runControl({
    argv: ["on"],
    stdout: out.stdout,
    env: {
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_PROJECT_DIR: root,
      CLAUDE_PLUGIN_DATA: data,
      OPENAI_API_KEY: "sk-test-secret-value"
    },
    request: (socketPath, req, opts) => requestIpc(socketPath, req, opts),
    spawnImpl: () => ({ unref() {} }),
    workerPath: "unused"
  }).catch(async () => {
    const direct = collectWriter();
    const response = await requestIpc(
      worker.socketPath,
      { capability: worker.controlCapability, op: "on" },
      { timeoutMs: 2000 }
    );
    direct.stdout.write(`${JSON.stringify(response.result)}\n`);
    return response;
  });
  const status = await requestIpc(
    worker.socketPath,
    { capability: worker.controlCapability, op: "on" },
    { timeoutMs: 2000 }
  );
  const body = JSON.stringify(status.result);
  assert.equal(body.includes("sk-test-secret-value"), false);
  assert.equal(status.result.enabled, true);
  const doctor = await requestIpc(
    worker.socketPath,
    { capability: worker.controlCapability, op: "doctor" },
    { timeoutMs: 2000 }
  );
  assert.equal(JSON.stringify(doctor.result).includes("sk-test-secret-value"), false);
  assert.equal(doctor.result.ipc.ok, true);
});

test("doctor reports a healthy bundle from dist/modules without plugin root env", async (t) => {
  const { worker, rpc } = await start(t);
  const doctor = await rpc({ capability: worker.controlCapability, op: "doctor" });
  assert.equal(doctor.result.ok, true);
  assert.equal(doctor.result.bundle.ok, true);
  assert.deepEqual(doctor.result.bundle.missing, []);
  assert.equal(doctor.result.config.ok, true);
  assert.equal(doctor.result.root.ok, true);
  assert.equal(doctor.result.ipc.ok, true);
});

test("doctor honors CLAUDE_PLUGIN_ROOT and reports a missing required entry", async (t) => {
  const complete = await pluginRootFixture(t, REQUIRED_BUNDLE);
  const { worker: healthyWorker, rpc: healthyRpc } = await start(t, {
    env: { CLAUDE_PLUGIN_ROOT: complete }
  });
  const healthy = await healthyRpc({ capability: healthyWorker.controlCapability, op: "doctor" });
  assert.equal(healthy.result.ok, true);
  assert.equal(healthy.result.bundle.ok, true);
  assert.deepEqual(healthy.result.bundle.missing, []);

  const incomplete = await pluginRootFixture(
    t,
    REQUIRED_BUNDLE.filter((name) => name !== "setup-control.mjs")
  );
  const { worker, rpc } = await start(t, {
    env: { CLAUDE_PLUGIN_ROOT: incomplete }
  });
  const doctor = await rpc({ capability: worker.controlCapability, op: "doctor" });
  assert.equal(doctor.result.bundle.ok, false);
  assert.deepEqual(doctor.result.bundle.missing, ["setup-control.mjs"]);
  assert.equal(doctor.result.ok, false);
  assert.equal(doctor.result.config.ok, true);
  assert.equal(doctor.result.root.ok, true);
});

test("unauthorized capability cannot call control; secrets stay out of error frames", async (t) => {
  const { rpc } = await start(t);
  await rpc({ capability: "nope", op: "on" });
  const off = await rpc({ capability: "nope", op: "off" });
  assert.equal(off.ok, false);
  assert.equal(JSON.stringify(off).includes("sk-test-secret-value"), false);
});

test("chunked socket writes still decode a full request", async (t) => {
  const { worker } = await start(t);
  const frame = encodeFrame({ capability: worker.controlCapability, op: "ping" });
  const result = await new Promise((resolve, reject) => {
    const socket = net.createConnection(worker.socketPath);
    let buf = Buffer.alloc(0);
    socket.on("connect", () => {
      const bytes = Buffer.from(frame);
      socket.write(bytes.subarray(0, 8));
      setTimeout(() => socket.write(bytes.subarray(8)), 5);
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const split = splitFrames(buf);
      if (split.frames[0]) {
        socket.end();
        resolve(split.frames[0]);
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("chunk timeout")), 1000);
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.pid, process.pid);
});

test("spawned worker env omits ambient headers and keeps configured key", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-probe-root-"));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "cma-probe-data-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(data, { recursive: true, force: true });
  });
  const sessionId = "probe-sess";
  await fs.mkdir(path.join(data, "sessions", sessionId), { recursive: true });
  await fs.writeFile(
    path.join(data, "sessions", sessionId, "state.json"),
    `${JSON.stringify({
      activation: {
        providers: {
          "openai-api": { kind: "api", provider: "openai", apiKeyEnv: "OPENAI_API_KEY" },
          "named-override": { kind: "api", provider: "kimi-coding", apiKeyEnv: "KIMI_CODE_OAUTH_HOST" }
        }
      }
    })}\n`
  );
  const identity = { sessionId, projectRoot: root, pluginData: data };
  const ambient = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: "/tmp/cma-config-dir",
    CODEX_HOME: "/tmp/codex-home",
    OPENAI_API_KEY: "sk-configured",
    OPENAI_CUSTOM_HEADERS: "Authorization: Bearer ambient-other-service-token",
    OPENAI_LOG: "debug",
    OPENAI_ORG_ID: "org-ambient",
    GOOGLE_GENAI_USE_VERTEXAI: "true",
    KIMI_CODE_OAUTH_HOST: "https://untrusted.invalid",
    KIMI_OAUTH_HOST: "https://untrusted.invalid",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json"
  };
  const filtered = workerChildEnv(identity, ambient);
  assert.equal(filtered.HOME, process.env.HOME);
  assert.equal(filtered.CLAUDE_CONFIG_DIR, "/tmp/cma-config-dir");
  assert.equal(filtered.CODEX_HOME, undefined);
  assert.equal(filtered.OPENAI_CUSTOM_HEADERS, undefined);
  assert.equal(filtered.OPENAI_LOG, undefined);
  assert.equal(filtered.GOOGLE_GENAI_USE_VERTEXAI, undefined);
  assert.equal(filtered.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(filtered.KIMI_CODE_OAUTH_HOST, undefined);
  assert.equal(filtered.KIMI_OAUTH_HOST, undefined);
  assert.equal(filtered.OPENAI_API_KEY, "sk-configured");

  const probe = path.join(data, "probe.mjs");
  await fs.writeFile(
    probe,
    `import fs from "node:fs";
import path from "node:path";
const dataDir = process.argv[process.argv.indexOf("--data") + 1];
fs.writeFileSync(path.join(dataDir, "probe-env.json"), JSON.stringify(process.env));
`
  );
  spawnWorkerProcess(identity, { env: { ...process.env, ...ambient }, workerPath: probe });
  const out = path.join(data, "probe-env.json");
  const deadline = Date.now() + 2000;
  let spawned;
  while (Date.now() < deadline) {
    try {
      spawned = JSON.parse(await fs.readFile(out, "utf8"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(spawned);
  assert.equal(spawned.HOME, process.env.HOME);
  assert.equal(spawned.CLAUDE_CONFIG_DIR, "/tmp/cma-config-dir");
  assert.equal(spawned.CODEX_HOME, undefined);
  assert.equal(spawned.OPENAI_CUSTOM_HEADERS, undefined);
  assert.equal(spawned.OPENAI_LOG, undefined);
  assert.equal(spawned.GOOGLE_GENAI_USE_VERTEXAI, undefined);
  assert.equal(spawned.KIMI_CODE_OAUTH_HOST, undefined);
  assert.equal(spawned.KIMI_OAUTH_HOST, undefined);
  assert.equal(spawned.OPENAI_API_KEY, "sk-configured");
});

test("command identity failures are visible while hook failures stay silent", () => {
  const helper = path.join(repo, "plugins/cross-model-advisor/dist/control.mjs");
  const env = { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: "diagnostic-session" };
  const doctor = spawnSync(process.execPath, [helper, "doctor"], {
    env, encoding: "utf8", timeout: 5000
  });
  assert.equal(doctor.status, 1);
  assert.equal(doctor.stdout, "");
  assert.match(doctor.stderr, /identity:.*CLAUDE_PLUGIN_DATA/);
  const hook = spawnSync(process.execPath, [helper, "hook"], {
    env, input: "{}", encoding: "utf8", timeout: 5000
  });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, "");
  assert.equal(hook.stderr, "");
});

test("command diagnostics never echo sensitive filesystem error paths", () => {
  const secret = "PRIVATE_VALUE_MUST_NOT_APPEAR";
  const result = spawnSync(process.execPath, [
    path.join(repo, "plugins/cross-model-advisor/dist/control.mjs"), "doctor"
  ], {
    env: {
      PATH: process.env.PATH,
      CLAUDE_CODE_SESSION_ID: "private-diagnostic",
      CLAUDE_PLUGIN_DATA: `/dev/null/${secret}`
    },
    encoding: "utf8",
    timeout: 5000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cross-model-advisor: control:/);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes(secret), false);
});

test("settings reports protocol 2 identity after on", async (t) => {
  const { rpc, worker, sessionId, root } = await start(t);
  await rpc({ capability: worker.controlCapability, op: "on" });
  const settings = await rpc({
    capability: worker.controlCapability,
    op: "settings",
    protocolVersion: 2
  });
  assert.equal(settings.ok, true);
  assert.equal(settings.result.ok, true);
  assert.equal(settings.result.protocolVersion, 2);
  assert.equal(settings.result.sessionId, sessionId);
  assert.equal(await fs.realpath(settings.result.projectRoot), await fs.realpath(root));
  assert.equal(typeof settings.result.workerGeneration, "number");
  assert.equal(typeof settings.result.settingsRevision, "number");
  assert.equal(typeof settings.result.enabled, "boolean");
  assert.ok(Array.isArray(settings.result.advisors));
});

test("settings and apply reject old protocol versions", async (t) => {
  const { rpc, worker } = await start(t);
  await rpc({ capability: worker.controlCapability, op: "on" });
  const settings = await rpc({ capability: worker.controlCapability, op: "settings" });
  assert.equal(settings.result?.ok, false);
  assert.equal(settings.result?.code, "protocol");
  const ping = await rpc({ capability: worker.controlCapability, op: "ping" });
  const apply = await rpc({
    capability: worker.controlCapability,
    op: "apply",
    protocolVersion: 1,
    workerGeneration: ping.result.workerGeneration,
    settingsRevision: ping.result.settingsRevision,
    configRevision: "0".repeat(64)
  });
  assert.equal(apply.result?.ok, false);
  assert.equal(apply.result?.code, "protocol");
});

test("runControl does not ack until stdout write callback completes", async (t) => {
  const { worker, sessionId, root, data, rpc, env } = await start(t, {
    reviewApi: async (args) => {
      await args.tools.call("advise", {
        severity: "concern",
        note: "hold-the-envelope",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "x" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc({ capability: worker.controlCapability, op: "on" });
  await rpc({
    capability: worker.controlCapability,
    op: "hook",
    payload: {
      hook_event_name: "UserPromptSubmit",
      prompt: "hold stdout",
      prompt_id: "hold-1"
    }
  });
  await waitUntil(async () => {
    const status = await rpc({ capability: worker.controlCapability, op: "status" });
    return status.result.inbox.some((item) => item.status === "pending");
  });

  let writePending = false;
  let writeSink = null;
  let writeReleased = false;
  let writeStarted;
  const started = new Promise((resolve) => {
    writeStarted = resolve;
  });
  const releaseWrite = () => {
    if (writeReleased) return;
    writeReleased = true;
    writePending = false;
    const cb = writeSink;
    writeSink = null;
    if (cb) cb();
  };
  const stdout = new Writable({
    write(_chunk, _enc, cb) {
      writePending = true;
      writeSink = cb;
      writeStarted();
    }
  });
  t.after(releaseWrite);

  let ackDuringHold = false;
  let ackCount = 0;
  const running = runControl({
    argv: ["hook"],
    stdin: Readable.from([
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        cwd: root,
        prompt_id: "hold-1",
        tool_name: "Read",
        tool_use_id: "toolu_hold"
      })
    ]),
    stdout,
    env,
    request: async (socketPath, req, opts) => {
      if (req.op === "ack") {
        ackCount += 1;
        if (writePending) ackDuringHold = true;
      }
      return requestIpc(socketPath, req, opts);
    },
    spawnImpl: () => {
      throw new Error("runControl must not spawn while the worker is live");
    }
  });

  await started;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ackDuringHold, false);
  assert.equal(ackCount, 0);
  releaseWrite();
  const result = await running;
  assert.equal(ackDuringHold, false);
  assert.ok(ackCount >= 1);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hold-the-envelope/);
});
