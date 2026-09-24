/**
 * What changed during one Claude turn, measured by git rather than reported by
 * Claude. A snapshot is a tree object of the whole working tree (tracked and
 * untracked, .gitignore honoured) written through a private temporary index,
 * so the user's index, branch, stash, and HEAD are never touched. Diffing two
 * snapshots scopes review to this turn even if Claude committed meanwhile.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const GIT_TIMEOUT_MS = 20_000;
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
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
