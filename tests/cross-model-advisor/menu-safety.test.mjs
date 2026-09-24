/**
 * Menu safety regressions: captured apply target, env-selected auth helper
 * ignore, nonzero auth exit, abort teardown of a TERM-resistant child, and
 * enable-off messaging. Injected UI drives runSetupMenu; auth cases spawn
 * real children via authHelperPath. No paid auth or live sessions.
 *
 *   node --test tests/cross-model-advisor/menu-safety.test.mjs
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distModules = path.join(repo, "plugins", "cross-model-advisor", "dist", "modules");
const load = (rel) => import(pathToFileURL(path.join(distModules, rel)).href);
const { runSetupMenu } = await load("setup-menu.mjs");

const scratchDirs = [];

after(async () => {
  for (const dir of scratchDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function dumpItems(opts) {
  const items = (opts.items ?? []).map((item) => `${item.value}:${item.label}`).join(" | ");
  return `${opts.title}\n${items}`;
}

function pick(items, pattern) {
  const hit = (items ?? []).find((item) => {
    const hay = `${item.value ?? ""} ${item.label ?? ""} ${item.description ?? ""}`;
    return typeof pattern === "string" ? hay.includes(pattern) : pattern.test(hay);
  });
  if (!hit) {
    throw new Error(`no item matching ${pattern} in ${(items ?? []).map((item) => item.label).join(" | ")}`);
  }
  return hit;
}

function select(items, pattern) {
  return { action: "select", value: pick(items, pattern).value };
}

function isHome(opts) {
  return opts.toggle === true && String(opts.title ?? "").startsWith("Cross-model advisors");
}

function abortError(reason) {
  if (reason && reason.name === "AbortError") return reason;
  const error = new Error("aborted");
  error.name = "AbortError";
  error.code = "abort";
  if (reason instanceof Error) error.cause = reason;
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw abortError(signal.reason);
}

async function makeWorld(prefix) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}root-`)));
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}data-`)));
  const configDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}cfg-`)));
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}home-`)));
  scratchDirs.push(root, data, configDir, home);
  return {
    root,
    data,
    configDir,
    home,
    configFile: path.join(configDir, "cross-model-advisor.json"),
    sessionId: `safety-${randomUUID().slice(0, 8)}`
  };
}

function limits() {
  return {
    maxConcurrentAdvisors: 2,
    reviewTimeoutSeconds: 90,
    maxToolCallsPerReview: 8,
    maxOutputTokens: 1500,
    maxReviewsPerAdvisorPerSession: 40
  };
}

function apiConfig(overrides = {}) {
  return {
    version: 2,
    providers: {
      "openai-api": { kind: "api", provider: "openai", apiKeyEnv: "OPENAI_API_KEY" }
    },
    advisors: [
      {
        name: "correctness",
        provider: "openai-api",
        model: "gpt-old",
        instructions: "Look for observable correctness failures.",
        enabled: true,
        reasoningEffort: "default"
      }
    ],
    exclude: [],
    limits: limits(),
    ...overrides
  };
}

function oauthConfig(overrides = {}) {
  return {
    version: 2,
    providers: {
      "codex-login": { kind: "oauth", provider: "openai-codex" }
    },
    advisors: [
      {
        name: "correctness",
        provider: "codex-login",
        model: "gpt-5",
        instructions: "Look for observable correctness failures.",
        enabled: true,
        reasoningEffort: "default"
      }
    ],
    exclude: [],
    limits: limits(),
    ...overrides
  };
}

async function writeConfig(file, config) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function configEnv(world, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: world.home,
    CLAUDE_CONFIG_DIR: world.configDir,
    ...extra
  };
}

function sessionEnv(world, extra = {}) {
  return configEnv(world, {
    CLAUDE_PLUGIN_DATA: world.data,
    CLAUDE_PROJECT_DIR: world.root,
    CLAUDE_CODE_SESSION_ID: extra.sessionId ?? world.sessionId,
    CLAUDE_SESSION_ID: extra.sessionId ?? world.sessionId,
    ...extra
  });
}

function openFdStdio() {
  const stdinFd = fsSync.openSync(os.devNull, "r");
  const stdoutFd = fsSync.openSync(os.devNull, "w");
  const stderrFd = fsSync.openSync(os.devNull, "w");
  let closed = false;
  return {
    stdin: stdinFd,
    stdout: stdoutFd,
    stderr: stderrFd,
    close() {
      if (closed) return;
      closed = true;
      for (const fd of [stdinFd, stdoutFd, stderrFd]) {
        try {
          fsSync.closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    }
  };
}

function scriptedUi(handler, { signal } = {}) {
  const notices = [];
  let closed = 0;
  let suspends = 0;
  let reacquires = 0;
  let calls = 0;
  const ui = {
    notices,
    get closed() {
      return closed;
    },
    get suspends() {
      return suspends;
    },
    get reacquires() {
      return reacquires;
    },
    async choose(opts) {
      throwIfAborted(signal);
      calls += 1;
      if (calls > 80) throw new Error(`too many choose()\n${dumpItems(opts)}`);
      return handler("choose", opts, ui);
    },
    async text(opts) {
      throwIfAborted(signal);
      calls += 1;
      if (calls > 80) throw new Error(`too many text()\n${opts.title}`);
      return handler("text", opts, ui);
    },
    async confirm(opts) {
      throwIfAborted(signal);
      return handler("confirm", opts, ui);
    },
    async notice(opts) {
      notices.push(opts);
      if (typeof handler.notice === "function") await handler.notice(opts, ui);
    },
    async suspend(fn) {
      throwIfAborted(signal);
      suspends += 1;
      try {
        return await fn();
      } finally {
        reacquires += 1;
      }
    },
    close() {
      closed += 1;
    }
  };
  if (signal) {
    Object.defineProperty(ui, "signal", { value: signal, enumerable: true, writable: false });
  }
  return ui;
}

async function runMenu(world, ui, extra = {}) {
  const io =
    extra.stdin != null || extra.stdout != null || extra.stderr != null ? null : openFdStdio();
  try {
    return await runSetupMenu({
      env: extra.env ?? sessionEnv(world),
      stdin: extra.stdin ?? io.stdin,
      stdout: extra.stdout ?? io.stdout,
      stderr: extra.stderr ?? io.stderr,
      ui,
      getProviderCatalog: extra.getProviderCatalog ?? (async () => []),
      getSessionSettings:
        extra.getSessionSettings ??
        (async () => ({
          ok: false,
          error: "no-live"
        })),
      applySessionSettings:
        extra.applySessionSettings ??
        (async () => {
          throw new Error("applySessionSettings must not run");
        }),
      ...extra
    });
  } finally {
    io?.close();
  }
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

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeHelper(dir, name, source) {
  const file = path.join(dir, name);
  await fs.writeFile(file, source, { mode: 0o755 });
  return file;
}

function loginFlowUi(options = {}) {
  return scriptedUi((kind, opts, ui) => {
    if (kind === "choose" && isHome(opts)) {
      if (!ui._providers) {
        ui._providers = true;
        return select(opts.items, "Provider accounts");
      }
      return select(opts.items, "Quit");
    }
    if (kind === "choose" && opts.title === "Provider accounts") {
      if (!ui._slot) {
        ui._slot = true;
        return select(opts.items, "codex-login");
      }
      return null;
    }
    if (kind === "choose" && /Provider codex-login/.test(String(opts.title))) {
      if (!ui._login) {
        ui._login = true;
        return select(opts.items, "Login");
      }
      return null;
    }
    throw new Error(`unexpected ${kind}\n${dumpItems(opts)}`);
  }, options);
}

test("CMA_TEST_AUTH_HELPER cannot replace the injected auth helper", async () => {
  const world = await makeWorld("cma-ms-helper-");
  await writeConfig(world.configFile, oauthConfig());
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "cma-ms-helper-files-"));
  scratchDirs.push(work);
  const intendedMarker = path.join(work, "intended.json");
  const maliciousMarker = path.join(work, "malicious.txt");
  const intended = await writeHelper(
    work,
    "intended.mjs",
    `import fs from "node:fs";
const dest = process.env.CMA_SAFETY_INTENDED_MARKER;
if (dest) {
  fs.writeFileSync(
    dest,
    JSON.stringify({ execPath: process.execPath, argv: process.argv })
  );
}
process.exit(0);
`
  );
  const malicious = await writeHelper(
    work,
    "malicious.mjs",
    `#!/usr/bin/env node
import fs from "node:fs";
const dest = process.env.CMA_SAFETY_MALICIOUS_MARKER;
if (dest) fs.writeFileSync(dest, "ran");
process.exit(0);
`
  );
  const ui = loginFlowUi();
  const code = await runMenu(world, ui, {
    env: configEnv(world, {
      CMA_TEST_AUTH_HELPER: malicious,
      CMA_SAFETY_INTENDED_MARKER: intendedMarker,
      CMA_SAFETY_MALICIOUS_MARKER: maliciousMarker
    }),
    authHelperPath: intended
  });
  assert.equal(code, 0);
  assert.equal(await pathExists(maliciousMarker), false);
  const ran = JSON.parse(await fs.readFile(intendedMarker, "utf8"));
  assert.equal(ran.execPath, process.execPath);
  assert.equal(ran.argv[1], intended);
  assert.deepEqual(ran.argv.slice(2), ["login", "codex-login"]);
  assert.equal(ui.suspends, 1);
  assert.equal(ui.reacquires, 1);
});

test("nonzero auth helper exit surfaces failure", async () => {
  const world = await makeWorld("cma-ms-exit-");
  await writeConfig(world.configFile, oauthConfig());
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "cma-ms-exit-files-"));
  scratchDirs.push(work);
  const marker = path.join(work, "ran.json");
  const helper = await writeHelper(
    work,
    "failing.mjs",
    `import fs from "node:fs";
const dest = process.env.CMA_SAFETY_RAN_MARKER;
if (dest) fs.writeFileSync(dest, JSON.stringify({ argv: process.argv.slice(2) }));
process.exit(7);
`
  );
  const ui = loginFlowUi();
  const code = await runMenu(world, ui, {
    env: configEnv(world, { CMA_SAFETY_RAN_MARKER: marker }),
    authHelperPath: helper
  });
  assert.equal(code, 0);
  const ran = JSON.parse(await fs.readFile(marker, "utf8"));
  assert.deepEqual(ran.argv, ["login", "codex-login"]);
  const loginNotices = ui.notices.filter((note) => note.title === "Login");
  assert.ok(loginNotices.some((note) => note.text === "Auth helper failed."));
  assert.equal(
    loginNotices.some((note) => /enabled this session/i.test(note.text)),
    false
  );
});

test("abort kills a TERM-resistant auth child before the menu settles", { timeout: 15_000 }, async (t) => {
  const world = await makeWorld("cma-ms-abort-");
  await writeConfig(world.configFile, oauthConfig());
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "cma-ms-abort-files-"));
  scratchDirs.push(work);
  const readyFile = path.join(work, "ready.pid");
  const termFile = path.join(work, "term.flag");
  const helper = await writeHelper(
    work,
    "sticky.mjs",
    `import fs from "node:fs";
process.on("SIGTERM", () => {
  const dest = process.env.CMA_SAFETY_TERM_MARKER;
  if (dest) fs.writeFileSync(dest, "term");
});
process.on("SIGINT", () => {});
const ready = process.env.CMA_SAFETY_READY_FILE;
if (ready) fs.writeFileSync(ready, String(process.pid));
setInterval(() => {}, 1 << 30);
`
  );
  const controller = new AbortController();
  const ui = loginFlowUi({ signal: controller.signal });
  let pid = 0;
  const menuPromise = runMenu(world, ui, {
    env: configEnv(world, {
      CMA_SAFETY_READY_FILE: readyFile,
      CMA_SAFETY_TERM_MARKER: termFile
    }),
    authHelperPath: helper
  });
  t.after(() => {
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (!controller.signal.aborted) controller.abort();
  });
  try {
    pid = await waitUntil(async () => {
      try {
        const n = Number(await fs.readFile(readyFile, "utf8"));
        return Number.isInteger(n) && n > 0 ? n : false;
      } catch {
        return false;
      }
    }, 4000);
    let aliveAtSettle = true;
    const finished = menuPromise.then((code) => {
      aliveAtSettle = isAlive(pid);
      return code;
    });
    controller.abort();
    const code = await finished;
    assert.equal(code, 0);
    assert.equal(aliveAtSettle, false);
    assert.equal(isAlive(pid), false);
    assert.equal(await pathExists(termFile), true);
  } finally {
    if (!controller.signal.aborted) controller.abort();
    await menuPromise.catch(() => {});
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
});

