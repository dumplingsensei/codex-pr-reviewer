import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);

// ../../plugins/cross-model-advisor/src/snapshot.mjs
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
var GIT_TIMEOUT_MS = 2e4;
var MAX_GIT_OUTPUT = 32 * 1024 * 1024;
var MAX_FILE_DIFF_CHARS = 16 * 1024;
var MAX_TOTAL_DIFF_CHARS = 60 * 1024;
var SnapshotError = class extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
};
function gitEnv(env, extra = {}) {
  const out = { ...env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX"]) {
    delete out[name];
  }
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_OPTIONAL_LOCKS = "0";
  return { ...out, ...extra };
}
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
async function gitTopLevel(dir, { env = process.env } = {}) {
  try {
    const out = (await git(dir, ["rev-parse", "--show-toplevel"], { env })).trim();
    return out ? await fs.realpath(out) : null;
  } catch {
    return null;
  }
}
async function reviewBaseTree(root, base, { env = process.env } = {}) {
  let head;
  try {
    head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { env })).trim();
  } catch {
    if (base) throw new SnapshotError("git", "the repository has no commits to compare against");
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
async function gitIgnoredPaths(root, { env = process.env } = {}) {
  const out = await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], { env });
  return out.split("\0").filter(Boolean);
}
async function snapshotTree(root, scratchDir, { env = process.env, signal } = {}) {
  const tmpIndex = path.join(scratchDir, `index.${process.pid}.${Date.now()}`);
  try {
    const realIndex = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"], { env })).trim();
    try {
      await fs.copyFile(realIndex, tmpIndex);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new SnapshotError("git", "unable to copy the index");
    }
    const extraEnv = { GIT_INDEX_FILE: tmpIndex };
    await git(root, ["add", "--all", "--", "."], { env, extraEnv, signal });
    const tree = (await git(root, ["write-tree"], { env, extraEnv, signal })).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new SnapshotError("git", "write-tree returned no tree");
    return tree;
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => {
    });
    await fs.rm(`${tmpIndex}.lock`, { force: true }).catch(() => {
    });
  }
}
async function changedFiles(root, base, head, { env = process.env } = {}) {
  const out = await git(root, ["diff", "--no-color", "--no-ext-diff", "-M", "--name-status", "-z", base, head], {
    env
  });
  const parts = out.split("\0");
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
async function turnDiff(root, base, head, { env = process.env, isExcluded, maxFileChars, maxTotalChars }) {
  const perFile = maxFileChars ?? MAX_FILE_DIFF_CHARS;
  let budget = maxTotalChars ?? MAX_TOTAL_DIFF_CHARS;
  const files = await changedFiles(root, base, head, { env });
  const included = [];
  const omitted = [];
  const unshown = [];
  for (const file of files) {
    if (await isExcluded(file.path) || file.oldPath && await isExcluded(file.oldPath)) {
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
    if (text.length > cap) text = `${text.slice(0, cap)}
[diff truncated: ${text.length - cap} more chars]`;
    budget -= text.length;
    included.push({ path: file.path, status: file.status, oldPath: file.oldPath, text });
  }
  return { files: included, omitted, unshown };
}
export {
  MAX_FILE_DIFF_CHARS,
  MAX_TOTAL_DIFF_CHARS,
  SnapshotError,
  changedFiles,
  gitIgnoredPaths,
  gitTopLevel,
  reviewBaseTree,
  snapshotTree,
  turnDiff
};
