#!/usr/bin/env node
/**
 * pr-workspace.mjs — materialize a GitHub PR into an isolated checkout that
 * Codex's native reviewer can read, then drive `codex review` against it.
 *
 * Codex reviews local git state only (`--uncommitted`, `--base`, `--commit`).
 * Everything here exists to turn "PR #42 on GitHub" into that local state
 * without disturbing the working tree the user is sitting in.
 *
 * Zero dependencies. Node >= 18.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REF_NS = "refs/codex-pr-reviewer";
const BRANCH_NS = "codex-pr";
const MANIFEST_VERSION = 1;

const PR_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "isCrossRepository",
  "baseRefName",
  "baseRefOid", // fallback base when the branch has been deleted post-merge
  "headRefOid", // what GitHub says the head is; the fetch is checked against it
  "author",
  "additions",
  "deletions",
  "changedFiles"
].join(",");

/* ------------------------------------------------------------------ *
 * process helpers
 * ------------------------------------------------------------------ */

class UserError extends Error {
  constructor(message, remedy) {
    super(message);
    this.name = "UserError";
    this.remedy = remedy ?? null;
  }
}

// Every helper subprocess is bounded: `doctor` is the preflight for every
// slash command, and a hung credential helper would otherwise hang the plugin.
const DEFAULT_TIMEOUT_MS = 120_000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: DEFAULT_TIMEOUT_MS,
    ...options
  });
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
  return {
    status: timedOut ? 124 : result.status,
    stdout: result.stdout ?? "",
    stderr: timedOut
      ? `${result.stderr ?? ""}\ntimed out after ${(options.timeout ?? DEFAULT_TIMEOUT_MS) / 1000}s`
      : (result.stderr ?? ""),
    error: result.error ?? null,
    timedOut
  };
}

/**
 * Everything a subprocess said, in order, for checks that scan output rather
 * than parse it.
 *
 * `run()` encodes a convention nothing else does: a timeout comes back as
 * status 124 with a synthetic "timed out after Ns" line appended to stderr. A
 * caller that concatenates the two streams and forgets to look at `status` will
 * happily search that text for a flag name and conclude the flag is missing.
 */
const combinedOutput = (result) => `${result.stdout}${result.stderr}`;

function runChecked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.error?.code === "ENOENT") {
    throw new UserError(`\`${command}\` is not installed or not on PATH.`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new UserError(
      `\`${command} ${args.join(" ")}\` failed (exit ${result.status}).`,
      detail || null
    );
  }
  return result;
}

const git = (dir, args) => run("git", ["-C", dir, ...args]);
const gitChecked = (dir, args) => runChecked("git", ["-C", dir, ...args]);
const gitOut = (dir, args) => gitChecked(dir, args).stdout.trim();

/**
 * Trimmed stdout of a git command that succeeded and said something, or null.
 *
 * `git(...).stdout.trim()` returns "" for a command that failed, and "" is
 * falsy — so `recorded && actual && actual !== recorded` skips the comparison
 * exactly when git could not answer. Every such check reads as a verification
 * and behaves as a no-op. Returning null makes the caller decide what a
 * non-answer means rather than defaulting it to "fine".
 */
function gitOutOrNull(dir, args) {
  const result = git(dir, args);
  if (result.status !== 0) return null;
  const text = result.stdout.trim();
  return text === "" ? null : text;
}

function gh(args, options = {}) {
  return run("gh", args, options);
}

function ghJson(args) {
  const result = runChecked("gh", args);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new UserError(
      `Could not parse JSON from \`gh ${args.join(" ")}\`.`,
      result.stdout.slice(0, 400)
    );
  }
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

const shellQuote = (value) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${String(value).replaceAll("'", `'\\''`)}'`;

/* ------------------------------------------------------------------ *
 * argument parsing
 * ------------------------------------------------------------------ */

function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const retiredOptions = new Map(Object.entries(config.retiredOptions ?? {}));
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const stripped = token.replace(/^--?/, "");
    const [rawName, inlineValue] = splitOnce(stripped, "=");
    const name = aliasMap[rawName] ?? rawName;

    // Unrecognized flags fall through to positionals below, which is right for
    // `#42` and wrong for a flag that used to work: silently ignoring it looks
    // identical to honouring it. A withdrawn flag says so.
    if (retiredOptions.has(name)) {
      throw new UserError(`Unknown option \`--${name}\`: ${retiredOptions.get(name)}`);
    }

    if (booleanOptions.has(name)) {
      options[name] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }

    if (valueOptions.has(name)) {
      if (inlineValue !== undefined) {
        options[name] = inlineValue;
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        throw new UserError(`Option \`--${name}\` needs a value.`);
      }
      options[name] = next;
      index += 1;
      continue;
    }

    // Unknown flags become positionals so PR refs like `#42` still survive.
    positionals.push(token);
  }

  return { options, positionals };
}

function splitOnce(text, separator) {
  const at = text.indexOf(separator);
  if (at === -1) return [text, undefined];
  return [text.slice(0, at), text.slice(at + separator.length)];
}

/**
 * One option table per command, derived rather than duplicated. `review` runs
 * `prepare`'s work, so it must accept every flag `prepare` does — when the two
 * were maintained by hand they drifted, and any flag placed before the PR
 * reference was silently reinterpreted as the PR reference.
 */
const PREPARE_SCHEMA = {
  valueOptions: ["pr", "repo"],
  booleanOptions: ["json", "clone"]
};

const REVIEW_SCHEMA = {
  valueOptions: [...PREPARE_SCHEMA.valueOptions, "model", "effort", "profile"],
  booleanOptions: [...PREPARE_SCHEMA.booleanOptions, "no-prepare", "dry-run"],
  retiredOptions: {
    context:
      "it appended a positional prompt, which `codex review --base` refuses outright, so it never ran a review.",
    "trust-worktree":
      "it enabled project `.codex` configuration from a pull request fetched off the internet."
  },
  aliasMap: { m: "model" }
};

/* ------------------------------------------------------------------ *
 * cache + manifest
 * ------------------------------------------------------------------ */

function cacheRoot() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "codex-pr-reviewer");
}

const manifestPath = () => path.join(cacheRoot(), "manifest.json");
const reviewsDir = () => path.join(cacheRoot(), "reviews");
const clonesDir = () => path.join(cacheRoot(), "repos");
const worktreesDir = () => path.join(cacheRoot(), "worktrees");

/**
 * GitHub treats owner and repo names case-insensitively, so the manifest key
 * and every cache path derive from a lowercased slug. Without this, preparing
 * `cli/cli` and `Cli/CLI` yields two manifest entries whose directories
 * collide on a case-insensitive filesystem.
 */
export function canonicalSlug(repo) {
  return String(repo ?? "").toLowerCase();
}

export function slugToDir(repo) {
  return canonicalSlug(repo).replaceAll("/", "__");
}

export const entryKey = (repo, number) => `${canonicalSlug(repo)}#${number}`;

function emptyManifest() {
  return { version: MANIFEST_VERSION, entries: [] };
}

function readManifest() {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath(), "utf8");
  } catch (error) {
    // Only "it is not there" means first run. A permissions problem, an I/O
    // error, or a directory where the file should be all used to read as an
    // empty manifest — which is the same shape as "you have nothing prepared",
    // and would have this plugin cheerfully re-create branches it already owns
    // while losing the record of the ones it cannot see.
    if (error.code === "ENOENT") return emptyManifest();
    throw new UserError(
      `Could not read the review manifest at ${manifestPath()} (${error.code ?? error.message}).`,
      "Fix the permissions or move the file aside; this is not the same as having no manifest."
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Never silently reset: the manifest is the only record of branches and
    // refs created inside the user's real repositories.
    const backup = `${manifestPath()}.corrupt-${Date.now()}`;
    fs.writeFileSync(backup, raw, { mode: 0o600 });
    throw new UserError(
      `The review manifest at ${manifestPath()} is not valid JSON (${error.message}).`,
      `A copy was saved to ${backup}. Repair it, or delete it and clean up any leftover \`codex-pr/*\` branches by hand.`
    );
  }

  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new UserError(
      `The review manifest at ${manifestPath()} is missing its \`entries\` array.`,
      "Repair or delete it before continuing."
    );
  }
  if (Number(parsed.version) > MANIFEST_VERSION) {
    throw new UserError(
      `The review manifest is version ${parsed.version}, but this script understands version ${MANIFEST_VERSION}.`,
      "Upgrade the plugin, or move the manifest aside to start fresh."
    );
  }
  return parsed;
}

/**
 * Creates a directory only this user can enter, and repairs one that predates
 * this rule.
 *
 * Everything under the cache is private by nature: saved reviews of code that
 * is often not public, and a manifest naming paths inside the user's own
 * repositories. Left to the process umask these were created 0755 and 0644,
 * which on a shared or multi-account machine is readable by everyone. `mode:`
 * alone would not fix an existing install, since mkdir ignores it when the
 * directory is already there — hence the chmod.
 */
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // A directory we cannot chmod is one somebody else owns; the operations
    // that follow will fail with a better message than this could give.
  }
}

/**
 * Blocks this thread. Node has no sync sleep; this is the standard stand-in,
 * and the waits here are tens of milliseconds while another process renames a
 * small file.
 */
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// Long enough to outlast a slow rename under load, short enough that a crashed
// holder does not make the next command look hung.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

/**
 * Serializes read-modify-write of the manifest across processes.
 *
 * Writing is already atomic — write to a temporary file, rename over — so the
 * file on disk is never torn. That is a different problem from this one. Every
 * mutation here reads the whole manifest, changes one entry, and writes the
 * whole thing back, so two of them overlapping means the second silently
 * discards the first: `sweep` prepares several PRs concurrently, and a
 * background review re-recording its entry can land in the middle of a clean.
 * The lost entry is a branch and a worktree in a real repository that nothing
 * has a record of any more.
 *
 * A lock that outlives its holder is its own failure, so this one expires. Ten
 * seconds is far longer than any critical section here, which is a read, a
 * small edit, and a rename.
 */
