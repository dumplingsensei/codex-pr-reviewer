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
  diffFileHashes
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
