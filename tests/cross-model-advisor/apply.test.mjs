/**
 * Save vs Apply targeting, live-only session helpers, and the publication
 * barrier. Imports bundled dist modules. No real providers or credentials.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distModules = path.join(repo, "plugins", "cross-model-advisor", "dist", "modules");
const load = (rel) => import(pathToFileURL(path.join(distModules, rel)).href);

const { startWorker } = await load("worker.mjs");
const { applySessionSettings, getSessionSettings } = await load("control.mjs");
const { requestIpc } = await load("session/ipc.mjs");
const { readLocator, sessionDir, statePath } = await load("session/paths.mjs");
const { saveState: persistState } = await load("session/state.mjs");

function protocolClient(pid = process.pid) {
  return { pid, id: randomUUID(), protocolVersion: 2 };
}

function limits() {
  return {
    maxConcurrentAdvisors: 2,
    reviewTimeoutSeconds: 2,
    maxToolCallsPerReview: 8,
    maxOutputTokens: 1500,
    maxReviewsPerAdvisorPerSession: 40
  };
}

function advisor(partial = {}) {
  return {
    name: "correctness",
    provider: "openai-api",
    model: "gpt-old",
    instructions: "Look for observable correctness failures.",
    enabled: true,
    reasoningEffort: "default",
    ...partial
  };
}

function configV2(overrides = {}) {
  return {
    version: 2,
    providers: {
      "openai-api": { kind: "api", provider: "openai", apiKeyEnv: "OPENAI_API_KEY" }
    },
    advisors: [advisor()],
    exclude: [],
    limits: limits(),
    ...overrides
  };
}

function makeTools() {
  let staged = null;
  return {
    async call(name, args) {
      if (name === "advise") {
        staged = {
          severity: args.severity,
          note: args.note,
          evidence: args.evidence ?? []
        };
        return { staged: true };
      }
      return { ok: true };
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

function hook(event, extra = {}) {
  return {
    hook_event_name: event,
    session_id: extra.session_id,
    cwd: extra.cwd,
    prompt: extra.prompt,
    prompt_id: extra.prompt_id,
    tool_name: extra.tool_name,
    tool_input: extra.tool_input,
    tool_use_id: extra.tool_use_id,
    tool_response: extra.tool_response
  };
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

async function fileRevision(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function writeConfig(file, config) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return fileRevision(file);
}

function failureCode(res) {
  if (!res || typeof res !== "object") return null;
  if (res.ok === false) return res.error ?? res.code ?? null;
  const body = res.result;
  if (body && body.ok === false) return body.code ?? body.error ?? null;
  return null;
}

function applyOk(res) {
  return Boolean(res) && res.ok === true && res.result?.ok !== false;
}

function spawnIssuer(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });
  assert.ok(child.pid);
  return child;
}

async function waitDead(pid, ms = 2000) {
  await waitUntil(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, ms);
}

function sessionEnv(world, extra = {}) {
  return {
    OPENAI_API_KEY: "sk-test-secret-value",
    CLAUDE_PLUGIN_DATA: world.data,
    CLAUDE_PROJECT_DIR: world.root,
    CLAUDE_CODE_SESSION_ID: extra.sessionId ?? world.sessionId,
    CLAUDE_CONFIG_DIR: world.configDir,
    ...extra.env
  };
}

async function makeWorld(t, extra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-apply-root-")));
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-apply-data-")));
  const configDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-apply-cfg-")));
  const configFile = path.join(configDir, "cross-model-advisor.json");
  const sessionId = extra.sessionId ?? `apply-${randomUUID().slice(0, 8)}`;
  const config = extra.config ?? configV2();
  await writeConfig(configFile, config);
  const world = {
    root,
    data,
    configDir,
    configFile,
    sessionId,
    worker: null,
    issuer: extra.issuer ?? null
  };
  t.after(async () => {
    if (world.worker) {
      await world.worker.stop({ reason: "test" }).catch(() => {});
      world.worker = null;
    }
    if (world.issuer) {
      try {
        world.issuer.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(data, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });
  return world;
}

function validateFromEnv() {
  return async ({ provider, env }) => {
    if (provider?.kind === "api" && provider.apiKeyEnv && !env?.[provider.apiKeyEnv]) {
      return { available: false, error: { code: "config", message: "missing api key env" } };
    }
    return { available: true };
  };
}

async function bootWorker(world, extra = {}) {
  if (world.worker) {
    await world.worker.stop({ reason: "replace" });
    world.worker = null;
  }
  const env = sessionEnv(world, extra);
  const worker = await startWorker({
    sessionId: extra.sessionId ?? world.sessionId,
    projectRoot: extra.projectRoot ?? world.root,
    pluginData: world.data,
    env,
    exitOnIdle: false,
    idleMs: Number.POSITIVE_INFINITY,
    debounceMs: extra.debounceMs ?? 0,
    claimLeaseMs: extra.claimLeaseMs ?? 80,
    loadConfig:
      extra.loadConfig ??
      (async () => JSON.parse(await fs.readFile(world.configFile, "utf8"))),
    configFilePath: extra.configFilePath ?? (() => world.configFile),
    readConfigState:
      extra.readConfigState ??
      (async () => {
        const file =
          typeof extra.configFilePath === "function" ? extra.configFilePath() : world.configFile;
        const raw = await fs.readFile(file);
        let config = null;
        let configError = null;
        try {
          config = JSON.parse(raw.toString("utf8"));
        } catch (error) {
          configError = error instanceof Error ? error.message : "invalid config";
        }
        return {
          path: file,
          revision: createHash("sha256").update(raw).digest("hex"),
          config,
          configError
        };
      }),
    snapshotRoot:
      extra.snapshotRoot ??
      (async () => {
        const listing = await fs.lstat(extra.projectRoot ?? world.root);
        return { path: extra.projectRoot ?? world.root, dev: listing.dev, ino: listing.ino };
      }),
    validateRoot: extra.validateRoot ?? (async () => extra.projectRoot ?? world.root),
    runtimeErrors: extra.runtimeErrors ?? (() => []),
    createReviewTools: extra.createReviewTools ?? (async () => makeTools()),
    validateApi: extra.validateApi ?? validateFromEnv(),
    reviewApi:
      extra.reviewApi ??
      (async () => ({ usage: { costUsd: "unknown" }, history: [] })),
    advisorSystemPrompt: extra.advisorSystemPrompt ?? "inspect independently",
    ...(typeof extra.saveState === "function" ? { saveState: extra.saveState } : {})
  });
  world.worker = worker;
  const rpc = (op, more = {}, timeoutMs = 2500) =>
    requestIpc(
      worker.socketPath,
      {
        capability: worker.controlCapability,
        op,
        ...more,
        ...(op === "hook" && more.client === undefined ? { client: protocolClient() } : {})
      },
      { timeoutMs }
    );
  return { worker, rpc, env };
}

function targetFrom(settings) {
  return {
    protocolVersion: settings.protocolVersion,
    sessionId: settings.sessionId,
    workerGeneration: settings.workerGeneration,
    settingsRevision: settings.settingsRevision,
    projectRoot: settings.projectRoot,
    configPath: settings.configPath
  };
}

async function ipcApply(rpc, world, extra = {}) {
  const ping = (await rpc("ping")).result;
  return rpc("apply", {
    protocolVersion: 2,
    workerGeneration: extra.workerGeneration ?? ping.workerGeneration,
    settingsRevision: extra.settingsRevision ?? ping.settingsRevision,
    configRevision: extra.configRevision ?? (await fileRevision(world.configFile)),
    ...(extra.enable !== undefined ? { enable: extra.enable } : {}),
    ...extra.fields
  });
}

async function liveSettings(env) {
  return getSessionSettings({ env, request: requestIpc });
}

async function liveApply(env, settings, configRevision, extra = {}) {
  return applySessionSettings({
    env,
    target: extra.target ?? targetFrom(settings),
    configRevision,
    ...(extra.enable !== undefined ? { enable: extra.enable } : {}),
    request: extra.request ?? requestIpc,
    ...(extra.spawnImpl ? { spawnImpl: extra.spawnImpl } : {})
  });
}

function advisorNamed(status, name) {
  return (status.advisors ?? []).find((item) => item.name === name);
}

test("save-only leaves the live snapshot on the previous model", async (t) => {
  const world = await makeWorld(t, { config: configV2() });
  const { rpc, env } = await bootWorker(world);
  await rpc("on");
  const before = (await rpc("status")).result;
  assert.equal(advisorNamed(before, "correctness").model, "gpt-old");

  const next = configV2({
    advisors: [advisor({ model: "gpt-new", reasoningEffort: "high" })]
  });
  await writeConfig(world.configFile, next);

  const status = (await rpc("status")).result;
  assert.equal(status.enabled, before.enabled);
  assert.equal(advisorNamed(status, "correctness").model, "gpt-old");
  const settings = await liveSettings(env);
  assert.equal(settings.ok, true);
  assert.equal(settings.protocolVersion, 2);
  assert.equal(advisorNamed(settings, "correctness").model, "gpt-old");
});

test("exact revision apply updates one of two live sessions", async (t) => {
  const shared = configV2();
  const worldA = await makeWorld(t, { sessionId: "apply-sess-a", config: shared });
  const worldB = await makeWorld(t, { sessionId: "apply-sess-b", config: shared });
  const a = await bootWorker(worldA);
  const b = await bootWorker(worldB, {
    sessionId: "apply-sess-b",
    env: { CLAUDE_CONFIG_DIR: worldA.configDir },
    loadConfig: async () => JSON.parse(await fs.readFile(worldA.configFile, "utf8")),
    configFilePath: () => worldA.configFile
  });
  await a.rpc("on");
  await b.rpc("on");

  const next = configV2({
    advisors: [advisor({ model: "gpt-new" })]
  });
  const revision = await writeConfig(worldA.configFile, next);

  const settingsA = await liveSettings(a.env);
  const applied = await liveApply(a.env, settingsA, revision);
  assert.equal(applied.ok, true);
  assert.equal(applied.protocolVersion, 2);
  assert.equal(advisorNamed(applied, "correctness").model, "gpt-new");

  const statusA = (await a.rpc("status")).result;
  const statusB = (await b.rpc("status")).result;
  assert.equal(advisorNamed(statusA, "correctness").model, "gpt-new");
  assert.equal(advisorNamed(statusB, "correctness").model, "gpt-old");
});

test("apply preserves on and off unless enable is set", async (t) => {
  const world = await makeWorld(t);
  const { rpc, env } = await bootWorker(world);
  await rpc("on");
  assert.equal((await rpc("status")).result.enabled, true);

  const next = configV2({
    advisors: [advisor({ model: "gpt-on" })]
  });
  let revision = await writeConfig(world.configFile, next);
  let settings = await liveSettings(env);
  const whileOn = await liveApply(env, settings, revision);
  assert.equal(whileOn.ok, true);
  assert.equal(whileOn.enabled, true);
  assert.equal((await rpc("status")).result.enabled, true);

  await rpc("off");
  assert.equal((await rpc("status")).result.enabled, false);

  const offModel = configV2({
    advisors: [advisor({ model: "gpt-off" })]
  });
  revision = await writeConfig(world.configFile, offModel);
  settings = await liveSettings(env);
  const whileOff = await liveApply(env, settings, revision);
  assert.equal(whileOff.ok, true);
  assert.equal(whileOff.enabled, false);
  assert.equal((await rpc("status")).result.enabled, false);

  settings = await liveSettings(env);
  const enabled = await liveApply(env, settings, revision, { enable: true });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.enabled, true);
  assert.equal((await rpc("status")).result.enabled, true);
});

test("new API env name is a static apply failure and leaves the snapshot", async (t) => {
  const world = await makeWorld(t);
  const { rpc, env } = await bootWorker(world);
  await rpc("on");
  const before = advisorNamed((await rpc("status")).result, "correctness").model;

  const next = configV2({
    providers: {
      "openai-api": { kind: "api", provider: "openai", apiKeyEnv: "BRAND_NEW_KEY" }
    },
    advisors: [advisor({ model: "gpt-new-env" })]
  });
  const revision = await writeConfig(world.configFile, next);
  const settings = await liveSettings(env);
  const applied = await liveApply(env, settings, revision);
  assert.equal(applied.ok, false);
  assert.equal(applied.error, "unavailable");
  assert.equal(advisorNamed((await rpc("status")).result, "correctness").model, before);
});

test("wrong config revision, frozen root, and config dir fail without retargeting", async (t) => {
  const world = await makeWorld(t);
  const { rpc, env } = await bootWorker(world);
  await rpc("on");
  const settings = await liveSettings(env);
  assert.equal(settings.ok, true);

  const next = configV2({ advisors: [advisor({ model: "gpt-new" })] });
  const revision = await writeConfig(world.configFile, next);

  const staleRev = await liveApply(env, settings, "0".repeat(64));
  assert.equal(staleRev.ok, false);
  assert.equal(staleRev.error, "config");
  assert.equal(advisorNamed((await rpc("status")).result, "correctness").model, "gpt-old");

  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cma-other-root-"));
  t.after(() => fs.rm(otherRoot, { recursive: true, force: true }));
  const rootFail = await liveApply(env, settings, revision, {
    target: { ...targetFrom(settings), projectRoot: otherRoot }
  });
  assert.equal(rootFail.ok, false);
  assert.equal(rootFail.error, "root");
  assert.equal(advisorNamed((await rpc("status")).result, "correctness").model, "gpt-old");

  const otherCfg = await fs.mkdtemp(path.join(os.tmpdir(), "cma-other-cfg-"));
  t.after(() => fs.rm(otherCfg, { recursive: true, force: true }));
  const cfgFail = await liveApply(
    { ...env, CLAUDE_CONFIG_DIR: otherCfg },
    settings,
    revision
  );
  assert.equal(cfgFail.ok, false);
  assert.equal(cfgFail.error, "config");
  assert.equal(advisorNamed((await rpc("status")).result, "correctness").model, "gpt-old");

  const staleGen = await ipcApply(rpc, world, {
    workerGeneration: (settings.workerGeneration ?? 1) + 99,
    configRevision: revision
  });
  assert.equal(applyOk(staleGen), false);
  assert.equal(failureCode(staleGen), "stale");
});

test("live-only helpers do not resurrect a missing worker", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-nolive-root-"));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "cma-nolive-data-"));
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "cma-nolive-cfg-"));
  t.after(async () => {
    const locator = await readLocator(data, "ghost-sess").catch(() => null);
    const pid = Number(locator?.pid);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(data, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });
  const configFile = path.join(configDir, "cross-model-advisor.json");
  const revision = await writeConfig(configFile, configV2());
  const env = {
    OPENAI_API_KEY: "sk-test-secret-value",
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PROJECT_DIR: root,
    CLAUDE_CODE_SESSION_ID: "ghost-sess",
    CLAUDE_CONFIG_DIR: configDir
  };
  const spawnImpl = () => {
    throw new Error("must not spawn");
  };
  const settings = await getSessionSettings({ env, request: requestIpc, spawnImpl });
  assert.equal(settings.ok, false);
  assert.equal(settings.error, "no-live");

  const applied = await applySessionSettings({
    env,
    target: {
      protocolVersion: 2,
      sessionId: "ghost-sess",
      workerGeneration: 1,
      settingsRevision: 0,
      projectRoot: root,
      configPath: configFile
    },
    configRevision: revision,
    request: requestIpc,
    spawnImpl
  });
  assert.equal(applied.ok, false);
  assert.equal(applied.error, "no-live");
  const locator = await readLocator(data, "ghost-sess").catch(() => null);
  let resurrected = false;
  const pid = Number(locator?.pid);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0);
      resurrected = true;
    } catch {
      resurrected = false;
    }
  }
  assert.equal(resurrected, false);
});

test("issued envelope blocks apply beyond lease until exact ack or death", async (t) => {
  const world = await makeWorld(t);
  const issuer = spawnIssuer(t);
  world.issuer = issuer;
  const { rpc, env } = await bootWorker(world, {
    claimLeaseMs: 40,
    reviewApi: async (args) => {
      await args.tools.call("advise", {
        severity: "concern",
        note: "old-epoch envelope",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "held" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "work", prompt_id: "hold-1" })
  });
  const client = protocolClient(issuer.pid);
  const drain = await waitUntil(async () => {
    const res = await rpc("hook", {
      client,
      payload: hook("PreToolUse", {
        prompt_id: "hold-1",
        tool_name: "Read",
        tool_use_id: "toolu_hold"
      })
    });
    return res.result?.claimId ? res : null;
  });
  assert.match(drain.result.stdout, /old-epoch envelope/);

  await new Promise((resolve) => setTimeout(resolve, 160));

  const next = configV2({ advisors: [advisor({ model: "gpt-new" })] });
  const revision = await writeConfig(world.configFile, next);
  let settings = await liveSettings(env);
  const busyLease = await liveApply(env, settings, revision);
  assert.equal(busyLease.ok, false);
  assert.equal(busyLease.error, "busy");
  assert.equal(advisorNamed((await rpc("status")).result, "correctness").model, "gpt-old");

  const wrong = await rpc("ack", {
    claimId: drain.result.claimId,
    client: protocolClient(process.pid)
  });
  assert.equal(wrong.result?.ok, false);
  assert.equal(wrong.result?.error, "protocol");
  settings = await liveSettings(env);
  const stillBusy = await liveApply(env, settings, revision);
  assert.equal(stillBusy.ok, false);
  assert.equal(stillBusy.error, "busy");

  issuer.kill("SIGKILL");
  await waitDead(issuer.pid);
  world.issuer = null;

  settings = await liveSettings(env);
  const afterDeath = await liveApply(env, settings, revision);
  assert.equal(afterDeath.ok, true);
  assert.equal(advisorNamed((await rpc("status")).result, "correctness").model, "gpt-new");
});

test("persisted unresolved issuer survives worker restart", async (t) => {
  const world = await makeWorld(t);
  const issuer = spawnIssuer(t);
  world.issuer = issuer;
  const reviewApi = async (args) => {
    await args.tools.call("advise", {
      severity: "nit",
      note: "restart-held envelope",
      evidence: [{ kind: "observation", eventId: "obs_1", detail: "held" }]
    });
    return { usage: { costUsd: "unknown" }, history: [] };
  };
  let { rpc, env } = await bootWorker(world, { claimLeaseMs: 40, reviewApi });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "persist", prompt_id: "p-iss" })
  });
  const client = protocolClient(issuer.pid);
  const drain = await waitUntil(async () => {
    const res = await rpc("hook", {
      client,
      payload: hook("PreToolUse", {
        prompt_id: "p-iss",
        tool_name: "Read",
        tool_use_id: "toolu_iss"
      })
    });
    return res.result?.claimId ? res : null;
  });
  assert.ok(drain.result.claimId);

  const booted = await bootWorker(world, { claimLeaseMs: 40, reviewApi });
  rpc = booted.rpc;
  env = booted.env;

  const next = configV2({ advisors: [advisor({ model: "gpt-restart" })] });
  const revision = await writeConfig(world.configFile, next);
  let settings = await liveSettings(env);
  const busy = await liveApply(env, settings, revision);
  assert.equal(busy.ok, false);
  assert.equal(busy.error, "busy");
  assert.notEqual(advisorNamed((await rpc("status")).result, "correctness").model, "gpt-restart");

  issuer.kill("SIGKILL");
  await waitDead(issuer.pid);
  world.issuer = null;
  settings = await liveSettings(env);
  const cleared = await liveApply(env, settings, revision);
  assert.equal(cleared.ok, true);
  assert.equal(advisorNamed((await rpc("status")).result, "correctness").model, "gpt-restart");
});

test("exact-client ack after a held claim allows apply", async (t) => {
  const world = await makeWorld(t);
  const { rpc, env } = await bootWorker(world, {
    reviewApi: async (args) => {
      await args.tools.call("advise", {
        severity: "concern",
        note: "ack-then-apply",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "x" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "ack", prompt_id: "p-ack" })
  });
  const client = protocolClient();
  const drain = await waitUntil(async () => {
    const res = await rpc("hook", {
      client,
      payload: hook("PreToolUse", {
        prompt_id: "p-ack",
        tool_name: "Read",
        tool_use_id: "toolu_ack"
      })
    });
    return res.result?.claimId ? res : null;
  });
  const next = configV2({ advisors: [advisor({ model: "gpt-acked" })] });
  const revision = await writeConfig(world.configFile, next);
  let settings = await liveSettings(env);
  const busy = await liveApply(env, settings, revision);
  assert.equal(busy.ok, false);
  assert.equal(busy.error, "busy");

  const ack = await rpc("ack", { claimId: drain.result.claimId, client });
  assert.equal(ack.ok, true);
  settings = await liveSettings(env);
  const applied = await liveApply(env, settings, revision);
  assert.equal(applied.ok, true);
  assert.equal(advisorNamed((await rpc("status")).result, "correctness").model, "gpt-acked");
  const emitted = (await rpc("status")).result.inbox.find((item) => item.status === "emitted");
  assert.ok(emitted);
});

test("legacy hook without client metadata cannot apply", async (t) => {
  const world = await makeWorld(t);
  const { rpc, env, worker } = await bootWorker(world, {
    claimLeaseMs: 40,
    reviewApi: async (args) => {
      await args.tools.call("advise", {
        severity: "concern",
        note: "legacy-claim",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "x" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "legacy", prompt_id: "p-leg" })
  });
  const drain = await waitUntil(async () => {
    const res = await requestIpc(
      worker.socketPath,
      {
        capability: worker.controlCapability,
        op: "hook",
        payload: hook("PreToolUse", {
          prompt_id: "p-leg",
          tool_name: "Read",
          tool_use_id: "toolu_leg"
        })
      },
      { timeoutMs: 2500 }
    );
    return res.result?.claimId ? res : null;
  });
  assert.ok(drain.result.claimId);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const next = configV2({ advisors: [advisor({ model: "gpt-legacy" })] });
  const revision = await writeConfig(world.configFile, next);
  const settings = await liveSettings(env);
  const applied = await liveApply(env, settings, revision);
  assert.equal(applied.ok, false);
  assert.equal(applied.error, "protocol");
  assert.equal(advisorNamed((await rpc("status")).result, "correctness").model, "gpt-old");
});

test("realpath-equivalent frozen root still applies", async (t) => {
  const world = await makeWorld(t);
  const realRoot = await fs.realpath(world.root);
  const alias = `${world.root}.alias`;
  await fs.symlink(realRoot, alias);
  t.after(() => fs.rm(alias, { force: true }));
  const { rpc, env } = await bootWorker(world, {
    projectRoot: alias,
    snapshotRoot: async () => {
      const listing = await fs.lstat(realRoot);
      return { path: realRoot, dev: listing.dev, ino: listing.ino };
    },
    validateRoot: async () => realRoot
  });
  await rpc("on");
  const next = configV2({ advisors: [advisor({ model: "gpt-canon" })] });
  const revision = await writeConfig(world.configFile, next);
  const settings = await liveSettings(env);
  assert.equal(await fs.realpath(settings.projectRoot), realRoot);
  const applied = await liveApply(env, settings, revision);
  assert.equal(applied.ok, true);
  assert.equal(advisorNamed((await rpc("status")).result, "correctness").model, "gpt-canon");
});

test("apply enable before on freezes root identity against replacement", async (t) => {
  const world = await makeWorld(t);
  const { rpc, env } = await bootWorker(world);
  const revision = await fileRevision(world.configFile);
  const settings = await liveSettings(env);
  const enabled = await liveApply(env, settings, revision, { enable: true });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.enabled, true);
  assert.equal(await fs.realpath(enabled.projectRoot), await fs.realpath(world.root));

  const displaced = `${world.root}.displaced`;
  await fs.rename(world.root, displaced);
  await fs.mkdir(world.root);
  t.after(async () => {
    await fs.rm(world.root, { recursive: true, force: true }).catch(() => {});
    await fs.rename(displaced, world.root).catch(() => {});
  });

  await rpc("hook", {
    payload: hook("UserPromptSubmit", {
      prompt: "rebound-root",
      prompt_id: "rebind-1",
      cwd: world.root
    })
  });
  const status = (await rpc("status")).result;
  assert.equal(status.reason, "cwd-outside-root");
  assert.equal(
    (status.advisors ?? []).some((item) => item.state === "busy"),
    false
  );
});

test("apply is rejected while an ended session is still stopping", async (t) => {
  let release;
  t.after(() => {
    try {
      release?.();
    } catch {
      /* already released */
    }
  });
  const world = await makeWorld(t);
  const { rpc, env } = await bootWorker(world, {
    reviewApi: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "ending", prompt_id: "end-1" })
  });
  await waitUntil(async () => (await rpc("status")).result.advisors[0]?.state === "busy");
  const next = configV2({ advisors: [advisor({ model: "gpt-ended" })] });
  const revision = await writeConfig(world.configFile, next);
  const settings = await liveSettings(env);
  await rpc("hook", { payload: hook("SessionEnd") });
  const applied = await liveApply(env, settings, revision);
  assert.equal(applied.ok, false);
  assert.equal(applied.error, "stale");
  let model = "gpt-old";
  try {
    model = advisorNamed((await rpc("status")).result, "correctness")?.model ?? "gpt-old";
  } catch {
    model = "gpt-old";
  }
  assert.notEqual(model, "gpt-ended");
  release?.();
  release = null;
});