function withManifestLock(fn) {
  ensurePrivateDir(cacheRoot());
  const lockPath = `${manifestPath()}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx", 0o600));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        continue; // released between the open and the stat; try again
      }
      if (age > LOCK_STALE_MS) {
        // Whoever held this is gone. Reclaiming is safe precisely because the
        // critical section is short: nothing legitimate holds it this long.
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new UserError(
          `Timed out waiting for the review manifest lock at ${lockPath}.`,
          "Another codex-pr-reviewer command is holding it. If none is running, delete that file."
        );
      }
      sleepSync(50);
    }
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

/** Read-modify-write under the lock. `mutate` returns the manifest to store. */
export function mutateManifest(mutate) {
  return withManifestLock(() => {
    const manifest = readManifest();
    const next = mutate(manifest);
    if (next) writeManifest(next);
    return next;
  });
}

function writeManifest(manifest) {
  ensurePrivateDir(cacheRoot());
  // Write-then-rename so an interrupted write cannot truncate the manifest.
  const temporary = `${manifestPath()}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ ...manifest, version: MANIFEST_VERSION }, null, 2)}\n`,
    { mode: 0o600 }
  );
  fs.renameSync(temporary, manifestPath());
}

function upsertEntry(entry) {
  mutateManifest((manifest) => ({
    ...manifest,
    entries: [...manifest.entries.filter((item) => item.key !== entry.key), entry]
  }));
}

/* ------------------------------------------------------------------ *
 * run markers
 *
 * A review is a long, paid, read-only run against a worktree that any other
 * process is free to delete. Nothing recorded that a run was under way, so a
 * `clean` starting mid-review removed the worktree codex was reading and the
 * manifest entry the review needs to stay reachable — and then the review
 * finished and wrote its output into a directory where no later
 * `--purge-reviews` could ever select it, because selection starts from the
 * manifest entry that had just been dropped.
 *
 * One small file per running review holds what another process needs in order
 * to decide whether that run is still real: its pid, the machine that owns it,
 * when it started, and where it will save. `clean` holds those entries back
 * rather than pulling state out from under them, and `review` re-records its
 * own entry if it was cleaned anyway.
 * ------------------------------------------------------------------ */

const runsDir = () => path.join(cacheRoot(), "runs");

// One marker per run, not per PR: two reviews of the same PR can overlap, and a
// shared filename would have the first to finish delete the second's marker.
const runMarkerPath = (repo, number, pid = process.pid) =>
  path.join(runsDir(), `${slugToDir(repo)}-pr${number}-${pid}.json`);

/**
 * How long a marker is believed at all. A review takes minutes, so a marker
 * older than this describes a run that is gone however alive its pid looks:
 * pids are recycled, and a marker able to block cleanup forever would be worse
 * than one that expires early. It is also the only bound available when the
 * marker was written by another machine against a shared cache.
 */
const RUN_MARKER_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * True when a marker still stands for a review that could be running. `now` and
 * `hostname` are injectable so both fallbacks can be tested without spawning
 * anything.
 */
export function runIsLive(marker, now = Date.now(), hostname = os.hostname()) {
  const startedAt = Date.parse(marker?.startedAt ?? "");
  if (!Number.isFinite(startedAt) || now - startedAt > RUN_MARKER_TTL_MS) return false;
  // Another machine's pid says nothing here, so the TTL above is all there is.
  if (marker.host && marker.host !== hostname) return true;
  // Signal 0 sends nothing; it only asks whether the process is there. A
  // non-positive pid addresses a process group, so it never identifies a run.
  if (!Number.isInteger(marker.pid) || marker.pid <= 0) return false;
  try {
    process.kill(marker.pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // running, just not ours to signal
  }
}

/**
 * Every marker on disk. One whose `startedAt` is missing or unparseable ages
 * from the file's own mtime instead, so a damaged field cannot produce a marker
 * that never expires and holds an entry back for good.
 */
function readRunMarkers() {
  let names;
  try {
    names = fs.readdirSync(runsDir());
  } catch {
    return []; // no runs directory yet is the normal state
  }

  const markers = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(runsDir(), name);
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      parsed = null; // unreadable or not JSON: there is no run here to believe
    }

    // The file's own mtime is the fallback clock, and only the clock: a stat
    // that fails must not discard a marker that parsed perfectly well.
    let startedAt = parsed?.startedAt;
    if (!Number.isFinite(Date.parse(startedAt))) {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        /* no age at all, so the marker expires immediately */
      }
      startedAt = new Date(mtimeMs).toISOString();
    }
    markers.push({ ...(parsed ?? {}), startedAt, file });
  }
  return markers;
}

/** The live run for a manifest key, if there is one. */
function liveRunFor(key, markers) {
  return markers.find((marker) => marker.key === key && runIsLive(marker)) ?? null;
}

/**
 * Records that a review is running, before codex is handed minutes of work.
 * Written with the manifest's write-then-rename, so a concurrent reader never
 * sees half a marker and reads a live run as a dead one. Best effort: a marker
 * that cannot be written must not stop the review it describes.
 */
function beginRun(entry, reviewPath) {
  const file = runMarkerPath(entry.repo, entry.number);
  const marker = {
    key: entry.key,
    repo: entry.repo,
    number: entry.number,
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    reviewPath
  };
  try {
    ensurePrivateDir(runsDir());
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return file;
  } catch {
    return null;
  }
}

/**
 * Clears a marker. Called from a `finally`, and a killed process leaves its
 * marker behind — which `runIsLive` reads as gone, and the next `clean` sweeps.
 */
function endRun(file) {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* a leftover marker expires on its own */
  }
}

/**
 * Puts an entry back in the manifest if it left while its review was running.
 *
 * A `clean` that overrode the running-review guard — or that had already taken
 * its snapshot before this run recorded itself — removes the entry for the PR
 * this review belongs to, and a review whose PR is not in the manifest can
 * never be selected by a later `--purge-reviews`. Re-recording costs an entry
 * whose worktree may be gone, which `list` already reports plainly; losing the
 * review announces nothing at all.
 */
function restoreEntryIfDropped(entry) {
  try {
    const restored = mutateManifest((manifest) =>
      manifest.entries.some((item) => item.key === entry.key)
        ? null // already there — another process re-recorded it first
        : { ...manifest, entries: [...manifest.entries, entry] }
    );
    if (!restored) return false;
    log(
      `Re-recorded ${entry.key} in the manifest: it was cleaned while this review ran, ` +
        "and a review whose PR is not recorded there cannot be selected by a later clean."
    );
    return true;
  } catch (error) {
    // The review itself succeeded and is already saved. Say what could not be
    // recorded rather than failing a run that produced a real review.
    log(
      `Could not re-record ${entry.key} in the manifest (${error.message}). ` +
        "The saved review is on disk, but `clean --purge-reviews` will not select it."
    );
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * PR reference resolution
 * ------------------------------------------------------------------ */

/** Accepts `42`, `#42`, `owner/repo#42`, and github.com PR URLs. */
export function parsePrRef(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    throw new UserError("No pull request given. Pass a number, `owner/repo#42`, or a PR URL.");
  }

  const url = text.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i);
  if (url) {
    return { repo: `${url[1]}/${stripGitSuffix(url[2])}`, number: Number(url[3]) };
  }

  const scoped = text.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (scoped) {
    return { repo: `${scoped[1]}/${stripGitSuffix(scoped[2])}`, number: Number(scoped[3]) };
  }

  const bare = text.match(/^#?(\d+)$/);
  if (bare) {
    return { repo: null, number: Number(bare[1]) };
  }

  throw new UserError(
    `Could not read \`${text}\` as a pull request.`,
    "Use a number (42), owner/repo#42, or https://github.com/owner/repo/pull/42."
  );
}

const stripGitSuffix = (value) => value.replace(/\.git$/i, "");

/** Normalizes any GitHub remote URL form to `owner/repo`. */
export function remoteUrlToSlug(url) {
  const text = String(url ?? "").trim();
  if (!text) return null;
  const match =
    text.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/) ||
    text.match(/^ssh:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/) ||
    text.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
  return match ? `${match[1]}/${stripGitSuffix(match[2])}` : null;
}

function findRemoteForSlug(repoDir, slug) {
  const result = git(repoDir, ["remote", "-v"]);
  if (result.status !== 0) return null;
  const wanted = slug.toLowerCase();
  for (const line of result.stdout.split("\n")) {
    const [name, url] = line.trim().split(/\s+/);
    if (!name || !url) continue;
    if (remoteUrlToSlug(url)?.toLowerCase() === wanted) return name;
  }
  return null;
}

