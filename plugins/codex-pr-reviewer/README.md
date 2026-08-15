# codex-pr-reviewer

Review other people's GitHub pull requests with Codex, from inside Claude Code.

Codex's reviewer only sees local git state. This plugin fetches any PR — including
from forks — into an isolated `git worktree`, pins the diff to the merge-base so it
matches GitHub's "Files changed" exactly, and hands that checkout to `codex review`.

## Commands

| Command | What it does |
|---|---|
| `/codex-pr-reviewer:review <pr> [--post]` | Fetch a PR and review it. `<pr>` is `42`, `owner/repo#42`, or a PR URL. |
| `/codex-pr-reviewer:list` | Show PRs awaiting your review. |
| `/codex-pr-reviewer:sweep [--limit N]` | Review a batch and produce one digest. |
| `/codex-pr-reviewer:clean` | Remove the worktrees, branches, and clones the plugin created. |

Requires `codex` (logged in), `gh` (authenticated), `git` ≥ 2.5, and Node ≥ 18.
Check with:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pr-workspace.mjs" doctor
```

## Safety

Reviews print to your terminal. Posting to a PR requires an explicit `--post`
flag plus a confirmation showing the exact body, and `/codex-pr-reviewer:sweep` cannot
post at all. Every Codex run passes `-s read-only`, the plugin never executes a
PR's build or tests, and local paths are stripped from review output before it
is saved.

Full documentation, design notes, and the script reference live in the
[repository README](https://github.com/dumplingsensei/codex-pr-reviewer#readme).
