---
description: Remove PR worktrees, branches, and cached clones this plugin created
argument-hint: '[--pr N] [--repo owner/repo] [--all] [--older-than DAYS] [--purge-clones]'
allowed-tools: Read, Grep, Glob, AskUserQuestion, Bash(node:*), Bash(git:*)
---

Remove the review scratch state this plugin created: worktrees, `codex-pr/*` branches, plugin-owned refs, and optionally cached clones.

Raw slash-command arguments:
`$ARGUMENTS`

## Steps

1. **Always dry-run first.** Pass the user's arguments through, with `--dry-run --json` added:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pr-workspace.mjs" clean $ARGUMENTS --dry-run --json
   ```
   With no arguments the script targets entries older than 7 days.

2. **Show exactly what will be removed** — the worktree path, the two branch names, and which repository they live in, per PR. This matters because removal touches the user's real repositories, not just the cache: worktree registrations and `codex-pr/*` branches are created inside whichever repo hosted the PR.

   If the dry run is empty, say so and stop.

3. **Confirm with `AskUserQuestion`** — `Remove them` / `Keep everything`. Skip the confirmation only if the user already passed `--dry-run` themselves (in which case you are done after step 2).

4. **On confirmation**, re-run without `--dry-run` and report what was removed.

5. **Verify** in one of the affected repositories:
   ```bash
   git -C <repoDir> worktree list
   git -C <repoDir> branch --list 'codex-pr/*'
   ```
   Both should be free of plugin entries.

## Notes

- The script only removes what it recorded in its own manifest, so it will not touch unrelated worktrees or branches.
- `--all` implies `--purge-clones`, which also deletes cached clones under the cache directory. Point this out before confirming, since re-cloning a large repo is slow.
- If a worktree was already deleted by hand, the manifest entry is dropped without error.
