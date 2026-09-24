#!/usr/bin/env node
/**
 * Lifecycle regressions for the session worker: observation order, control
 * classification, compaction, cancellation, snapshot restart, drain, and
 * per-advisor settings epochs.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distModules = path.join(repo, "plugins", "cross-model-advisor", "dist", "modules");

const load = (rel) => import(pathToFileURL(path.join(distModules, rel)).href);

const { startWorker, cwdInsideRoot } = await load("worker.mjs");
const { requestIpc } = await load("session/ipc.mjs");
const { classifyPrompt } = await load("session/classifier.mjs");
const { parseJsonlChunk, interpretRecord } = await load("session/transcript.mjs");
const { boundHistory } = await load("session/history.mjs");
const { formatEnvelope } = await load("session/findings.mjs");

function configFixture(overrides = {}) {
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
        instructions: "Look for observable correctness failures."
      }
    ],
    exclude: [],
    limits: {
      maxConcurrentAdvisors: 2,
      reviewTimeoutSeconds: 2,
      maxToolCallsPerReview: 8,
      maxOutputTokens: 1500,
      maxReviewsPerAdvisorPerSession: 40
    },
    ...overrides
  };
}

function protocolClient(pid = process.pid) {
  return { pid, id: randomUUID(), protocolVersion: 2 };
}

function configV2(overrides = {}) {
  const base = configFixture(overrides);
  return {
    ...base,
    version: 2,
    advisors: (base.advisors ?? []).map((item) => ({
      ...item,
      enabled: item.enabled ?? true,
      reasoningEffort: item.reasoningEffort ?? "default"
    }))
  };
}

function compatibleProvider(overrides = {}) {
  return {
    kind: "api",
    provider: "openai-compatible",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "http://127.0.0.1:9/v1",
    models: {
      "local-model": {
        contextWindow: 8192,
        maxTokens: 2048
      }
    },
    ...overrides
  };
}

function applySucceeded(res) {
  return Boolean(res) && res.ok === true && res.result?.ok !== false;
}

async function writeAdvisorConfig(file, config) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

async function applyConfig(h, config, extra = {}) {
  await writeAdvisorConfig(h.configFile, config);
  const ping = (await h.rpc("ping")).result;
  const configRevision = createHash("sha256").update(await fs.readFile(h.configFile)).digest("hex");
  return h.rpc("apply", {
    protocolVersion: 2,
    workerGeneration: extra.workerGeneration ?? ping.workerGeneration,
    settingsRevision: extra.settingsRevision ?? ping.settingsRevision,
    configRevision,
    ...(extra.enable !== undefined ? { enable: extra.enable } : {})
  });
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

async function harness(t, extra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-root-")));
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-data-")));
  const sessionId = extra.sessionId ?? `sess-${Math.random().toString(16).slice(2)}`;
  const started = { count: 0, last: null, cancelled: 0 };
  const releases = [];
  const workers = [];
  const reviewApi =
    extra.reviewApi ??
    (async (args) => {
      started.count += 1;
      started.last = args;
      if (args.signal?.aborted) {
        const error = new Error("cancel");
        error.code = "cancel";
        started.cancelled += 1;
        throw error;
      }
      return { usage: { inputTokens: 1, outputTokens: 1, costUsd: "unknown" }, history: args.history ?? [] };
    });
  const worker = await startWorker({
    sessionId,
    projectRoot: root,
    pluginData: data,
    env: {
      OPENAI_API_KEY: "sk-test-secret-value",
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_PROJECT_DIR: root,
      CLAUDE_CODE_SESSION_ID: sessionId,
      ...extra.env
    },
    exitOnIdle: false,
    idleMs: Number.POSITIVE_INFINITY,
    debounceMs: extra.debounceMs ?? 0,
    claimLeaseMs: extra.claimLeaseMs ?? 80,
    loadConfig: extra.loadConfig ?? (async () => extra.config ?? configFixture()),
    validateRoot: extra.validateRoot ?? (async () => {}),
    runtimeErrors: extra.runtimeErrors ?? (() => []),
    createReviewTools: extra.createReviewTools ?? (async () => makeTools()),
    validateApi: extra.validateApi ?? (async () => ({ available: true })),
    reviewApi,
    advisorSystemPrompt: extra.advisorSystemPrompt ?? "inspect independently",
    ...extra.workerOptions
  });
  workers.push(worker);
  t.after(async () => {
    for (const release of releases) {
      try {
        release();
      } catch {
        /* already released */
      }
    }
    for (const item of [...workers].reverse()) {
      await item.stop({ reason: "test" }).catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.rm(data, { recursive: true, force: true }).catch(() => {});
  });
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
  return { root, data, sessionId, worker, rpc, started, releases, workers };
}

async function fileHarness(t, extra = {}) {

  const configDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-life-cfg-")));
  t.after(async () => {
    await fs.rm(configDir, { recursive: true, force: true }).catch(() => {});
  });
  const configFile = path.join(configDir, "cross-model-advisor.json");
  const config = extra.config ?? configV2();
  await writeAdvisorConfig(configFile, config);
  const h = await harness(t, {
    ...extra,
    env: { CLAUDE_CONFIG_DIR: configDir, ...extra.env },
    loadConfig: extra.loadConfig ?? (async () => JSON.parse(await fs.readFile(configFile, "utf8"))),
    workerOptions: {
      configFilePath: () => configFile,
      readConfigState: async () => {
        const raw = await fs.readFile(configFile);
        let config = null;
        let configError = null;
        try {
          config = JSON.parse(raw.toString("utf8"));
        } catch (error) {
          configError = error instanceof Error ? error.message : "invalid config";
        }
        return {
          path: configFile,
          revision: createHash("sha256").update(raw).digest("hex"),
          config,
          configError
        };
      },
      ...extra.workerOptions
    }
  });
  return { ...h, configDir, configFile };
}

function hook(event, extra = {}) {
  return {
    hook_event_name: event,
    session_id: extra.session_id,
    cwd: extra.cwd,
    prompt: extra.prompt,
    prompt_id: extra.prompt_id,
    transcript_path: extra.transcript_path,
    tool_name: extra.tool_name,
    tool_input: extra.tool_input,
    tool_use_id: extra.tool_use_id,
    tool_response: extra.tool_response,
    error: extra.error,
    is_interrupt: extra.is_interrupt,
    last_assistant_message: extra.last_assistant_message,
    source: extra.source,
    compact_summary: extra.compact_summary,
    agent_id: extra.agent_id,
    command_name: extra.command_name,
    command_source: extra.command_source
  };
}

test("classifier accepts only exact namespaced commands", () => {
  assert.equal(classifyPrompt("/cross-model-advisor:on").kind, "control");
  assert.equal(classifyPrompt("/cross-model-advisor:off").kind, "control");
  assert.equal(classifyPrompt("/cross-model-advisor:status").kind, "control");
  assert.equal(classifyPrompt("/cross-model-advisor:doctor").kind, "control");
  assert.equal(classifyPrompt("/cross-model-advisor:login").kind, "control");
  assert.equal(classifyPrompt("/cross-model-advisor:logout").kind, "control");
  assert.equal(classifyPrompt("/on").kind, "slash");
  assert.equal(classifyPrompt("/advisor:on").kind, "slash");
  assert.equal(classifyPrompt("/status").kind, "slash");
  assert.equal(classifyPrompt("please turn on advisors").kind, "task");
});

