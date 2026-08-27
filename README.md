# codex-pr-reviewer

A Claude Code plugin that reviews **other people's GitHub pull requests** with Codex.

Codex's reviewer only reads local git state — `--uncommitted`, `--base <branch>`, `--commit <sha>` — all relative to its own working directory. There is no built-in path from "PR #42 on GitHub" to "Codex reviewed it." This plugin builds it: Claude drives `gh` and `git` to materialize any PR into an isolated worktree, then hands that worktree to Codex's native reviewer.

Reviewing a real checkout rather than a raw diff lets Codex read surrounding code, follow call sites, and pick up the repository's own review conventions. Against [cli/cli#13899](https://github.com/cli/cli/pull/13899) it found a P1 exit-code regression and cited that repo's `.github/skills/cli-code-reviewer/SKILL.md` as the basis.

## Status

Written for my own use, published in case it is useful. It is tested and it works. It is not maintained on a schedule, and I am not promising that it will be.

- **Bug reports are welcome and may not get fixed.** File one anyway with a reproduction — it tells the next person what to expect, whether or not I act on it.
- **Pull requests are welcome and may not get merged.** If something matters to you and I am slow, fork it; that is what the MIT license is for.
- **Security reports are the exception.** Those get a reply — see [SECURITY.md](SECURITY.md).
- A quiet stretch means I have not had time, not that this is abandoned. If it ever is, this section will say so.

## Install

```
/plugin marketplace add dumplingsensei/codex-pr-reviewer
/plugin install codex-pr-reviewer@dumplingsensei-plugins
```

Choose **user** scope when prompted, not project: the point is to review PRs from whichever repository you happen to be in, so scoping to one directory defeats it.

To install from a local checkout instead, pass the repository root — an absolute path always works, a relative one must start with `./`, and a bare `.` is rejected. Commands are namespaced by the *plugin*, not the marketplace: `/codex-pr-reviewer:review`.

**macOS and Linux.** Those are what CI runs and what this is used on. Windows is not tested and not supported: the read-only sandbox reads the whole filesystem there, and the process handling here assumes POSIX signals.

Requires `codex` (logged in), `gh` (authenticated), `git` ≥ 2.19, and Node ≥ 18. `/codex-pr-reviewer:review` reports anything missing, or ask directly:

```
node plugins/codex-pr-reviewer/scripts/pr-workspace.mjs doctor
```

## Commands

| Command | What it does |
|---|---|
| `/codex-pr-reviewer:review <pr>` | Fetch a PR, review it, and check the findings against the code. `<pr>` is `42`, `owner/repo#42`, or a URL. |
| `/codex-pr-reviewer:list` | Show PRs awaiting your review, across GitHub or in one repo. |
| `/codex-pr-reviewer:sweep [--limit N]` | Review a batch (smallest first) into one digest. |
| `/codex-pr-reviewer:clean` | Remove the worktrees, branches, and clones the plugin created. |

## How it works

```
/codex-pr-reviewer:review 42
   │
   ├─ gh pr view 42 --json …               resolve PR metadata
   ├─ host repo = yours if it matches, else a cached blobless clone
   ├─ git fetch +refs/pull/42/head:refs/codex-pr-reviewer/pr/42
   │              +refs/heads/main:refs/codex-pr-reviewer/base/42
   ├─ git branch -f codex-pr/42-base $(git merge-base <base> <head>)
   ├─ git worktree add -B codex-pr/42 <cache>/worktrees/owner__repo/pr-42
   │
   └─ codex -C <worktree> -s read-only review --base codex-pr/42-base
```

- **`--base` pinned to a branch at the merge-base** makes the review see exactly what GitHub's "Files changed" tab shows, whether Codex reads `--base` with two-dot or three-dot semantics. Verified against `gh pr diff`: identical file lists, identical `+225/-18` totals.
- **`refs/codex-pr-reviewer/*` instead of branches:** refs outside `refs/heads/` are never checked out, so a forced update succeeds even when a stale worktree sits on the old commit. That is what makes re-running idempotent.
- **A worktree** never touches the branch you are on, survives a dirty working tree, and holds several PRs at once — none of which `gh pr checkout` can do.

Fork PRs need no extra remotes: GitHub serves `refs/pull/<N>/head` from the base repository.

## Safety