test("legacy issuance ledger absent after off rejects later apply", async (t) => {
  const world = await makeWorld(t);
  const { rpc, env, worker } = await bootWorker(world, {
    reviewApi: async (args) => {
      await args.tools.call("advise", {
        severity: "concern",
        note: "legacy-after-off",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "held" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "legacy-off", prompt_id: "leg-off" })
  });
  const client = protocolClient();
  const drain = await waitUntil(async () => {
    const res = await rpc("hook", {
      client,
      payload: hook("PreToolUse", {
        prompt_id: "leg-off",
        tool_name: "Read",
        tool_use_id: "toolu_leg_off"
      })
    });
    return res.result?.claimId ? res : null;
  });
  assert.match(drain.result.stdout, /legacy-after-off/);
  await rpc("off");
  await worker.stop({ reason: "replace" });
  world.worker = null;

  const snapshotFile = statePath(sessionDir(world.data, world.sessionId));
  const snapshot = JSON.parse(await fs.readFile(snapshotFile, "utf8"));
  delete snapshot.issuance;
  await fs.writeFile(snapshotFile, `${JSON.stringify(snapshot)}\n`);

  const booted = await bootWorker(world);
  const next = configV2({ advisors: [advisor({ model: "gpt-legacy-off" })] });
  await writeConfig(world.configFile, next);
  const applied = await ipcApply(booted.rpc, world);
  assert.equal(applyOk(applied), false);
  assert.equal(failureCode(applied), "protocol");
  assert.notEqual(
    advisorNamed((await booted.rpc("status")).result, "correctness").model,
    "gpt-legacy-off"
  );
});

test("failed durable issuance cannot emit then survive restart", async (t) => {
  const world = await makeWorld(t);
  let failPersist = false;
  const saveState = async (dir, state) => {
    if (failPersist) {
      const error = new Error("ENOSPC");
      error.code = "ENOSPC";
      throw error;
    }
    return persistState(dir, state);
  };
  const { rpc } = await bootWorker(world, {
    saveState,
    reviewApi: async (args) => {
      await args.tools.call("advise", {
        severity: "concern",
        note: "undurable-envelope",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "held" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "persist-fail", prompt_id: "pf1" })
  });
  await waitUntil(async () =>
    (await rpc("status")).result.inbox.some((item) => item.note === "undurable-envelope")
  );
  failPersist = true;
  const drain = await rpc("hook", {
    client: protocolClient(),
    payload: hook("PreToolUse", {
      prompt_id: "pf1",
      tool_name: "Read",
      tool_use_id: "toolu_pf"
    })
  });
  failPersist = false;
  assert.equal((drain.result?.stdout ?? "").includes("undurable-envelope"), false);
  assert.equal(drain.result?.claimId == null, true);

  const booted = await bootWorker(world, {
    reviewApi: async () => ({ usage: { costUsd: "unknown" }, history: [] })
  });
  const next = configV2({ advisors: [advisor({ model: "gpt-after-undurable" })] });
  const revision = await writeConfig(world.configFile, next);
  const settings = await liveSettings(booted.env);
  const applied = await liveApply(booted.env, settings, revision);
  assert.equal(applied.ok, true);
  assert.equal(
    advisorNamed((await booted.rpc("status")).result, "correctness").model,
    "gpt-after-undurable"
  );
  const later = await booted.rpc("hook", {
    payload: hook("PreToolUse", {
      prompt_id: "pf1",
      tool_name: "Read",
      tool_use_id: "toolu_pf2"
    })
  });
  assert.equal((later.result?.stdout ?? "").includes("undurable-envelope"), false);
});

test("reasoning-invalid apply fails before replacing the live model", async (t) => {
  const seen = [];
  const world = await makeWorld(t);
  const { rpc, env } = await bootWorker(world, {
    validateApi: async (args) => {
      seen.push(args);
      if (args?.advisor?.reasoningEffort === "high") {
        return { available: false, reasoningInvalid: true };
      }
      return { available: true };
    }
  });
  await rpc("on");
  const next = configV2({
    advisors: [advisor({ model: "gpt-reason", reasoningEffort: "high" })]
  });
  const revision = await writeConfig(world.configFile, next);
  const settings = await liveSettings(env);
  const applied = await liveApply(env, settings, revision);
  assert.equal(applied.ok, false);
  assert.equal(applied.error, "config");
  assert.equal(advisorNamed((await rpc("status")).result, "correctness").model, "gpt-old");
  const diagnosed = seen.find((item) => item?.advisor?.reasoningEffort === "high");
  assert.ok(diagnosed);
  assert.equal(diagnosed.maxOutputTokens, 1500);
  assert.ok(diagnosed.provider);
  assert.ok(diagnosed.advisor);
  assert.ok(diagnosed.env);
});