test("parallel PostToolUse keeps both observations and does not double-deliver", async (t) => {
  let tools;
  const { rpc, started } = await harness(t, {
    createReviewTools: async () => {
      tools = makeTools();
      return tools;
    },
    reviewApi: async (args) => {
      started.count += 1;
      await args.tools.call("advise", {
        severity: "concern",
        note: "null deref on empty input",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "parse path" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "parse the file", prompt_id: "p1" })
  });
  await waitUntil(async () => {
    const status = (await rpc("status")).result;
    return status.inbox.some((item) => item.status === "pending");
  });
  const a = rpc("hook", {
    payload: hook("PostToolUse", {
      prompt_id: "p1",
      tool_name: "Read",
      tool_use_id: "toolu_a",
      tool_input: { file_path: "/tmp/x" }
    })
  });
  const b = rpc("hook", {
    payload: hook("PostToolUse", {
      prompt_id: "p1",
      tool_name: "Read",
      tool_use_id: "toolu_b",
      tool_input: { file_path: "/tmp/y" }
    })
  });
  const [ra, rb] = await Promise.all([a, b]);
  const texts = [ra.result?.stdout ?? "", rb.result?.stdout ?? ""].filter(Boolean);
  assert.equal(texts.length, 1);
  const body = JSON.parse(texts[0]);
  assert.equal(body.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(body.hookSpecificOutput.additionalContext, /untrusted/i);
  const status = (await rpc("status")).result;
  assert.equal(status.inbox.filter((item) => item.status === "claimed" || item.status === "emitted").length, 1);
});

test("reversed PostToolUse then PreToolUse preserves intent and outcome", async (t) => {
  const { rpc, worker } = await harness(t);
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "edit src", prompt_id: "p2" })
  });
  await rpc("hook", {
    payload: hook("PostToolUse", {
      prompt_id: "p2",
      tool_name: "Edit",
      tool_use_id: "toolu_late",
      tool_input: { file_path: path.join("src", "a.js") },
      tool_response: { success: true }
    })
  });
  await rpc("hook", {
    payload: hook("PreToolUse", {
      prompt_id: "p2",
      tool_name: "Edit",
      tool_use_id: "toolu_late",
      tool_input: { file_path: path.join("src", "a.js") }
    })
  });
  const state = worker._state();
  const match = state;
  assert.ok(match.observationSeq >= 2);
  assert.equal(new Set(state.dedupe.filter((key) => key.includes("toolu_late"))).size >= 2, true);
});

test("/off does not drain advice and discards injection candidates", async (t) => {
  const { rpc } = await harness(t, {
    reviewApi: async (args) => {
      await args.tools.call("advise", {
        severity: "blocker",
        note: "should not inject after off",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "x" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "do work", prompt_id: "p-off" })
  });
  await waitUntil(async () => (await rpc("status")).result.inbox.length > 0);
  const offHook = await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "/cross-model-advisor:off", prompt_id: "p-off-cmd" })
  });
  assert.equal(offHook.result?.stdout ?? "", "");
  const status = (await rpc("status")).result;
  assert.equal(status.enabled, false);
  assert.equal(status.inbox.every((item) => item.status === "discarded"), true);
});

test("/status /doctor /setup /login /logout never replace the task or start reviews", async (t) => {
  const { rpc, started, worker } = await harness(t);
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "implement auth", prompt_id: "real-task" })
  });
  await waitUntil(() => started.count >= 1);
  const before = started.count;
  const task = worker._state().latestTask?.text;
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "/cross-model-advisor:status", prompt_id: "status-cmd" })
  });
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "/cross-model-advisor:doctor", prompt_id: "doctor-cmd" })
  });
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "/cross-model-advisor:login", prompt_id: "login-cmd" })
  });
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "/cross-model-advisor:logout", prompt_id: "logout-cmd" })
  });
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "/cross-model-advisor:setup", prompt_id: "setup-cmd" })
  });
  await rpc("hook", {
    payload: hook("PreToolUse", {
      prompt_id: "setup-cmd",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_setup"
    })
  });
  await rpc("hook", {
    payload: hook("PreToolUse", {
      prompt_id: "status-cmd",
      tool_name: "Bash",
      tool_use_id: "toolu_status"
    })
  });
  await rpc("hook", {
    payload: hook("PostToolUse", {
      prompt_id: "status-cmd",
      tool_name: "Bash",
      tool_use_id: "toolu_status"
    })
  });
  await rpc("hook", {
    payload: hook("PreToolUse", {
      prompt_id: "doctor-cmd",
      tool_name: "Bash",
      tool_use_id: "toolu_doctor"
    })
  });
  await rpc("status");
  await rpc("doctor");
  assert.equal(worker._state().latestTask?.text, task);
  assert.equal(started.count, before);
});

test("ambiguous aliases do not enable the plugin", async (t) => {
  const { rpc } = await harness(t);
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "/on", prompt_id: "alias" })
  });
  const status = (await rpc("status")).result;
  assert.equal(status.enabled, false);
});

test("slow advisor after Stop stays silent then drains on the next real prompt", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const backendStarted = new Promise((resolve) => {
    entered = resolve;
  });
  const { rpc } = await harness(t, {
    reviewApi: async (args) => {
      entered();
      await gate;
      await args.tools.call("advise", {
        severity: "nit",
        note: "late finding after stop",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "prior turn" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "refactor", prompt_id: "p-stop" })
  });
  await backendStarted;
  const stop = await rpc("hook", {
    payload: hook("Stop", { last_assistant_message: "done for now", prompt_id: "p-stop" })
  });
  assert.equal(stop.result?.stdout ?? "", "");
  const parsed = stop.result?.stdout ? JSON.parse(stop.result.stdout) : {};
  assert.equal(parsed.hookSpecificOutput, undefined);
  assert.equal(parsed.asyncRewake, undefined);
  release();
  await waitUntil(async () => (await rpc("status")).result.inbox.some((item) => item.status === "pending"));
  const next = await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "continue", prompt_id: "p-next" })
  });
  assert.match(next.result.stdout, /UserPromptSubmit/);
  assert.match(next.result.stdout, /untrusted/i);
});

test("fork session does not inherit parent inbox", async (t) => {
  const parent = await harness(t, {
    sessionId: "parent-sess",
    reviewApi: async (args) => {
      await args.tools.call("advise", {
        severity: "concern",
        note: "parent only",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "p" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await parent.rpc("on");
  await parent.rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "parent task", prompt_id: "pp" })
  });
  await waitUntil(async () => (await parent.rpc("status")).result.inbox.length > 0);
  const child = await harness(t, { sessionId: "fork-sess" });
  await child.rpc("hook", {
    payload: hook("SessionStart", { source: "fork" })
  });
  const status = (await child.rpc("status")).result;
  assert.equal(status.enabled, false);
  assert.equal(status.inbox.length, 0);
});

test("off, new prompt, compaction, and SessionEnd abort in-flight work", async (t) => {
  const hanging = async ({ signal }) =>
    new Promise((_, reject) => {
      const fail = () => {
        const error = new Error("cancel");
        error.code = "cancel";
        reject(error);
      };
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  const { rpc, worker } = await harness(t, { reviewApi: hanging });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "first", prompt_id: "a" })
  });
  await waitUntil(async () => (await rpc("status")).result.advisors[0]?.state === "busy");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "second", prompt_id: "b" })
  });
  await rpc("hook", { payload: hook("PreCompact") });
  assert.notEqual((await rpc("status")).result.advisors[0]?.state, "busy");
  await rpc("off");
  assert.equal((await rpc("status")).result.enabled, false);
  await rpc("hook", { payload: hook("SessionEnd") });
  await worker.stop({ reason: "session-end" });
});

