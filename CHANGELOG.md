# Changelog

Versions are the plugin's, in `plugins/codex-pr-reviewer/.claude-plugin/plugin.json`.
Claude Code resolves an install by that number and caches it, so every change to
anything under `plugins/` moves it — `tests/version-guard.sh` fails the build
otherwise.

## 0.9.1

Hardening found by an external security review, in the places that survived
0.9.0's narrowing.

- `clean` recomputes where a worktree must be before deleting it recursively,
  and refuses any other path. The manifest is a JSON file in a cache directory;
  `rmSync(recursive)` on a path read straight out of it was only ever safe while
  nothing had edited it.
- Manifest read-modify-write is serialized by a lock file with a 10-second
  staleness cutoff. Writing was already atomic, which is a different problem:
  two overlapping mutations meant the second discarded the first, and `sweep`
  prepares several PRs at once.
- A manifest that cannot be read is no longer treated as absent. Only `ENOENT`
  means first run; a permissions or I/O error now says so instead of presenting
  as an empty queue.
- `review --no-prepare` checks that the worktree is still a worktree, still at
  the head that was prepared, and still based on the recorded merge-base.
- The cache is created `0700` and reviews and the manifest `0600`, and an
  existing cache is repaired. These were left to the process umask.
- `list` no longer throws on an entry missing a field.
- `sweep` gathers from the same two queues as `list` — review-requested *and*
  assigned — de-duplicates on `url` before taking `--limit`, and fetches the
  `createdAt` that `--order newest` sorts on and never had.
- `review --dry-run` no longer prepares a worktree first.
- The integration suite compares the whole patch against `gh pr diff`, byte for
  byte, rather than file names and totals. Blob-hash abbreviation is normalized;
  nothing else is.
- CI validates both plugin manifests, and the actions are pinned to commit SHAs
  rather than mutable major tags. Dependabot still carries the updates.

## 0.9.0

Removed `post` and everything that existed to make publishing safe: −295 lines.
Raw Codex output is a poor pull request comment — findings are advisory and some
are wrong — so the plugin stops at the review and the command prompts instruct
Claude not to publish by another route. Three open findings are answered by
deletion rather than a fix, along with the missing comment-size guard.

## 0.8.1

`clean`'s verification step pre-approved `git worktree list` and
`git branch --list`, neither of which matches a command beginning `git -C`.

## 0.8.0

Closed the holes an external security review found in guarantees the repository
was asserting.

- Codex runs with project documents disabled, so an `AGENTS.md` inside a pull
  request cannot rewrite the instructions of the reviewer reading it.
- Every git this plugin causes to run gets an empty `core.hooksPath` and
  neutralized LFS filters. Checkout writes attacker-authored bytes to disk
  before Codex's sandbox exists.
- The `node` grant is narrowed to this plugin's own script by full path.
- The fetched head is verified against GitHub's `headRefOid`.
- Branches are namespaced by repository; `prepare` will not move a branch it has
  no record of creating, and `clean` deletes one only at the recorded commit.
- `clean` binds the whole plan with `--confirm-plan`, not just the review list.
- Removed `--context`, which `codex review --base` had always rejected, and
  `--trust-worktree`.
- The integration suite isolates its cache before installing its cleanup trap.
  It could delete real prepared state, including on the skip path.
- Git floor raised to 2.19 for `clone --filter`. `LICENSE` ships inside the
  packaged plugin directory.

## 0.7.0

A review still running is left alone by `clean`, guarded by run markers with
liveness and a TTL.

## 0.6.0

`clean --purge-reviews` deletes saved reviews, bound by digest to the list a dry
run showed.

## 0.5.0

Posting rules moved from the command prompt into the script, where a stale
prompt or a hostile diff cannot argue with them.

## 0.4.0

`doctor` reports when the installed copy is older than its source, or older than
the prompts a session loaded.

## 0.1.0 – 0.3.0

Initial plugin: fetch a pull request into an isolated worktree, pin the diff to
the merge-base so it matches GitHub's "Files changed", and hand it to
`codex review`.
