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
  remoteUrlParts,
  apiHostOf,
  stripWorktreePaths,
  canonicalSlug,
  slugToDir,
  entryKey,
  hashPluginDir,
  diffFileHashes,
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

describe("remoteUrlParts");
// The host used to be discarded, so every URL form below normalized to the same
// owner/repo whatever served it — and a remote for `o/r` on a mirror matched a
// pull request whose metadata came from GitHub. Both halves are compared now.
eq("scp-style carries its host", remoteUrlParts("git@github.com:cli/cli.git"), {
  host: "github.com",
  slug: "cli/cli"
});
eq("https carries its host", remoteUrlParts("https://github.com/cli/cli"), {
  host: "github.com",
  slug: "cli/cli"
});
eq("ssh:// with userinfo", remoteUrlParts("ssh://git@github.com/cli/cli.git"), {
  host: "github.com",
  slug: "cli/cli"
});
// A port is not part of the host's identity, and neither is the user.
eq("a port does not change the host", remoteUrlParts("ssh://git@github.com:22/cli/cli"), {
  host: "github.com",
  slug: "cli/cli"
});
eq("host case is not significant", remoteUrlParts("https://GitHub.COM/cli/cli").host, "github.com");
eq("an enterprise host is reported as itself", remoteUrlParts("https://ghe.corp.example/team/proj.git"), {
  host: "ghe.corp.example",
  slug: "team/proj"
});
// The case this exists for: same slug, different host.
eq(
  "the same repository on another host is another host",
  remoteUrlParts("https://gitlab.example.com/cli/cli").host ===
    remoteUrlParts("https://github.com/cli/cli").host,
  false
);
eq("not a URL", remoteUrlParts("not-a-url"), null);

describe("apiHostOf");
// Read off the URL the API returned, not guessed from the environment: GH_HOST
// describes `gh`'s default, which is not necessarily where this PR came from.
eq("from the PR url", apiHostOf({ url: "https://github.com/cli/cli/pull/1" }), "github.com");
eq(
  "an enterprise PR url",
  apiHostOf({ url: "https://ghe.corp.example/team/proj/pull/9" }),
  "ghe.corp.example"
);
// GH_HOST is the fallback this reads, so the suite has to say which value it is
// asserting about. Left to the ambient environment, an Enterprise user running
// the tests got a failure from a code path behaving exactly as intended.
const savedGhHost = process.env.GH_HOST;
delete process.env.GH_HOST;
eq("falls back to github.com when there is no url", apiHostOf({}), "github.com");
process.env.GH_HOST = "ghe.corp.example";
eq("and to GH_HOST where one is configured", apiHostOf({}), "ghe.corp.example");
if (savedGhHost === undefined) delete process.env.GH_HOST;
else process.env.GH_HOST = savedGhHost;

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

// Claude Code writes `.in_use/<pid>` into the installed copy to record which
// versions are live. Hashing it made every plugin in actual use report stale,
// with a remedy that could not clear it — the file returns on the next run.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cpr-hash-"));
fs.mkdirSync(path.join(scratch, "commands"), { recursive: true });
fs.writeFileSync(path.join(scratch, "commands", "review.md"), "a prompt\n");
fs.mkdirSync(path.join(scratch, ".in_use"), { recursive: true });
fs.writeFileSync(path.join(scratch, ".in_use", "4242"), '{"pid":4242}\n');
const walked = hashPluginDir(scratch);
eq("the live-use marker is not hashed", [...walked.keys()], ["commands/review.md"]);
// Narrow on purpose: everything that is not on the list still counts.
fs.writeFileSync(path.join(scratch, "commands", "extra.md"), "another prompt\n");
eq(
  "a real file beside it still is",
  [...hashPluginDir(scratch).keys()].sort(),
  ["commands/extra.md", "commands/review.md"]
);
fs.rmSync(scratch, { recursive: true, force: true });

describe("reviewStamp");
// The matcher below anchors on the shape of this stamp. If the two ever drift,
// every saved review stops being recognised as one, and `--purge-reviews` stops
// being able to select the reviews it is meant to remove.
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
// The wrapper can be killed outright — SIGKILL runs no handler, so nothing
// clears the marker — while codex carries on in its own process group, reading
// the worktree. A marker that knew only the wrapper reported that as finished.
eq("a dead wrapper but a live codex", runIsLive(marker({ pid: 999_999, codexPid: process.pid })), true);
eq("both processes gone", runIsLive(marker({ pid: 999_999, codexPid: 999_998 })), false);
eq("a codex pid that identifies nothing", runIsLive(marker({ pid: 999_999, codexPid: 0 })), false);
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
const grantsOf = (command) =>
  /allowed-tools:(.*)/.exec(
    fs.readFileSync(path.join(pluginDir, "commands", command), "utf8").split("---")[1]
  )[1];