- **PR content is untrusted input.** Every Codex run passes `-s read-only` explicitly rather than trusting config defaults, the plugin never runs the PR's build, tests, or hooks, and the prompts tell Claude to treat diff text as data, never instructions.
- **The reviewer's instructions cannot come from the PR.** Codex reads `AGENTS.md` and its fallbacks from its working directory — which *is* the pull request — so reviews run with `project_doc_max_bytes=0`. The prompts' anti-injection rules bind Claude and are not inherited by the Codex process, which is why this is enforced on the command line.
- **Checkout cannot execute the PR either.** Fetching writes attacker-authored bytes into a tree before Codex's sandbox exists, and git runs hooks and filters during that write. Every git this plugin causes to run — including the one `gh` spawns — gets `core.hooksPath` aimed at an empty directory and neutralised LFS filters via `GIT_CONFIG_*`. Without it, a repository that configures hooks into the tree, which is what Husky does, lets a PR touching `.husky/post-checkout` run a script the moment its worktree appears.
- **Nothing is published, by any command.** Reviews print to your terminal and save to disk. No subcommand or flag comments on a PR, and `review` holds no `gh` grant at all, so a PR whose text asks to be approved has nowhere to go — see [Publishing is out of scope](#publishing-is-out-of-scope).
- **Each command is granted only the subcommands it uses.** `review` and `sweep` pre-approve `pr-workspace.mjs` by full path and only its `doctor`, `prepare`, and `review` subcommands; `list` gets `list`; `clean` gets `clean`. So `clean` — the one destructive subcommand — is not reachable from a review, and no command reaches `gh` directly, where a grant would also carry `gh pr review`, `gh pr merge`, and `gh api`. `sweep` and `list` additionally hold read-only `gh` subcommands for finding pull requests. `clean` holds nothing else at all: it verifies its own removals, so the `git -C` grant it used to need — a prefix that also matched `reset`, `branch -D`, and `config` — is gone. Pre-approval is not a sandbox: `allowed-tools` grants permission rather than removing capability, so `node -e` stays callable. Whether it also becomes *visible* is your permission mode's call — under `auto`, a read-only command outside the grant simply runs — so the narrow rules are scoping the prompts are written to keep rather than a wall that stops them.
- **Local paths are stripped** from saved review output, so a comment you paste never leaks your filesystem layout.
- **Cleanup is precise.** The plugin records what it created in a manifest and `clean` removes only that, deleting a branch only while it still points at the recorded commit. Saved reviews survive every clean unless `--purge-reviews` names them.
- **A review in flight is left alone.** Cleanup holds a running review's PR back — worktree, branches, shared clone — and says which, rather than deleting state out from under a paid run. A guard, not a lock: see [Script reference](#script-reference).
- **What is fetched is what GitHub says it is.** Metadata and code arrive by different paths, so all three ends are tied together: the remote must be on the same host that served the PR's metadata, the fetched head must equal the API's `headRefOid`, and the fetched base must contain its `baseRefOid`. The base is checked by ancestry rather than equality, because a base branch legitimately moves between the API call and the fetch. Any of the three failing stops the run and points at `--clone`.
- **A pull request cannot point the reviewer out of its own worktree.** `-s read-only` bounds what Codex may write, not what it may read, so a symlink committed in a diff would be a path into the rest of your filesystem. Every git this plugin runs sets `core.symlinks=false`, which checks such a link out as a small regular file holding the link text — the target becomes a string to review instead of a path to follow. The diff is unaffected: the index still records the entry as a symlink, so the review sees exactly GitHub's diff and the worktree is not dirty. The setting is forced per-process rather than written into anyone's repository, so a plain `git status` you run yourself inside a worktree will report symlink entries as modified; the plugin's own git, which is the one that checks, does not.
- **A review cannot run forever.** Codex is stopped after 45 minutes (`CPR_CODEX_TIMEOUT_MS` to change it), signalling its whole process group, and the output kept for the saved document is capped — so a wedged or runaway run cannot hold a worktree indefinitely or exhaust memory. Both cases say so in the saved review rather than looking like a short one.
- **A failed run is visible as one.** Codex can exit nonzero and still print a body, and an interrupted run emits `Review was interrupted…`, so "the file exists" was never evidence a review happened. The exit status is written into the saved document's first line as `exit=<n>`.
- **A stale install says so** — see [Updating](#updating).

## Publishing is out of scope

This plugin reviews pull requests. It does not comment on them, and no subcommand or flag does — a deliberate narrowing in 0.9.0, which removed a `post` subcommand.

**Raw review output is a poor comment.** Codex's findings are advisory and some are wrong — the footer on every review says so. Publishing them verbatim puts your name on claims nobody checked, on a stranger's pull request, and a maintainer reading twenty machine-generated findings cannot tell which two you actually stand behind.

**Everything guarding it was guarding something optional.** A publish path needs its own checks — did this plugin write this review, does it belong to this PR, did the run succeed, are these the approved bytes — plus GitHub's 65,536-character cap and an answer for the head moving in between. That is a lot of surface defending a step you are better off doing by hand.

**What checking the findings is for.** `review` ends by reading the code each finding names and marking it confirmed, refuted, or unverified, with a `file:line` behind each verdict. That is the step that turns twenty machine-generated claims into the two you would actually stand behind — so if you do comment, you are writing from findings someone looked at rather than from the raw list. `--no-vet` skips it; `sweep` does not do it at all, because a digest across a batch is already the summary.

**The scope is the command, not your session.** While `review` or `sweep` is running, Claude publishes nothing by any route. Afterwards the instructions stop being a refusal: ask for a comment and you get one, written from the confirmed findings and shown to you in full before it goes anywhere. Posting it is then a separate action you asked for, and this plugin has no say in how it happens: the route may be `gh`, a GitHub MCP tool, or anything else the session can reach, and whether any of them stops to ask you first is your permission mode's call rather than a property of the grant. So the checkpoint is the text, not the prompt — you read the exact comment, and only that text is posted. An instruction, not a lock: if a review gets published, you decided that, having read it.

## Updating

Claude Code copies the plugin into its own cache at install time and reads command prompts once, at session start. A prompt edit is invisible twice over — until the copy refreshes, then until the session restarts — which matters because the prompts hold the rules deciding whether a review may be published.

```
claude plugin marketplace update dumplingsensei-plugins
claude plugin update codex-pr-reviewer@dumplingsensei-plugins
```

then restart Claude Code. Neither gap is silent:

- `doctor` hashes the installed copy against the marketplace source and names the files that differ (`stale: true` under `--json`). Warn-level — a stale copy still reviews correctly, so it never blocks a review.
- Each prompt carries the version it was written for and compares it against the script's `pluginVersion`. A mismatch means this session's prompts are older than the script answering them — the case refreshing alone does not fix.

Either way the command says so and carries on, because a prompt and a script that disagree about flags fail in a way that reads like the pull request's fault rather than the install's.

While working on the plugin, skip the cache — `claude --plugin-dir /path/to/codex-pr-reviewer/plugins/codex-pr-reviewer` — and every edit is live in the next session. `doctor` then reports `running from source`.

## Cache layout

Everything lives under `${XDG_CACHE_HOME:-~/.cache}/codex-pr-reviewer`:

```
manifest.json                     what the plugin created, for precise cleanup
repos/owner__repo/                cached clones (only for repos you lack locally)
worktrees/owner__repo/pr-42/      the isolated checkout Codex reads
reviews/owner__repo-pr42-*.md     saved review documents
runs/owner__repo-pr42-<pid>.json  a review in flight, so cleanup leaves it alone
```

## Script reference

The commands are thin; the git and `gh` choreography lives in one zero-dependency script.

```
pr-workspace.mjs doctor  [--json]
                 prepare <pr> [--repo owner/repo] [--clone] [--json]
                 review  <pr> [--repo …] [--model M] [--effort E]
                              [--profile P] [--no-prepare] [--dry-run] [--json]
                 list    [--repo owner/repo] [--json]
                 clean   [--pr N | --repo owner/repo | --all | --older-than DAYS]
                         --confirm-plan <digest> [--purge-clones]
                         [--purge-reviews --confirm-reviews <digest>]
                         [--include-running] [--dry-run] [--json]
```

`--confirm-plan` is required for any `clean` that is not a `--dry-run`: the digest binds the run to the plan a dry run printed. An unknown flag is an error rather than a silent positional, so a mistyped `--modle` stops the command instead of being read as the pull request to review.

`review --dry-run` prints the exact `codex` command it would run, without running it:

```
$ pr-workspace.mjs review cli/cli#14057 --dry-run
codex -C <cache>/worktrees/cli__cli/pr-14057 -s read-only \
  review --base codex-pr/14057-base --title 'PR #14057: docs: recommend nix-shell …'
```

**`sweep` reviews smallest first** (`additions + deletions` ascending, tie-broken on file count), because each PR in a batch is a separate paid run. For `cli/cli` at the time of writing, `--limit 5` costs 27 lines of churn smallest-first against 352 newest-first. `--order newest` gives queue order; skipped PRs are named before the run.

**`clean` is the one destructive subcommand** and will not act on a plan it was not shown: a dry run prints a `planDigest` over every entry, worktree, branch, ref, and flag, and the real run must name it with `--confirm-plan`. A clean is two processes with a human confirmation in between, and a selector like `--all` re-evaluated in the second would sweep up whatever was prepared during the pause.

- **A bare `--pr N` is not scoped to the current repository.** `review 42` resolves the repo from the directory you are in; `clean --pr 42` selects PR #42 in *every* repository the manifest knows about. The command names each entry's repository before asking — but pass `owner/repo#42`, or add `--repo`, when only one is meant.
- **`--purge-reviews` is deliberately awkward,** and not implied by `--all` the way `--purge-clones` is: a clone can be re-fetched, a review is the output of a paid run. It takes `--confirm-reviews <digest>` over the exact list a dry run printed, so a review saved during the confirmation is not deleted having appeared in nothing anyone approved. Matching is on the whole filename rather than a `<slug>-pr<N>-` prefix, which would otherwise catch `o/r-pr7-archive#9` for `o/r#7`.
- **A running review holds its PR back.** `review` records a marker under `runs/` — pid, host, start time, destination — before handing work to Codex, and `clean` skips those entries, worktree and branches included. A marker whose process is gone is swept; one older than six hours expires, so a recycled pid cannot block cleanup forever. `--include-running` overrides the guard for a crashed run.
- **One window stays open deliberately.** A `clean` whose snapshot predates a review's marker cannot hold back what does not exist yet, so that review may still lose the worktree it is reading; `prepare` is likewise free to refresh a worktree mid-review. The cost is bounded rather than avoided — a review re-records its PR when it saves, so output that *was* produced stays reachable. Closing either means locking, and a lock that outlives a crashed run is the worse failure.

`--context` and `--trust-worktree` were removed in 0.8.0, and passing either is an error rather than a silent no-op. `--context` appended the PR title and description as a positional prompt, which `codex review` refuses alongside `--base` — *the argument '--base <BRANCH>' cannot be used with '[PROMPT]'* — so every run that used it failed at argument parsing, documented and advertised and never once working. `--trust-worktree` gave effect to `.codex` configuration inside a repository fetched from the internet, which is not something a flag should be able to ask for.

## Tests

```
node tests/unit.mjs          # pure helpers, no network
./tests/regression.sh        # synthetic repos + stub codex, no network
./tests/integration.sh       # real git/gh plumbing, never calls Codex
```

Both suites and the CI workflow share one Codex stub, `tests/stubs/codex`; `unit.mjs` fails the build if a second copy appears.

`regression.sh` pins the defects found in code review — the symlinked-entrypoint guard, `--dry-run` side effects, manifest corruption, shared-clone purging, output hygiene, the retired flags, the `--purge-reviews` guards, and both halves of the in-flight race, that last driven by a stub `codex` that runs a real `clean` mid-review so the concurrency is genuine. It runs against synthetic repositories in an isolated `XDG_CACHE_HOME`, so it needs no network or GitHub account and never touches your real cache.

`integration.sh` is the one that matters: it prepares a real fork PR and asserts the worktree's diff against the pinned merge-base is byte-identical to `gh pr diff` — same file list, same `+A/-D`. That is the property the whole design rests on. It also checks idempotency and that `clean` removes exactly what was created, and never invokes Codex, so it costs nothing. Point it at any public PR:

```
./tests/integration.sh cli/cli 13899
```

CI runs the offline suites on every pull request and push to `main`, across Node 18 — the documented floor — and 22, on Linux and macOS. One leg runs `tests/version-guard.sh`, which fails the build when shipped plugin content changed without the version moving: Claude Code resolves an install by version and caches it, so a fixed prompt keeping the old number reaches nobody who already has the plugin. The integration suite runs weekly and on demand, needing the network and an upstream PR that still exists.

## Security, changelog, license

Reporting a vulnerability, scope, and known-and-accepted issues: [SECURITY.md](SECURITY.md). Release notes: [CHANGELOG.md](CHANGELOG.md), each release tagged `v<version>`. Licensed [MIT](LICENSE).
