---
description: Find GitHub pull requests waiting on your review
argument-hint: '[--repo owner/repo] [--limit N]'
allowed-tools: Read, Grep, Glob, AskUserQuestion, Bash(node:*), Bash(git:*), Bash(gh:*)
---

Show pull requests that are waiting on you, so you can pick one to review without leaving the session.

Raw slash-command arguments:
`$ARGUMENTS`

## Steps

1. **Pick the source.**
   - With `--repo owner/repo`, list that repo's open PRs:
     ```bash
     gh pr list --repo <owner/repo> --state open --limit <N> \
       --json number,title,author,createdAt,updatedAt,isDraft,additions,deletions,changedFiles,url,statusCheckRollup,reviewDecision
     ```
   - With no `--repo`, find what is assigned to the user across GitHub. Run both and merge, de-duplicating on `url`, and keep track of which query produced each row:
     ```bash
     gh search prs --review-requested=@me --state=open --limit <N> --json number,title,author,repository,createdAt,isDraft,url
     gh search prs --assignee=@me --state=open --limit <N> --json number,title,author,repository,createdAt,isDraft,url
     ```
     These mean different things — review-requested is work waiting on you, assigned is work owned by you — so label the reason rather than blurring them into one list.
   - If neither returns anything, fall back to the current directory's repository, but only if it actually resolves to one:
     ```bash
     gh repo view --json nameWithOwner
     ```
     A directory can be a git repository with no GitHub remote at all, in which case `gh pr list` fails. If that lookup fails, say plainly that there is nothing to list and that `--repo owner/repo` will scope it — do not report an error as an empty queue.

   `--limit` defaults to 20.

2. **Render a compact table**, newest first (sort by `createdAt` descending — do not rely on the API's ordering): index, `repo#number`, title (truncate to ~60 chars), author, size (`N files, +A/-D` when available), age, and CI/review state when available. Mark drafts, and mark why each row is listed when the source was the two searches.

   `gh search prs` does not return size fields. Do not issue a `gh pr view` per row just to fill them in — leave the size column blank for search results and note that `/codex-pr-reviewer:review` will report it.

3. **Show what is already prepared** so the user knows which reviews are cheap to re-run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pr-workspace.mjs" list --json
   ```
   Mark rows that already have a worktree.

4. **Offer next steps.** End by telling the user they can run `/codex-pr-reviewer:review <repo#number>` on any row. If there are four or fewer rows, use `AskUserQuestion` to offer reviewing one directly — then hand off to the `/codex-pr-reviewer:review` flow. Do not start a review without the user choosing one.

## Notes

- This command only reads. It never prepares worktrees or starts a Codex run on its own.
- If `gh search prs` errors on scopes, say which scope is missing rather than silently falling back.
