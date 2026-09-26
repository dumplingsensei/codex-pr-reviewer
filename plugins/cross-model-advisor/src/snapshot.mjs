/**
 * What changed during one Claude turn, measured by git rather than reported by
 * Claude. A snapshot is a tree object of the whole working tree (tracked and
 * untracked, .gitignore honoured) written through a private temporary index,
 * so the user's index, branch, stash, and HEAD are never touched. Diffing two
 * snapshots scopes review to this turn even if Claude committed meanwhile.
 */

import { execFile, spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";

const GIT_TIMEOUT_MS = 20_000;
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_TREE_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_HEADER_BYTES = 256;
export const MAX_FILE_DIFF_CHARS = 16 * 1024;
export const MAX_TOTAL_DIFF_CHARS = 60 * 1024;

export class SnapshotError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

/**
 * Environment for git: the caller's, minus variables that would redirect it to
 * another repository or index, plus no prompts and no optional locks.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, string>} [extra]
 */
function gitEnv(env, extra = {}) {
  const out = { ...env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX"]) {
    delete out[name];
  }
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_OPTIONAL_LOCKS = "0";
  return { ...out, ...extra };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, extraEnv?: Record<string, string>, signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
function git(cwd, args, { env = process.env, extraEnv, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      {
        cwd,
        env: gitEnv(env, extraEnv),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT,
        encoding: "utf8",
        signal
      },
      (error, stdout) => {
        if (error) {
          reject(new SnapshotError("git", `git ${args[0]} failed`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * The repository top level containing `dir`, or null outside a work tree.
 *
 * @param {string} dir
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export async function gitTopLevel(dir, { env = process.env } = {}) {
  try {
    const out = (await git(dir, ["rev-parse", "--show-toplevel"], { env })).trim();
    return out ? await fs.realpath(out) : null;
  } catch {
    return null;
  }
}

/**
 * The tree an on-demand review compares the working tree against: HEAD's, or
 * with `base` that of HEAD's merge base with `base`, so a branch review covers
 * its commits and its uncommitted work together.
 *
 * @param {string} root repository top level
 * @param {string | null} base a ref the caller has already checked for shape
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ tree: string, commit: string | null }>}
 */
export async function reviewBaseTree(root, base, { env = process.env } = {}) {
  let head;
  try {
    head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { env })).trim();
  } catch {
    if (base) throw new SnapshotError("git", "the repository has no commits to compare against");
    // No commits yet: compare against the empty tree, asked of git because its
    // id depends on the repository's object format (SHA-1 or SHA-256).
    return { tree: (await git(root, ["hash-object", "-t", "tree", "/dev/null"], { env })).trim(), commit: null };
  }
  let commit = head;
  if (base) {
    let target;
    try {
      target = (await git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`], { env })).trim();
    } catch {
      throw new SnapshotError("git", `\`${base}\` is not a commit in this repository`);
    }
    commit = (await git(root, ["merge-base", head, target], { env })).trim();
  }
  const tree = (await git(root, ["rev-parse", `${commit}^{tree}`], { env })).trim();
  return { tree, commit };
}

/**
 * Untracked paths git ignores under `root`, by every rule `git add` honours:
 * .gitignore, .git/info/exclude, and core.excludesFile. Ignored directories
 * are listed once, ending in `/`.
 *
 * @param {string} root repository top level
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<string[]>}
 */
export async function gitIgnoredPaths(root, { env = process.env } = {}) {
  const out = await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], { env });
  return out.split("\0").filter(Boolean);
}

/**
 * Write a tree object for the current working tree of `root`.
 *
 * The real index is copied first only so git can reuse its stat cache instead
 * of rehashing every file; the copy is what gets updated. Objects written for
 * untracked files are ordinary loose objects that `git gc` collects.
 *
 * @param {string} root repository top level
 * @param {string} scratchDir private directory for the temporary index
 * @param {{ env?: NodeJS.ProcessEnv, signal?: AbortSignal }} [options]
 * @returns {Promise<string>} tree id
 */
export async function snapshotTree(root, scratchDir, { env = process.env, signal } = {}) {
  const tmpIndex = path.join(scratchDir, `index.${process.pid}.${Date.now()}`);
  try {
    const realIndex = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"], { env })).trim();
    try {
      await fs.copyFile(realIndex, tmpIndex);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new SnapshotError("git", "unable to copy the index");
      // No index yet (fresh repository): start empty and let add -A fill it.
    }
    const extraEnv = { GIT_INDEX_FILE: tmpIndex };
    await git(root, ["add", "--all", "--", "."], { env, extraEnv, signal });
    const tree = (await git(root, ["write-tree"], { env, extraEnv, signal })).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new SnapshotError("git", "write-tree returned no tree");
    return tree;
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => {});
    await fs.rm(`${tmpIndex}.lock`, { force: true }).catch(() => {});
  }
}

/**
 * @typedef {{ status: string, path: string, oldPath?: string }} ChangedFile
 */

/**
 * @param {string} root
 * @param {string} base
 * @param {string} head
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<ChangedFile[]>}
 */
export async function changedFiles(root, base, head, { env = process.env } = {}) {
  const out = await git(root, ["diff", "--no-color", "--no-ext-diff", "-M", "--name-status", "-z", base, head], {
    env
  });
  const parts = out.split("\0");
  /** @type {ChangedFile[]} */
  const files = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      files.push({ status: status[0], oldPath: parts[i + 1], path: parts[i + 2] });
      i += 3;
    } else {
      files.push({ status: status[0], path: parts[i + 1] });
      i += 2;
    }
  }
  return files;
}

/**
 * Unified diffs for the files that survive `isExcluded`. Excluded paths are
 * named in `omitted` but their content is never read. Output is bounded per
 * file and in total, with truncation labelled.
 *
 * @param {string} root
 * @param {string} base
 * @param {string} head
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   isExcluded: (relPosix: string) => Promise<boolean>,
 *   maxFileChars?: number,
 *   maxTotalChars?: number
 * }} options
 */
export async function turnDiff(root, base, head, { env = process.env, isExcluded, maxFileChars, maxTotalChars }) {
  const perFile = maxFileChars ?? MAX_FILE_DIFF_CHARS;
  let budget = maxTotalChars ?? MAX_TOTAL_DIFF_CHARS;
  const files = await changedFiles(root, base, head, { env });
  /** @type {{ path: string, status: string, oldPath?: string, text: string }[]} */
  const included = [];
  /** @type {string[]} */
  const omitted = [];
  /** @type {string[]} */
  const unshown = [];
  for (const file of files) {
    if ((await isExcluded(file.path)) || (file.oldPath && (await isExcluded(file.oldPath)))) {
      omitted.push(file.path);
      continue;
    }
    if (budget <= 0) {
      unshown.push(file.path);
      continue;
    }
    const pathspec = file.oldPath ? [file.oldPath, file.path] : [file.path];
    let text = await git(
      root,
      ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--unified=3", base, head, "--", ...pathspec],
      { env }
    );
    const cap = Math.min(perFile, budget);
    if (text.length > cap) text = `${text.slice(0, cap)}\n[diff truncated: ${text.length - cap} more chars]`;
    budget -= text.length;
    included.push({ path: file.path, status: file.status, oldPath: file.oldPath, text });
  }
  return { files: included, omitted, unshown };
}

/**
 * @typedef {{ kind: "dir" | "file" | "other", oid: string }} TreeEntry
 */

/**
 * The entries of a raw tree object. Symlinks, submodules, and any other mode
 * are "other", so they are never followed; names that are not UTF-8 or could
 * not name a path segment are dropped.
 *
 * @param {Buffer} buf
 * @param {number} hashBytes
 * @returns {Map<string, TreeEntry>}
 */
function parseTree(buf, hashBytes) {
  /** @type {Map<string, TreeEntry>} */
  const entries = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const space = buf.indexOf(0x20, pos);
    const nul = space < 0 ? -1 : buf.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 1 + hashBytes > buf.length) throw new SnapshotError("git", "malformed tree object");
    const mode = buf.toString("latin1", pos, space);
    const nameBytes = buf.subarray(space + 1, nul);
    const oid = buf.toString("hex", nul + 1, nul + 1 + hashBytes);
    pos = nul + 1 + hashBytes;
    if (!isUtf8(nameBytes)) continue;
    const name = nameBytes.toString("utf8");
    if (!name || name === "." || name === ".." || name.includes("/")) continue;
    const kind = mode === "40000" ? "dir" : mode === "100644" || mode === "100755" ? "file" : "other";
    entries.set(name, { kind, oid });
  }
  return entries;
}