function repoRootOf(dir) {
  const result = git(dir, ["rev-parse", "--show-toplevel"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

const realPath = (target) => {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

/**
 * True only when `dir` is itself a repository root. `repoRootOf` reports the
 * nearest *ancestor* repo, so a leftover non-git directory inside a tracked
 * tree would otherwise be mistaken for a healthy cached clone — and the plugin
 * would write its refs into that unrelated repository.
 */
function isRepoRoot(dir) {
  if (!fs.existsSync(dir)) return false;
  const root = repoRootOf(dir);
  return Boolean(root) && realPath(root) === realPath(dir);
}

function resolveRepoSlug(prRef, options, cwd) {
  if (prRef.repo) return prRef.repo;
  if (options.repo) return stripGitSuffix(options.repo);

  const root = repoRootOf(cwd);
  if (!root) {
    throw new UserError(
      "A bare PR number needs a repository for context, but this directory is not a git repository.",
      "Pass --repo owner/repo, or use owner/repo#42 / a full PR URL."
    );
  }
  const view = gh(["repo", "view", "--json", "nameWithOwner"], { cwd: root });
  if (view.status !== 0) {
    throw new UserError(
      `Could not determine the GitHub repository for ${root}.`,
      "Pass --repo owner/repo explicitly."
    );
  }
  return JSON.parse(view.stdout).nameWithOwner;
}

/**
 * Picks the git repository that will host the PR's refs and worktree:
 * the caller's own repo when it matches, otherwise a cached clone.
 */
function resolveHostRepo(slug, cwd, options = {}) {
  if (!options.forceClone) {
    const root = repoRootOf(cwd);
    if (root) {
      const remote = findRemoteForSlug(root, slug);
      if (remote) {
        return { repoDir: root, remote, mode: "worktree" };
      }
    }
  }

  const repoDir = path.join(clonesDir(), slugToDir(slug));
  if (isRepoRoot(repoDir)) {
    log(`Refreshing cached clone of ${slug}…`);
    return { repoDir, remote: "origin", mode: "clone" };
  }

  log(`Cloning ${slug} into the review cache (blobless)…`);
  ensurePrivateDir(clonesDir());
  fs.rmSync(repoDir, { recursive: true, force: true });
  const clone = gh(["repo", "clone", slug, repoDir, "--", "--filter=blob:none", "--no-tags", "--quiet"]);
  if (clone.status !== 0) {
    throw new UserError(
      `Could not clone ${slug}.`,
      "Check that the repository exists and your `gh` account can read it."
    );
  }
  return { repoDir, remote: "origin", mode: "clone" };
}

/* ------------------------------------------------------------------ *
 * plugin build
 *
 * The safety rules that decide whether a review may be published live in the
 * command prompts, not in this script. Claude Code copies those prompts into
 * its plugin cache at install time and loads them at session start, so an edit
 * to a prompt is invisible twice over: until the copy is refreshed, and then
 * until the session is restarted. Both gaps are silent, and both leave a run
 * following an older set of rules than the ones in the source tree.
 *
 * `doctor` closes the first gap by comparing the running copy against the
 * marketplace source. The second is closed from the prompt side: each command
 * file carries the version it was written for, and compares it against the
 * `pluginVersion` reported here.
 * ------------------------------------------------------------------ */

const claudeConfigDir = () =>
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const pluginRoot = () => path.dirname(path.dirname(realPath(fileURLToPath(import.meta.url))));

const pluginManifest = () =>
  readJsonFile(path.join(pluginRoot(), ".claude-plugin", "plugin.json"));

// Never compared: `.git` is not shipped, and the rest is editor and tool debris
// that says nothing about whether the installed prompts match their source.
const UNCOMPARED = new Set([".git", "node_modules", ".DS_Store"]);

/**
 * Content hash of every shipped file, keyed by path relative to `root`.
 * Symlinks are skipped rather than followed — a link cycle inside a plugin
 * directory would otherwise hang the preflight for every command.
 */
export function hashPluginDir(root) {
  const hashes = new Map();

  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (UNCOMPARED.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) {
        try {
          hashes.set(rel, createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
        } catch {
          hashes.set(rel, "unreadable");
        }
      }
    }
  };

  walk(realPath(root), "");
  return hashes;
}

/** Relative paths that differ between two `hashPluginDir` results, sorted. */
export function diffFileHashes(installed, source) {
  const changed = new Set();
  for (const [rel, hash] of source) if (installed.get(rel) !== hash) changed.add(rel);
  for (const rel of installed.keys()) if (!source.has(rel)) changed.add(rel);
  return [...changed].sort();
}

/**
 * The marketplace a cached copy came from. Claude Code lays the cache out as
 * <config>/plugins/cache/<marketplace>/<plugin>/<version>, which is only a
 * preference here: the caller falls back to scanning every known marketplace.
 */
function marketplaceFromInstallPath(root) {
  const parts = realPath(root).split(path.sep);
  const index = parts.lastIndexOf("cache");
  return index > 0 && parts.length - index >= 4 ? parts[index + 1] : null;
}

/**
 * Where the installed copy was built from, if that source is still on disk.
 * Both local-directory marketplaces and cloned ones qualify — `installLocation`
 * is a real path in either case.
 */
function findPluginSource(pluginName, installedRoot) {
  const known = readJsonFile(path.join(claudeConfigDir(), "plugins", "known_marketplaces.json"));
  if (!known || typeof known !== "object") return null;

  const preferred = marketplaceFromInstallPath(installedRoot);
  const all = Object.keys(known);
  const names = [...all.filter((name) => name === preferred), ...all.filter((name) => name !== preferred)];

  for (const name of names) {
    const location = known[name]?.installLocation;
    if (typeof location !== "string" || !location) continue;

    const manifest = readJsonFile(path.join(location, ".claude-plugin", "marketplace.json"));
    const entry = manifest?.plugins?.find?.((plugin) => plugin?.name === pluginName);
    // A `source` object means a remote plugin: there is no local tree to diff.
    if (typeof entry?.source !== "string") continue;

    const dir = path.resolve(location, entry.source);
    if (fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) {
      return { marketplace: name, dir };
    }
  }
  return null;
}

/**
 * Warn-level: a stale copy still reviews correctly, and blocking every review
 * on an unreleased edit would be intolerable during development. What it has to
 * do is say so, loudly enough that a flag the prompts describe and the script no
 * longer accepts is read as a stale install rather than a broken pull request.
 */
function checkPluginBuild() {
  const root = pluginRoot();
  const manifest = pluginManifest();
  const version = manifest?.version ?? "unknown";
  const name = manifest?.name ?? "codex-pr-reviewer";
  const base = { name: "plugin", version, stale: false, source: null, changed: [] };

  const source = findPluginSource(name, root);
  if (!source) {
    return { ...base, ok: true, detail: `${version} (no local source to compare against)`, remedy: null };
  }
  if (realPath(source.dir) === realPath(root)) {
    return { ...base, ok: true, source: source.dir, detail: `${version}, running from source`, remedy: null };
  }

  const changed = diffFileHashes(hashPluginDir(root), hashPluginDir(source.dir));
  if (changed.length === 0) {
    return { ...base, ok: true, source: source.dir, detail: `${version}, matches ${source.marketplace}`, remedy: null };
  }

  const shown = changed.slice(0, 3).join(", ");
  return {
    ...base,
    ok: false,
    level: "warn",
    stale: true,
    source: source.dir,
    changed,
    detail: `${version} — installed copy differs from ${source.dir} in ${changed.length} file(s): ${shown}${changed.length > 3 ? ", …" : ""}`,
    remedy:
      `Run \`claude plugin marketplace update ${source.marketplace}\`, then ` +
      `\`claude plugin update ${name}@${source.marketplace}\`, then restart Claude Code — ` +
      "command prompts are only read at session start."
  };
}

/* ------------------------------------------------------------------ *
 * doctor
 * ------------------------------------------------------------------ */

// 2.5 is when `git worktree` arrived, but it is not the floor that matters:
// cached clones are made with `clone --filter=blob:none`, which needs the
// partial-clone support added in 2.19. Checking the lower number reported a
// healthy toolchain and then failed at the first clone.
const GIT_MIN = [2, 19];

// Stated once. Both codex remedies name it, and only one of them is reachable
// in the test suite, so a rename would leave the other pointing at a package
// that no longer exists with the suite still green.
const CODEX_INSTALL = "npm install -g @openai/codex";

function checkGit() {
  const result = run("git", ["--version"]);
  const wanted = GIT_MIN.join(".");
  if (result.error?.code === "ENOENT") {
    return { name: "git", ok: false, detail: "not installed", remedy: `Install Git ${wanted} or newer.` };
  }
  const version = result.stdout.trim().replace(/^git version\s*/, "");
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [needMajor, needMinor] = GIT_MIN;
  const ok = major > needMajor || (major === needMajor && minor >= needMinor);
  return {
    name: "git",
    ok,
    detail: version,
    remedy: ok ? null : `worktrees and \`clone --filter\` need Git ${wanted} or newer.`
  };
}

function checkGh() {
  const version = run("gh", ["--version"]);
  if (version.error?.code === "ENOENT") {
    return {
      name: "gh",
      ok: false,
      detail: "not installed",
      remedy: "Install the GitHub CLI: https://cli.github.com"
    };
  }
  const auth = run("gh", ["auth", "status"]);
  if (auth.status !== 0) {
    return {
      name: "gh",
      ok: false,
      detail: "not authenticated",
      remedy: "Run `gh auth login`."
    };
  }
  const account = `${auth.stdout}${auth.stderr}`.match(/account\s+(\S+)/)?.[1] ?? "unknown";
  return {
    name: "gh",
    ok: true,
    detail: `${version.stdout.split("\n")[0].trim()} (${account})`,
    remedy: null
  };
}

function checkCodex() {
  const version = run("codex", ["--version"]);
  if (version.error?.code === "ENOENT") {
    return {
      name: "codex",
      ok: false,
      detail: "not installed",
      remedy: `Install the Codex CLI: \`${CODEX_INSTALL}\``
    };
  }
  // Being installed is not the same as speaking the interface this plugin
  // builds against. `--context` is the cautionary case: it appended a
  // positional prompt that `codex review --base` rejects outright, and the flag
  // shipped broken across several releases because nothing checked.
  //
  // Tested by capability rather than by version number. A floor would be a
  // guess — the Codex CLI does not document which release added `review
  // --base`, and a renumbering would invalidate it either way — while this asks
  // the binary in front of us the only question that matters. It costs about
  // 30ms and needs no network.
  //
  // `--help` exits 0 for a subcommand that does not exist, printing top-level
  // help, so the exit status proves nothing and the flag text is the signal.
  const reviewHelp = run("codex", ["review", "--help"]);
  // Distinguish "it answered, and the flag is not there" from "it never
  // answered". A crash or a timeout produces output with no `--base` in it, and
  // reading only the text turns a hung binary into "update the Codex CLI" —
  // advice that cannot fix the actual problem and hides it.
  if (reviewHelp.status !== 0) {
    return {
      name: "codex",
      ok: false,
      detail: `${version.stdout.trim()} — \`codex review --help\` ${reviewHelp.timedOut ? "timed out" : `exited ${reviewHelp.status}`}`,
      remedy: `Could not ask this Codex what \`review\` accepts: ${
        combinedOutput(reviewHelp).trim().split("\n").slice(-1)[0] || "no output"
      }`
    };
  }
  if (!combinedOutput(reviewHelp).includes("--base")) {
    return {
      name: "codex",
      ok: false,
      detail: `${version.stdout.trim()} — \`codex review\` does not accept --base`,
      remedy:
        `This plugin pins the diff to the merge-base with \`codex review --base <branch>\`, which this Codex does not support. Update the Codex CLI: \`${CODEX_INSTALL}\`.`
    };
  }

  const login = run("codex", ["login", "status"]);
  // `codex login status` reports on stderr, not stdout.
  const loginText = combinedOutput(login).trim().split("\n")[0] ?? "";
  const loggedIn = login.status === 0 && /logged in/i.test(loginText);
  return {
    name: "codex",
    ok: loggedIn,
    detail: `${version.stdout.trim()} — ${loggedIn ? loginText : "not logged in"}`,
    remedy: loggedIn ? null : "Run `codex login`."
  };
}

function commandDoctor(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });
  const build = checkPluginBuild();
  const checks = [checkGit(), checkGh(), checkCodex(), build];
  // A warn-level check reports itself as not ok but does not fail the preflight:
  // it describes the plugin's own state, not a missing prerequisite.
  const ok = checks.every((check) => check.ok || check.level === "warn");
  const report = {
    ok,
    checks,
    cacheRoot: cacheRoot(),
    pluginVersion: build.version,
    stale: build.stale
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return ok ? 0 : 1;
  }

  for (const check of checks) {
    const status = check.ok ? "ok  " : check.level === "warn" ? "warn" : "FAIL";
    process.stdout.write(`${status}  ${check.name}: ${check.detail}\n`);
    if (check.remedy) process.stdout.write(`      → ${check.remedy}\n`);
  }
  process.stdout.write(`\ncache: ${cacheRoot()}\n`);
  return ok ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * prepare
 * ------------------------------------------------------------------ */

/**
 * Fetches the PR head and its base as two separate calls. A single atomic
 * fetch of both would abort entirely when the base branch has been deleted —
 * routine on merged PRs — even though the head is perfectly fetchable.
 */
function fetchPullRefs(repoDir, remote, number, baseRefName, baseRefOid) {
  const headRef = `${REF_NS}/pr/${number}`;
  const baseRef = `${REF_NS}/base/${number}`;

  // Plugin-owned refs outside refs/heads: never checked out, so a forced
  // update always succeeds no matter what state a stale worktree is in.
  gitChecked(repoDir, [
    "fetch", "--force", "--no-tags", remote,
    `+refs/pull/${number}/head:${headRef}`
  ]);

  const byName = git(repoDir, [
    "fetch", "--force", "--no-tags", remote,
    `+refs/heads/${baseRefName}:${baseRef}`
  ]);
  if (byName.status === 0) return { headRef, baseRef, baseSource: baseRefName };

  // The base branch is gone from the remote. Fall back to the commit GitHub
  // recorded as the base tip, which is still reachable while the PR exists.
  if (baseRefOid) {
    const byOid = git(repoDir, ["fetch", "--force", "--no-tags", remote, baseRefOid]);
    if (byOid.status === 0) {
      const fetched = git(repoDir, ["rev-parse", "FETCH_HEAD"]).stdout.trim() || baseRefOid;
      gitChecked(repoDir, ["update-ref", baseRef, fetched]);
      log(`Base branch \`${baseRefName}\` is gone from the remote; using recorded base commit ${baseRefOid.slice(0, 12)}.`);
      return { headRef, baseRef, baseSource: `${baseRefOid.slice(0, 12)} (branch deleted)` };
    }
    // The OID may still be present locally from an earlier fetch.
    if (git(repoDir, ["rev-parse", "--verify", `${baseRefOid}^{commit}`]).status === 0) {
      gitChecked(repoDir, ["update-ref", baseRef, baseRefOid]);
      return { headRef, baseRef, baseSource: `${baseRefOid.slice(0, 12)} (local)` };
    }
  }

  throw new UserError(
    `Could not fetch the base branch \`${baseRefName}\` for PR #${number}.`,
    "The branch appears to be deleted on the remote and its base commit is unreachable. Pass --clone to retry against a fresh cache clone."
  );
}

function ensureWorktree(repoDir, worktree, headBranch, headRef) {
  const registered = git(repoDir, ["worktree", "list", "--porcelain"])
    .stdout.split("\n")
    .some((line) => line.startsWith("worktree ") && path.resolve(line.slice(9)) === worktree);

  if (registered && fs.existsSync(path.join(worktree, ".git"))) {
    // Idempotent refresh: `checkout -B` already resets the branch to headRef.
    gitChecked(worktree, ["checkout", "--force", "-B", headBranch, headRef]);
    gitChecked(worktree, ["clean", "-fdx", "--quiet"]);
    return;
  }

  // Stale registration or leftover directory — clear both, then recreate.
  if (registered) git(repoDir, ["worktree", "remove", "--force", worktree]);
  fs.rmSync(worktree, { recursive: true, force: true });
  git(repoDir, ["worktree", "prune"]);
  ensurePrivateDir(path.dirname(worktree));
  gitChecked(repoDir, ["worktree", "add", "--force", "-B", headBranch, worktree, headRef]);
}

/**
 * Resolves which PR is being addressed without touching the network or disk.
 * Shared by every command so the identity of a target is computed one way.
 */
function resolveTarget(options, positionals, cwd) {
  const prRef = parsePrRef(options.pr ?? positionals[0]);
  const slug = resolveRepoSlug(prRef, options, cwd);
  return {
    slug,
    number: prRef.number,
    key: entryKey(slug, prRef.number),
    // Namespaced by repository, as the worktree path already is. Bare
    // `codex-pr/42` collides whenever one checkout has remotes for two
    // repositories, and silently reviews one PR against another's branch.
    headBranch: `${BRANCH_NS}/${slugToDir(slug)}/${prRef.number}`,
    baseBranch: `${BRANCH_NS}/${slugToDir(slug)}/${prRef.number}-base`,
    worktree: path.join(worktreesDir(), slugToDir(slug), `pr-${prRef.number}`)
  };
}

/** Takes already-parsed options — callers must never re-parse argv. */
function prepare(options, positionals, cwd) {
  const target = resolveTarget(options, positionals, cwd);
  const { slug, number } = target;

  log(`Resolving ${slug}#${number}…`);
  const pr = ghJson(["pr", "view", String(number), "--repo", slug, "--json", PR_FIELDS]);

  const { repoDir, remote, mode } = resolveHostRepo(slug, cwd, { forceClone: options.clone });

  log(`Fetching pull ref and base branch (${pr.baseRefName})…`);
  const { headRef, baseRef } = fetchPullRefs(
    repoDir,
    remote,
    number,
    pr.baseRefName,
    pr.baseRefOid
  );

  const headSha = gitOut(repoDir, ["rev-parse", headRef]);

  // What was fetched has to be what GitHub says the head is. Without this the
  // metadata comes from the API while the code comes from whichever remote
  // matched the slug, and nothing ever compares the two — so a review can be
  // run, saved, and posted against a commit the pull request does not contain.
  if (pr.headRefOid && headSha !== pr.headRefOid) {
    throw new UserError(
      `The fetched head of ${slug}#${number} is not the one GitHub advertises.`,
      `Fetched ${headSha.slice(0, 12)} from \`${remote}\`, expected ${String(pr.headRefOid).slice(0, 12)}. Pass --clone to fetch from the repository the API is describing.`
    );
  }

  const mergeBase = gitOut(repoDir, ["merge-base", baseRef, headRef]);
  const { headBranch, baseBranch, worktree } = target;

  // These branch names belong to the plugin, but the namespace is not reserved
  // and `--force` below would move whatever is sitting there. Anything already
  // present that this plugin did not record is someone else's.
  const known = readManifest().entries.find((item) => item.key === target.key);
  for (const branch of [headBranch, baseBranch]) {
    const exists =
      git(repoDir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
    if (exists && !known) {
      throw new UserError(
        `\`${branch}\` already exists in ${repoDir} and this plugin has no record of creating it.`,
        "Rename or delete that branch yourself, then run this again. It will not be moved for you."
      );
    }
  }

  // Pinning --base to a branch at the merge-base makes the review see exactly
  // GitHub's three-dot "Files changed" diff, whichever range semantics Codex uses.
  gitChecked(repoDir, ["branch", "--force", baseBranch, mergeBase]);

  log(`Preparing worktree at ${worktree}…`);
  ensureWorktree(repoDir, worktree, headBranch, headRef);

  // Also warms lazily-fetched blobs while the network is still available,
  // so the read-only sandboxed review never needs to reach out.
  const changed = gitOut(worktree, ["diff", "--numstat", baseBranch, "--"])
    .split("\n")
    .filter(Boolean).length;

  const entry = {
    key: target.key,
    repo: slug,
    number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: Boolean(pr.isDraft),
    author: pr.author?.login ?? "unknown",
    isFork: Boolean(pr.isCrossRepository),
    worktree,
    repoDir,
    remote,
    mode,
    headBranch,
    baseBranch,
    refs: [headRef, baseRef],
    headSha,
    mergeBase,
    baseRefName: pr.baseRefName,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles ?? changed,
    preparedAt: new Date().toISOString()
  };
  upsertEntry(entry);

  return { entry, pr };
}

function commandPrepare(argv, cwd) {
  const { options, positionals } = parseArgs(argv, PREPARE_SCHEMA);
  const { entry } = prepare(options, positionals, cwd);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${describeEntry(entry)}\n`);
  return 0;
}

const describeSize = (entry) =>
  `${entry.changedFiles} file${entry.changedFiles === 1 ? "" : "s"}, +${entry.additions}/-${entry.deletions}`;

function describeEntry(entry) {
  const size = describeSize(entry);
  return [
    `${entry.repo}#${entry.number} — ${entry.title}`,
    `  by @${entry.author}${entry.isFork ? " (fork)" : ""} · ${entry.state}${entry.isDraft ? " (draft)" : ""} · ${size} · base ${entry.baseRefName}`,
    `  worktree  ${entry.worktree}`,
    `  base ref  ${entry.baseBranch} @ ${entry.mergeBase.slice(0, 12)}`,
    `  head      ${entry.headBranch} @ ${entry.headSha.slice(0, 12)}`
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * review
 * ------------------------------------------------------------------ */

// Every saved review opens with this marker, so a file in the reviews
// directory can be told apart from anything else that lands there.
const REVIEW_MARKER = "<!-- codex-pr-reviewer";

/**
 * Codex's own exit status, carried in the first line of the document.
 *
 * The wrapper reports its own success separately — a review that ran and was
 * saved is a result even when codex failed, so `sweep` does not mark healthy
 * PRs broken — which leaves the file itself as the only durable record of
 * whether the run finished. It is in the document rather than the manifest
 * because the manifest is mutable and separable: the entry a review came from
 * can be cleaned away while the review stays on disk.
 */
const reviewMarker = (exitCode) => `${REVIEW_MARKER} exit=${exitCode} -->`;

// Written in place of the review body when codex returned nothing, so a saved
// file that looks complete cannot be mistaken for a run that produced findings.
const NO_REVIEW_BODY = "_Codex produced no review output._";

/** sha256 of a saved review, used to bind an approval to the exact bytes. */
export const digestOf = (text) => createHash("sha256").update(text).digest("hex");

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The timestamp `reviewStamp` produces, as a pattern. Kept beside it. */
const REVIEW_STAMP_PATTERN = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z`;

export const reviewStamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, "-");

function reviewOutputPath(entry) {
  return path.join(reviewsDir(), `${slugToDir(entry.repo)}-pr${entry.number}-${reviewStamp()}.md`);
}

/**
 * Matches a saved review filename to one PR, anchored on the whole name that
 * `reviewOutputPath` writes: `<slug>-pr<N>-<stamp>.md`.
 *
 * The obvious spelling — does the name start with `<slug>-pr<N>-` — is wrong,
 * because a repository name may itself continue where that prefix stops. A
 * review of `o/r-pr7-archive#9` is saved as `o__r-pr7-archive-pr9-<stamp>.md`,
 * which starts with `o__r-pr7-` and so reads as a review of `o/r#7`. Getting
 * that wrong deletes another repository's review under `--purge-reviews`.
 * Requiring the stamp to follow the number removes the ambiguity:
 * `archive-pr9-…` is not a stamp.
 */
export function reviewFileMatches(name, repo, number) {
  const head = escapeRegex(`${slugToDir(repo)}-pr${number}-`);
  return new RegExp(`^${head}${REVIEW_STAMP_PATTERN}\\.md$`).test(name);
}

/**
 * Saved review filenames belonging to `entries`. Re-running a review on one PR
 * is expected and leaves several files, so every match is returned, newest
 * first. Takes the listing rather than reading the directory so the matching
 * rule stays testable on its own.
 */
export function selectReviewFiles(names, entries) {
  return names
    .filter((name) => entries.some((entry) => reviewFileMatches(name, entry.repo, entry.number)))
    .sort()
    .reverse();
}

/** Absolute paths of the saved reviews for `entries`, newest first. */
function savedReviewsFor(entries) {
  const dir = reviewsDir();
  if (!fs.existsSync(dir)) return [];
  return selectReviewFiles(fs.readdirSync(dir), entries).map((name) => path.join(dir, name));
}

/** How many saved reviews are on disk. */
const savedReviewCount = () => (fs.existsSync(reviewsDir()) ? fs.readdirSync(reviewsDir()).length : 0);

/**
 * Identifies a set of reviews as one list, so an approval to delete them can be
 * carried between the process that showed the plan and the process that acts on
 * it. Order-independent: the same files always digest the same.
 */
export const reviewSnapshotDigest = (files) => digestOf([...files].sort().join("\n"));

/**
 * Identifies the entire removal as one plan: every entry, and for each of them
 * the exact worktree, branches, refs, and clone decision that were shown.
 *
 * `--confirm-reviews` covered only the reviews, so everything else was
 * re-selected from scratch by the confirmed run. A PR prepared between the
 * preview and the confirmation matched the same selector — `--all` most
 * obviously — and was deleted without ever having been in the list the user
 * approved. Order-independent, so the same plan always digests the same.
 */
export function cleanPlanDigest(targets, options = {}) {
  const lines = [...targets]
    .map((entry) =>
      [
        entry.key,
        entry.worktree ?? "",
        entry.headBranch ?? "",
        entry.baseBranch ?? "",
        [...(entry.refs ?? [])].sort().join(","),
        entry.repoDir ?? ""
      ].join("\u0000")
    )
    .sort();
  // The flags belong in the digest too: the same entries with --purge-clones
  // added is a different, larger removal than the one that was shown.
  lines.push(`purgeClones=${Boolean(options.purgeClones)}`);
  lines.push(`purgeReviews=${Boolean(options.purgeReviews)}`);
  return digestOf(lines.join("\n"));
}

/**
 * Codex cites files by absolute path inside the worktree. Rewrite those to
 * repo-relative paths — they are noise when read locally and leak a local
 * filesystem path if the review is posted to a public PR.
 */
export function stripWorktreePaths(text, worktree) {
  const escaped = escapeRegex(worktree);
  return String(text)
    .replaceAll(new RegExp(`${escaped}/`, "g"), "")
    .replaceAll(new RegExp(escaped, "g"), ".");
}

/**
 * Confirms a worktree `--no-prepare` is about to review is still the one that
 * was prepared.
 *
 * `--no-prepare` exists so the command can prepare once and review without
 * paying for a second round of git and API calls, and it took the manifest
 * entirely on trust. The gap between the two steps is not small: a `clean` runs
 * in it, a person opens the directory, a branch gets checked out somewhere
 * else. Reviewing whatever is there now and labelling the result with the head
 * the manifest remembers produces a review that is wrong about which commits it
 * read, which is worse than not running.
 *
 * Cheap enough to do every time — three git commands against a local checkout.
 */
function verifyPreparedWorktree(entry) {
  const stop = (message, remedy) => {
    throw new UserError(message, remedy ?? "Re-run without --no-prepare to rebuild it.");
  };

  if (!fs.existsSync(entry.worktree)) {
    stop(`The worktree for ${entry.key} is gone (${entry.worktree}).`);
  }
  const root = git(entry.worktree, ["rev-parse", "--show-toplevel"]);
  if (root.status !== 0 || realPath(root.stdout.trim()) !== realPath(entry.worktree)) {
    stop(`${entry.worktree} is no longer a git worktree of its own.`);
  }

  const head = gitOutOrNull(entry.worktree, ["rev-parse", "HEAD"]);
  if (!head) {
    stop(`Could not resolve HEAD in the worktree for ${entry.key}.`);
  }
  if (entry.headSha && head !== entry.headSha) {
    stop(
      `The worktree for ${entry.key} is at ${head.slice(0, 12)}, not the ${String(entry.headSha).slice(0, 12)} that was prepared.`,
      "Re-run without --no-prepare to fetch the current head and review that."
    );
  }

  const base = gitOutOrNull(entry.worktree, ["rev-parse", entry.baseBranch]);
  if (!base) {
    stop(`Could not resolve \`${entry.baseBranch}\`, the base this review would diff against.`);
  }
  if (entry.mergeBase && base !== entry.mergeBase) {
    stop(
      `\`${entry.baseBranch}\` is at ${base.slice(0, 12)}, not the merge-base ${String(entry.mergeBase).slice(0, 12)} that was prepared.`,
      "The diff would not be GitHub's diff. Re-run without --no-prepare."
    );
  }

  // The commits matching is not the same as the tree matching. `codex review
  // --base` diffs the *working tree*, so an uncommitted edit is reviewed as
  // part of the pull request while HEAD and the base both still agree with the
  // manifest — and the saved review carries the real PR's title and head over
  // findings about content the pull request does not contain. This is the one
  // failure here that needs no attacker and no race: someone opening the
  // checkout and saving a file is enough.
  const dirty = git(entry.worktree, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty.status !== 0) {
    stop(`Could not read the state of the worktree for ${entry.key}.`);
  }
  const changes = dirty.stdout.trim();
  if (changes) {
    const count = changes.split("\n").length;
    stop(
      `The worktree for ${entry.key} has ${count} uncommitted change${count === 1 ? "" : "s"}, which a review would read as part of the pull request.`,
      `Discard them, or re-run without --no-prepare — that refreshes the checkout. First: ${changes.split("\n")[0]}`
    );
  }
}

async function commandReview(argv, cwd) {
  const { options, positionals } = parseArgs(argv, REVIEW_SCHEMA);
  const dryRun = Boolean(options["dry-run"]);
  let entry;

  // --dry-run must not fetch, branch, or write a worktree: it exists to answer
  // "what would this run?", so it resolves the target and stops there.
  if (options["no-prepare"] || dryRun) {
    const target = resolveTarget(options, positionals, cwd);
    entry = readManifest().entries.find((item) => item.key === target.key);

    if (!entry && !dryRun) {
      throw new UserError(
        `No prepared worktree for ${target.slug}#${target.number}.`,
        "Run `prepare` first, or drop --no-prepare."
      );
    }
    if (!entry) {
      // Nothing prepared yet — the paths are pure functions of slug and number,
      // so the planned command can still be shown honestly.
      entry = { ...target, repo: target.slug, title: "(not prepared yet)", unprepared: true };
    } else if (!dryRun) {
      verifyPreparedWorktree(entry);
    }
  } else {
    ({ entry } = prepare(options, positionals, cwd));
  }

  if (entry.state && entry.state !== "OPEN") {
    log(`Note: ${entry.key} is ${entry.state}.`);
  }

  // The worktree is someone else's code, fetched from the internet, and Codex
  // reads project documents (AGENTS.md and its fallbacks) from its working
  // directory before it starts. Left on, a pull request can rewrite the
  // instructions of the reviewer sent to inspect it — suppressing findings,
  // redirecting attention, or asserting that something malicious is intended.
  // The anti-injection rules in review.md bind Claude, not this child process,
  // so this is the only place that hole can be closed.
  const codexArgs = ["-C", entry.worktree, "-s", "read-only", "-c", "project_doc_max_bytes=0"];
  if (options.model) codexArgs.push("-m", options.model);
  if (options.profile) codexArgs.push("-p", options.profile);
  if (options.effort) codexArgs.push("-c", `model_reasoning_effort="${options.effort}"`);

  codexArgs.push(
    "review",
    "--base",
    entry.baseBranch,
    "--title",
    `PR #${entry.number}: ${entry.title}`
  );

  if (dryRun) {
    const plan = {
      entry: entry.key,
      worktree: entry.worktree,
      prepared: !entry.unprepared,
      command: ["codex", ...codexArgs]
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      if (entry.unprepared) log("Not prepared yet — showing the command `prepare` would enable.");
      process.stdout.write(`${["codex", ...codexArgs].map(shellQuote).join(" ")}\n`);
    }
    return 0;
  }

  ensurePrivateDir(reviewsDir());
  const outputPath = reviewOutputPath(entry);
  // Declared before the run rather than after it: a concurrent `clean` needs to
  // know this worktree is being read while codex is still reading it.
  const runMarker = beginRun(entry, outputPath);

  try {
    log(`Running: codex ${codexArgs.slice(0, 4).join(" ")} … review --base ${entry.baseBranch}`);
    // With --json the review text must not share stdout with the JSON payload.
    const { status, stdout } = await streamCodex(codexArgs, {
      echo: options.json ? process.stderr : process.stdout
    });

    const body = stripWorktreePaths(stdout, entry.worktree).trim();
    // `||` not `??`: a failed `codex --version` yields "", which is not nullish.
    const model = options.model || run("codex", ["--version"]).stdout.trim() || "codex";
    const document = [
      reviewMarker(status),
      `# Codex review — ${entry.repo}#${entry.number}`,
      "",
      `**${entry.title}** by @${entry.author}`,
      entry.url,
      "",
      `Base \`${entry.baseRefName}\` @ \`${entry.mergeBase.slice(0, 12)}\` · head \`${entry.headSha.slice(0, 12)}\` · ${describeSize(entry)}`,
      "",
      "---",
      "",
      body || NO_REVIEW_BODY,
      "",
      "---",
      "",
      `<sub>Automated review by ${model} against the merge-base of \`${entry.baseRefName}\`. Findings are advisory and may be wrong — verify before acting.</sub>`,
      ""
    ].join("\n");
    fs.writeFileSync(outputPath, document, { mode: 0o600 });
    const digest = digestOf(document);
    // Held until here, after the file exists: a review is only reachable once
    // both its own bytes and its PR's manifest entry are on disk.
    const restored = restoreEntryIfDropped(entry);

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ...entry,
            reviewPath: outputPath,
            reviewDigest: digest,
            manifestRestored: restored,
            exitCode: status
          },
          null,
          2
        )}\n`
      );
    } else {
        process.stdout.write(`\nSaved to ${outputPath}\n`);
    }

    if (status !== 0) log(`Note: codex exited ${status}.`);
    // Our exit status reports whether *this* wrapper did its job. A review that
    // ran and was saved is a success even if codex exited nonzero — callers like
    // `sweep` would otherwise mark healthy PRs as failed. Codex's own status is
    // carried in the JSON `exitCode` field and logged above.
    return body ? 0 : (status || 1);
  } finally {
    endRun(runMarker);
  }
}

function streamCodex(args, { echo = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      echo.write(chunk);
    });
    child.on("error", (error) => {
      reject(
        error.code === "ENOENT"
          ? new UserError("`codex` is not installed or not on PATH.", "Run `/codex-pr-reviewer:review` after installing the Codex CLI.")
          : error
      );
    });
    child.on("close", (status) => resolve({ status, stdout }));
  });
}

/* ------------------------------------------------------------------ *
 * list
 * ------------------------------------------------------------------ */

function commandList(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["repo"],
    booleanOptions: ["json"]
  });

  // A missing worktree directory does NOT mean there is nothing to clean: the
  // branches and refs still exist in the user's real repository, and this
  // manifest is the only record of them. Report the state; never drop it.
  const manifest = readManifest();
  const annotated = manifest.entries.map((entry) => ({
    ...entry,
    worktreeMissing: !fs.existsSync(entry.worktree)
  }));

  const filtered = options.repo
    ? annotated.filter((entry) => canonicalSlug(entry.repo) === canonicalSlug(options.repo))
    : annotated;
  // `?? ""` rather than assuming the field: a manifest is a file on disk that
  // people do edit, and an entry missing one key should not turn `list` — the
  // command someone reaches for when things look wrong — into a stack trace.
  const sorted = [...filtered].sort((a, b) =>
    String(b.preparedAt ?? "").localeCompare(String(a.preparedAt ?? ""))
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ entries: sorted }, null, 2)}\n`);
    return 0;
  }

  if (sorted.length === 0) {
    process.stdout.write("No prepared PR worktrees.\n");
    return 0;
  }
  for (const entry of sorted) {
    process.stdout.write(`${describeEntry(entry)}\n  prepared  ${entry.preparedAt}\n`);
    if (entry.worktreeMissing) {
      process.stdout.write(
        `  ! worktree directory is gone; \`clean --pr ${entry.repo}#${entry.number}\` still removes its branches and refs\n`
      );
    }
    process.stdout.write("\n");
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * clean
 * ------------------------------------------------------------------ */

function selectForClean(entries, options) {
  if (options.all) return entries;

  if (options.pr !== undefined) {
    const prRef = parsePrRef(options.pr);
    return entries.filter(
      (entry) =>
        entry.number === prRef.number &&
        (!prRef.repo || canonicalSlug(entry.repo) === canonicalSlug(prRef.repo)) &&
        (!options.repo || canonicalSlug(entry.repo) === canonicalSlug(options.repo))
    );
  }

  if (options.repo) {
    return entries.filter((entry) => canonicalSlug(entry.repo) === canonicalSlug(options.repo));
  }

  const days = Number(options["older-than"] ?? 7);
  if (!Number.isFinite(days) || days < 0) {
    throw new UserError("`--older-than` needs a non-negative number of days.");
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => Date.parse(entry.preparedAt) < cutoff);
}

/**
 * Removes one entry's git state. Reports failures instead of swallowing them —
 * a branch that could not be deleted (because the user has it checked out, say)
 * must keep its manifest entry, or the record needed to retry is lost.
 *
 * Deliberately does NOT delete cached clones: several entries in one batch can
 * share a clone, and deleting it here would pull the repository out from under
 * every entry still queued behind this one — their branch and ref removal would
 * then be skipped silently, and reported as success. `purgeUnusedClones` runs
 * once, after the whole batch.
 */
/**
 * Everything `removeEntry` is about to destroy, checked before anything is
 * destroyed.
 *
 * The manifest is a JSON file in a cache directory. It is hand-edited when
 * something goes wrong, and writable by anything running as this user, so every
 * field below is untrusted input to a routine that runs `git worktree remove
 * --force`, `git branch -D`, `git update-ref -d`, and `rmSync(recursive)`.
 *
 * Validating late is the same as not validating: the previous version checked
 * the worktree path immediately before `rmSync`, by which point git had already
 * been handed that path and both branches and every ref had already been
 * deleted. So this runs first and returns a reason instead of throwing —
 * a bad entry is reported and kept for inspection, never silently skipped.
 *
 * Recomputing the worktree path is not enough on its own either: `expected`
 * derives from `entry.number`, and a number of `1/../../../..` normalizes out
 * of the cache, so an entry naming that path on both sides compares equal to
 * itself. The number and slug are therefore validated as values first.
 */
function entryRemovalProblem(entry) {
  if (!Number.isSafeInteger(entry.number) || entry.number <= 0) {
    return `pull request number ${JSON.stringify(entry.number)} is not a positive integer`;
  }
  if (typeof entry.repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(entry.repo)) {
    return `repository ${JSON.stringify(entry.repo)} is not an owner/name slug`;
  }

  // Branches and refs are deleted outright, in a repository that is usually the
  // user's own. Nothing else in it belongs to this plugin.
  for (const branch of [entry.headBranch, entry.baseBranch]) {
    if (typeof branch !== "string" || !branch.startsWith(`${BRANCH_NS}/`)) {
      return `branch ${JSON.stringify(branch)} is outside \`${BRANCH_NS}/\``;
    }
  }
  for (const ref of entry.refs ?? []) {
    if (typeof ref !== "string" || !ref.startsWith(`${REF_NS}/`)) {
      return `ref ${JSON.stringify(ref)} is outside \`${REF_NS}/\``;
    }
  }

  if (typeof entry.worktree !== "string" || !entry.worktree) {
    return `worktree ${JSON.stringify(entry.worktree)} is not a path`;
  }
  const expected = path.join(worktreesDir(), slugToDir(entry.repo), `pr-${entry.number}`);
  if (realPath(entry.worktree) !== realPath(expected)) {
    return `worktree ${entry.worktree} is not where one for ${entry.key} belongs (${expected})`;
  }
  return null;
}

function removeEntry(entry) {
  const removed = [];
  const failed = [];

  const problem = entryRemovalProblem(entry);
  if (problem) {
    failed.push(`${entry.key}: ${problem} — nothing was removed for this entry`);
    return { removed, failed };
  }

  if (repoRootOf(entry.repoDir)) {
    git(entry.repoDir, ["worktree", "remove", "--force", entry.worktree]);
    git(entry.repoDir, ["worktree", "prune"]);

    for (const [branch, recordedOid] of [
      [entry.headBranch, entry.headSha],
      [entry.baseBranch, entry.mergeBase]
    ]) {
      if (git(entry.repoDir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status !== 0) {
        continue; // already gone
      }
      // `branch -D` is unconditional, so the manifest naming a branch is not
      // enough on its own: the entry can outlive what it describes, and the
      // name can have been reused since. Delete only the commit that was
      // recorded — anything else is now somebody's work, not this plugin's.
      const tip = git(entry.repoDir, ["rev-parse", `refs/heads/${branch}`]).stdout.trim();
      if (recordedOid && tip && tip !== recordedOid) {
        failed.push(
          `branch ${branch}: now at ${tip.slice(0, 12)}, recorded as ${String(recordedOid).slice(0, 12)} — left alone`
        );
        continue;
      }
      const result = git(entry.repoDir, ["branch", "-D", branch]);
      if (result.status === 0) {
        removed.push(`branch ${branch}`);
      } else {
        failed.push(`branch ${branch}: ${(result.stderr || "").trim().split("\n")[0]}`);
      }
    }

    for (const ref of entry.refs ?? []) {
      if (git(entry.repoDir, ["show-ref", "--verify", "--quiet", ref]).status !== 0) continue;
      const result = git(entry.repoDir, ["update-ref", "-d", ref]);
      if (result.status === 0) {
        removed.push(`ref ${ref}`);
      } else {
        failed.push(`ref ${ref}: ${(result.stderr || "").trim().split("\n")[0]}`);
      }
    }
  }

  // Safe to delete recursively: `entryRemovalProblem` established at the top of
  // this function, before git touched anything, that this path is the one a
  // worktree for this entry would occupy.
  fs.rmSync(entry.worktree, { recursive: true, force: true });
  removed.push(`worktree ${entry.worktree}`);
  // Drop the now-empty per-repo parent; throws harmlessly if siblings remain.
  try {
    fs.rmdirSync(path.dirname(entry.worktree));
  } catch {
    /* other PRs from this repo are still prepared */
  }

  return { removed, failed };
}

/**
 * Deletes cached clones left unreferenced once the batch is done. Runs after
 * every entry has had its branches and refs removed, so nothing is pulled out
 * from under an entry still waiting its turn.
 */
function purgeUnusedClones(processed, survivors) {
  const notes = [];
  const seen = new Set();

  for (const entry of processed) {
    if (entry.mode !== "clone") continue;
    const repoDir = realPath(entry.repoDir);
    if (seen.has(repoDir)) continue;
    seen.add(repoDir);

    // Normalize both sides: manifest paths are stored as given, so a raw
    // `startsWith` against a path.join-normalized prefix can silently miss.
    const insideCache = `${repoDir}${path.sep}`.startsWith(`${realPath(clonesDir())}${path.sep}`);
    if (!insideCache) continue;

    const stillUsed = survivors.some((other) => realPath(other.repoDir) === repoDir);
    if (stillUsed) {
      notes.push(`kept clone ${entry.repoDir} (still used by another prepared PR)`);
    } else if (fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true, force: true });
      notes.push(`clone ${entry.repoDir}`);
    }
  }
  return notes;
}

/**
 * Binds a `--purge-reviews` run to the file list its dry run showed.
 *
 * The plan is built by one process and carried out by another, with a human
 * confirmation in between. Recomputing the list in the second process would
 * delete whatever is on disk by then — including a review a background run or a
 * sweep saved during the confirmation, which appeared in nothing anyone
 * approved. The digest is never quoted back in a failure: a caller that can
 * read it off an error has lost the link to an approval it exists to carry.
 */
/**
 * The same rule as `requireReviewSnapshot`, over the whole removal.
 *
 * A clean is two processes: one shows a plan, another carries it out. Between
 * them a review can finish, a sweep can prepare more PRs, and the selector is
 * re-run from a manifest that has moved. Refusing here costs one repeat of a
 * dry run; not refusing costs a worktree nobody agreed to delete.
 */
function requireCleanPlan(targets, flags, confirm) {
  const supplied = String(confirm ?? "").trim().toLowerCase();
  if (!supplied) {
    throw new UserError(
      "Refusing to clean without `--confirm-plan <digest>`.",
      "Re-run with --dry-run, show what it lists, and pass the plan digest it prints."
    );
  }
  if (supplied.length < 12) {
    throw new UserError(
      `The plan digest \`${supplied}\` is too short to identify a cleanup.`,
      "Pass at least the first 12 characters that --dry-run printed."
    );
  }
  if (!cleanPlanDigest(targets, flags).startsWith(supplied)) {
    throw new UserError(
      "What would be removed is no longer what that plan digest described.",
      "Re-run with --dry-run to see what is there now, show that list, and confirm it."
    );
  }
}

function requireReviewSnapshot(planned, confirm) {
  const supplied = String(confirm ?? "").trim().toLowerCase();
  if (!supplied) {
    throw new UserError(
      `Refusing to delete ${planned.length} saved review${planned.length === 1 ? "" : "s"} without \`--confirm-reviews <digest>\`.`,
      "Re-run with --dry-run, show the list, and pass the digest it prints."
    );
  }
  if (supplied.length < 12) {
    throw new UserError(
      `The digest \`${supplied}\` is too short to identify a set of reviews.`,
      "Pass at least the first 12 characters that --dry-run printed."
    );
  }
  if (!reviewSnapshotDigest(planned).startsWith(supplied)) {
    throw new UserError(
      "The saved reviews on disk are not the ones that digest approved.",
      "Re-run with --dry-run to see what is there now, and confirm that list."
    );
  }
}

/**
 * Reviews are the product, not scratch state, so cleaning only deletes them
 * when asked. What is left has to be said on every path that reports a clean,
 * `--json` and `Nothing to clean.` included: reviews of a PR no longer in the
 * manifest are precisely the ones no later `--purge-reviews` can select, so a
 * remainder nobody is told about is one nobody thinks to look for.
 */
function describeKeptReviews(count, purgeReviews) {
  if (count <= 0) return "";
  return `\nKept ${count} saved review${count === 1 ? "" : "s"} in ${reviewsDir()}${
    purgeReviews ? " (not tied to a cleaned PR)" : ""
  }\n`;
}

/**
 * The entries a review is still running against — held back by default, cleaned
 * anyway under `--include-running`. Said on every path that reports a clean,
 * for the same reason kept reviews are: an entry nobody is told about is one
 * nobody comes back for.
 */
function describeRunning(runs, includeRunning) {
  if (runs.length === 0) return "";
  const count = `${runs.length} entr${runs.length === 1 ? "y" : "ies"}`;
  const lines = runs
    .map((run) => {
      const pid = run.pid ? `, pid ${run.pid}` : "";
      const saving = run.reviewPath ? ` → will save ${path.basename(run.reviewPath)}` : "";
      return `  - ${run.key} (running since ${run.startedAt}${pid})${saving}`;
    })
    .join("\n");

  return includeRunning
    ? `\nCleaning ${count} with a review still running (--include-running). Those reviews read the worktrees being removed and may fail; each re-records its PR when it saves.\n${lines}\n`
    : `\nHeld back ${count} with a review still running:\n${lines}\nWait for the review to finish, or pass --include-running to clean it anyway.\n`;
}

function commandClean(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["pr", "repo", "older-than", "confirm-reviews", "confirm-plan"],
    booleanOptions: ["json", "all", "dry-run", "purge-clones", "purge-reviews", "include-running"]
  });

  const manifest = readManifest();
  const selected = selectForClean(manifest.entries, options);

  // A review still running is reading the worktree this would delete, and writes
  // its output after any snapshot taken here — into a file no later
  // `--purge-reviews` could select, since selection starts from the manifest
  // entry this run would have removed. So hold those entries back and say which:
  // the run finishes in minutes, and the next clean takes them. `review`
  // re-records its own entry if this guard is overridden, which is the backstop
  // rather than the fix — an overridden run may still lose its worktree.
  const markers = readRunMarkers();
  const includeRunning = Boolean(options["include-running"]);
  const running = selected.flatMap((entry) => {
    const run = liveRunFor(entry.key, markers);
    return run
      ? [
          {
            key: entry.key,
            startedAt: run.startedAt,
            pid: Number.isInteger(run.pid) ? run.pid : null,
            reviewPath: run.reviewPath ?? null,
            held: !includeRunning
          }
        ]
      : [];
  });
  const heldKeys = new Set(running.filter((run) => run.held).map((run) => run.key));
  const targets = selected.filter((entry) => !heldKeys.has(entry.key));

  // Deliberately not implied by `--all`, the way `--purge-clones` is. A clone
  // can be re-fetched; a review is the output of a Codex run the user paid for
  // and cannot be regenerated byte-for-byte. Deleting one stays its own ask.
  const purgeReviews = Boolean(options["purge-reviews"]);
  const purgeClone = Boolean(options["purge-clones"] || options.all);
  // Held per entry, so a review that could not be deleted keeps its own PR in
  // the manifest rather than being charged to the batch.
  const doomed = new Map(
    targets.map((entry) => [entry.key, purgeReviews ? savedReviewsFor([entry]) : []])
  );
  const allDoomed = targets.flatMap((entry) => doomed.get(entry.key));

  if (options["dry-run"]) {
    const plan = targets.map((entry) => ({
      key: entry.key,
      worktree: entry.worktree,
      repoDir: entry.repoDir,
      branches: [entry.headBranch, entry.baseBranch],
      refs: entry.refs ?? [],
      reviews: doomed.get(entry.key)
    }));
    const digest = reviewSnapshotDigest(allDoomed).slice(0, 12);
    const planDigest = cleanPlanDigest(targets, { purgeClones: purgeClone, purgeReviews }).slice(0, 12);
    const wouldKeep = savedReviewCount() - allDoomed.length;

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            wouldRemove: plan,
            planDigest: plan.length > 0 ? planDigest : null,
            reviews: allDoomed,
            reviewsDigest: allDoomed.length > 0 ? digest : null,
            running,
            keptReviews: { count: wouldKeep, dir: reviewsDir() }
          },
          null,
          2
        )}\n`
      );
      return 0;
    }

    // "Nothing to clean." is only true when nothing was held back; a run that
    // declined to touch an entry has something to report, not nothing.
    const body =
      plan.length === 0
        ? running.length === 0
          ? "Nothing to clean.\n"
          : ""
        : `${plan
            .map(
              (item) =>
                `${item.key}\n  worktree  ${item.worktree}\n  branches  ${item.branches.join(", ")}\n  in repo   ${item.repoDir}${
                  item.reviews.length > 0
                    ? `\n  reviews   ${item.reviews.map((file) => path.basename(file)).join("\n            ")}`
                    : ""
                }`
            )
            .join("\n\n")}\n${
            allDoomed.length > 0
              ? `\n${allDoomed.length} saved review${allDoomed.length === 1 ? "" : "s"} would be deleted permanently.\nReviews digest ${digest}\n`
              : ""
          }\nPlan digest ${planDigest}\n`;
    process.stdout.write(
      `${body}${describeRunning(running, includeRunning)}${describeKeptReviews(wouldKeep, purgeReviews)}`
    );
    return 0;
  }

  // Only now that this is a real run: a marker whose process is gone stands for
  // nothing, so drop it rather than let `runs/` fill with the debris of
  // interrupted reviews. `--dry-run` stays free of side effects.
  for (const marker of markers) {
    if (runIsLive(marker)) continue;
    try {
      fs.rmSync(marker.file, { force: true });
    } catch {
      /* a marker that will not delete expires on its own */
    }
  }

  // Nothing to approve when nothing would be deleted, and the check would then
  // be friction with no subject.
  if (allDoomed.length > 0) requireReviewSnapshot(allDoomed, options["confirm-reviews"]);
  if (targets.length > 0) {
    requireCleanPlan(targets, { purgeClones: purgeClone, purgeReviews }, options["confirm-plan"]);
  }

  const targetKeys = new Set(targets.map((entry) => entry.key));
  const survivors = manifest.entries.filter((entry) => !targetKeys.has(entry.key));

  // Per-entry work first, for every entry, against clones that still exist.
  // A review is removed with the PR it belongs to, so a failure here counts
  // against that entry and holds it in the manifest for a retry — the reviews
  // of a PR no longer recorded there could never be selected again.
  const results = targets.map((entry) => {
    const outcome = removeEntry(entry);
    for (const file of doomed.get(entry.key)) {
      try {
        fs.rmSync(file);
        outcome.removed.push(`review ${file}`);
      } catch (error) {
        outcome.failed.push(`review ${file}: ${error.message}`);
      }
    }
    return { key: entry.key, ...outcome };
  });

  // Then, once nothing else needs them, the shared clones.
  const clonesRemoved = purgeClone ? purgeUnusedClones(targets, survivors) : [];

  // Only entries that were fully removed leave the manifest. Anything that
  // failed keeps its record so it can be retried — reporting success while
  // orphaning branches in the user's repo is the worse outcome.
  //
  // Re-read rather than writing back the snapshot this run started from: a
  // review that finished in the meantime has re-recorded its own entry, and a
  // `prepare` may have added one, both of which writing the stale list back
  // would erase — re-creating the very unreachable review this guard is for.
  const cleared = new Set(results.filter((r) => r.failed.length === 0).map((r) => r.key));
  mutateManifest((latest) => ({
    ...latest,
    entries: latest.entries.filter((entry) => !cleared.has(entry.key))
  }));

  const failures = results.filter((result) => result.failed.length > 0);
  const kept = savedReviewCount();

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          cleaned: results,
          clones: clonesRemoved,
          incomplete: failures.map((f) => f.key),
          running,
          keptReviews: { count: kept, dir: reviewsDir() }
        },
        null,
        2
      )}\n`
    );
    return failures.length === 0 ? 0 : 1;
  }
  if (results.length === 0) {
    process.stdout.write(
      `${running.length === 0 ? "Nothing to clean.\n" : ""}${describeRunning(running, includeRunning)}${describeKeptReviews(kept, purgeReviews)}`
    );
    return 0;
  }
  for (const result of results) {
    process.stdout.write(`${result.key}\n${result.removed.map((item) => `  - ${item}`).join("\n")}\n`);
    for (const failure of result.failed) {
      process.stdout.write(`  ! could not remove ${failure}\n`);
    }
  }
  if (clonesRemoved.length > 0) {
    process.stdout.write(`\ncached clones\n${clonesRemoved.map((item) => `  - ${item}`).join("\n")}\n`);
  }
  if (failures.length > 0) {
    process.stdout.write(
      `\n${failures.length} entr${failures.length === 1 ? "y was" : "ies were"} left in the manifest so cleanup can be retried.\n`
    );
  }
  process.stdout.write(describeRunning(running, includeRunning));
  process.stdout.write(describeKeptReviews(kept, purgeReviews));
  return failures.length === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * entrypoint
 * ------------------------------------------------------------------ */

