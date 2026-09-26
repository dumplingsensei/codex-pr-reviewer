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

const { runStop, runOn, runReview, runAdvise } = await load("gate.mjs");
const { recordPrompt, runOff, runStatus, runSessionStart } = await load("control.mjs");
const { reviewBaseTree, snapshotTree, turnDiff } = await load("snapshot.mjs");
const { validateConfig } = await load("config.mjs");
const { loadState, updateState } = await load("session/state.mjs");

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
  let clock = () => Date.now();
  const deps = {
    now: () => clock(),
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
    /** Every hook's clock from now on. */
    setClock(fn) {
      clock = fn;
    },
    stateDir: path.join(data, "sessions", sessionId),
    async prompt(text, promptId = `p${++seq}`) {
      const out = await recordPrompt({ session_id: sessionId, prompt: text, prompt_id: promptId }, { env, now: deps.now });
      w.promptOut = out ? JSON.parse(out) : null;
      w.promptId = promptId;
      return promptId;
    },
    /** advise mode's background hook, with the payload the Stop gate got */
    advise(extra = {}, options = {}) {
      return runAdvise(
        { session_id: sessionId, prompt_id: w.promptId, last_assistant_message: "Done.", hook_event_name: "Stop", ...extra },
        { env, deps, pollMs: 5, waitMs: 2_000, ...options }
      );
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

const finding = (severity, note) => async ({ tools }) => {
  const result = await tools.call("advise", {
    severity,
    note,
    evidence: [{ kind: "observation", eventId: "diff:src/a.js", detail: "seen in the diff" }]
  });
  assert.equal(result, "staged");
};

/** The prompt Claude Code submits when an asyncRewake hook wakes Claude. */
const wakePrompt = (stderr) =>
  `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": ${stderr}\n</system-reminder>`;

const concern = (note, eventId = "diff:src/a.js") => async ({ tools }) => {
  const result = await tools.call("advise", {
    severity: "concern",
    note,
    evidence: [{ kind: "observation", eventId, detail: "seen in the diff" }]
  });
  assert.equal(result, "staged");
};

test("state updates from overlapping processes all land, and a dead holder's lock clears", async () => {
  const dir = await scratch("cma-state-lock-");
  const worker = `
    const { updateState } = await import(${JSON.stringify(pathToFileURL(path.join(modules, "session", "state.mjs")).href)});
    for (let i = 0; i < 10; i += 1) {
      await updateState(process.argv[1], (state) => {
        const entry = (state.advisors.counter ??= { reviews: 0, usage: null, lastError: null });
        entry.reviews += 1;
      });
    }`;
  const { spawn } = await import("node:child_process");
  await Promise.all(
    Array.from({ length: 8 }, () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", worker, dir], { stdio: "inherit" });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
      })
    )
  );
  assert.equal((await loadState(dir)).advisors.counter.reviews, 80);

  // A holder that died without releasing: its pid is gone.
  await fs.writeFile(path.join(dir, "state.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, token: "dead" }));
  const started = Date.now();
  await updateState(dir, (state) => {
    state.enabled = true;
  });
  assert.ok(Date.now() - started < 2_000);
  assert.equal((await loadState(dir)).enabled, true);
  await assert.rejects(fs.access(path.join(dir, "state.lock")));
});

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
  // The user sees the findings too, not only Claude's reply to them.
  assert.equal(out.systemMessage, "cross-model-advisor: sent Claude back with 1 finding (round 1 of at most 2)\n- [concern] correctness: items[items.length] reads past the end; use length - 1.");
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
  assert.equal((await w.stop()).decision, undefined);
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

test("a clean review says which advisors found nothing", async () => {
  const w = await world();
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  const out = await w.stop();
  assert.equal(out.decision, undefined);
  assert.equal(out.systemMessage, "cross-model-advisor: no findings from correctness");
  assert.equal((await w.status()).lastReview.outcome, "passed");
});

test("a changed turn the gate cannot review tells the user instead of passing silently", async () => {
  const cases = [
    ["snapshotTree", "could not snapshot the working tree"],
    ["gitIgnoredPaths", "could not list the paths git ignores"],
    ["turnDiff", "could not compute the diff"]
  ];
  for (const [dep, why] of cases) {
    const w = await world();
    await w.prompt("change");
    await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
    w.deps[dep] = async () => {
      throw new Error("boom");
    };
    const out = await w.stop();
    assert.equal(out.decision, undefined, dep);
    assert.equal(out.systemMessage, `cross-model-advisor: this turn was not reviewed (${why})`, dep);
    assert.equal(w.reviews.length, 0, dep);
  }

  const unavailable = await world();
  await unavailable.prompt("change");
  await fs.appendFile(path.join(unavailable.root, "src", "a.js"), "// x\n");
  unavailable.deps.validateApi = async () => ({ available: false, error: "CMA_TEST_KEY is not set" });
  assert.equal(
    (await unavailable.stop()).systemMessage,
    "cross-model-advisor: this turn was not reviewed (correctness: CMA_TEST_KEY is not set)"
  );

  const capped = await world({ limits: { maxReviewsPerAdvisorPerSession: 1 } });
  await capped.prompt("change");
  await fs.appendFile(path.join(capped.root, "src", "a.js"), "// x\n");
  await capped.stop();
  await capped.prompt("change again");
  await fs.appendFile(path.join(capped.root, "src", "a.js"), "// y\n");
  assert.equal(
    (await capped.stop()).systemMessage,
    "cross-model-advisor: this turn was not reviewed (correctness: session review limit reached)"
  );
  assert.equal(capped.reviews.length, 1);
});

test("a prompt the prompt hook failed to snapshot is reported as not reviewed, after work or a control prompt", async () => {
  for (const before of ["earlier work", "/cross-model-advisor:status"]) {
    const w = await world();
    await w.prompt(before);
    await w.stop();
    // The hook failed for the next prompt, so it recorded nothing.
    w.promptId = "unrecorded";
    await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
    const out = await w.stop();
    assert.equal(out.decision, undefined, before);
    assert.equal(out.systemMessage, "cross-model-advisor: this turn was not reviewed (the prompt hook did not snapshot this prompt)", before);
    assert.equal(w.reviews.length, 0, before);
  }
});

test("a missed snapshot is reported without prompt ids, and on the first prompt after /on", async () => {
  const notice = "cross-model-advisor: this turn was not reviewed (the prompt hook did not snapshot this prompt)";

  // /on's own turn stays quiet; the next prompt's hook fails.
  const first = await world();
  assert.equal(await first.stop(), null);
  await fs.appendFile(path.join(first.root, "src", "a.js"), "// x\n");
  assert.equal((await first.stop()).systemMessage, notice);
  // A continuation cannot fall back to an older baseline either.
  assert.equal((await first.stop({ stop_hook_active: true })).systemMessage, notice);
  assert.equal(first.reviews.length, 0);

  for (const before of ["earlier work", "/cross-model-advisor:status"]) {
    const w = await world();
    await w.prompt(before, null);
    await w.stop();
    const reviews = w.reviews.length;
    await fs.appendFile(path.join(w.root, "src", "a.js"), "// y\n");
    assert.equal((await w.stop()).systemMessage, notice, before);
    assert.equal(w.reviews.length, reviews, before);
  }
});

test("a message sent before the turn's Stop extends the turn instead of moving its baseline", async () => {
  const paths = (review) => review.turn.diff.files.map((file) => file.path).sort();

  // Typed mid-turn: Claude Code submits it with the same prompt id.
  const typed = await world();
  await typed.prompt("make last() safe", "p1");
  await fs.appendFile(path.join(typed.root, "src", "a.js"), "// first edit\n");
  await typed.prompt("also add b.js", "p1");
  await fs.writeFile(path.join(typed.root, "src", "b.js"), "export const b = 1;\n");
  await typed.stop();
  assert.deepEqual(paths(typed.reviews[0]), ["src/a.js", "src/b.js"]);
  assert.match(typed.reviews[0].turn.request, /^make last\(\) safe\n\n\[Also sent during this turn\]\nalso add b\.js$/);

  // An interrupted turn gets no Stop, so its edits are reviewed with the next prompt's.
  const interrupted = await world();
  await interrupted.prompt("first task", "p1");
  await fs.appendFile(path.join(interrupted.root, "src", "a.js"), "// interrupted\n");
  await interrupted.prompt("second task", "p2");
  await fs.writeFile(path.join(interrupted.root, "src", "b.js"), "export const b = 1;\n");
  assert.equal((await interrupted.stop()).systemMessage, "cross-model-advisor: no findings from correctness");
  assert.deepEqual(paths(interrupted.reviews[0]), ["src/a.js", "src/b.js"]);

  // A message sent while Claude works on findings keeps the blocked turn open.
  const blocked = await world();
  await blocked.prompt("change a.js", "p1");
  await fs.appendFile(path.join(blocked.root, "src", "a.js"), "// needs work\n");
  blocked.setScript(concern("real bug"));
  assert.equal((await blocked.stop()).decision, "block");
  await blocked.prompt("also add b.js", "p1");
  await fs.writeFile(path.join(blocked.root, "src", "b.js"), "export const b = 1;\n");
  blocked.setScript(async () => {});
  await blocked.stop({ stop_hook_active: true });
  assert.deepEqual(paths(blocked.reviews[1]), ["src/a.js", "src/b.js"]);

  // Once a Stop lets Claude stop, the next prompt starts a new turn.
  await blocked.prompt("next task", "p2");
  await fs.writeFile(path.join(blocked.root, "src", "c.js"), "export const c = 1;\n");
  await blocked.stop();
  assert.deepEqual(paths(blocked.reviews[2]), ["src/c.js"]);
  assert.equal(blocked.reviews[2].turn.request, "next task");
});

test("advisors read the reviewed snapshot even when files change during the review", async () => {
  const w = await world();
  await w.prompt("change");
  await fs.writeFile(path.join(w.root, "src", "a.js"), "REVIEWED\n");
  let seen;
  w.setScript(async ({ tools }) => {
    await fs.writeFile(path.join(w.root, "src", "a.js"), "EDITED_DURING_REVIEW\n");
    seen = await tools.call("read", { path: "src/a.js" });
  });
  await w.stop();
  assert.equal(seen, "1|REVIEWED");
});

test("advise mode: Claude stops at once, and a blocker found in the background wakes it and is shown to the user", async () => {
  const w = await world({ gate: { mode: "advise", maxRounds: 2 } });
  await w.prompt("make last() safe");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  w.setScript(finding("blocker", "last() now reads past the end"));
  assert.equal(await w.stop(), null);
  assert.equal(w.reviews.length, 0);
  const wake = await w.advise();
  assert.equal(w.reviews.length, 1);
  assert.match(wake, /^\[cross-model-advisor background review\] /);
  assert.match(wake, /reads past the end/);
  assert.match(wake, /finish that first/);
  assert.match(wake, /Begin your reply by telling the user/);
  assert.equal((await w.status()).lastReview.outcome, "woke");
  // Claude Code submits the wake as a prompt: the user gets the card; Claude already has the findings.
  await w.prompt(wakePrompt(wake));
  assert.match(w.promptOut.systemMessage, /a background review woke Claude with 1 finding on an earlier turn \(wake 1 of at most 2\)\n- \[blocker\] correctness: last\(\) now reads past the end/);
  assert.equal(w.promptOut.hookSpecificOutput, undefined);
});

test("advise mode: other findings reach the user and Claude once, with the next prompt", async () => {
  const w = await world({ gate: { mode: "advise", maxRounds: 2 } });
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  w.setScript(finding("concern", "real bug"));
  assert.equal(await w.stop(), null);
  assert.equal(await w.advise(), null);
  await w.prompt("next task");
  assert.match(w.promptOut.systemMessage, /1 finding from the background review of an earlier turn\n- \[concern\] correctness: real bug/);
  const context = w.promptOut.hookSpecificOutput.additionalContext;
  assert.match(context, /unverified claims/);
  assert.match(context, /- \[concern\] correctness: real bug \(evidence: diff:src\/a\.js/);
  assert.equal(w.promptOut.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  await w.stop();
  await w.prompt("another");
  assert.equal(w.promptOut, null);
});

test("advise mode: a result that lands mid-turn is shown at that turn's Stop, and Claude gets it with the next prompt", async () => {
  const w = await world({ gate: { mode: "advise", maxRounds: 2 } });
  await w.prompt("first");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  w.setScript(finding("nit", "comment wording"));
  await w.stop();
  await w.prompt("second");
  assert.equal(w.promptOut, null);
  assert.equal(await w.advise({ prompt_id: "p1" }), null);
  const shown = await w.stop();
  assert.match(shown.systemMessage, /1 finding from the background review of an earlier turn/);
  await w.prompt("third");
  assert.equal(w.promptOut.systemMessage, undefined);
  assert.match(w.promptOut.hookSpecificOutput.additionalContext, /comment wording/);
});

test("advise mode: the background review wakes Claude at most maxRounds times before the user's next prompt", async () => {
  const w = await world({ gate: { mode: "advise", maxRounds: 1 } });
  const file = path.join(w.root, "src", "a.js");
  await w.prompt("change");
  await fs.appendFile(file, "// one\n");
  w.setScript(finding("blocker", "first blocker"));
  await w.stop();
  const wake = await w.advise();
  assert.ok(wake);

  // The turn Claude was woken for is reviewed with the findings that woke it, but cannot wake it again.
  await w.prompt(wakePrompt(wake));
  await fs.appendFile(file, "// two\n");
  w.setScript(finding("blocker", "second blocker"));
  await w.stop({ stop_hook_active: true });
  assert.equal(await w.advise({ stop_hook_active: true }), null);
  assert.deepEqual(w.reviews[1].turn.previous.map((item) => item.note), ["first blocker"]);
  assert.equal((await w.status()).lastReview.reason, "the wake limit was reached");

  // The user's own prompt shows what was held back and allows a wake again.
  await w.prompt("carry on");
  assert.match(w.promptOut.systemMessage, /not waking Claude again before your next prompt \(limit 1\)/);
  await fs.appendFile(file, "// three\n");
  w.setScript(finding("blocker", "third blocker"));
  await w.stop();
  assert.match(await w.advise(), /third blocker/);
});

test("advise mode: the background review waits for the Stop gate, and ends at once when there is nothing to review", async () => {
  const w = await world({ gate: { mode: "advise", maxRounds: 2 } });
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  w.setScript(finding("concern", "found after waiting"));
  // Both Stop hooks start together; the background one must not run first.
  const pending = w.advise({}, { waitMs: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(w.reviews.length, 0);
  await w.stop();
  assert.equal(await pending, null);
  assert.equal(w.reviews.length, 1);

  await w.prompt("explain it");
  await w.stop();
  let started = Date.now();
  assert.equal(await w.advise({}, { waitMs: 10_000 }), null);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(w.reviews.length, 1);

  const blocking = await world();
  await blocking.prompt("change");
  await fs.appendFile(path.join(blocking.root, "src", "a.js"), "// x\n");
  started = Date.now();
  assert.equal(await blocking.advise({}, { waitMs: 10_000 }), null);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(blocking.reviews.length, 0);
});

test("advise mode: a background review that fails is reported as not reviewed with the next prompt", async () => {
  const w = await world({ gate: { mode: "advise", maxRounds: 2 } });
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  w.deps.reviewApi = async () => {
    const error = new Error("OAuth authentication failed");
    error.code = "auth";
    throw error;
  };
  await w.stop();
  assert.equal(await w.advise(), null);
  await w.prompt("next");
  assert.match(w.promptOut.systemMessage, /the background review failed, so an earlier turn was not reviewed \(correctness: auth:/);
  assert.equal((await w.status()).lastReview.outcome, "failed");
  // Not reviewed, so the diff is free to be reviewed again.
  assert.deepEqual((await loadState(w.stateDir)).reviewed, []);
});

test("advise mode: two Stops that share a key are both reviewed", async () => {
  const w = await world({ gate: { mode: "advise", maxRounds: 2 } });
  const file = path.join(w.root, "src", "a.js");
  w.setScript(async () => {});
  // No prompt ids and the same final message: both Stops have one key.
  await w.prompt("first", null);
  await fs.appendFile(file, "// one\n");
  await w.stop();
  await w.prompt("second", null);
  await fs.appendFile(file, "// two\n");
  await w.stop();
  assert.deepEqual(await Promise.all([w.advise(), w.advise()]), [null, null]);
  assert.deepEqual(w.reviews.map((review) => review.turn.request).sort(), ["first", "second"]);
  assert.deepEqual((await loadState(w.stateDir)).advise.stops, []);
});

test("advise mode: a Stop whose job is taken before it finishes leaves no stray marker", async () => {
  const w = await world({ gate: { mode: "advise", maxRounds: 2 } });
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  // Slow config loads: the background hook takes the job while the Stop gate
  // is still loading config for its last step.
  w.deps.loadConfig = async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return w.config;
  };
  const background = w.advise({}, { waitMs: 10_000 });
  await w.stop();
  assert.equal(await background, null);
  assert.equal(w.reviews.length, 1);
  // A marker left here could be taken by a later Stop that shares this key.
  assert.deepEqual((await loadState(w.stateDir)).advise.stops, []);
});

test("advise mode: a job no background hook took, or one whose hook never finished, is reported as not reviewed", async () => {
  const minutes = (n) => n * 60_000;
  const w = await world({ gate: { mode: "advise", maxRounds: 2 } });
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  // The background hook gave up before the Stop gate finished measuring.
  assert.equal(await w.advise({}, { waitMs: 20 }), null);
  await w.stop();
  assert.equal(w.reviews.length, 0);
  await w.prompt("soon after");
  assert.equal(w.promptOut, null);
  w.setClock(() => Date.now() + minutes(3));
  await w.prompt("later");
  assert.match(w.promptOut.systemMessage, /an earlier turn was not reviewed in the background \(no background review picked it up\)/);
  let state = await loadState(w.stateDir);
  assert.deepEqual([state.advise.stops, state.reviewed], [[], []]);

  // Taken, but its hook was killed before saving a result.
  w.setClock(() => Date.now());
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// y\n");
  await w.stop();
  await updateState(w.stateDir, (fresh) => {
    fresh.advise.stops[0].claimedAt = Date.now();
    fresh.advise.stops[0].job.status = "running";
  });
  w.setClock(() => Date.now() + minutes(4));
  await w.prompt("still waiting");
  assert.equal(w.promptOut, null);
  w.setClock(() => Date.now() + minutes(6));
  await w.prompt("much later");
  assert.match(w.promptOut.systemMessage, /not reviewed in the background \(the background review did not finish\)/);
  state = await loadState(w.stateDir);
  assert.deepEqual(state.advise.stops, []);
});

test("advise mode: a background review that cannot save its result says so", async () => {
  const w = await world({ gate: { mode: "advise", maxRounds: 2 } });
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  await w.stop();
  // Fails once the advisors are done, where the result is saved.
  w.setScript(async () => {
    w.setClock(() => {
      throw new Error("state could not be saved");
    });
  });
  assert.equal(await w.advise(), null);
  w.setClock(() => Date.now());
  await w.prompt("next");
  assert.match(w.promptOut.systemMessage, /not reviewed in the background \(the background review failed\)/);
  const state = await loadState(w.stateDir);
  assert.deepEqual([state.advise.stops, state.reviewed], [[], []]);
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
  assert.match(out.systemMessage, /no findings, but one advisor did not finish reviewing this turn \(beta: rate_limit:/);
  assert.doesNotMatch(out.systemMessage, /alpha/);
  assert.equal((await w.status()).lastReview.outcome, "passed");
});

test("a failed advisor is named to the user when the rest send Claude back or report findings", async () => {
  const advisor = (name) => ({ name, provider: "local", model: "gpt-test", instructions: name, enabled: true, reasoningEffort: "default" });
  const failBeta = (w) => {
    const reviewApi = w.deps.reviewApi;
    w.deps.reviewApi = async (args) => {
      if (args.advisor.name === "alpha") return reviewApi(args);
      const error = new Error("rate limited");
      error.code = "rate_limit";
      throw error;
    };
  };

  const blocked = await world({ advisors: [advisor("alpha"), advisor("beta")] });
  await blocked.prompt("change");
  await fs.appendFile(path.join(blocked.root, "src", "a.js"), "// x\n");
  blocked.setScript(concern("real bug"));
  failBeta(blocked);
  const out = await blocked.stop();
  assert.equal(out.decision, "block");
  assert.match(out.reason, /real bug/);
  assert.doesNotMatch(out.reason, /rate_limit/);
  const told = out.systemMessage.split("\n");
  assert.match(told[0], /sent Claude back with 1 finding \(round 1 of at most 2\)/);
  assert.match(told[1], /^- one advisor did not finish reviewing this turn \(beta: rate_limit:/);
  assert.match(told[2], /\[concern\] alpha: real bug/);

  const reported = await world({ advisors: [advisor("alpha"), advisor("beta")], gate: { mode: "report", maxRounds: 2 } });
  await reported.prompt("change");
  await fs.appendFile(path.join(reported.root, "src", "a.js"), "// x\n");
  reported.setScript(concern("real bug"));
  failBeta(reported);
  const summary = (await reported.stop()).systemMessage.split("\n");
  assert.match(summary[1], /^- one advisor did not finish reviewing this turn \(beta: rate_limit:/);
  assert.match(summary[2], /\[concern\] alpha: real bug/);

  const clean = await world({ advisors: [advisor("alpha"), advisor("beta")] });
  await clean.prompt("change");
  await fs.appendFile(path.join(clean.root, "src", "a.js"), "// x\n");
  clean.setScript(concern("real bug"));
  const cleanOut = await clean.stop();
  assert.equal(cleanOut.decision, "block");
  assert.doesNotMatch(cleanOut.systemMessage, /did not finish/);
});

test("findings an advisor reported before being cut off still count", async () => {
  const w = await world();
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  w.setScript(async (args) => {
    await concern("real bug")(args);
    const error = new Error("max tool calls per review exceeded");
    error.code = "audit";
    throw error;
  });
  const out = await w.stop();
  assert.equal(out.decision, "block");
  assert.match(out.reason, /real bug/);
  assert.match(out.systemMessage, /one advisor did not finish reviewing this turn \(correctness: audit: max tool calls/);
  const review = (await w.status()).lastReview;
  assert.equal(review.outcome, "blocked");
  assert.deepEqual(review.advisors.map(({ ok, findings }) => ({ ok, findings })), [{ ok: false, findings: 1 }]);
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
  assert.match(out.systemMessage, /beta: timeout: the review's time ran out before this advisor started/);
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

test("advisors cannot read files git ignores through .git/info/exclude", async () => {
  const w = await world();
  await fs.appendFile(path.join(w.root, ".git", "info", "exclude"), "local-secrets.yml\n");
  await fs.writeFile(path.join(w.root, "local-secrets.yml"), "INFO_EXCLUDE_SENTINEL\n");
  await w.prompt("change");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  const seen = [];
  w.setScript(async ({ tools }) => {
    seen.push(await tools.call("read", { path: "local-secrets.yml" }));
    seen.push(await tools.call("list", {}));
    seen.push(await tools.call("search", { query: "INFO_EXCLUDE_SENTINEL" }));
  });
  await w.stop();
  assert.equal(w.reviews.length, 1);
  assert.match(seen[0], /^Error:/);
  assert.doesNotMatch(seen[1], /local-secrets/);
  assert.doesNotMatch(seen[2], /local-secrets/);
});

test("a turn that only touches gate.skipWhenOnly files is skipped, a mixed turn is not", async () => {
  const w = await world({ gate: { mode: "block", maxRounds: 2, skipWhenOnly: ["*.md", "docs/**"] } });
  await w.prompt("fix the readme typo");
  await fs.writeFile(path.join(w.root, "README.md"), "# fixed\n");
  await fs.mkdir(path.join(w.root, "docs"));
  await fs.writeFile(path.join(w.root, "docs", "guide.txt"), "guide\n");
  assert.equal(await w.stop(), null);
  assert.equal(w.reviews.length, 0);
  assert.equal((await w.status()).lastSkip.reason, "only files matching gate.skipWhenOnly changed");

  await w.prompt("document and change last()");
  await fs.appendFile(path.join(w.root, "README.md"), "more\n");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// x\n");
  await w.stop();
  assert.equal(w.reviews.length, 1);
  assert.ok(w.reviews[0].turn.diff.files.some((file) => file.path === "README.md"));
});

test("gate.autoOn in the user's config turns the gate on at session start, and /off wins", async () => {
  const root = await scratch("cma-autoon-repo-");
  git(root, "init", "-q");
  await fs.writeFile(path.join(root, "a.js"), "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  const other = await scratch("cma-autoon-other-");
  git(other, "init", "-q");
  const configDir = await scratch("cma-autoon-cfg-");
  const data = await scratch("cma-autoon-data-");
  await fs.writeFile(
    path.join(configDir, "cross-model-advisor.json"),
    JSON.stringify({
      version: 2,
      providers: { local: { kind: "api", provider: "openai", apiKeyEnv: "CMA_TEST_KEY" } },
      advisors: [{ name: "correctness", provider: "local", model: "gpt-test", instructions: "check", enabled: true, reasoningEffort: "default" }],
      gate: { mode: "block", maxRounds: 2, autoOn: [root] }
    })
  );
  const envFor = (sessionId, projectDir) => {
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_CONFIG_DIR: configDir };
    delete env.CLAUDE_SESSION_ID;
    return env;
  };
  const start = (env, sessionId) => runSessionStart({ session_id: sessionId, hook_event_name: "SessionStart", source: "startup" }, { env });

  const listed = envFor("autoon-listed", root);
  const out = JSON.parse(await start(listed, "autoon-listed"));
  assert.match(out.systemMessage, /review gate on for .* \(gate\.autoOn\)/);
  assert.equal(out.additionalContext, undefined);
  const status = await runStatus(listed);
  assert.equal(status.enabled, true);
  assert.equal(status.projectRoot, await fs.realpath(root));

  await runOff(listed);
  assert.equal(await start(listed, "autoon-listed"), "");
  assert.equal((await runStatus(listed)).enabled, false);

  const unlisted = envFor("autoon-unlisted", other);
  assert.equal(await start(unlisted, "autoon-unlisted"), "");
  assert.equal((await runStatus(unlisted)).enabled, false);
});

test("an on-demand review covers uncommitted work, untracked files included, without touching the gate", async () => {
  const w = await world();
  await runOff(w.env);
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// uncommitted\n");
  await fs.writeFile(path.join(w.root, "src", "new.js"), "export const n = 1;\n");
  w.setScript(concern("real bug"));
  const report = await runReview(w.env, {}, w.deps);
  assert.equal(report.ok, true);
  assert.match(report.scope, /uncommitted/);
  assert.deepEqual(report.files.sort(), ["src/a.js", "src/new.js"]);
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0].note, /real bug/);
  assert.equal(w.reviews[0].turn.final, "");
  assert.match(w.reviews[0].turn.request, /On-demand review requested by the user/);
  const status = await w.status();
  assert.equal(status.enabled, false);
  assert.equal(status.lastReview, null);
  assert.equal(status.advisors.correctness.reviews, 1);
});

test("an on-demand review with --base covers the branch's commits and its uncommitted work", async () => {
  const w = await world();
  git(w.root, "tag", "start");
  git(w.root, "checkout", "-qb", "feature");
  await fs.writeFile(path.join(w.root, "src", "committed.js"), "export const c = 1;\n");
  git(w.root, "add", "-A");
  git(w.root, "commit", "-qm", "on the branch");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// uncommitted\n");
  const report = await runReview(w.env, { base: "start" }, w.deps);
  assert.match(report.scope, /everything since start/);
  assert.deepEqual(report.files.sort(), ["src/a.js", "src/committed.js"]);

  await assert.rejects(runReview(w.env, { base: "--output=/tmp/x" }, w.deps), (error) => error.code === "base");
  await assert.rejects(runReview(w.env, { base: "no-such-ref" }, w.deps), /not a commit/);
});

test("an on-demand review works in a repository with no commits, SHA-1 or SHA-256", async () => {
  for (const format of ["sha1", "sha256"]) {
    const root = await scratch(`cma-empty-${format}-`);
    const scratchDir = await scratch(`cma-empty-${format}-idx-`);
    git(root, "init", "-q", `--object-format=${format}`);
    await fs.writeFile(path.join(root, "first.js"), "export const x = 1;\n");
    const from = await reviewBaseTree(root, null);
    assert.equal(from.commit, null);
    const head = await snapshotTree(root, scratchDir);
    const diff = await turnDiff(root, from.tree, head, { isExcluded: async () => false });
    assert.deepEqual(diff.files.map((file) => file.path), ["first.js"], format);
  }
});

test("an on-demand review with nothing changed makes no model request", async () => {
  const w = await world();
  const report = await runReview(w.env, {}, w.deps);
  assert.equal(report.note, "nothing changed in this scope");
  assert.equal(w.reviews.length, 0);
});

test("control commands, subagents, other prompts, and off are never reviewed", async () => {
  const w = await world();
  await w.prompt("/cross-model-advisor:status");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// during a control turn\n");
  assert.equal(await w.stop(), null);
  assert.equal((await w.status()).lastSkip.reason, "control prompt");

  await w.prompt("real work");
  await fs.appendFile(path.join(w.root, "src", "a.js"), "// work\n");
  assert.equal(await w.stop({ agent_id: "sub-1" }), null);
  assert.match((await w.stop({ prompt_id: "someone-else" })).systemMessage, /not reviewed \(the prompt hook did not snapshot this prompt\)/);
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
  assert.equal((await w.stop()).systemMessage, "cross-model-advisor: no findings from correctness");
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