// Which subcommands of the helper each command may run. `clean` is the one
// destructive subcommand, so it appears in exactly one row — reviewing a pull
// request and deleting worktrees are different jobs and get different grants.
// A wildcard over the whole script made every command able to run every
// subcommand, which is what these assertions exist to stop coming back.
const HELPER_GRANTS = {
  "review.md": ["doctor", "prepare", "review"],
  "sweep.md": ["doctor", "prepare", "review"],
  "list.md": ["list"],
  "clean.md": ["clean"]
};
const SUBCOMMANDS = ["doctor", "prepare", "review", "list", "clean"];

for (const [command, allowed] of Object.entries(HELPER_GRANTS)) {
  const grants = grantsOf(command);
  eq(`${command} has no blanket gh grant`, grants.includes("Bash(gh:*)"), false);
  eq(`${command} has no blanket git grant`, grants.includes("Bash(git:*)"), false);
  // `git -C` is a prefix, not a promise: it also matches reset, branch -D and
  // config. `clean` verifies its own removals, so nothing needs it.
  eq(`${command} has no git -C grant`, grants.includes("Bash(git -C"), false);
  // The wildcard this replaced pre-approved every subcommand at once.
  eq(
    `${command} does not grant the whole script`,
    /pr-workspace\.mjs"? \*\)/.test(grants),
    false
  );
  for (const sub of SUBCOMMANDS) {
    eq(
      `${command} ${allowed.includes(sub) ? "grants" : "withholds"} ${sub}`,
      grants.includes(`pr-workspace.mjs" ${sub} *)`),
      allowed.includes(sub)
    );
  }
}

const reviewGrants = grantsOf("review.md");
eq("review.md reaches gh only through the script", reviewGrants.includes("gh"), false);

// The rule has to match the command the prompt actually writes, quotes and all.
// A rule without them never matched the quoted invocation these prompts
// prescribe, so every helper call fell through to a permission prompt and the
// scoping below described a boundary that was not being applied.
for (const [command, allowed] of Object.entries(HELPER_GRANTS)) {
  const body = fs.readFileSync(path.join(pluginDir, "commands", command), "utf8");
  const invoked = [...body.matchAll(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/pr-workspace\.mjs" (\w+)/g)]
    .map((match) => match[1]);
  const ungranted = [...new Set(invoked)].filter((sub) => !allowed.includes(sub));
  eq(`${command} runs only what it grants`, ungranted, []);
}

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

describe("test stubs");
// `doctor` asks three things, and every test that gets past the preflight has
// to answer all three. That contract was written out six times across two
// languages, so adding a probe meant finding every copy — and the copy in the
// workflow is invisible to the regression suite, which is how a stale stub
// turns into an integration job failing with "toolchain unhealthy". These
// assertions are what stops it drifting back.
const stubPath = path.join(root, "tests", "stubs", "codex");
eq("the shared codex stub exists", fs.existsSync(stubPath), true);
eq(
  "and is executable",
  fs.existsSync(stubPath) && Boolean(fs.statSync(stubPath).mode & 0o111),
  true
);

const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "tests.yml"), "utf8");
eq("CI puts the shared stub on PATH", workflow.includes("tests/stubs"), true);
eq(
  "and does not write a codex of its own",
  /codex["']?\s*<<|--version\)\s*echo\s+"codex-cli/.test(workflow),
  false
);

const regression = fs.readFileSync(path.join(root, "tests", "regression.sh"), "utf8");
eq(
  "the regression suite writes no codex of its own",
  /codex["']?\s*<</.test(regression),
  false
);

describe("packaging");
// marketplace.json ships `./plugins/codex-pr-reviewer`, so anything left at the
// repository root is not in what a user installs. The licence has to be inside
// the packaged directory to reach them, and identical to the root copy or the
// two say different things about the same code.
const rootLicense = path.join(root, "LICENSE");
const pluginLicense = path.join(pluginDir, "LICENSE");
eq("the plugin directory carries a LICENSE", fs.existsSync(pluginLicense), true);
eq(
  "it is byte-identical to the root one",
  fs.existsSync(pluginLicense) && fs.readFileSync(pluginLicense, "utf8"),
  fs.readFileSync(rootLicense, "utf8")
);
// SECURITY.md lives at the repository root and is not packaged, so the only
// route an installed copy can offer is a link. Without one, a user who installs
// the plugin gets the short Safety section and no way to report privately.
const shippedReadme = fs.readFileSync(path.join(pluginDir, "README.md"), "utf8");
eq(
  "the shipped README routes to the security policy",
  shippedReadme.includes("SECURITY.md"),
  true
);
eq(
  "and to the private reporting path",
  shippedReadme.includes("security/advisories/new"),
  true
);

eq(
  "plugin.json declares the licence it ships",
  readJson(path.join(pluginDir, ".claude-plugin", "plugin.json")).license,
  "MIT"
);

console.log(failures === 0 ? "\nAll unit tests passed." : `\n${failures} test(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