const USAGE = `pr-workspace.mjs — review GitHub PRs with Codex

  doctor  [--json]
  prepare <pr> [--repo owner/repo] [--clone] [--json]
  review  <pr> [--repo owner/repo] [--model M] [--effort E]
               [--profile P] [--no-prepare] [--json]
  list    [--repo owner/repo] [--json]
  clean   [--pr N | --repo owner/repo | --all | --older-than DAYS]
          --confirm-plan <digest> [--purge-clones]
          [--purge-reviews --confirm-reviews <digest>]
          [--include-running] [--dry-run] [--json]

<pr> accepts 42, #42, owner/repo#42, or a github.com pull request URL.
`;

/**
 * Git configuration forced on every git this process causes to run, its own
 * and the ones `gh` spawns alike.
 *
 * Checking out a pull request writes attacker-authored bytes into a working
 * tree, and that happens *before* codex is started under `-s read-only` — so
 * anything git executes during checkout runs outside the sandbox entirely.
 *
 *   - `core.hooksPath` is the live one. A repository that configures it into
 *     the working tree — which is exactly what Husky does, and it is common —
 *     lets a pull request that touches `.husky/post-checkout` run a script the
 *     moment the worktree is created. Pointing it at an empty directory ends
 *     that for hooks generally, not just that one.
 *   - The LFS filters are neutralised because `.gitattributes` is part of the
 *     diff: a pull request can direct files through a filter driver it does not
 *     have to define, so long as the user has one configured. Reviews read
 *     pointer files instead of fetched objects, which is the right trade when
 *     the alternative is running a filter on a stranger's say-so.
 *
 * Set through GIT_CONFIG_* rather than `-c` because it has to reach the git
 * that `gh repo clone` runs, where there is no command line to add flags to.
 *
 * What this does not close: a filter driver other than LFS that the user has
 * configured under a name a pull request can guess. Enumerating those is not
 * possible from here; a plugin-owned clone with its own config file is the
 * complete fix, and it is a larger change than this one.
 */
