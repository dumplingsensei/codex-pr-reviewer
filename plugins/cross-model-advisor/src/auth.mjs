/**
 * Slot-scoped OAuth credential store. Implements the SDK CredentialStore
 * surface without importing the SDK. Credentials live under the config
 * directory, never in session state, and never borrowed from other tools.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { configFilePath } from "./config.mjs";
import { DIR_MODE, FILE_MODE, PLUGIN_NAME } from "./session/constants.mjs";
import { pidIsLive } from "./session/paths.mjs";

const IDENTIFIER_RE = /^[a-z][a-z0-9-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ENVELOPE_VERSION = 1;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_STRING = 16 * 1024;
const MAX_KEYS = 64;
const MAX_DEPTH = 3;
const LOCK_POLL_MS = 50;
const LOCK_WAIT_MS = 30_000;
const MISSING_OWNER_WAITS = 20;
const LOCK_OWNER_MAX_BYTES = 1024;
const CREDS_DIRNAME = "credentials";
const NOFOLLOW = fsSync.constants.O_NOFOLLOW || 0;
const O_CLOEXEC = fsSync.constants.O_CLOEXEC ?? 0;
const OPEN_READ = fsSync.constants.O_RDONLY | NOFOLLOW | O_CLOEXEC;
const OPEN_WRITE =
  fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | NOFOLLOW | O_CLOEXEC;

export class AuthError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function credentialsDir(env = process.env) {
  return path.join(path.dirname(configFilePath(env)), PLUGIN_NAME, CREDS_DIRNAME);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value) || FORBIDDEN_KEYS.has(value)) {
    throw new AuthError("identifier", `${label} is not a restricted identifier`);
  }
  return value;
}

/**
 * @param {AbortSignal | undefined} signal
 */
function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new AuthError("abort", "aborted");
  error.name = "AbortError";
  return error;
}

/**
 * @param {AbortSignal | undefined} signal
 */
function throwIfAborted(signal) {
  if (typeof signal?.throwIfAborted === "function") {
    signal.throwIfAborted();
  }
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 */
function abortableWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * @param {Promise<unknown>} promise
 * @param {AbortSignal | undefined} signal
 */
function waitForSettled(promise, signal) {
  const settled = promise.then(
    () => undefined,
    () => undefined
  );
  if (!signal) return settled;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    settled.then(() => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(abortReason(signal));
      else resolve();
    });
  });
}

/**
 * @param {unknown} value
 * @param {number} [depth]
 */
function isBoundedJson(value, depth = 0) {
  if (value === null) return true;
  if (typeof value === "string") return value.length <= MAX_STRING;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) {
    if (value.length > 256) return false;
    return value.every((item) => isBoundedJson(item, depth + 1));
  }
  if (typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const keys = Object.keys(value);
    if (keys.length > MAX_KEYS) return false;
    return keys.every(
      (key) =>
        typeof key === "string" &&
        key.length > 0 &&
        key.length <= 128 &&
        !FORBIDDEN_KEYS.has(key) &&
        (value[key] === undefined || isBoundedJson(value[key], depth + 1))
    );
  }
  return false;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function cloneOAuthCredential(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError("storage", "credential envelope is invalid");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new AuthError("storage", "credential envelope is invalid");
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.type !== "oauth") {
    throw new AuthError("storage", "credential envelope is invalid");
  }
  if (typeof record.access !== "string" || record.access.length > MAX_STRING) {
    throw new AuthError("storage", "credential envelope is invalid");
  }
  if (typeof record.refresh !== "string" || record.refresh.length === 0 || record.refresh.length > MAX_STRING) {
    throw new AuthError("storage", "credential envelope is invalid");
  }
  if (typeof record.expires !== "number" || !Number.isFinite(record.expires)) {
    throw new AuthError("storage", "credential envelope is invalid");
  }
  if (!isBoundedJson(record)) {
    throw new AuthError("storage", "credential envelope is invalid");
  }
  return structuredClone(record);
}

/**
 * @param {string} dir
 */