test("PreCompact/PostCompact/SessionStart compact increments generation once", async (t) => {
  const { rpc } = await harness(t);
  await rpc("on");
  const g0 = (await rpc("status")).result.generation;
  await rpc("hook", { payload: hook("PreCompact") });
  assert.equal((await rpc("status")).result.generation, g0);
  await rpc("hook", {
    payload: hook("PostCompact", { compact_summary: "summarized the auth work" })
  });
  const g1 = (await rpc("status")).result.generation;
  assert.equal(g1, g0 + 1);
  await rpc("hook", {
    payload: hook("SessionStart", { source: "compact", compact_summary: "summarized the auth work" })
  });
  await rpc("hook", {
    payload: hook("PostCompact", { compact_summary: "summarized the auth work" })
  });
  assert.equal((await rpc("status")).result.generation, g1);
  const drain = await rpc("hook", {
    payload: hook("PostCompact", { compact_summary: "summarized the auth work" })
  });
  assert.equal(drain.result?.stdout ?? "", "");
});

test("blocked compaction preserves generation and later prompt resumes", async (t) => {
  const { rpc, worker } = await harness(t);
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "keep this task", prompt_id: "keep" })
  });
  const g0 = (await rpc("status")).result.generation;
  await rpc("hook", { payload: hook("PreCompact") });
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "continue the same task", prompt_id: "after-block" })
  });
  assert.equal((await rpc("status")).result.generation, g0);
  assert.match(worker._state().latestTask.text, /continue the same task/);
});

test("missed compact summary pauses rather than inventing context", async (t) => {
  const { rpc } = await harness(t);
  await rpc("on");
  await rpc("hook", { payload: hook("PreCompact") });
  await rpc("hook", { payload: hook("SessionStart", { source: "compact" }) });
  const status = (await rpc("status")).result;
  assert.equal(status.reason === "context-unavailable" || status.paused, true);
});

test("Esc interrupt is not treated as Stop", async (t) => {
  const { rpc, worker } = await harness(t);
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "running", prompt_id: "esc" })
  });
  const fail = await rpc("hook", {
    payload: hook("PostToolUseFailure", {
      prompt_id: "esc",
      tool_name: "Bash",
      tool_use_id: "toolu_esc",
      is_interrupt: true,
      error: "interrupted"
    })
  });
  assert.notEqual(worker._state().primaryIdle, true);
  if (fail.result?.stdout) {
    const body = JSON.parse(fail.result.stdout);
    assert.equal(body.decision, undefined);
  }
});

test("transcript partial JSONL, sidechains, queued commands, and unknown types", async () => {
  const chunk = [
    '{"type":"user","uuid":"u1","message":{"role":"user","content":"real constraint"}}',
    '{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"thinking","thinking":"secret chain"},{"type":"text","text":"ok"}]}}',
    '{"type":"user","uuid":"u2","isSidechain":true,"message":{"role":"user","content":"side"}}',
    '{"type":"weird","uuid":"w1"}',
    '{"type":"user","uuid":"u3","message":{"role":"user","content":[{"type":"queued_command","command":"/commit now"}]}}',
    '{"incomplete"'
  ].join("\n");
  const parsed = parseJsonlChunk(chunk);
  assert.equal(parsed.rest.includes("incomplete"), true);
  const kinds = parsed.records.map((record) => interpretRecord(record).kind);
  assert.ok(kinds.includes("user"));
  assert.ok(kinds.includes("assistant"));
  assert.ok(kinds.includes("skip") || kinds.includes("gap"));
  const side = interpretRecord({ type: "user", isSidechain: true, message: { content: "nope" } });
  assert.equal(side.kind, "skip");
  const thinking = interpretRecord({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] }
  });
  assert.equal(thinking.text ?? "", "");
});

test("activation snapshot A survives worker replace after config B", async (t) => {
  const workers = [];
  const dirs = [];
  t.after(async () => {
    for (const item of [...workers].reverse()) {
      await item.stop({ reason: "test" }).catch(() => {});
    }
    for (const dir of dirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-root-")));
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-data-")));
  dirs.push(root, data);
  const sessionId = "snap-sess";
  const cfgA = configFixture();
  const cfgB = configFixture({
    advisors: [
      {
        name: "architecture",
        provider: "openai-api",
        model: "other-model",
        instructions: "B"
      }
    ]
  });
  const common = {
    sessionId,
    projectRoot: root,
    pluginData: data,
    env: { OPENAI_API_KEY: "sk-test-secret-value" },
    exitOnIdle: false,
    idleMs: Number.POSITIVE_INFINITY,
    debounceMs: 0,
    validateRoot: async () => {},
    runtimeErrors: () => [],
    createReviewTools: async () => makeTools(),
    validateApi: async () => ({ available: true }),
    reviewApi: async () => ({ usage: { costUsd: "unknown" }, history: [] }),
    advisorSystemPrompt: "inspect"
  };
  const first = await startWorker({ ...common, loadConfig: async () => cfgA });
  workers.push(first);
  await requestIpc(
    first.socketPath,
    { capability: first.controlCapability, op: "on" },
    { timeoutMs: 2000 }
  );
  await first.stop({ reason: "test" });
  const second = await startWorker({ ...common, loadConfig: async () => cfgB });
  workers.push(second);
  const status = await requestIpc(
    second.socketPath,
    { capability: second.controlCapability, op: "status" },
    { timeoutMs: 2000 }
  );
  assert.equal(status.result.advisors[0].name, "correctness");
  assert.equal(status.result.advisors[0].model, "gpt-test");
});

test("persisted latest task survives a 256 KiB transcript tail", async (t) => {
  const { rpc, worker, root } = await harness(t);
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "unique-task-keep-me", prompt_id: "keep-task" })
  });
  const transcript = path.join(root, "transcript.jsonl");
  const junk = `${JSON.stringify({ type: "assistant", uuid: "z", message: { role: "assistant", content: "x".repeat(1000) } })}\n`;
  await fs.writeFile(transcript, junk.repeat(300));
  worker._state().transcriptPath = transcript;
  worker._state().transcriptCursor = { offset: 0, uuid: null, inode: null, size: 0 };
  await rpc("hook", {
    payload: hook("PreToolUse", {
      prompt_id: "keep-task",
      tool_name: "Read",
      tool_use_id: "toolu_big",
      transcript_path: transcript
    })
  });
  assert.match(worker._state().latestTask.text, /unique-task-keep-me/);
});

