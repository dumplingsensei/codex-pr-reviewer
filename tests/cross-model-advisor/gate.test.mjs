#!/usr/bin/env node
/**
 * The review gate end to end against real temporary git repositories and the
 * real read-only tools; only the model call is scripted. Imports bundled dist
 * modules, not unbundled source.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.join(here, "..", "..", "plugins", "cross-model-advisor", "dist", "modules");
const load = (rel) => import(pathToFileURL(path.join(modules, rel)).href);

const { runStop, runOn } = await load("gate.mjs");
const { recordPrompt, runOff, runStatus } = await load("control.mjs");
const { snapshotTree, turnDiff } = await load("snapshot.mjs");
const { validateConfig } = await load("config.mjs");

const scratchDirs = [];
after(async () => {
  for (const dir of scratchDirs) await fs.rm(dir, { recursive: true, force: true });
});

async function scratch(prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8"
  });
}

/**
 * A repository with one commit, plugin data, and a config directory.
 */
async function world({ gate, advisors, limits } = {}) {
  const root = await scratch("cma-gate-repo-");
  const data = await scratch("cma-gate-data-");
  const configDir = await scratch("cma-gate-cfg-");
  git(root, "init", "-q");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "a.js"), "export function last(items) {\n  return items[items.length - 1];\n}\n");
  await fs.writeFile(path.join(root, ".gitignore"), "build/\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  const config = validateConfig({
    version: 2,
    providers: { local: { kind: "api", provider: "openai", apiKeyEnv: "CMA_TEST_KEY" } },
    advisors: advisors ?? [
      { name: "correctness", provider: "local", model: "gpt-test", instructions: "check", enabled: true, reasoningEffort: "default" }
    ],
    exclude: [],
    ...(gate ? { gate } : {}),
    ...(limits ? { limits } : {})
  });
  const sessionId = `gate-${Math.random().toString(16).slice(2)}`;
  const env = {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: sessionId,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PROJECT_DIR: root,
    CLAUDE_CONFIG_DIR: configDir,
    CMA_TEST_KEY: "sk-test-key-value"
  };
  delete env.CLAUDE_SESSION_ID;
  const reviews = [];
  let script = async () => {};
  const deps = {
    loadConfig: async () => config,
    validateApi: async () => ({ available: true }),
    reviewApi: async (args) => {
      reviews.push(args);
      await script(args);
      return { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: "unknown" }, history: [] };
    }
  };
  await runOn(env, deps);
  let seq = 0;
  const w = {
    root,
    data,
    env,
    deps,
    reviews,
    config,
    setScript(fn) {
      script = fn;
    },
    async prompt(text, promptId = `p${++seq}`) {
      await recordPrompt({ session_id: sessionId, prompt: text, prompt_id: promptId }, { env });
      w.promptId = promptId;
      return promptId;
    },
    async stop(extra = {}) {
      const out = await runStop(
        { session_id: sessionId, prompt_id: w.promptId, last_assistant_message: "Done.", hook_event_name: "Stop", ...extra },
        { env, deps }
      );
      return out ? JSON.parse(out) : null;
    },
    status: () => runStatus(env)
  };
  return w;
}

const concern = (note, eventId = "diff:src/a.js") => async ({ tools }) => {
  const result = await tools.call("advise", {
    severity: "concern",
    note,
    evidence: [{ kind: "observation", eventId, detail: "seen in the diff" }]
  });
  assert.equal(result, "staged");
};

test("a turn without file changes is not reviewed", async () => {
  const w = await world();
  await w.prompt("explain last()");
  assert.equal(await w.stop(), null);
  assert.equal(w.reviews.length, 0);
  assert.equal((await w.status()).lastSkip.reason, "no file changes this turn");
});

test("a concern sends Claude back with the finding, and an unchanged rebuttal is accepted", async () => {
  const w = await world();
  await w.prompt("make last() safe on empty arrays");
  await fs.writeFile(path.join(w.root, "src", "a.js"), "export function last(items) {\n  return items[items.length];\n}\n");
  w.setScript(concern("items[items.length] reads past the end; use length - 1."));
  const out = await w.stop();
  assert.equal(out.decision, "block");
  assert.match(out.reason, /reads past the end/);
  assert.match(out.reason, /not the user/);
  assert.match(out.reason, /round 1 of at most 2/);
  const review = w.reviews[0];
  assert.equal(review.turn.request, "make last() safe on empty arrays");
  assert.equal(review.turn.final, "Done.");
  assert.equal(review.turn.diff.files[0].path, "src/a.js");
  assert.match(review.turn.diff.files[0].text, /items\[items\.length\]/);
  const status = await w.status();
  assert.equal(status.lastReview.outcome, "blocked");
  assert.equal(status.lastReview.findings[0].advisor, "correctness");

  // Claude rebuts without editing: the same diff is not reviewed again.
  assert.equal(await w.stop({ stop_hook_active: true }), null);
  assert.equal(w.reviews.length, 1);
  assert.equal((await w.status()).lastReview.outcome, "blocked");
});