async function lstatOrNull(dir) {
  try {
    return await fs.lstat(dir);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * @param {import("node:fs").Stats | null | undefined} st
 * @param {string} label
 */
function refuseSymlink(st, label) {
  if (st?.isSymbolicLink()) {
    throw new AuthError("symlink", `${label} must not be a symlink`);
  }
}

/**
 * @param {import("node:fs").Stats | null | undefined} a
 * @param {import("node:fs").Stats | { dev: unknown, ino: unknown } | null | undefined} b
 */
function sameIdent(a, b) {
  return Boolean(a && b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino));
}

/**
 * @param {unknown} error
 * @param {string} label
 */
function mapFsError(error, label) {
  if (error instanceof AuthError) return error;
  if (error && (error.code === "ELOOP" || error.code === "EMLINK")) {
    return new AuthError("symlink", `${label} must not be a symlink`);
  }
  return error;
}

/**
 * @param {import("node:fs").Stats} st
 * @param {string} label
 */
function assertPrivateMode(st, label) {
  if ((st.mode & 0o077) !== 0) {
    throw new AuthError("storage", `${label} is not private`);
  }
}

/**
 * @param {string} dir
 */
async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  const st = await fs.lstat(dir);
  refuseSymlink(st, "credential directory");
  if (!st.isDirectory()) {
    throw new AuthError("storage", "credential path is not a directory");
  }
  try {
    await fs.chmod(dir, DIR_MODE);
  } catch {
    throw new AuthError("storage", "credential directory could not be made private");
  }
  const after = await fs.lstat(dir);
  refuseSymlink(after, "credential directory");
  if (!after.isDirectory()) {
    throw new AuthError("storage", "credential path is not a directory");
  }
  assertPrivateMode(after, "credential directory");
  return after;
}

/**
 * Trusted config dir may resolve through OS aliases such as macOS /var.
 * Plugin-owned private subdirectories are never followed as symlinks.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} slotId
 * @param {{ create?: boolean }} [options]
 */
async function resolveAuthPaths(env, slotId, { create = false } = {}) {
  const logicalConfig = path.resolve(path.dirname(configFilePath(env)));
  let canonical;
  try {
    canonical = await fs.realpath(logicalConfig);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    if (!create) {
      return { absent: true };
    }
    await fs.mkdir(logicalConfig, { recursive: true });
    try {
      canonical = await fs.realpath(logicalConfig);
    } catch {
      throw new AuthError("storage", "credential configuration directory is unavailable");
    }
  }
  const pluginDir = path.join(canonical, PLUGIN_NAME);
  const credsDir = path.join(pluginDir, CREDS_DIRNAME);
  return {
    absent: false,
    pluginDir,
    credsDir,
    file: path.join(credsDir, `${slotId}.json`),
    lockPath: path.join(credsDir, `${slotId}.lock`)
  };
}

/**
 * @param {string} pluginDir
 * @param {string} credsDir
 * @returns {Promise<
 *   | { present: false }
 *   | { present: true, pluginSt: import("node:fs").Stats, credsSt: import("node:fs").Stats }
 * >}
 */
async function inspectPrivateTree(pluginDir, credsDir) {
  const pluginSt = await lstatOrNull(pluginDir);
  if (!pluginSt) return { present: false };
  refuseSymlink(pluginSt, "credential directory");
  if (!pluginSt.isDirectory()) {
    throw new AuthError("storage", "credential path is not a directory");
  }
  assertPrivateMode(pluginSt, "credential directory");
  const credsSt = await lstatOrNull(credsDir);
  if (!credsSt) return { present: false };
  refuseSymlink(credsSt, "credential directory");
  if (!credsSt.isDirectory()) {
    throw new AuthError("storage", "credential path is not a directory");
  }
  assertPrivateMode(credsSt, "credential directory");
  return { present: true, pluginSt, credsSt };
}

/**
 * @param {{ pluginDir: string, credsDir: string }} paths
 */
async function ensureCredentialsTree(paths) {
  await ensurePrivateDir(paths.pluginDir);
  await ensurePrivateDir(paths.credsDir);
}

/**
 * Open the path, confirm it is the same inode as the lstat, and read at most
 * maxBytes (the buffer is maxBytes+1 so growth past the bound is detected).
 * @param {string} file
 * @param {number} maxBytes
 * @param {string} label
 */