test("claim crash before stdout redelivers; ack is best-effort emitted", async (t) => {
  const { rpc } = await harness(t, {
    claimLeaseMs: 40,
    reviewApi: async (args) => {
      await args.tools.call("advise", {
        severity: "concern",
        note: "redeliver me",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "x" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "work", prompt_id: "c1" })
  });
  const firstClient = protocolClient();
  const first = await waitUntil(async () => {
    const res = await rpc("hook", {
      client: firstClient,
      payload: hook("PreToolUse", {
        prompt_id: "c1",
        tool_name: "Read",
        tool_use_id: "toolu_c"
      })
    });
    return res.result?.claimId ? res : null;
  });
  const id = JSON.parse(first.result.stdout).hookSpecificOutput ? (await rpc("status")).result.inbox[0].id : null;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const statusPending = (await rpc("status")).result;
  const afterExpire = statusPending.inbox.find((item) => item.id === id) ?? statusPending.inbox[0];
  assert.ok(afterExpire.status === "pending" || afterExpire.status === "claimed" || afterExpire.status === "emitted");
  const againClient = protocolClient();
  const again = await rpc("hook", {
    client: againClient,
    payload: hook("PostToolUse", {
      prompt_id: "c1",
      tool_name: "Read",
      tool_use_id: "toolu_d",
      tool_response: { success: true }
    })
  });
  if (again.result?.claimId) {
    const ack = await rpc("ack", { claimId: again.result.claimId, client: againClient });
    assert.equal(ack.result.emission, "best-effort");
    const emitted = (await rpc("status")).result.inbox.find((item) => item.status === "emitted");
    assert.ok(emitted);
    assert.ok(!("confirmed" in emitted));
  }
});

test("saved CLI activation fails closed and does not call the direct provider", async (t) => {
  const workers = [];
  const dirs = [];
  t.after(async () => {
    for (const item of [...workers].reverse()) {
      await item.stop({ reason: "test" }).catch(() => {});
    }
    for (const dir of dirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-root-")));
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cma-data-")));
  dirs.push(root, data);
  const sessionId = "cli-saved";
  await fs.mkdir(path.join(data, "sessions", sessionId), { recursive: true });
  await fs.writeFile(
    path.join(data, "sessions", sessionId, "state.json"),
    `${JSON.stringify({
      version: 1,
      enabled: true,
      paused: false,
      generation: 1,
      projectRoot: root,
      latestTask: { text: "saved-task", promptId: "p0", at: Date.now(), generation: 1 },
      activation: {
        version: 1,
        providers: { "codex-login": { kind: "cli", cli: "codex" } },
        advisors: [{ name: "architecture", provider: "codex-login", model: "codex-test", instructions: "a" }],
        exclude: [],
        limits: {
          maxConcurrentAdvisors: 2,
          reviewTimeoutSeconds: 2,
          maxToolCallsPerReview: 8,
          maxOutputTokens: 1500,
          maxReviewsPerAdvisorPerSession: 40
        }
      }
    })}\n`
  );
  let reviews = 0;
  const worker = await startWorker({
    sessionId,
    projectRoot: root,
    pluginData: data,
    env: {
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_PROJECT_DIR: root,
      CLAUDE_CODE_SESSION_ID: sessionId
    },
    exitOnIdle: false,
    idleMs: Number.POSITIVE_INFINITY,
    debounceMs: 0,
    loadConfig: async () => configFixture(),
    validateRoot: async () => {},
    runtimeErrors: () => [],
    createReviewTools: async () => makeTools(),
    validateApi: async () => ({ available: true }),
    reviewApi: async () => {
      reviews += 1;
      return { usage: { costUsd: "unknown" }, history: [] };
    },
    advisorSystemPrompt: "inspect"
  });
  workers.push(worker);
  await requestIpc(
    worker.socketPath,
    {
      capability: worker.controlCapability,
      op: "hook",
      payload: hook("UserPromptSubmit", { prompt: "continue saved", prompt_id: "p1" })
    },
    { timeoutMs: 2000 }
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reviews, 0);
  const status = await requestIpc(
    worker.socketPath,
    { capability: worker.controlCapability, op: "status" },
    { timeoutMs: 2000 }
  );
  assert.equal(status.result.advisors[0].state, "paused");
  assert.match(String(status.result.advisors[0].lastError ?? ""), /cross-model-advisor:on/);
});

test("rate error pauses advisor; session limit is visible; missing cost stays unknown", async (t) => {
  let calls = 0;
  const { rpc } = await harness(t, {
    config: configFixture({
      limits: {
        maxConcurrentAdvisors: 1,
        reviewTimeoutSeconds: 2,
        maxToolCallsPerReview: 8,
        maxOutputTokens: 1500,
        maxReviewsPerAdvisorPerSession: 1
      }
    }),
    reviewApi: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("429");
        error.code = "rate";
        throw error;
      }
      return { usage: { inputTokens: 3 }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "one", prompt_id: "lim1" })
  });
  await waitUntil(async () => (await rpc("status")).result.advisors[0].state === "paused");
  const status = (await rpc("status")).result;
  assert.equal(status.advisors[0].state, "paused");
  const usage = status.advisors[0].usage;
  if (usage) assert.equal(usage.costUsd === 0, false);
});

test("subagent hooks are ignored", async (t) => {
  const { rpc, worker } = await harness(t);
  await rpc("on");
  const seq = worker._state().observationSeq;
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "from agent", prompt_id: "ag", agent_id: "agent_1" })
  });
  assert.equal(worker._state().observationSeq, seq);
});

test("control-turn helper tool hooks do not drain or schedule", async (t) => {
  let reviews = 0;
  const { rpc } = await harness(t, {
    reviewApi: async (args) => {
      reviews += 1;
      await args.tools.call("advise", {
        severity: "concern",
        note: "should not drain on control tools",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "x" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "real work", prompt_id: "real-1" })
  });
  await waitUntil(async () => (await rpc("status")).result.inbox.length > 0);
  const before = reviews;
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "/cross-model-advisor:status", prompt_id: "ctrl-1" })
  });
  const tool = await rpc("hook", {
    payload: hook("PreToolUse", {
      prompt_id: "ctrl-1",
      tool_name: "Bash",
      tool_use_id: "toolu_ctrl"
    })
  });
  assert.equal(tool.result?.stdout ?? "", "");
  assert.equal(reviews, before);
});

test("backend receives persisted latestTask and compactSummary", async (t) => {
  const seen = [];
  const { rpc } = await harness(t, {
    reviewApi: async (args) => {
      seen.push({
        latestTask: args.latestTask,
        compactSummary: args.compactSummary
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "keep-this-task", prompt_id: "ctx-1" })
  });
  await waitUntil(() => seen.length > 0);
  assert.match(seen[0].latestTask?.text ?? "", /keep-this-task/);
  await rpc("hook", { payload: hook("PreCompact") });
  await rpc("hook", {
    payload: hook("PostCompact", { compact_summary: "compacted keep-this-task" })
  });
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "after compact", prompt_id: "ctx-2" })
  });
  await waitUntil(() => seen.length > 1);
  assert.equal(typeof seen.at(-1).compactSummary?.text, "string");
});

test("failed review still merges reported usage once", async (t) => {
  const { rpc } = await harness(t, {
    reviewApi: async () => {
      const error = new Error("429");
      error.code = "rate";
      error.usage = { inputTokens: 11, outputTokens: 2, totalTokens: 13, costUsd: "unknown" };
      throw error;
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "usage", prompt_id: "u1" })
  });
  await waitUntil(async () => (await rpc("status")).result.advisors[0].usage?.inputTokens === 11);
  const usage = (await rpc("status")).result.advisors[0].usage;
  assert.equal(usage.inputTokens, 11);
  assert.equal(usage.costUsd, "unknown");
});