test("a later round sees the earlier findings, and the round limit lets Claude stop", async () => {
  const w = await world({ gate: { mode: "block", maxRounds: 2 } });
  await w.prompt("refactor");
  const file = path.join(w.root, "src", "a.js");
  w.setScript(concern("first problem"));
  await fs.appendFile(file, "// one\n");
  assert.equal((await w.stop()).decision, "block");

  w.setScript(concern("second problem"));
  await fs.appendFile(file, "// two\n");
  assert.equal((await w.stop({ stop_hook_active: true })).decision, "block");
  assert.equal(w.reviews[1].turn.round, 2);
  assert.deepEqual(w.reviews[1].turn.previous.map((item) => item.note), ["first problem"]);
  // Round 2 diffs from the prompt's snapshot, so it covers the whole turn.
  assert.match(w.reviews[1].turn.diff.files[0].text, /\/\/ one/);

  await fs.appendFile(file, "// three\n");
  const out = await w.stop({ stop_hook_active: true });
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /after 2 review rounds/);
  assert.equal(w.reviews.length, 2);
  assert.equal((await w.status()).lastReview.findings[0].note, "second problem");

  // A new prompt starts a fresh round count.
  await w.prompt("next task");
  await fs.appendFile(file, "// four\n");
  w.setScript(async () => {});
  assert.equal(await w.stop(), null);
  assert.equal(w.reviews.length, 3);
});

test("nits and report mode show findings to the user without sending Claude back", async () => {
  const w = await world();
  await w.prompt("tweak");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// tweak\n");
  w.setScript(async ({ tools }) => {
    await tools.call("advise", {
      severity: "nit",
      note: "comment wording",
      evidence: [{ kind: "observation", eventId: "diff:src/a.js", detail: "x" }]
    });
  });
  const nits = await w.stop();
  assert.equal(nits.decision, undefined);
  assert.match(nits.systemMessage, /\[nit\] correctness: comment wording/);

  const r = await world({ gate: { mode: "report", maxRounds: 2 } });
  await r.prompt("tweak");
  await fs.appendFile(path.join(r.root, "src", "a.js"), "// tweak\n");
  r.setScript(concern("real bug"));
  const reported = await r.stop();
  assert.equal(reported.decision, undefined);
  assert.match(reported.systemMessage, /\[concern\] correctness: real bug/);
  assert.equal((await r.status()).lastReview.outcome, "reported");
});

test("a failed review fails open and says so", async () => {
  const w = await world();
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  w.deps.reviewApi = async () => {
    const error = new Error("OAuth authentication failed");
    error.code = "auth";
    throw error;
  };
  const out = await w.stop();
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /review failed, so this turn was not reviewed/);
  const status = await w.status();
  assert.equal(status.lastReview.outcome, "failed");
  assert.match(status.advisors.correctness.lastError, /^auth:/);
});

test("a partial failure with no findings is not reported as a silent pass", async () => {
  const advisor = (name) => ({ name, provider: "local", model: "gpt-test", instructions: name, enabled: true, reasoningEffort: "default" });
  const w = await world({ advisors: [advisor("alpha"), advisor("beta")] });
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  const reviewApi = w.deps.reviewApi;
  w.deps.reviewApi = async (args) => {
    if (args.advisor.name === "alpha") return reviewApi(args);
    const error = new Error("rate limited");
    error.code = "rate_limit";
    throw error;
  };
  const out = await w.stop();
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /no findings, but one advisor did not review this turn \(beta: rate_limit:/);
  assert.doesNotMatch(out.systemMessage, /alpha/);
  assert.equal((await w.status()).lastReview.outcome, "passed");
});

