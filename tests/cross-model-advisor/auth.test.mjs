/**
 * OAuth credential store regressions: concurrency, logout races, provider
 * binding, symlinks, stale locks, and abortable queues. Imports bundled
 * dist modules; does not perform real logins or read user credential homes.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modules = path.join(repo, "plugins", "cross-model-advisor", "dist", "modules");
const { AuthError, createCredentialStore, credentialsDir } = await import(
  pathToFileURL(path.join(modules, "auth.mjs")).href
);

const scratchDirs = [];

async function scratch(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of scratchDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function envFor(dir) {
  return { CLAUDE_CONFIG_DIR: dir };
}

function oauthCred(extra = {}) {
  return {
    type: "oauth",
    access: extra.access ?? "access-token-one",
    refresh: extra.refresh ?? "refresh-token-one",
    expires: extra.expires ?? 1_700_000_000_000,
    ...extra
  };
}

function store(dir, slot = "codex", provider = "openai-codex") {
  return createCredentialStore({ env: envFor(dir), slot, provider });
}

function defer() {
  /** @type {(value?: unknown) => void} */
  let resolve;
  const promise = new Promise((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

function isAuth(error, code) {
  return error instanceof AuthError && error.code === code;
}

test("modify serializes refresh across independent stores", async () => {
  const dir = await scratch("cma-auth-conc-");
  const a = store(dir);
  const b = store(dir);
  await a.modify("openai-codex", async () => oauthCred({ access: "start-access", refresh: "start-refresh" }));
  const order = [];
  const first = defer();
  const release = defer();
  const one = a.modify("openai-codex", async (current) => {
    order.push("a-enter");
    first.resolve();
    await release.promise;
    order.push("a-write");
    return oauthCred({ access: "rotated-a", refresh: current.refresh });
  });
  await first.promise;
  const two = b.modify("openai-codex", async (current) => {
    order.push("b-enter");
    assert.equal(current.access, "rotated-a");
    return oauthCred({ access: "rotated-b", refresh: current.refresh });
  });
  release.resolve();
  await Promise.all([one, two]);
  assert.deepEqual(order, ["a-enter", "a-write", "b-enter"]);
  const final = await a.read("openai-codex");
  assert.equal(final.access, "rotated-b");
  assert.equal(final.refresh, "start-refresh");
});

test("logout waits for an in-flight locked refresh then removes it", async () => {
  const dir = await scratch("cma-auth-logout-");
  const writer = store(dir);
  const other = store(dir);
  await writer.modify("openai-codex", async () => oauthCred({ access: "live-access", refresh: "live-refresh" }));
  const entered = defer();
  const release = defer();
  const refresh = writer.modify("openai-codex", async (current) => {
    entered.resolve();
    await release.promise;
    return oauthCred({ access: "refreshed-access", refresh: current.refresh });
  });
  await entered.promise;
  let logoutDone = false;
  const logout = other.delete("openai-codex").then(() => {
    logoutDone = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(logoutDone, false);
  release.resolve();
  await refresh;
  await logout;
  assert.equal(await writer.read("openai-codex"), undefined);
});

test("a lock released while another process polls it is waited for, not reported stale", async () => {
  // Between a waiter's lstat of owner.json and its read, the holder can release
  // the lock. That once read as a malformed owner and failed with stale-lock.
  // Eight processes contending for one slot hit that window every few hundred
  // acquisitions.
  const dir = await scratch("cma-auth-contend-");
  // A shared start time, so process startup does not stagger the contention.
  const startAt = Date.now() + 1500;
  const worker = `
    const { createCredentialStore } = await import(${JSON.stringify(pathToFileURL(path.join(modules, "auth.mjs")).href)});
    const store = createCredentialStore({ env: { CLAUDE_CONFIG_DIR: ${JSON.stringify(dir)} }, slot: "codex", provider: "openai-codex" });
    const errors = [];
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ${startAt} - Date.now())));
    for (let i = 0; i < 150; i += 1) {
      await store.modify("openai-codex", async () => ({ type: "oauth", access: "a" + i, refresh: "r" + i, expires: 1e13 }))
        .catch((error) => errors.push(error.code));
    }
    process.stdout.write(JSON.stringify(errors));
  `;
  const { execFile } = await import("node:child_process");
  const run = () =>
    new Promise((resolve, reject) =>
      execFile(process.execPath, ["--input-type=module", "-e", worker], (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout))))
    );
  const errors = (await Promise.all(Array.from({ length: 8 }, run))).flat();
  assert.deepEqual(errors, []);
});

test("locked refresh does not overwrite a later login", async () => {
  const dir = await scratch("cma-auth-login-");
  const a = store(dir);
  const b = store(dir);
  await a.modify("openai-codex", async () => oauthCred({ access: "old-access", refresh: "old-refresh" }));
  const entered = defer();
  const release = defer();
  const refresh = a.modify("openai-codex", async (current) => {
    entered.resolve();
    await release.promise;
    return oauthCred({ access: "stale-refresh-access", refresh: current.refresh });
  });
  await entered.promise;
  const login = b.modify("openai-codex", async () =>
    oauthCred({ access: "new-login-access", refresh: "new-login-refresh" })
  );
  release.resolve();
  await Promise.all([refresh, login]);
  const final = await a.read("openai-codex");
  assert.equal(final.access, "new-login-access");
  assert.equal(final.refresh, "new-login-refresh");
});

test("modify of a logged-out slot sees undefined and can decline to write", async () => {
  const dir = await scratch("cma-auth-empty-");
  const a = store(dir);
  await a.modify("openai-codex", async () => oauthCred());
  await a.delete("openai-codex");
  const result = await a.modify("openai-codex", async (current) => {
    assert.equal(current, undefined);
    return undefined;
  });
  assert.equal(result, undefined);
  assert.equal(await a.read("openai-codex"), undefined);
});

test("missing private credential paths mean no credential", async () => {
  const dir = await scratch("cma-auth-missing-");
  const a = store(dir);
  assert.equal(await a.read("openai-codex"), undefined);
  assert.deepEqual(await a.list(), []);
});

test("provider binding does not reuse another upstream credential", async () => {
  const dir = await scratch("cma-auth-bind-");
  const codex = store(dir, "shared", "openai-codex");
  await codex.modify("openai-codex", async () =>
    oauthCred({ access: "codex-access", refresh: "codex-refresh" })
  );
  const copilot = store(dir, "shared", "github-copilot");
  assert.equal(await copilot.read("github-copilot"), undefined);
  assert.equal(await copilot.read("openai-codex"), undefined);
  assert.deepEqual(await copilot.list(), []);
  await copilot.modify("github-copilot", async (current) => {
    assert.equal(current, undefined);
    return oauthCred({ access: "copilot-access", refresh: "copilot-refresh" });
  });
  assert.equal((await copilot.read("github-copilot")).access, "copilot-access");
  assert.equal(await codex.read("openai-codex"), undefined);
  await assert.rejects(
    () => copilot.modify("openai-codex", async () => oauthCred()),
    (error) => isAuth(error, "provider")
  );
  await assert.rejects(
    () => copilot.delete("openai-codex"),
    (error) => isAuth(error, "provider")
  );
});

test("logout deletes a slot file bound to a previous upstream", async () => {
  const dir = await scratch("cma-auth-rebind-");
  const codex = store(dir, "shared", "openai-codex");
  await codex.modify("openai-codex", async () =>
    oauthCred({ access: "old-codex-access", refresh: "old-codex-refresh" })
  );
  const copilot = store(dir, "shared", "github-copilot");
  assert.equal(await copilot.read("github-copilot"), undefined);
  await copilot.delete("github-copilot");
  const file = path.join(credentialsDir(envFor(dir)), "shared.json");
  await assert.rejects(() => fs.lstat(file), (error) => error && error.code === "ENOENT");
  assert.equal(await codex.read("openai-codex"), undefined);
});

test("extra credential metadata is copied not shared", async () => {
  const dir = await scratch("cma-auth-meta-");
  const a = store(dir);
  const account = { id: "acct-1", tags: ["primary"] };
  const saved = await a.modify("openai-codex", async () => oauthCred({ account }));
  account.id = "mutated-src";
  account.tags.push("mutated-src");
  saved.account.id = "mutated-ret";
  saved.account.tags.push("mutated-ret");
  const read = await a.read("openai-codex");
  assert.equal(read.account.id, "acct-1");
  assert.deepEqual(read.account.tags, ["primary"]);
  read.account.id = "mutated-read";
  const again = await a.read("openai-codex");
  assert.equal(again.account.id, "acct-1");
});

test("symlink credential files and directories fail closed", async () => {
  const dir = await scratch("cma-auth-link-");
  const target = path.join(dir, "elsewhere.json");
  await fs.writeFile(target, `${JSON.stringify({ v: 1, provider: "openai-codex", credential: oauthCred() })}\n`);
  const credRoot = credentialsDir(envFor(dir));
  const pluginDir = path.dirname(credRoot);
  await fs.mkdir(credRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(pluginDir, 0o700);
  await fs.chmod(credRoot, 0o700);
  await fs.symlink(target, path.join(credRoot, "codex.json"));
  const a = store(dir);
  await assert.rejects(() => a.read("openai-codex"), (error) => isAuth(error, "symlink"));
  await assert.rejects(
    () => a.modify("openai-codex", async () => oauthCred()),
    (error) => isAuth(error, "symlink")
  );

  const other = path.join(dir, "other-creds");
  await fs.mkdir(other, { recursive: true, mode: 0o700 });
  await fs.rm(credRoot, { recursive: true, force: true });
  await fs.symlink(other, credRoot);
  const linkedStore = store(dir);
  await assert.rejects(() => linkedStore.read("openai-codex"), (error) => isAuth(error, "symlink"));
  await assert.rejects(() => linkedStore.list(), (error) => isAuth(error, "symlink"));
  await assert.rejects(
    () => linkedStore.modify("openai-codex", async () => oauthCred()),
    (error) => isAuth(error, "symlink")
  );
});

test("symlink plugin directory fails closed on read", async () => {
  const dir = await scratch("cma-auth-plugin-link-");
  const a = store(dir);
  await a.modify("openai-codex", async () => oauthCred());
  const pluginDir = path.join(dir, "cross-model-advisor");
  const moved = path.join(dir, "moved-plugin");
  await fs.rename(pluginDir, moved);
  await fs.symlink(moved, pluginDir);
  await assert.rejects(() => a.read("openai-codex"), (error) => isAuth(error, "symlink"));
  await assert.rejects(() => a.list(), (error) => isAuth(error, "symlink"));
});

test("oversized credential files fail closed", async () => {
  const dir = await scratch("cma-auth-size-");
  const a = store(dir);
  await a.modify("openai-codex", async () => oauthCred());
  const file = path.join(credentialsDir(envFor(dir)), "codex.json");
  await fs.writeFile(file, `${"x".repeat(32 * 1024 + 2)}\n`, { mode: 0o600 });
  await assert.rejects(() => a.read("openai-codex"), (error) => isAuth(error, "storage"));
});

test("stale lock owners fail closed and are not stolen", async () => {
  const dir = await scratch("cma-auth-lock-");
  const a = store(dir);
  await a.modify("openai-codex", async () => oauthCred());
  const lockPath = path.join(credentialsDir(envFor(dir)), "codex.lock");
  await fs.mkdir(lockPath, { recursive: true, mode: 0o700 });
  const deadToken = "dead-owner-token-value-32b";
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ pid: 2_147_483_647, token: deadToken, startedAt: Date.now() })}\n`,
    { mode: 0o600 }
  );
  await assert.rejects(
    () => a.modify("openai-codex", async (current) => current),
    (error) => isAuth(error, "stale-lock")
  );
  const deadOwner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
  assert.equal(deadOwner.token, deadToken);
  assert.equal(deadOwner.pid, 2_147_483_647);
  assert.equal((await a.read("openai-codex")).access, "access-token-one");

  await fs.rm(lockPath, { recursive: true, force: true });
  await fs.mkdir(lockPath, { recursive: true, mode: 0o700 });
  const liveToken = "live-owner-token-value-32bxx";
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ pid: process.pid, token: liveToken, startedAt: Date.now() })}\n`,
    { mode: 0o600 }
  );
  const abort = AbortSignal.timeout(150);
  await assert.rejects(
    () => a.modify("openai-codex", async (current) => current, { signal: abort }),
    (error) => error?.name === "TimeoutError" || error?.name === "AbortError" || error?.code === "abort"
  );
  const liveOwner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
  assert.equal(liveOwner.token, liveToken);
  assert.equal(liveOwner.pid, process.pid);
  await fs.rm(lockPath, { recursive: true, force: true });
});

test("queued modify abort returns promptly and skips the callback", async () => {
  const dir = await scratch("cma-auth-abort-");
  const a = store(dir);
  await a.modify("openai-codex", async () => oauthCred({ access: "start-access", refresh: "start-refresh" }));
  const entered = defer();
  const release = defer();
  let secondRan = false;
  const first = a.modify("openai-codex", async (current) => {
    entered.resolve();
    await release.promise;
    return oauthCred({ access: "first-done", refresh: current.refresh });
  });
  await entered.promise;
  const ac = new AbortController();
  const started = Date.now();
  const second = a.modify(
    "openai-codex",
    async () => {
      secondRan = true;
      return oauthCred({ access: "should-not-write", refresh: "should-not-write" });
    },
    { signal: ac.signal }
  );
  ac.abort();
  await assert.rejects(
    second,
    (error) => error?.name === "AbortError" || error?.code === "abort"
  );
  assert.equal(Date.now() - started < 200, true);
  assert.equal(secondRan, false);
  release.resolve();
  await first;
  const final = await a.read("openai-codex");
  assert.equal(final.access, "first-done");
});