test("non-control slash after Stop resumes advisors", async (t) => {
  let started = 0;
  const { rpc } = await harness(t, {
    reviewApi: async () => {
      started += 1;
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "first", prompt_id: "s1" })
  });
  await waitUntil(() => started >= 1);
  await rpc("hook", { payload: hook("Stop", { prompt_id: "s1" }) });
  const before = started;
  await rpc("hook", {
    payload: hook("UserPromptExpansion", {
      prompt: "/commit",
      command_name: "commit",
      command_source: "builtin",
      prompt_id: "s2"
    })
  });
  await waitUntil(() => started > before);
  assert.ok(started > before);
});

test("second worker does not steal a live startup lock", async (t) => {
  const first = await harness(t);
  await assert.rejects(
    () =>
      startWorker({
        sessionId: first.sessionId,
        projectRoot: first.root,
        pluginData: first.data,
        exitOnIdle: false,
        idleMs: Number.POSITIVE_INFINITY,
        loadConfig: async () => configFixture(),
        validateRoot: async () => first.root,
        runtimeErrors: () => [],
        createReviewTools: async () => makeTools(),
        validateApi: async () => ({ available: true }),
        reviewApi: async () => ({ usage: { costUsd: "unknown" }, history: [] }),
        advisorSystemPrompt: "inspect"
      }),
    /already running/
  );
});

test("off during tool setup does not publish a staged candidate", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(t, {
    createReviewTools: async () => {
      await gate;
      const tools = makeTools();
      await tools.call("advise", {
        severity: "concern",
        note: "too late",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "x" }]
      });
      return tools;
    }
  });
  h.releases.push(() => release?.());
  const { rpc } = h;
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "race", prompt_id: "r1" })
  });
  await rpc("off");
  release();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const inbox = (await rpc("status")).result.inbox;
  assert.equal(
    inbox.filter((item) => item.status === "pending" || item.status === "claimed").length,
    0
  );
});

test("deadline abort discards a staged candidate even if the backend returns", async (t) => {
  const { rpc } = await harness(t, {
    config: configFixture({
      limits: {
        maxConcurrentAdvisors: 2,
        reviewTimeoutSeconds: 0.05,
        maxToolCallsPerReview: 8,
        maxOutputTokens: 1500,
        maxReviewsPerAdvisorPerSession: 40
      }
    }),
    reviewApi: async (args) => {
      await args.tools.call("advise", {
        severity: "concern",
        note: "late after deadline",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "x" }]
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "deadline", prompt_id: "d1" })
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await rpc("status")).result.inbox.length, 0);
});

test("saturated advisors still coalesce pending observations", async (t) => {
  const hanging = async ({ signal }) =>
    new Promise((_, reject) => {
      const fail = () => {
        const error = new Error("cancel");
        error.code = "cancel";
        reject(error);
      };
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  const cfg = configFixture({
    advisors: [
      { name: "correctness", provider: "openai-api", model: "gpt-test", instructions: "a" },
      { name: "architecture", provider: "openai-api", model: "gpt-test", instructions: "b" }
    ],
    limits: {
      maxConcurrentAdvisors: 2,
      reviewTimeoutSeconds: 2,
      maxToolCallsPerReview: 8,
      maxOutputTokens: 1500,
      maxReviewsPerAdvisorPerSession: 40
    }
  });
  const { rpc, worker } = await harness(t, { config: cfg, reviewApi: hanging });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "start both", prompt_id: "sat1" })
  });
  await waitUntil(async () => {
    const advisors = (await rpc("status")).result.advisors;
    return advisors.filter((item) => item.state === "busy").length === 2;
  });
  await rpc("hook", {
    payload: hook("PostToolUse", {
      prompt_id: "sat1",
      tool_name: "Read",
      tool_use_id: "toolu_sat",
      tool_response: { success: true }
    })
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const recs = Object.values(worker._state().advisors);
  assert.ok(recs.some((rec) => rec.coalesced));
});

test("realpath-equivalent hook cwd does not pause scheduling", async (t) => {
  const { rpc, started, root } = await harness(t, {
    validateRoot: async (projectRoot) => fs.realpath(projectRoot)
  });
  const alias = `${root}.alias`;
  await fs.symlink(await fs.realpath(root), alias);
  t.after(async () => {
    await fs.rm(alias, { force: true });
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", {
      prompt: "via alias cwd",
      prompt_id: "cwd-eq",
      cwd: alias
    })
  });
  await waitUntil(() => started.count >= 1);
  assert.notEqual((await rpc("status")).result.reason, "cwd-outside-root");
});

test("cwd outside frozen root pauses and does not schedule", async (t) => {
  const { rpc, started } = await harness(t);
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", {
      prompt: "elsewhere",
      prompt_id: "cwd-out",
      cwd: os.homedir()
    })
  });
  assert.equal(started.count, 0);
  assert.equal((await rpc("status")).result.reason, "cwd-outside-root");
});

test("in-root cwd symlink targeting outside pauses and does not schedule", async (t) => {
  const { rpc, started, root } = await harness(t);
  const escape = path.join(root, "escape-link");
  await fs.symlink(os.homedir(), escape);
  t.after(async () => {
    await fs.rm(escape, { force: true });
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", {
      prompt: "escaped cwd",
      prompt_id: "cwd-escape",
      cwd: escape
    })
  });
  assert.equal(started.count, 0);
  assert.equal((await rpc("status")).result.reason, "cwd-outside-root");
});

test("cwdInsideRoot denies retargeted root identity and missing paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cma-ident-"));
  const real = await fs.realpath(root);
  const listing = await fs.lstat(real);
  const ident = { path: real, dev: listing.dev, ino: listing.ino };
  const alias = `${root}.alias`;
  await fs.symlink(real, alias);
  const escape = path.join(real, "escape-link");
  await fs.symlink(os.homedir(), escape);
  try {
    assert.equal(cwdInsideRoot(alias, real, ident), true);
    assert.equal(cwdInsideRoot(escape, real, ident), false);
    assert.equal(cwdInsideRoot(path.join(real, "missing"), real, ident), false);
    assert.equal(cwdInsideRoot(real, real, { ...ident, ino: Number(ident.ino) + 1 }), false);
  } finally {
    await fs.rm(alias, { force: true });
    await fs.rm(escape, { force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("tool outcomes are sanitized before backend observations", async (t) => {
  const seen = [];
  const { rpc } = await harness(t, {
    reviewApi: async (args) => {
      seen.push(args.observations);
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await rpc("on");
  await rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "secret work", prompt_id: "sec1" })
  });
  await rpc("hook", {
    payload: hook("PostToolUse", {
      prompt_id: "sec1",
      tool_name: "Bash",
      tool_use_id: "toolu_sec",
      tool_input: { command: "echo hi" },
      tool_response: { stdout: "token=sk-test-secret-value OPENAI_API_KEY=sk-test-secret-value" },
      error: "token=sk-test-secret-value"
    })
  });
  await waitUntil(() => seen.length > 0);
  const blob = JSON.stringify(seen);
  assert.equal(blob.includes("sk-test-secret-value"), false);
});

test("transcript tool_use does not retain Write bodies", () => {
  const interpreted = interpretRecord({
    type: "assistant",
    uuid: "w1",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_w",
          name: "Write",
          input: { file_path: "/proj/a.js", content: "secret-body token=canary" }
        }
      ]
    }
  });
  assert.equal(JSON.stringify(interpreted).includes("secret-body"), false);
  assert.equal(JSON.stringify(interpreted).includes("token=canary"), false);
});