async function readBoundedFile(file, maxBytes, label) {
  const st = await fs.lstat(file);
  refuseSymlink(st, label);
  if (!st.isFile()) {
    throw new AuthError("storage", `${label} is not a file`);
  }
  assertPrivateMode(st, label);
  if (st.size > maxBytes) {
    throw new AuthError("storage", `${label} is too large`);
  }
  let handle;
  try {
    handle = await fs.open(file, OPEN_READ);
    const opened = await handle.stat();
    if (!sameIdent(st, opened) || !opened.isFile()) {
      throw new AuthError("storage", `${label} changed during read`);
    }
    if (opened.size > maxBytes) {
      throw new AuthError("storage", `${label} is too large`);
    }
    const cap = maxBytes + 1;
    const buf = Buffer.alloc(cap);
    let bytesRead = 0;
    while (bytesRead < cap) {
      const part = await handle.read(buf, bytesRead, cap - bytesRead, bytesRead);
      if (part.bytesRead === 0) break;
      bytesRead += part.bytesRead;
    }
    if (bytesRead > maxBytes) {
      throw new AuthError("storage", `${label} is too large`);
    }
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    throw mapFsError(error, label);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * @param {string} file
 * @param {string} body
 */
async function atomicWriteFile(file, body) {
  const dir = path.dirname(file);
  await ensurePrivateDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmp, OPEN_WRITE, FILE_MODE);
    await handle.writeFile(body);
    await handle.close();
    handle = undefined;
    try {
      await fs.chmod(tmp, FILE_MODE);
    } catch {
      throw new AuthError("storage", "credential file could not be made private");
    }
    const st = await fs.lstat(tmp);
    refuseSymlink(st, "credential tempfile");
    if (!st.isFile()) {
      throw new AuthError("storage", "credential tempfile is not a file");
    }
    assertPrivateMode(st, "credential file");
    const dest = await lstatOrNull(file);
    if (dest) {
      refuseSymlink(dest, "credential file");
      if (!dest.isFile()) {
        throw new AuthError("storage", "credential path is not a file");
      }
    }
    await fs.rename(tmp, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw mapFsError(error, "credential file");
  }
}

/**
 * @param {string} lockPath
 * @returns {Promise<{ kind: "missing" } | { kind: "malformed" } | { kind: "owner", pid: number, token: string }>}
 */
async function readOwner(lockPath) {
  const ownerFile = path.join(lockPath, "owner.json");
  const st = await lstatOrNull(ownerFile);
  if (!st) return { kind: "missing" };
  refuseSymlink(st, "credential lock");
  if (!st.isFile() || st.size > LOCK_OWNER_MAX_BYTES) return { kind: "malformed" };
  try {
    const parsed = JSON.parse(await readBoundedFile(ownerFile, LOCK_OWNER_MAX_BYTES, "credential lock"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "malformed" };
    if (typeof parsed.token !== "string" || parsed.token.length < 16 || parsed.token.length > 128) {
      return { kind: "malformed" };
    }
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return { kind: "malformed" };
    return { kind: "owner", pid, token: parsed.token };
  } catch (error) {
    if (error instanceof AuthError && error.code === "symlink") throw error;
    // Released or re-acquired between the lstat and the read: the lock is
    // changing hands, not stale, so wait like any other missing owner.
    if (error?.code === "ENOENT" || !sameIdent(st, await lstatOrNull(ownerFile).catch(() => null))) {
      return { kind: "missing" };
    }
    return { kind: "malformed" };
  }
}

function staleLockError(lockPath) {
  return new AuthError(
    "stale-lock",
    `credential lock is stale or unreadable (${lockPath}). After verifying no auth operation is running, remove this lock directory manually.`
  );
}

/**
 * Directory lock. Live owners are waited for boundedly and may be aborted.
 * Missing, malformed, and dead owners fail closed; no foreign lock is deleted.
 * @param {string} lockPath
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ token: string, ident: { dev: unknown, ino: unknown } }>}
 */
async function acquireLock(lockPath, signal) {
  let missingOwnerWaits = 0;
  const deadline = performance.now() + LOCK_WAIT_MS;
  for (;;) {
    throwIfAborted(signal);
    if (performance.now() >= deadline) {
      throw new AuthError("busy", "credential storage is busy; retry after the current auth operation finishes");
    }
    const parent = path.dirname(lockPath);
    const parentSt = await lstatOrNull(parent);
    if (parentSt) {
      refuseSymlink(parentSt, "credential directory");
      if (!parentSt.isDirectory()) {
        throw new AuthError("storage", "credential path is not a directory");
      }
    }
    try {
      await fs.mkdir(lockPath, { mode: DIR_MODE });
      const ident = await fs.lstat(lockPath);
      refuseSymlink(ident, "credential lock");
      if (!ident.isDirectory()) {
        throw new AuthError("storage", "credential lock is not a directory");
      }
      try {
        await fs.chmod(lockPath, DIR_MODE);
      } catch {
        throw new AuthError("storage", "credential lock could not be made private");
      }
      const after = await fs.lstat(lockPath);
      refuseSymlink(after, "credential lock");
      assertPrivateMode(after, "credential lock");
      const token = randomBytes(16).toString("hex");
      await atomicWriteFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })}\n`
      );
      return { token, ident: { dev: after.dev, ino: after.ino } };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const st = await lstatOrNull(lockPath);
      if (!st) continue;
      refuseSymlink(st, "credential lock");
      const owner = await readOwner(lockPath);
      if (owner.kind === "owner" && pidIsLive(owner.pid)) {
        missingOwnerWaits = 0;
        await abortableWait(LOCK_POLL_MS, signal);
        continue;
      }
      if (owner.kind === "missing" && missingOwnerWaits < MISSING_OWNER_WAITS) {
        missingOwnerWaits += 1;
        await abortableWait(LOCK_POLL_MS, signal);
        continue;
      }
      throw staleLockError(lockPath);
    }
  }
}

/**
 * Release only the lock directory this holder created (matching token and inode).
 * @param {string} lockPath
 * @param {{ token: string, ident: { dev: unknown, ino: unknown } } | undefined} held
 */
async function releaseLock(lockPath, held) {
  if (!held?.token) return;
  try {
    const st = await lstatOrNull(lockPath);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
    if (!sameIdent(st, held.ident)) return;
    const owner = await readOwner(lockPath);
    if (owner.kind !== "owner" || owner.token !== held.token) return;
    await fs.rm(lockPath, { recursive: true, force: true });
  } catch {
    // Best-effort release of our own lock only.
  }
}

/**
 * Synchronous factory. The returned store is bound to one configured slot
 * and one upstream provider id for its lifetime.
 * @param {{ env?: NodeJS.ProcessEnv, slot?: unknown, provider?: unknown }} [options]
 */
export function createCredentialStore({ env = process.env, slot, provider } = {}) {
  const slotId = assertIdentifier(slot, "slot");
  const boundProvider = assertIdentifier(provider, "provider");
  let chain = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<T>}
   */
  function enqueue(task, options) {
    const signal = options?.signal;
    throwIfAborted(signal);
    const prev = chain;
    const queued = (async () => {
      await waitForSettled(prev, signal);
      throwIfAborted(signal);
      return await task();
    })();
    chain = Promise.all([
      prev.then(
        () => undefined,
        () => undefined
      ),
      queued.then(
        () => undefined,
        () => undefined
      )
    ]).then(() => undefined);
    return queued;
  }

  /**
   * @template T
   * @param {(paths: { pluginDir: string, credsDir: string, file: string, lockPath: string }) => Promise<T>} fn
   * @param {AbortSignal | undefined} signal
   */
  async function withLock(fn, signal) {
    const paths = await resolveAuthPaths(env, slotId, { create: true });
    if (paths.absent) {
      throw new AuthError("storage", "credential configuration directory is unavailable");
    }
    await ensureCredentialsTree(paths);
    const held = await acquireLock(paths.lockPath, signal);
    try {
      throwIfAborted(signal);
      return await fn(paths);
    } finally {
      await releaseLock(paths.lockPath, held);
    }
  }

  /**
   * @returns {Promise<{ provider: string, credential: Record<string, unknown> } | undefined>}
   */
  async function readEnvelope() {
    const paths = await resolveAuthPaths(env, slotId);
    if (paths.absent) return undefined;
    const tree = await inspectPrivateTree(paths.pluginDir, paths.credsDir);
    if (!tree.present) return undefined;
    const st = await lstatOrNull(paths.file);
    if (!st) return undefined;
    let text;
    try {
      text = await readBoundedFile(paths.file, MAX_FILE_BYTES, "credential file");
    } catch (error) {
      if (error && error.code === "ENOENT") return undefined;
      throw error;
    }
    const treeAfter = await inspectPrivateTree(paths.pluginDir, paths.credsDir);
    if (
      !treeAfter.present ||
      !sameIdent(tree.pluginSt, treeAfter.pluginSt) ||
      !sameIdent(tree.credsSt, treeAfter.credsSt)
    ) {
      throw new AuthError("storage", "credential directory changed during read");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AuthError("storage", "credential envelope is invalid");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AuthError("storage", "credential envelope is invalid");
    }
    const proto = Object.getPrototypeOf(parsed);
    if (proto !== Object.prototype && proto !== null) {
      throw new AuthError("storage", "credential envelope is invalid");
    }
    if (parsed.v !== ENVELOPE_VERSION || typeof parsed.provider !== "string") {
      throw new AuthError("storage", "credential envelope is invalid");
    }
    if (parsed.provider !== boundProvider) return undefined;
    return {
      provider: parsed.provider,
      credential: cloneOAuthCredential(parsed.credential)
    };
  }

  /**
   * @param {{ file: string, pluginDir: string, credsDir: string }} paths
   * @param {Record<string, unknown>} credential
   */
  async function writeEnvelope(paths, credential) {
    const cloned = cloneOAuthCredential(credential);
    const body = `${JSON.stringify({
      v: ENVELOPE_VERSION,
      provider: boundProvider,
      credential: cloned
    })}\n`;
    if (Buffer.byteLength(body, "utf8") > MAX_FILE_BYTES) {
      throw new AuthError("storage", "credential envelope is invalid");
    }
    const tree = await inspectPrivateTree(paths.pluginDir, paths.credsDir);
    if (!tree.present) {
      throw new AuthError("storage", "credential directory is missing");
    }
    const existing = await lstatOrNull(paths.file);
    if (existing) {
      refuseSymlink(existing, "credential file");
      if (!existing.isFile()) {
        throw new AuthError("storage", "credential path is not a file");
      }
    }
    await atomicWriteFile(paths.file, body);
    return cloned;
  }

  /**
   * @param {string} providerId
   */
  function assertBoundProvider(providerId) {
    if (providerId !== boundProvider) {
      throw new AuthError("provider", "OAuth credentials do not match this provider");
    }
  }

  return {
    /**
     * @param {string} providerId
     * @param {{ signal?: AbortSignal }} [options]
     */
    async read(providerId, options = {}) {
      throwIfAborted(options.signal);
      if (providerId !== boundProvider) return undefined;
      try {
        const envelope = await readEnvelope();
        return envelope?.credential;
      } catch (error) {
        if (error && error.code === "ENOENT") return undefined;
        throw error;
      }
    },

    /**
     * @param {{ signal?: AbortSignal }} [options]
     */
    async list(options = {}) {
      throwIfAborted(options.signal);
      const envelope = await readEnvelope().catch((error) => {
        if (error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!envelope) return [];
      return Object.freeze([{ providerId: boundProvider, type: "oauth" }]);
    },

    /**
     * @param {string} providerId
     * @param {(current: Record<string, unknown> | undefined) => Promise<Record<string, unknown> | undefined>} fn
     * @param {{ signal?: AbortSignal }} [options]
     */
    modify(providerId, fn, options = {}) {
      return enqueue(async () => {
        assertBoundProvider(providerId);
        return withLock(async (paths) => {
          const current = (await readEnvelope())?.credential;
          const next = await fn(current);
          throwIfAborted(options.signal);
          if (next === undefined) return current;
          return writeEnvelope(paths, next);
        }, options.signal);
      }, options);
    },

    /**
     * @param {string} providerId
     * @param {{ signal?: AbortSignal }} [options]
     */
    delete(providerId, options = {}) {
      return enqueue(async () => {
        assertBoundProvider(providerId);
        await withLock(async (paths) => {
          const tree = await inspectPrivateTree(paths.pluginDir, paths.credsDir);
          if (!tree.present) return;
          const st = await lstatOrNull(paths.file);
          if (!st) return;
          refuseSymlink(st, "credential file");
          if (!st.isFile()) {
            throw new AuthError("storage", "credential path is not a file");
          }
          await fs.unlink(paths.file);
        }, options.signal);
      }, options);
    }
  };
}
