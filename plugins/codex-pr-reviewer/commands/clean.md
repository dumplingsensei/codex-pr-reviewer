---
description: Remove PR worktrees, branches, and cached clones this plugin created
argument-hint: '[--pr N] [--repo owner/repo] [--all] [--older-than DAYS] [--purge-clones]'
allowed-tools: Read, Grep, Glob, AskUserQuestion, Bash(node:*), Bash(git worktree list:*), Bash(git branch --list:*)
---

Remove the review scratch state this plugin created: worktrees, `codex-pr/*` branches, plugin-owned refs, and optionally cached clones.

Raw slash-command arguments:
`$ARGUMENTS`

## Steps

1. **Always dry-run first.** Recognized flags are `--pr`, `--repo`, `--older-than`, `--all`, and `--purge-clones`. Pass through only those, each as a separate argument — never interpolate the raw argument string into the shell:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pr-workspace.mjs" clean [--pr <ref>] [--repo <owner/repo>] \
     [--older-than <days>] [--all] [--purge-clones] --dry-run --json
   ```
   With no selector the script targets entries older than 7 days. If the user passed something unrecognized, say which flag you ignored rather than forwarding it.

2. **Show exactly what will be removed** — the worktree path, the two branch names, and which repository they live in, per PR. This matters because removal touches the user's real repositories, not just the cache: worktree registrations and `codex-pr/*` branches are created inside whichever repo hosted the PR.

   If the dry run is empty, say so and stop.

3. **Confirm with `AskUserQuestion`** — `Keep everything` / `Remove them`. Skip the confirmation only if the user already passed `--dry-run` themselves (in which case you are done after step 2). If the answer is ambiguous or contradicts what the user asked for in plain text, do not remove anything.

4. **On confirmation**, re-run with the same flags minus `--dry-run`, and report what was removed.

   The script exits non-zero when a removal was incomplete and prints `! could not remove …` for each one. Surface those lines — do not report success. Entries that failed are deliberately kept in the manifest so cleanup can be retried once the cause is cleared (most often a `codex-pr/*` branch still checked out somewhere).

5. **Verify** in one of the affected repositories, if it still exists — under `--all` a cached clone is deleted outright, in which case there is nothing left to inspect:
   ```bash
   git -C <repoDir> worktree list
   git -C <repoDir> branch --list 'codex-pr/*'
   ```
   Both should be free of plugin entries.

## Notes

- The script only removes what it recorded in its own manifest, so it will not touch unrelated worktrees or branches.
- `--all` implies `--purge-clones`, which also deletes cached clones under the cache directory. Point this out before confirming, since re-cloning a large repo is slow.
- Cached clones are shared between PRs of the same repository. They are purged only after every selected entry has been processed, and only when no remaining entry still needs them.
- A missing worktree directory does **not** mean there is nothing to clean: the `codex-pr/*` branches and plugin refs still live in the host repository, and the manifest entry is the only record of them. `/codex-pr-reviewer:list` flags these; cleaning still removes them.
- Saved reviews under `reviews/` are never deleted — they are output, not scratch state.