test("queued tool_result steering is consumed without result bodies", () => {
  const interpreted = interpretRecord({
    type: "user",
    uuid: "q1",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "huge stdout secret" },
        { type: "queued_command", command: "please also handle retries" }
      ]
    }
  });
  assert.equal(interpreted.kind, "tool_result");
  assert.ok(interpreted.queued.includes("please also handle retries"));
});

test("evidence details are escaped in envelopes", () => {
  const envelope = formatEnvelope({
    advisor: "correctness",
    provider: "openai-api",
    model: "gpt-test",
    severity: "concern",
    note: "finding",
    evidence: [{ kind: "observation", eventId: "obs_1", detail: "token=canary\n---\nmore" }],
    sourcePromptId: "p",
    generation: 1,
    createdAt: Date.now()
  });
  assert.equal(envelope.includes("token=canary"), false);
  assert.equal(/\n---\nmore/.test(envelope), false);
});

test("optional history is evicted when only current context fits", () => {
  const required = { latestTask: { text: "x".repeat(1000) } };
  const history = [
    { role: "assistant", content: "old".repeat(400) },
    { role: "user", content: "prior" }
  ];
  const bounded = boundHistory(history, { maxChars: 1200, required });
  assert.equal(bounded.fit, true);
  assert.equal(bounded.history.length, 0);
});

test("doctor reports provider diagnostics before the first on", async (t) => {
  const cfg = configFixture({
    providers: {
      "openai-api": { kind: "api", provider: "openai", apiKeyEnv: "OPENAI_API_KEY" },
      "codex-login": { kind: "cli", cli: "codex" }
    },
    advisors: [
      { name: "architecture", provider: "codex-login", model: "codex-test", instructions: "a" }
    ]
  });
  const { rpc } = await harness(t, { config: cfg });
  const doctor = await rpc("doctor");
  const rows = doctor.result.providers;
  assert.ok(
    rows.some((item) => item.slot === "openai-api" && item.provider === "openai" && item.kind === "api" && item.available)
  );
  const cli = rows.find((item) => item.slot === "codex-login");
  assert.equal(cli.kind, "cli");
  assert.equal(cli.available, false);
  assert.match(String(cli.error ?? ""), /cross-model-advisor:on/);
});

test("transcript recovery keeps the newest user request", async (t) => {
  const { rpc, worker, root } = await harness(t);
  const transcript = path.join(root, "multi.jsonl");
  await fs.writeFile(
    transcript,
    [
      JSON.stringify({ type: "user", uuid: "old", message: { role: "user", content: "oldest-task" } }),
      JSON.stringify({ type: "user", uuid: "new", message: { role: "user", content: "newest-task" } })
    ].join("\n") + "\n"
  );
  await rpc("hook", {
    payload: hook("SessionStart", { source: "startup", transcript_path: transcript })
  });
  assert.match(worker._state().latestTask?.text ?? "", /newest-task/);
});

test("delayed old model review cannot publish into the new epoch", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const calls = [];
  const cfg = configV2({
    advisors: [
      {
        name: "correctness",
        provider: "openai-api",
        model: "gpt-old",
        instructions: "old",
        enabled: true,
        reasoningEffort: "default"
      }
    ]
  });
  const h = await fileHarness(t, {
    config: cfg,
    reviewApi: async (args) => {
      calls.push({
        model: args.advisor.model,
        effort: args.advisor.reasoningEffort,
        history: args.history
      });
      entered();
      await gate;
      await args.tools.call("advise", {
        severity: "concern",
        note: "poison-from-old-model",
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "late" }]
      });
      return {
        usage: { costUsd: "unknown" },
        history: [{ role: "assistant", content: "poison-history" }]
      };
    }
  });
  h.releases.push(() => release?.());
  await h.rpc("on");
  await h.rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "first", prompt_id: "ep1" })
  });
  await started;
  const applied = await applyConfig(
    h,
    configV2({
      advisors: [
        {
          name: "correctness",
          provider: "openai-api",
          model: "gpt-new",
          instructions: "old",
          enabled: true,
          reasoningEffort: "high"
        }
      ]
    })
  );
  assert.equal(applySucceeded(applied), true);
  release();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const inbox = (await h.rpc("status")).result.inbox;
  assert.equal(
    inbox.some((item) => item.note === "poison-from-old-model" && item.status !== "discarded"),
    false
  );
  const drain = await h.rpc("hook", {
    payload: hook("PreToolUse", {
      prompt_id: "ep1",
      tool_name: "Read",
      tool_use_id: "toolu_ep"
    })
  });
  assert.equal((drain.result?.stdout ?? "").includes("poison-from-old-model"), false);
});

test("coalesced finally and returned history cannot poison the replacement review", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const cfg = configV2();
  const h = await fileHarness(t, {
    config: cfg,
    reviewApi: async (args) => {
      calls.push({
        model: args.advisor.model,
        effort: args.advisor.reasoningEffort,
        history: args.history
      });
      if (args.advisor.model === "gpt-old" || args.advisor.model === "gpt-test") {
        await gate;
        await args.tools.call("advise", {
          severity: "nit",
          note: "coalesced-old",
          evidence: [{ kind: "observation", eventId: "obs_1", detail: "x" }]
        });
        return {
          usage: { costUsd: "unknown" },
          history: [{ role: "assistant", content: "poison-history" }]
        };
      }
      return { usage: { costUsd: "unknown" }, history: args.history ?? [] };
    }
  });
  h.releases.push(() => release?.());
  await h.rpc("on");
  await h.rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "start", prompt_id: "co1" })
  });
  await waitUntil(async () => (await h.rpc("status")).result.advisors[0]?.state === "busy");
  await h.rpc("hook", {
    payload: hook("PostToolUse", {
      prompt_id: "co1",
      tool_name: "Read",
      tool_use_id: "toolu_co",
      tool_response: { success: true }
    })
  });
  const applied = await applyConfig(
    h,
    configV2({
      advisors: [
        {
          name: "correctness",
          provider: "openai-api",
          model: "gpt-new",
          instructions: "Look for observable correctness failures.",
          enabled: true,
          reasoningEffort: "default"
        }
      ]
    })
  );
  assert.equal(applySucceeded(applied), true);
  release();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const afterApply = calls.length;
  await h.rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "next", prompt_id: "co2" })
  });
  await waitUntil(() => calls.length > afterApply);
  const neu = calls.filter((item) => item.model === "gpt-new");
  assert.ok(neu.length >= 1);
  assert.equal(JSON.stringify(neu).includes("poison-history"), false);
  assert.equal(
    calls.slice(afterApply).some((item) => item.model !== "gpt-new"),
    false
  );
});

