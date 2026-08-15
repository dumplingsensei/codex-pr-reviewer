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

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { parsePrRef, remoteUrlToSlug, stripWorktreePaths, canonicalSlug, slugToDir, entryKey } =
  await import(
    path.join(here, "..", "plugins", "codex-pr-reviewer", "scripts", "pr-workspace.mjs")
  );

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

console.log(failures === 0 ? "\nAll unit tests passed." : `\n${failures} test(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