function hardenGitEnvironment() {
  // Deliberately never created. Git is content with a hooksPath that does not
  // exist and simply finds no hooks there, which is the whole point — creating
  // it would make `review --dry-run`, which promises to touch nothing, write to
  // disk on every invocation.
  const hooks = path.join(cacheRoot(), "empty-hooks");
  const forced = [
    ["core.hooksPath", hooks],
    ["filter.lfs.smudge", "cat"],
    ["filter.lfs.clean", "cat"],
    ["filter.lfs.process", ""],
    ["filter.lfs.required", "false"]
  ];
  process.env.GIT_CONFIG_COUNT = String(forced.length);
  forced.forEach(([key, value], index) => {
    process.env[`GIT_CONFIG_KEY_${index}`] = key;
    process.env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
}

async function main() {
  hardenGitEnvironment();
  const [command, ...rest] = process.argv.slice(2);
  const cwd = process.cwd();

  switch (command) {
    case "doctor":
      return commandDoctor(rest);
    case "prepare":
      return commandPrepare(rest, cwd);
    case "review":
      return commandReview(rest, cwd);
    case "list":
      return commandList(rest);
    case "clean":
      return commandClean(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(USAGE);
      return command === undefined ? 1 : 0;
    default:
      throw new UserError(`Unknown command \`${command}\`.`, USAGE);
  }
}

// `import.meta.url` is already symlink-resolved (Node resolves symlinks unless
// --preserve-symlinks), so argv[1] must be too. Comparing a symlinked argv[1]
// against the real module path makes this false and silently skips main() —
// which is exactly how a plugin installed via a symlinked checkout, or any
// path under macOS's /tmp -> /private/tmp, would run and print nothing at all.
const invokedDirectly =
  process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      if (error instanceof UserError) {
        process.stderr.write(`error: ${error.message}\n`);
        if (error.remedy) process.stderr.write(`${error.remedy}\n`);
      } else {
        process.stderr.write(`error: ${error?.stack ?? error}\n`);
      }
      process.exitCode = 1;
    });
}