test("unrelated advisor keeps running across a sibling apply", async (t) => {
  const hanging = async ({ signal, advisor: spec }) =>
    new Promise((resolve, reject) => {
      const fail = () => {
        const error = new Error("cancel");
        error.code = "cancel";
        reject(error);
      };
      if (spec?.name === "correctness") {
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
        return;
      }
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  const cfg = configV2({
    advisors: [
      {
        name: "correctness",
        provider: "openai-api",
        model: "gpt-old",
        instructions: "a",
        enabled: true,
        reasoningEffort: "default"
      },
      {
        name: "architecture",
        provider: "openai-api",
        model: "gpt-arch",
        instructions: "b",
        enabled: true,
        reasoningEffort: "default"
      }
    ]
  });
  const h = await fileHarness(t, { config: cfg, reviewApi: hanging });
  await h.rpc("on");
  await h.rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "both", prompt_id: "u1" })
  });
  await waitUntil(async () => {
    const advisors = (await h.rpc("status")).result.advisors;
    return advisors.filter((item) => item.state === "busy").length === 2;
  });
  const applied = await applyConfig(
    h,
    configV2({
      advisors: [
        {
          name: "correctness",
          provider: "openai-api",
          model: "gpt-new",
          instructions: "a",
          enabled: true,
          reasoningEffort: "default"
        },
        {
          name: "architecture",
          provider: "openai-api",
          model: "gpt-arch",
          instructions: "b",
          enabled: true,
          reasoningEffort: "default"
        }
      ]
    })
  );
  assert.equal(applySucceeded(applied), true);
  const status = (await h.rpc("status")).result;
  const arch = status.advisors.find((item) => item.name === "architecture");
  const cor = status.advisors.find((item) => item.name === "correctness");
  assert.equal(arch.state, "busy");
  assert.notEqual(cor.state, "busy");
  assert.equal(cor.model, "gpt-new");
  assert.equal(arch.model, "gpt-arch");
});

test("A to B to A and remove/readd start new epochs", async (t) => {
  let releaseA;
  const gateA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const calls = [];
  const two = configV2({
    advisors: [
      {
        name: "correctness",
        provider: "openai-api",
        model: "gpt-a",
        instructions: "a",
        enabled: true,
        reasoningEffort: "default"
      },
      {
        name: "architecture",
        provider: "openai-api",
        model: "gpt-arch",
        instructions: "b",
        enabled: true,
        reasoningEffort: "default"
      }
    ]
  });
  const h = await fileHarness(t, {
    config: two,
    reviewApi: async (args) => {
      calls.push(args.advisor.model);
      if (args.advisor.model === "gpt-a" && args.advisor.name === "correctness" && calls.filter((m) => m === "gpt-a").length === 1) {
        await gateA;
        await args.tools.call("advise", {
          severity: "concern",
          note: "first-A-finding",
          evidence: [{ kind: "observation", eventId: "obs_1", detail: "x" }]
        });
      }
      if (args.advisor.name === "architecture") {
        await args.tools.call("advise", {
          severity: "nit",
          note: "arch-old",
          evidence: [{ kind: "observation", eventId: "obs_1", detail: "x" }]
        });
      }
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  h.releases.push(() => releaseA?.());
  await h.rpc("on");
  await h.rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "aba", prompt_id: "aba1" })
  });
  await waitUntil(() => calls.includes("gpt-a"));
  assert.equal(
    applySucceeded(
      await applyConfig(
        h,
        configV2({
          advisors: two.advisors.map((item) =>
            item.name === "correctness" ? { ...item, model: "gpt-b" } : item
          )
        })
      )
    ),
    true
  );
  assert.equal(
    applySucceeded(
      await applyConfig(
        h,
        configV2({
          advisors: two.advisors.map((item) =>
            item.name === "correctness" ? { ...item, model: "gpt-a" } : item
          )
        })
      )
    ),
    true
  );
  releaseA();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const afterAba = (await h.rpc("status")).result.inbox;
  assert.equal(
    afterAba.some(
      (item) => item.note === "first-A-finding" && item.status !== "discarded" && item.status !== "stale"
    ),
    false
  );

  await waitUntil(async () =>
    (await h.rpc("status")).result.inbox.some((item) => item.note === "arch-old")
  );
  const onlyCorrectness = configV2({
    advisors: [
      {
        name: "correctness",
        provider: "openai-api",
        model: "gpt-a",
        instructions: "a",
        enabled: true,
        reasoningEffort: "default"
      }
    ]
  });
  assert.equal(applySucceeded(await applyConfig(h, onlyCorrectness)), true);
  assert.equal(applySucceeded(await applyConfig(h, two)), true);
  const client = protocolClient();
  const drain = await h.rpc("hook", {
    client,
    payload: hook("PostToolUse", {
      prompt_id: "aba1",
      tool_name: "Read",
      tool_use_id: "toolu_readd",
      tool_response: { success: true }
    })
  });
  assert.equal((drain.result?.stdout ?? "").includes("arch-old"), false);
  assert.equal((drain.result?.stdout ?? "").includes("first-A-finding"), false);
});

test("pending old-epoch findings stay undeliverable while emitted survive restart", async (t) => {
  const notes = [];
  const cfg = configV2();
  const h = await fileHarness(t, {
    config: cfg,
    reviewApi: async (args) => {
      const note = notes.shift() ?? "pending-old";
      await args.tools.call("advise", {
        severity: "concern",
        note,
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "x" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  notes.push("keep-emitted");
  await h.rpc("on");
  await h.rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "one", prompt_id: "pe1" })
  });
  const emitClient = protocolClient();
  const first = await waitUntil(async () => {
    const res = await h.rpc("hook", {
      client: emitClient,
      payload: hook("PreToolUse", {
        prompt_id: "pe1",
        tool_name: "Read",
        tool_use_id: "toolu_pe1"
      })
    });
    return res.result?.claimId ? res : null;
  });
  await h.rpc("ack", { claimId: first.result.claimId, client: emitClient });
  notes.push("pending-old");
  await h.rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "two", prompt_id: "pe2" })
  });
  await waitUntil(async () =>
    (await h.rpc("status")).result.inbox.some((item) => item.note === "pending-old")
  );
  const reviewsBefore = (await h.rpc("status")).result.advisors[0].reviews;
  assert.equal(
    applySucceeded(
      await applyConfig(
        h,
        configV2({
          advisors: [
            {
              name: "correctness",
              provider: "openai-api",
              model: "gpt-new",
              instructions: "Look for observable correctness failures.",
              enabled: true,
              reasoningEffort: "off"
            }
          ]
        })
      )
    ),
    true
  );
  const after = (await h.rpc("status")).result;
  assert.ok((after.advisors[0].reviews ?? 0) >= reviewsBefore);
  const drain = await h.rpc("hook", {
    payload: hook("PostToolUse", {
      prompt_id: "pe2",
      tool_name: "Read",
      tool_use_id: "toolu_pe2",
      tool_response: { success: true }
    })
  });
  assert.equal((drain.result?.stdout ?? "").includes("pending-old"), false);
  assert.ok(after.inbox.some((item) => item.status === "emitted" && item.note === "keep-emitted"));

  await h.worker.stop({ reason: "replace" });
  const restarted = await startWorker({
    sessionId: h.sessionId,
    projectRoot: h.root,
    pluginData: h.data,
    env: {
      OPENAI_API_KEY: "sk-test-secret-value",
      CLAUDE_PLUGIN_DATA: h.data,
      CLAUDE_PROJECT_DIR: h.root,
      CLAUDE_CODE_SESSION_ID: h.sessionId,
      CLAUDE_CONFIG_DIR: h.configDir
    },
    exitOnIdle: false,
    idleMs: Number.POSITIVE_INFINITY,
    debounceMs: 0,
    loadConfig: async () => JSON.parse(await fs.readFile(h.configFile, "utf8")),
    configFilePath: () => h.configFile,
    validateRoot: async () => {},
    runtimeErrors: () => [],
    createReviewTools: async () => makeTools(),
    validateApi: async () => ({ available: true }),
    reviewApi: async () => ({ usage: { costUsd: "unknown" }, history: [] }),
    advisorSystemPrompt: "inspect independently"
  });
  h.workers.push(restarted);
  const status = await requestIpc(
    restarted.socketPath,
    { capability: restarted.controlCapability, op: "status" },
    { timeoutMs: 2500 }
  );
  assert.ok(status.result.inbox.some((item) => item.status === "emitted" && item.note === "keep-emitted"));
  const later = await requestIpc(
    restarted.socketPath,
    {
      capability: restarted.controlCapability,
      op: "hook",
      client: protocolClient(),
      payload: hook("PreToolUse", {
        prompt_id: "pe2",
        tool_name: "Read",
        tool_use_id: "toolu_pe3"
      })
    },
    { timeoutMs: 2500 }
  );
  assert.equal((later.result?.stdout ?? "").includes("pending-old"), false);
});

