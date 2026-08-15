# codex-pr-reviewer

A Claude Code plugin that reviews **other people's GitHub pull requests** with Codex.

Codex's reviewer only sees local git state — `--uncommitted`, `--base <branch>`, or `--commit <sha>`, all relative to its own working directory. There is no built-in path from "PR #42 on GitHub" to "Codex reviewed it." This plugin builds that path: Claude drives `gh` and `git` to materialize any PR into an isolated worktree, then hands that worktree to Codex's native reviewer.

Reviewing in a real checkout — rather than from a raw diff — means Codex can read surrounding code, follow call sites, and pick up the repository's own review conventions. On a test run against [cli/cli#13899](https://github.com/cli/cli/pull/13899) it found a P1 exit-code regression *and* cited that repo's `.github/skills/cli-code-reviewer/SKILL.md` rules as the basis.

## Install

From a local checkout — run this from the repository root, or substitute its path:

```
/plugin marketplace add .
/plugin install codex-pr-reviewer
```

Requires `codex` (logged in), `gh` (authenticated), `git` ≥ 2.5, and Node ≥ 18. Run `/codex-pr:review` and it will tell you if anything is missing, or check directly:

```
node plugins/codex-pr-reviewer/scripts/pr-workspace.mjs doctor
```

## Commands

| Command | What it does |
|---|---|
| `/codex-pr:review <pr> [--post]` | Fetch a PR and review it. `<pr>` is `42`, `owner/repo#42`, or a PR URL. |
| `/codex-pr:list` | Show PRs awaiting your review, across GitHub or in one repo. |
| `/codex-pr:sweep [--limit N]` | Review a batch of PRs and produce one digest. |
| `/codex-pr:clean` | Remove the worktrees, branches, and clones the plugin created. |

## How it works

```
/codex-pr:review 42
   │
   ├─ gh pr view 42 --json …               resolve PR metadata
   ├─ host repo = your repo if it matches, else a cached blobless clone
   ├─ git fetch +refs/pull/42/head:refs/codex-pr-reviewer/pr/42
   │              +refs/heads/main:refs/codex-pr-reviewer/base/42
   ├─ git branch -f codex-pr/42-base $(git merge-base <base> <head>)
   ├─ git worktree add -B codex-pr/42 <cache>/worktrees/owner__repo/pr-42
   │
   └─ codex -C <worktree> -s read-only review --base codex-pr/42-base
```

**Why pin `--base` to a branch at the merge-base?** Because then the review sees exactly what GitHub's "Files changed" tab shows, regardless of whether Codex interprets `--base` with two-dot or three-dot range semantics. Verified against `gh pr diff`: identical file lists and identical `+225/-18` totals.

**Why `refs/codex-pr-reviewer/*` instead of branches for the fetch?** Refs outside `refs/heads/` are never checked out, so a forced update always succeeds even when a stale worktree is sitting on the old commit. That is what makes re-running on the same PR idempotent.

**Why a worktree?** It never touches the branch you are on, survives a dirty working tree, and lets you review several PRs at once — none of which `gh pr checkout` can do.

Fork PRs work without adding remotes: GitHub serves `refs/pull/<N>/head` from the base repository.

## Safety

- **PR content is untrusted input.** Every Codex run passes `-s read-only` explicitly rather than relying on config defaults, and the plugin never runs the PR's build, tests, or hooks. The commands instruct Claude to treat text inside a diff as data to review, never as instructions to follow.
- **Nothing is posted without asking.** Reviews print to your terminal. `--post` additionally requires an explicit confirmation showing the exact comment body. `/codex-pr:sweep` cannot post at all.
- **Local paths are stripped** from review output before it is saved, so a posted comment never leaks your filesystem layout.
- **Cleanup is precise.** The plugin records what it created in a manifest and `/codex-pr:clean` removes only that — it will not touch unrelated worktrees or branches.

## Cache layout

Everything lives under `${XDG_CACHE_HOME:-~/.cache}/codex-pr-reviewer`:

```
manifest.json                     what the plugin created, for precise cleanup
repos/owner__repo/                cached clones (only for repos you lack locally)
worktrees/owner__repo/pr-42/      the isolated checkout Codex reads
reviews/owner__repo-pr42-*.md     saved review documents
```

## Script reference

The commands are thin; the git and `gh` choreography lives in one zero-dependency script.

```
pr-workspace.mjs doctor  [--json]
                 prepare <pr> [--repo owner/repo] [--clone] [--json]
                 review  <pr> [--repo …] [--context] [--model M] [--effort E]
                              [--profile P] [--trust-worktree] [--no-prepare]
                              [--dry-run] [--json]
                 list    [--repo owner/repo] [--json]
                 clean   [--pr N | --repo owner/repo | --all | --older-than DAYS]
                         [--purge-clones] [--dry-run] [--json]
```

`review --dry-run` prints the exact `codex` command it would run, without
running it — useful for checking what a flag actually does:

```
$ pr-workspace.mjs review cli/cli#14057 --dry-run
codex -C <cache>/worktrees/cli__cli/pr-14057 -s read-only \
  review --base codex-pr/14057-base --title 'PR #14057: docs: recommend nix-shell …'
```

`--context` passes the PR title and description to the reviewer as stated intent, explicitly framed as a claim rather than as instructions. It is off by default so runs stay comparable to a plain `codex review`.

`--trust-worktree` adds a per-invocation `projects."<worktree>".trust_level="trusted"` override. It is off by default and never writes to `~/.codex/config.toml`. Testing showed Codex does not gate on project trust for read-only reviews, so you should not normally need it.

## Tests

```
node tests/unit.mjs          # pure helpers, no network
./tests/regression.sh        # synthetic repos + stub codex, no network
./tests/integration.sh       # real git/gh plumbing, never calls Codex
```

`regression.sh` pins the defects found in code review — the symlinked-entrypoint
guard, `--dry-run` side effects, manifest corruption handling, shared-clone
purging, and review output hygiene. It runs entirely against synthetic
repositories in an isolated `XDG_CACHE_HOME`, so it needs no network or GitHub
account and never touches your real cache.

The integration suite is the one that matters: it prepares a real fork PR and
asserts that the worktree's diff against the pinned merge-base is byte-identical
to `gh pr diff` — same file list, same `+A/-D`. That is the property the whole
design rests on. It also checks idempotency and that `clean` removes exactly
what was created and nothing else. It never invokes Codex, so it costs nothing.

Point it at any public PR:

```
./tests/integration.sh cli/cli 13899
```

## License

MIT
