#!/usr/bin/env node
/**
 * Unit tests for the pure helpers in pr-workspace.mjs.
 *
 * These cover the parsing and rewriting logic that has no side effects.
 * The git/gh/codex integration is covered by tests/integration.sh, which
 * needs network access and a working `gh` login.
 *
 *   node tests/unit.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const pluginDir = path.join(root, "plugins", "codex-pr-reviewer");
const {
  parsePrRef,
  remoteUrlToSlug,
  stripWorktreePaths,
  canonicalSlug,
  slugToDir,
  entryKey,
  hashPluginDir,
  diffFileHashes,
  isInsideDir,
  digestOf,
  reviewStamp,
  reviewFileMatches,
  selectReviewFiles,
  reviewSnapshotDigest,
  runIsLive
} = await import(path.join(pluginDir, "scripts", "pr-workspace.mjs"));

let failures = 0;

const describe = (name) => {
  console.log(`${name}:`);
};

const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) {
    console.log(`       got      ${JSON.stringify(actual)}`);
    console.log(`       expected ${JSON.stringify(expected)}`);
  }
};

const throws = (label, fn) => {
  try {
    fn();
    failures += 1;
    console.log(`  FAIL ${label} (expected a throw)`);
  } catch {
    console.log(`  ok   ${label}`);
  }
};

describe("parsePrRef");
eq("bare number", parsePrRef("42"), { repo: null, number: 42 });
eq("hash number", parsePrRef("#42"), { repo: null, number: 42 });
eq("surrounding space", parsePrRef("  42  "), { repo: null, number: 42 });
eq("owner/repo#n", parsePrRef("owner/repo#42"), { repo: "owner/repo", number: 42 });
eq("pull URL", parsePrRef("https://github.com/cli/cli/pull/13899"), {
  repo: "cli/cli",
  number: 13899
});
eq("pull URL with /files", parsePrRef("https://github.com/cli/cli/pull/13899/files"), {
  repo: "cli/cli",
  number: 13899
});
eq("pull URL with .git", parsePrRef("https://github.com/o/r.git/pull/7"), {
  repo: "o/r",
  number: 7
});
eq("http URL", parsePrRef("http://github.com/o/r/pull/1"), { repo: "o/r", number: 1 });
throws("rejects prose", () => parsePrRef("the second one"));
throws("rejects empty", () => parsePrRef(""));
throws("rejects undefined", () => parsePrRef(undefined));

describe("remoteUrlToSlug");
eq("scp-style ssh", remoteUrlToSlug("git@github.com:cli/cli.git"), "cli/cli");
eq("scp-style, no .git", remoteUrlToSlug("git@github.com:cli/cli"), "cli/cli");
eq("https with .git", remoteUrlToSlug("https://github.com/cli/cli.git"), "cli/cli");
eq("https bare", remoteUrlToSlug("https://github.com/cli/cli"), "cli/cli");
eq("ssh:// URL", remoteUrlToSlug("ssh://git@github.com/cli/cli.git"), "cli/cli");
eq("enterprise host", remoteUrlToSlug("https://ghe.corp.example/team/proj.git"), "team/proj");
eq("nested group path", remoteUrlToSlug("https://github.com/org/sub/repo.git"), "org/sub/repo");
eq("not a URL", remoteUrlToSlug("not-a-url"), null);
eq("empty", remoteUrlToSlug(""), null);

describe("stripWorktreePaths");
eq(
  "rewrites a cited file path",
  stripWorktreePaths("see /wt/pkg/a.go:12 now", "/wt"),
  "see pkg/a.go:12 now"
);
eq("rewrites the bare root", stripWorktreePaths("root is /wt end", "/wt"), "root is . end");
eq(
  "handles regex metacharacters in the path",
  stripWorktreePaths("at /a+b(c)/x.go:1", "/a+b(c)"),
  "at x.go:1"
);
eq(
  "rewrites every occurrence",
  stripWorktreePaths("/wt/a.go and /wt/b.go", "/wt"),
  "a.go and b.go"
);
eq("leaves unrelated text alone", stripWorktreePaths("no paths here", "/wt"), "no paths here");

describe("slug canonicalization");
// Regression: `.replace("/", "__")` substituted only the first slash, so a
// three-segment slug kept a path separator and the review write threw ENOENT
// *after* the paid Codex run had already completed.
eq("three-segment slug has no separator", slugToDir("org/sub/repo"), "org__sub__repo");
eq("two-segment slug", slugToDir("cli/cli"), "cli__cli");
// Regression: GitHub slugs are case-insensitive, so two spellings used to
// produce two manifest entries pointing at one directory on APFS.
eq("case folds to one directory", slugToDir("Cli/CLI"), slugToDir("cli/cli"));
eq("case folds to one key", entryKey("Cli/CLI", 42), entryKey("cli/cli", 42));
eq("key shape", entryKey("cli/cli", 42), "cli/cli#42");
eq("canonicalSlug lowercases", canonicalSlug("Owner/Repo"), "owner/repo");

describe("diffFileHashes");
const hashes = (entries) => new Map(Object.entries(entries));
eq("identical trees", diffFileHashes(hashes({ "a.md": "1" }), hashes({ "a.md": "1" })), []);
eq(
  "edited file",
  diffFileHashes(hashes({ "a.md": "1" }), hashes({ "a.md": "2" })),
  ["a.md"]
);
eq(
  "file added at the source",
  diffFileHashes(hashes({}), hashes({ "commands/new.md": "1" })),
  ["commands/new.md"]
);
// A file deleted upstream but still sitting in the installed copy is just as
// stale as an edited one: the command it defines is still loadable.
eq("file deleted at the source", diffFileHashes(hashes({ "old.md": "1" }), hashes({})), ["old.md"]);
eq(
  "reports each path once, sorted",
  diffFileHashes(hashes({ "b": "1", "gone": "1" }), hashes({ "b": "2", "added": "1" })),
  ["added", "b", "gone"]
);

describe("hashPluginDir");
const shipped = hashPluginDir(pluginDir);
eq("hashes the command prompts", shipped.has("commands/review.md"), true);
eq("keys are relative to the root", shipped.has("scripts/pr-workspace.mjs"), true);
eq("a tree matches itself", diffFileHashes(shipped, hashPluginDir(pluginDir)), []);

describe("isInsideDir");
// Paths that do not exist on disk, so the assertions are about the path algebra
// rather than about whatever /tmp happens to be a symlink to today.
const reviewsRoot = "/nonexistent-cache/reviews";
eq("a file in the directory", isInsideDir(reviewsRoot, `${reviewsRoot}/o__r-pr7.md`), true);
eq("the directory itself is not inside itself", isInsideDir(reviewsRoot, reviewsRoot), false);
eq("an unrelated path", isInsideDir(reviewsRoot, "/nonexistent-cache/elsewhere/x.md"), false);
eq("a traversal that escapes", isInsideDir(reviewsRoot, `${reviewsRoot}/../elsewhere/x.md`), false);
eq("a traversal that lands back inside", isInsideDir(reviewsRoot, `${reviewsRoot}/../reviews/x.md`), true);
// The string-prefix version of this check calls a sibling directory a child.
eq("a sibling sharing a prefix", isInsideDir(reviewsRoot, "/nonexistent-cache/reviews-old/x.md"), false);

describe("reviewStamp");
// The matcher below anchors on the shape of this stamp. If the two ever drift,
// every saved review stops being recognised as one — including by `post`.
eq("matches the pattern the matcher expects", /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(reviewStamp()), true);
eq(
  "is the ISO timestamp with : and . swapped out",
  reviewStamp(new Date("2026-08-16T13:50:02.197Z")),
  "2026-08-16T13-50-02-197Z"
);

describe("reviewFileMatches");
eq("its own output", reviewFileMatches(`o__r-pr7-${reviewStamp()}.md`, "o/r", 7), true);
// A repository name can continue where a `<slug>-pr<N>-` prefix stops. This is
// a review of o/r-pr7-archive#9, and a prefix test reads it as one of o/r#7 —
// which deletes it under --purge-reviews and posts it to the wrong PR.
eq(
  "a repo whose name extends the prefix",
  reviewFileMatches("o__r-pr7-archive-pr9-2026-01-01T00-00-00-000Z.md", "o/r", 7),
  false
);
eq(
  "that same file against its real PR",
  reviewFileMatches("o__r-pr7-archive-pr9-2026-01-01T00-00-00-000Z.md", "o/r-pr7-archive", 9),
  true
);
eq("a longer number", reviewFileMatches("o__r-pr70-2026-01-01T00-00-00-000Z.md", "o/r", 7), false);
eq("a missing stamp", reviewFileMatches("o__r-pr7-a.md", "o/r", 7), false);
eq("trailing junk after the stamp", reviewFileMatches("o__r-pr7-2026-01-01T00-00-00-000Z.md.bak", "o/r", 7), false);
// Repo names may contain regex metacharacters; `.` must not match any byte.
eq("a dot is a literal dot", reviewFileMatches("o__rXjs-pr7-2026-01-01T00-00-00-000Z.md", "o/r.js", 7), false);
eq("the real dotted name", reviewFileMatches("o__r.js-pr7-2026-01-01T00-00-00-000Z.md", "o/r.js", 7), true);

describe("selectReviewFiles");
const listing = [
  "o__r-pr7-2026-01-01T00-00-00-000Z.md",
  "o__r-pr7-2026-02-02T00-00-00-000Z.md",
  "o__r-pr70-2026-01-01T00-00-00-000Z.md",
  "o__other-pr7-2026-01-01T00-00-00-000Z.md",
  "o__r-pr7-archive-pr9-2026-01-01T00-00-00-000Z.md",
  "manifest.json"
];
eq(
  "newest first, one PR",
  selectReviewFiles(listing, [{ repo: "o/r", number: 7 }]),
  ["o__r-pr7-2026-02-02T00-00-00-000Z.md", "o__r-pr7-2026-01-01T00-00-00-000Z.md"]
);
eq("a longer number is not a match", selectReviewFiles(listing, [{ repo: "o/r", number: 70 }]), [
  "o__r-pr70-2026-01-01T00-00-00-000Z.md"
]);
eq("another repo, same number", selectReviewFiles(listing, [{ repo: "o/other", number: 7 }]), [
  "o__other-pr7-2026-01-01T00-00-00-000Z.md"
]);
eq("repo case does not matter", selectReviewFiles(listing, [{ repo: "O/R", number: 7 }]).length, 2);
eq("no entries selects nothing", selectReviewFiles(listing, []), []);
eq("an unprepared PR selects nothing", selectReviewFiles(listing, [{ repo: "o/r", number: 9 }]), []);
eq(
  "several entries at once",
  selectReviewFiles(listing, [{ repo: "o/r", number: 70 }, { repo: "o/other", number: 7 }]).length,
  2
);

describe("reviewSnapshotDigest");
eq("order does not matter", reviewSnapshotDigest(["b", "a"]), reviewSnapshotDigest(["a", "b"]));
eq("an added file changes it", reviewSnapshotDigest(["a", "b"]) === reviewSnapshotDigest(["a", "b", "c"]), false);
eq("a removed file changes it", reviewSnapshotDigest(["a", "b"]) === reviewSnapshotDigest(["a"]), false);
eq("empty is stable", reviewSnapshotDigest([]), reviewSnapshotDigest([]));

describe("digestOf");
eq("known sha256", digestOf(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
eq("differs on one byte", digestOf("a") === digestOf("b"), false);

describe("runIsLive");
// A live marker is what stops `clean` deleting the worktree a review is reading.
// Reading a dead marker as live blocks cleanup; reading a live one as dead is
// what the whole guard exists to prevent — so both directions are pinned here.
// A dead pid needs a process to outlive, so that case is in regression.sh.
const marker = (extra) => ({
  key: "o/r#7",
  pid: process.pid,
  host: os.hostname(),
  startedAt: new Date().toISOString(),
  ...extra
});
const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
eq("this very process", runIsLive(marker()), true);
// No review takes this long, and a recycled pid must not block cleanup forever.
eq("older than any real review", runIsLive(marker({ startedAt: longAgo })), false);
eq("no start time", runIsLive(marker({ startedAt: undefined })), false);
eq("an unreadable start time", runIsLive(marker({ startedAt: "whenever" })), false);
// `process.kill(0, 0)` probes our own process group and succeeds, so a marker
// with no usable pid would otherwise report every stale run as a live one.
eq("pid 0", runIsLive(marker({ pid: 0 })), false);
eq("a negative pid", runIsLive(marker({ pid: -1 })), false);
eq("a pid that is a string", runIsLive(marker({ pid: String(process.pid) })), false);
eq("no pid at all", runIsLive(marker({ pid: undefined })), false);
// Another machine's pid cannot be probed from here, so the age cap is all there
// is: believed while fresh, gone once it is not.
eq("a fresh run on another host", runIsLive(marker({ host: "elsewhere", pid: 999_999 }), Date.now(), "here"), true);
eq("a stale run on another host", runIsLive(marker({ host: "elsewhere", startedAt: longAgo }), Date.now(), "here"), false);
eq("the same host, injected", runIsLive(marker({ host: "here", pid: 0 }), Date.now(), "here"), false);

describe("tool grants");
// Posting is the one irreversible act here, so only the command that posts may
// hold a grant that can reach it — and it reaches it through the script, not
// through `gh`. A blanket Bash(gh:*) would also carry `gh pr review`,
// `gh pr merge`, and `gh api` into commands that must never use them.
for (const command of ["review.md", "list.md", "sweep.md", "clean.md"]) {
  const front = fs.readFileSync(path.join(pluginDir, "commands", command), "utf8").split("---")[1];
  const grants = /allowed-tools:(.*)/.exec(front)[1];
  eq(`${command} has no blanket gh grant`, grants.includes("Bash(gh:*)"), false);
  eq(`${command} has no blanket git grant`, grants.includes("Bash(git:*)"), false);
}
const reviewGrants = /allowed-tools:(.*)/.exec(
  fs.readFileSync(path.join(pluginDir, "commands", "review.md"), "utf8")
)[1];
eq("review.md reaches gh only through the script", reviewGrants.includes("gh"), false);

describe("release stamps");
// Each command prompt names the version it was written for, and compares it at
// runtime against the version `doctor` reports. A stamp left behind at release
// time silently disables the only signal a session gets that its prompts are
// older than the plugin they are driving.
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const version = readJson(path.join(pluginDir, ".claude-plugin", "plugin.json")).version;
const marketplace = readJson(path.join(root, ".claude-plugin", "marketplace.json"));

eq("marketplace metadata version", marketplace.metadata.version, version);
eq(
  "marketplace entry version",
  marketplace.plugins.find((plugin) => plugin.name === "codex-pr-reviewer").version,
  version
);

for (const command of ["review.md", "sweep.md"]) {
  const text = fs.readFileSync(path.join(pluginDir, "commands", command), "utf8");
  const stamps = [...text.matchAll(/written for plugin version `([^`]+)`/g)].map((m) => m[1]);
  eq(`${command} carries exactly one stamp`, stamps.length, 1);
  eq(`${command} stamp matches plugin.json`, stamps[0], version);
  // review.md quotes the version a second time, in the comparison it is told to
  // make. Every version literal in the file has to move together or the prompt
  // ends up checking itself against a number nothing reports.
  const literals = [...new Set([...text.matchAll(/`(\d+\.\d+\.\d+)`/g)].map((m) => m[1]))];
  eq(`${command} has one version literal throughout`, literals, [version]);
}

console.log(failures === 0 ? "\nAll unit tests passed." : `\n${failures} test(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