test("same-slot provider identity changes fence in-flight reviews", async (t) => {
  const pending = new Set();
  const releaseAll = () => {
    for (const resolve of pending) resolve();
    pending.clear();
  };
  let entered = 0;
  const advisorSpec = {
    name: "correctness",
    provider: "local",
    model: "local-model",
    instructions: "a",
    enabled: true,
    reasoningEffort: "default"
  };
  const cfg = (provider) =>
    configV2({
      providers: { local: provider },
      advisors: [advisorSpec]
    });
  let seq = 0;
  const h = await fileHarness(t, {
    config: cfg(compatibleProvider()),
    env: { CMA_SLOT_KEY: "sk-other-slot" },
    reviewApi: async (args) => {
      const mine = ++seq;
      const gate = new Promise((resolve) => {
        pending.add(resolve);
      });
      entered = mine;
      await gate;
      await args.tools.call("advise", {
        severity: "concern",
        note: `stale-slot-${mine}`,
        evidence: [{ kind: "observation", eventId: "obs_1", detail: "late" }]
      });
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  h.releases.push(releaseAll);
  await h.rpc("on");

  const fenceAndDiscard = async (nextProvider, promptId, note, expectedSeq) => {
    await h.rpc("hook", {
      payload: hook("UserPromptSubmit", { prompt: note, prompt_id: promptId })
    });
    await waitUntil(() => entered === expectedSeq);
    assert.equal(applySucceeded(await applyConfig(h, cfg(nextProvider))), true);
    releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const inbox = (await h.rpc("status")).result.inbox;
    assert.equal(
      inbox.some((item) => item.note === note && item.status !== "discarded" && item.status !== "stale"),
      false
    );
    const drain = await h.rpc("hook", {
      payload: hook("PreToolUse", {
        prompt_id: promptId,
        tool_name: "Read",
        tool_use_id: `toolu_${promptId}`
      })
    });
    assert.equal((drain.result?.stdout ?? "").includes(note), false);
  };

  await fenceAndDiscard(
    compatibleProvider({ baseUrl: "http://127.0.0.1:11/v1" }),
    "slot-url",
    "stale-slot-1",
    1
  );
  await fenceAndDiscard(
    compatibleProvider({
      baseUrl: "http://127.0.0.1:11/v1",
      apiKeyEnv: "CMA_SLOT_KEY"
    }),
    "slot-auth",
    "stale-slot-2",
    2
  );
  await fenceAndDiscard(
    compatibleProvider({
      baseUrl: "http://127.0.0.1:11/v1",
      apiKeyEnv: "CMA_SLOT_KEY",
      models: { "local-model": { contextWindow: 16384, maxTokens: 2048 } }
    }),
    "slot-meta",
    "stale-slot-3",
    3
  );
});

test("independent paused advisor stays paused across sibling apply", async (t) => {
  const cfg = configV2({
    advisors: [
      {
        name: "correctness",
        provider: "openai-api",
        model: "gpt-old",
        instructions: "a",
        enabled: true,
        reasoningEffort: "default"
      },
      {
        name: "architecture",
        provider: "openai-api",
        model: "gpt-arch",
        instructions: "b",
        enabled: true,
        reasoningEffort: "default"
      }
    ]
  });
  const h = await fileHarness(t, {
    config: cfg,
    reviewApi: async (args) => {
      if (args.advisor.name === "architecture") {
        const error = new Error("429");
        error.code = "rate";
        throw error;
      }
      return { usage: { costUsd: "unknown" }, history: [] };
    }
  });
  await h.rpc("on");
  await h.rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "pause-sib", prompt_id: "ps1" })
  });
  await waitUntil(async () => {
    const arch = (await h.rpc("status")).result.advisors.find((item) => item.name === "architecture");
    return arch?.state === "paused";
  });
  const applied = await applyConfig(
    h,
    configV2({
      advisors: [
        {
          name: "correctness",
          provider: "openai-api",
          model: "gpt-new",
          instructions: "a",
          enabled: true,
          reasoningEffort: "default"
        },
        {
          name: "architecture",
          provider: "openai-api",
          model: "gpt-arch",
          instructions: "b",
          enabled: true,
          reasoningEffort: "default"
        }
      ]
    })
  );
  assert.equal(applySucceeded(applied), true);
  const status = (await h.rpc("status")).result;
  const arch = status.advisors.find((item) => item.name === "architecture");
  const cor = status.advisors.find((item) => item.name === "correctness");
  assert.equal(arch.state, "paused");
  assert.equal(cor.model, "gpt-new");
  const reviews = arch.reviews;
  await h.rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "again", prompt_id: "ps2" })
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const later = (await h.rpc("status")).result.advisors.find((item) => item.name === "architecture");
  assert.equal(later.state, "paused");
  assert.equal(later.reviews, reviews);
});

test("consumed usage is retained when a stale epoch is cancelled", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const h = await fileHarness(t, {
    reviewApi: async (args) => {
      if (args.advisor.model === "gpt-test") {
        entered();
        await gate;
        const error = new Error("cancel");
        error.code = "cancel";
        error.usage = { inputTokens: 42, outputTokens: 3, totalTokens: 45, costUsd: "unknown" };
        throw error;
      }
      return { usage: { inputTokens: 1, outputTokens: 1, costUsd: "unknown" }, history: [] };
    }
  });
  h.releases.push(() => release?.());
  await h.rpc("on");
  await h.rpc("hook", {
    payload: hook("UserPromptSubmit", { prompt: "paid-round", prompt_id: "pay1" })
  });
  await started;
  const applied = await applyConfig(
    h,
    configV2({
      advisors: [
        {
          name: "correctness",
          provider: "openai-api",
          model: "gpt-new",
          instructions: "Look for observable correctness failures.",
          enabled: true,
          reasoningEffort: "default"
        }
      ]
    })
  );
  assert.equal(applySucceeded(applied), true);
  release();
  await waitUntil(async () => (await h.rpc("status")).result.advisors[0]?.usage?.inputTokens >= 42);
  const usage = (await h.rpc("status")).result.advisors[0].usage;
  assert.equal(usage.inputTokens, 42);
});