test("queued advisors share the Stop hook's time, so a late one is recorded instead of the hook being killed", async () => {
  const advisor = (name) => ({ name, provider: "local", model: "gpt-test", instructions: name, enabled: true, reasoningEffort: "default" });
  const w = await world({ advisors: [advisor("alpha"), advisor("beta")], limits: { maxConcurrentAdvisors: 1, reviewTimeoutSeconds: 240 } });
  let clock = 1_000_000;
  w.deps.now = () => clock;
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  w.setScript(async () => {
    clock += 271_000;
  });
  const out = await w.stop();
  assert.deepEqual(w.reviews.map((args) => args.advisor.name), ["alpha"]);
  assert.match(out.systemMessage, /beta: timeout: the Stop hook's review time ran out/);
  const status = await w.status();
  assert.equal(status.advisors.beta.reviews, 0);
  assert.match(status.advisors.beta.lastError, /^timeout:/);
});

test("excluded files are never sent, and an excluded-only change is not reviewed", async () => {
  const w = await world();
  await w.prompt("rotate the key");
  await fs.writeFile(path.join(w.root, ".env"), "API_TOKEN=super-secret-value\n");
  assert.equal(await w.stop(), null);
  assert.equal(w.reviews.length, 0);
  assert.equal((await w.status()).lastSkip.reason, "only excluded files changed");

  await w.prompt("rotate the key and use it");
  await fs.writeFile(path.join(w.root, ".env"), "API_TOKEN=another-secret-value\n");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// uses the key\n");
  await w.stop();
  const turn = w.reviews[0].turn;
  assert.deepEqual(turn.diff.files.map((file) => file.path), ["src/a.js"]);
  assert.deepEqual(turn.diff.omitted, [".env"]);
  assert.doesNotMatch(JSON.stringify(turn), /another-secret-value/);
});

test("control commands, subagents, other prompts, and off are never reviewed", async () => {
  const w = await world();
  await w.prompt("/cross-model-advisor:status");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// during a control turn\n");
  assert.equal(await w.stop(), null);
  assert.equal((await w.status()).lastSkip.reason, "no snapshot for this prompt");

  await w.prompt("real work");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// work\n");
  assert.equal(await w.stop({ agent_id: "sub-1" }), null);
  assert.equal(await w.stop({ prompt_id: "someone-else" }), null);
  assert.equal(w.reviews.length, 0);

  await runOff(w.env);
  assert.equal(await w.stop(), null);
  assert.equal(w.reviews.length, 0);
});

test("advisors run in parallel and their findings merge by severity without duplicates", async () => {
  const advisor = (name) => ({ name, provider: "local", model: "gpt-test", instructions: name, enabled: true, reasoningEffort: "default" });
  const w = await world({ advisors: [advisor("alpha"), advisor("beta")] });
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  w.setScript(async ({ tools, advisor: who }) => {
    const add = (severity, note) =>
      tools.call("advise", { severity, note, evidence: [{ kind: "observation", eventId: "request", detail: "x" }] });
    if (who.name === "alpha") {
      await add("nit", "Shared   Finding");
      await add("concern", "alpha concern");
    } else {
      await add("blocker", "beta blocker");
      await add("nit", "shared finding");
    }
  });
  const out = await w.stop();
  assert.equal(out.decision, "block");
  const findings = (await w.status()).lastReview.findings;
  assert.deepEqual(findings.map((item) => item.severity), ["blocker", "concern", "nit"]);
  assert.equal(findings.filter((item) => /shared\s+finding/i.test(item.note)).length, 1);
  assert.ok(out.reason.indexOf("beta blocker") < out.reason.indexOf("alpha concern"));
  assert.match(out.reason, /Optional \(nits\)/);
});

test("invalid evidence is refused, so a finding cannot cite what the reviewer never saw", async () => {
  const w = await world();
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  let refused;
  w.setScript(async ({ tools }) => {
    refused = await tools.call("advise", {
      severity: "blocker",
      note: "made up",
      evidence: [{ kind: "file", path: "src/a.js", line: 1, detail: "never read" }]
    });
  });
  assert.equal(await w.stop(), null);
  assert.notEqual(refused, "staged");
  assert.equal((await w.status()).lastReview.outcome, "passed");
});

test("snapshots leave the user's index, HEAD, and staged work untouched and scope the diff to the turn", async () => {
  const w = await world();
  const a = path.join(w.root, "src", "a.js");
  await fs.appendFile(a, "// user's own uncommitted edit\n");
  git(w.root, "add", "src/a.js");
  const indexBefore = await fs.readFile(path.join(w.root, ".git", "index"));
  const headBefore = git(w.root, "rev-parse", "HEAD");
  const statusBefore = git(w.root, "status", "--porcelain");

  const base = await snapshotTree(w.root, w.data);
  await fs.writeFile(path.join(w.root, "src", "b.js"), "export const b = 1;\n");
  await fs.mkdir(path.join(w.root, "build"));
  await fs.writeFile(path.join(w.root, "build", "out.js"), "ignored\n");
  const beforeCommit = await snapshotTree(w.root, w.data);

  // Snapshotting changed nothing the user owns.
  assert.equal(git(w.root, "rev-parse", "HEAD"), headBefore);
  assert.deepEqual(await fs.readFile(path.join(w.root, ".git", "index")), indexBefore);
  assert.equal(git(w.root, "status", "--porcelain"), `${statusBefore}?? src/b.js\n`);
  assert.equal(git(w.root, "stash", "list"), "");

  // A commit during the turn does not change what the turn is measured against.
  git(w.root, "commit", "-qm", "claude committed during the turn");
  const head = await snapshotTree(w.root, w.data);
  assert.equal(head, beforeCommit);
  const diff = await turnDiff(w.root, base, head, { isExcluded: async () => false });
  assert.deepEqual(diff.files.map((file) => file.path), ["src/b.js"]);
  assert.doesNotMatch(JSON.stringify(diff), /user's own uncommitted edit|ignored/);
});

test("on refuses a project outside git", async () => {
  const dir = await scratch("cma-gate-nogit-");
  const data = await scratch("cma-gate-nogit-data-");
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "nogit", CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: dir, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  await assert.rejects(
    runOn(env, { loadConfig: async () => validateConfig({ version: 2, providers: {}, advisors: [] }), validateApi: async () => ({ available: true }) }),
    { code: "git" }
  );
});