/**
 * Read one snapshot's directories and files from git's object store through a
 * single `git cat-file --batch`, started on first use: no checkout, no filter
 * or textconv, and the working tree can change underneath without changing
 * what is read. Lookups are by exact name. `close()` must be called.
 *
 * @param {string} root repository top level
 * @param {string} tree snapshot tree id
 * @param {{ env?: NodeJS.ProcessEnv, signal?: AbortSignal }} [options]
 */
export function openTreeReader(root, tree, { env = process.env, signal } = {}) {
  if (typeof tree !== "string" || !OBJECT_ID_RE.test(tree)) throw new SnapshotError("git", "invalid tree id");
  const hashBytes = tree.length / 2;
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
  let child = null;
  /** @type {Error | null} */
  let failed = null;
  /** @type {{ maxBytes: number, resolve: (value: any) => void, reject: (error: Error) => void }[]} */
  const pending = [];
  /** @type {"header" | "body" | "newline"} */
  let mode = "header";
  /** @type {Buffer[]} */
  let headerParts = [];
  let headerLength = 0;
  /** @type {{ type: string, size: number, remaining: number, keep: boolean, chunks: Buffer[] } | null} */
  let current = null;

  const fail = (/** @type {unknown} */ reason) => {
    if (failed) return;
    failed = reason instanceof Error ? reason : new SnapshotError("git", "git cat-file failed");
    for (const request of pending.splice(0)) request.reject(failed);
    if (child) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill();
    }
    signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => fail(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  // The child holds the process open only while a request is in flight, so a
  // reader left open can never keep a hook from exiting.
  const hold = (/** @type {boolean} */ on) => {
    if (!child) return;
    for (const handle of [child, child.stdin, child.stdout]) {
      if (on) handle.ref?.();
      else handle.unref?.();
    }
  };

  /** @param {Buffer} chunk */
  const onData = (chunk) => {
    let pos = 0;
    while (pos < chunk.length && !failed) {
      if (mode === "header") {
        const nl = chunk.indexOf(0x0a, pos);
        const end = nl < 0 ? chunk.length : nl;
        headerParts.push(chunk.subarray(pos, end));
        headerLength += end - pos;
        if (headerLength > MAX_BATCH_HEADER_BYTES || !pending.length) {
          fail(new SnapshotError("git", "unexpected git cat-file output"));
          return;
        }
        if (nl < 0) return;
        pos = nl + 1;
        const line = Buffer.concat(headerParts).toString("latin1");
        headerParts = [];
        headerLength = 0;
        const found = /^[0-9a-f]{40,64} (blob|tree|commit|tag) (\d+)$/.exec(line);
        if (!found) {
          // `<id> missing`: not an object in this repository.
          pending.shift()?.resolve(null);
          if (!pending.length) hold(false);
          continue;
        }
        const size = Number(found[2]);
        current = { type: found[1], size, remaining: size, keep: size <= pending[0].maxBytes, chunks: [] };
        mode = size === 0 ? "newline" : "body";
      } else if (mode === "body" && current) {
        const take = Math.min(current.remaining, chunk.length - pos);
        // An object over the caller's limit streams past without being kept.
        if (current.keep) current.chunks.push(chunk.subarray(pos, pos + take));
        current.remaining -= take;
        pos += take;
        if (current.remaining === 0) mode = "newline";
      } else {
        if (chunk[pos] !== 0x0a || !current) {
          fail(new SnapshotError("git", "unexpected git cat-file output"));
          return;
        }
        pos += 1;
        const done = current;
        current = null;
        mode = "header";
        pending.shift()?.resolve({ type: done.type, size: done.size, bytes: done.keep ? Buffer.concat(done.chunks) : null });
        if (!pending.length) hold(false);
      }
    }
  };

  /**
   * @param {string} oid
   * @param {number} maxBytes
   * @returns {Promise<{ type: string, size: number, bytes: Buffer | null } | null>}
   */
  const object = (oid, maxBytes) => {
    if (failed) return Promise.reject(failed);
    if (!OBJECT_ID_RE.test(oid)) return Promise.resolve(null);
    if (!child) {
      child = spawn("git", ["-c", "core.quotepath=off", "cat-file", "--batch"], {
        cwd: root,
        env: gitEnv(env),
        stdio: ["pipe", "pipe", "ignore"]
      });
      child.on("error", () => fail(new SnapshotError("git", "git cat-file failed")));
      child.on("exit", () => fail(new SnapshotError("git", "git cat-file exited")));
      child.stdin.on("error", () => fail(new SnapshotError("git", "git cat-file failed")));
      child.stdout.on("data", onData);
    }
    return new Promise((resolve, reject) => {
      if (!pending.length) hold(true);
      pending.push({ maxBytes, resolve, reject });
      child?.stdin.write(`${oid}\n`);
    });
  };

  /** @type {Map<string, Promise<Map<string, TreeEntry> | null>>} */
  const dirs = new Map();
  /**
   * @param {string} relPosix
   * @returns {Promise<Map<string, TreeEntry> | null>}
   */
  const dirEntries = (relPosix) => {
    let found = dirs.get(relPosix);
    if (!found) {
      found = (async () => {
        let oid = tree;
        if (relPosix) {
          const entry = await entryAt(relPosix);
          if (entry?.kind !== "dir") return null;
          oid = entry.oid;
        }
        const obj = await object(oid, MAX_TREE_OBJECT_BYTES);
        return obj?.type === "tree" && obj.bytes ? parseTree(obj.bytes, hashBytes) : null;
      })();
      dirs.set(relPosix, found);
    }
    return found;
  };
  /**
   * @param {string} relPosix
   * @returns {Promise<TreeEntry | null>}
   */
  const entryAt = async (relPosix) => {
    if (!relPosix) return { kind: "dir", oid: tree };
    const slash = relPosix.lastIndexOf("/");
    const parent = await dirEntries(slash < 0 ? "" : relPosix.slice(0, slash));
    return parent?.get(relPosix.slice(slash + 1)) ?? null;
  };

  return {
    /** The entry at a normalized relative path, or null. */
    entry: entryAt,
    /**
     * A directory's files and subdirectories, sorted; symlinks and submodules
     * are left out. Null when `relPosix` is not a directory.
     *
     * @param {string} relPosix
     */
    async list(relPosix) {
      const entries = await dirEntries(relPosix);
      if (!entries) return null;
      return [...entries]
        .filter(([, entry]) => entry.kind !== "other")
        .map(([name, entry]) => ({ name, directory: entry.kind === "dir" }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    /**
     * A blob's size, and its bytes when it is at most `maxBytes`.
     *
     * @param {string} oid
     * @param {number} maxBytes
     */
    async blob(oid, maxBytes) {
      const obj = await object(oid, maxBytes);
      return obj?.type === "blob" ? { size: obj.size, bytes: obj.bytes } : null;
    },
    close() {
      fail(new SnapshotError("git", "tree reader closed"));
    }
  };
}
