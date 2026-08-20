# codex-pr-reviewer

A Claude Code plugin that reviews **other people's GitHub pull requests** with Codex.

Codex's reviewer only sees local git state — `--uncommitted`, `--base <branch>`, or `--commit <sha>`, all relative to its own working directory. There is no built-in path from "PR #42 on GitHub" to "Codex reviewed it." This plugin builds that path: Claude drives `gh` and `git` to materialize any PR into an isolated worktree, then hands that worktree to Codex's native reviewer.

Reviewing in a real checkout — rather than from a raw diff — means Codex can read surrounding code, follow call sites, and pick up the repository's own review conventions. On a test run against [cli/cli#13899](https://github.com/cli/cli/pull/13899) it found a P1 exit-code regression *and* cited that repo's `.github/skills/cli-code-reviewer/SKILL.md` rules as the basis.

## Install

From a local checkout, pass the path to the repository root. An absolute path
always works; a relative one must start with `./` — a bare `.` is rejected as an
invalid source format.

```
/plugin marketplace add /absolute/path/to/codex-pr-reviewer
/plugin install codex-pr-reviewer@chase-plugins
```

The marketplace is named `chase-plugins` and the plugin inside it is
`codex-pr-reviewer`, so the fully-qualified name is
`codex-pr-reviewer@chase-plugins`. Commands are namespaced by the *plugin*
name: `/codex-pr-reviewer:review`.

Choose **user** scope when prompted, not project scope: the point is to review
PRs from whichever repository you happen to be working in, so scoping the plugin
to a single directory defeats it.

Requires `codex` (logged in), `gh` (authenticated), `git` ≥ 2.19, and Node ≥ 18. Run `/codex-pr-reviewer:review` and it will tell you if anything is missing, or check directly:

```
node plugins/codex-pr-reviewer/scripts/pr-workspace.mjs doctor
```

## Updating

Claude Code copies the plugin into its own cache at install time, and reads the
command prompts once, at session start. An edit to a prompt is therefore
invisible twice over — until the copy is refreshed, and then until the session
restarts. That matters here because the prompts are where the rules deciding
whether a review may be published actually live.

```
claude plugin marketplace update chase-plugins
claude plugin update codex-pr-reviewer@chase-plugins
```

then restart Claude Code.

Neither gap is silent. The preflight reports both:

- `doctor` hashes the installed copy against the marketplace source and names
  the files that differ — `stale: true` under `--json`. It is warn-level: a
  stale copy still reviews correctly, so it never blocks a review.
- Each command prompt carries the version it was written for and compares it
  against the `pluginVersion` the script reports. A mismatch means this session
  loaded its prompts from an older install than the script answering it — the
  case that refreshing the copy alone does not fix.

On either signal `/codex-pr-reviewer:review` still reviews, but refuses
`--post`: the guard that keeps a failed review from being published is itself
one of the prompt rules that may be out of date.

While working on the plugin, skip the cache entirely —

```
claude --plugin-dir /path/to/codex-pr-reviewer/plugins/codex-pr-reviewer
```

— and every prompt edit is live in the next session. `doctor` then reports
`running from source`.

## Commands

| Command | What it does |
|---|---|
| `/codex-pr-reviewer:review <pr> [--post]` | Fetch a PR and review it. `<pr>` is `42`, `owner/repo#42`, or a PR URL. |
| `/codex-pr-reviewer:list` | Show PRs awaiting your review, across GitHub or in one repo. |
| `/codex-pr-reviewer:sweep [--limit N]` | Review a batch of PRs (smallest first) and produce one digest. |
| `/codex-pr-reviewer:clean` | Remove the worktrees, branches, and clones the plugin created. |

## How it works

```
/codex-pr-reviewer:review 42
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
- **The reviewer's instructions cannot come from the PR.** Codex reads project documents — `AGENTS.md` and its fallbacks — from its working directory before it starts, and that directory *is* the pull request. Reviews run with `project_doc_max_bytes=0`, so a PR cannot rewrite the instructions of the reviewer sent to inspect it. The anti-injection rules in the command prompts bind Claude; they are not inherited by the Codex process, which is why this is enforced on the command line instead.
- **Checkout cannot execute the PR either.** Fetching a PR writes attacker-authored bytes into a working tree before Codex's sandbox exists, and git runs hooks and filters during that write. Every git this plugin causes to run — including the one `gh` spawns — is given `core.hooksPath` pointing at an empty directory and neutralised LFS filters, through `GIT_CONFIG_*`. Without it, a repository configuring hooks into the tree, which is exactly what Husky does, lets a PR touching `.husky/post-checkout` run a script the moment its worktree is created.
- **Nothing is posted without asking — and not everything can be posted.** Reviews print to your terminal, and `--post` additionally requires an explicit confirmation showing the exact comment body. Publishing then goes through `pr-workspace.mjs post`, which refuses, in code, any file that is not a review this plugin wrote, that belongs to a different PR, that came from a run Codex produced no output for, or whose bytes are not the ones that were approved. Those rules used to live only in the command prompt, where a stale copy or a persuasive diff could get around them.
- **Only the command that posts can reach posting.** `/codex-pr-reviewer:review` pre-approves one Bash rule: `pr-workspace.mjs` by its full path. It reaches `git` and `gh` through the script, which is where the checks are. Pre-approval is not a sandbox — `allowed-tools` grants permission rather than removing capability, so `node -e` remains callable and simply stops being silent, arriving as a permission prompt instead. The narrow rule is what makes that prompt the boundary. `/codex-pr-reviewer:sweep` holds three read-only `gh` subcommands, so it cannot comment on a PR at all, and `/codex-pr-reviewer:clean` holds two read-only `git` ones.
- **Local paths are stripped** from review output before it is saved, so a posted comment never leaks your filesystem layout.
- **Cleanup is precise.** The plugin records what it created in a manifest and `/codex-pr-reviewer:clean` removes only that — it will not touch unrelated worktrees or branches. Saved reviews are output rather than scratch state, so they survive every clean unless `--purge-reviews` asks for them by name. The whole removal is bound to the plan a dry run showed, through `--confirm-plan`: a clean is two processes, and between them a review can finish or a sweep can prepare more PRs that a selector like `--all` would then match. Branches are deleted only while they still point at the commit the manifest recorded, so a name that has been reused since is left alone.
- **A review in flight is left alone.** A running review is reading a worktree and has not written its output yet, so cleanup holds its PR back — worktree, branches, and shared clone included — and says which, rather than deleting state out from under a paid run. This is a guard, not a lock: it does not close the window described under [Script reference](#script-reference), where a clean cannot see a review that had not started yet.
- **What is fetched is what GitHub says it is.** The head commit written into the worktree is compared against the `headRefOid` the API reports, and a mismatch stops the run. Metadata and code otherwise arrive by different paths — `gh` for one, whichever remote matched the slug for the other — with nothing comparing them.
- **A failed run cannot be published.** Codex can exit nonzero and still print a body; an interrupted run emits `Review was interrupted…` on stdout. The exit status is recorded in the saved document, covered by the same digest that authorizes posting, and `post` refuses anything that did not exit 0.
- **A stale install cannot post.** The rules above only hold if the running copy is the one you edited, so the preflight checks that and `--post` is withdrawn when it is not. See [Updating](#updating).

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
                 post    <pr> --review <path> --confirm <digest> [--repo …]
                              [--again] [--dry-run] [--json]
                 list    [--repo owner/repo] [--json]
                 clean   [--pr N | --repo owner/repo | --all | --older-than DAYS]
                         [--purge-clones] [--purge-reviews --confirm-reviews <digest>]
                         [--include-running] [--dry-run] [--json]
```

`review --dry-run` prints the exact `codex` command it would run, without
running it — useful for checking what a flag actually does:

```
$ pr-workspace.mjs review cli/cli#14057 --dry-run
codex -C <cache>/worktrees/cli__cli/pr-14057 -s read-only \
  review --base codex-pr/14057-base --title 'PR #14057: docs: recommend nix-shell …'
```

`/codex-pr-reviewer:sweep` gathers up to 50 candidates and reviews the
**smallest first** (`additions + deletions` ascending, tie-broken on file
count), because each PR in the batch is a separate paid Codex run. On a busy
queue the difference is large: for `cli/cli` at the time of writing, `--limit 5`
costs 27 lines of churn smallest-first versus 352 newest-first, and the queue's
largest open PR is 4,111 lines across 66 files. Pass `--order newest` for queue
order. The skipped large PRs are named before the run, so nothing is dropped
silently, and a specific PR is always reachable via
`/codex-pr-reviewer:review <pr>`.

`post` is the only path to a published comment. `review` prints a `Digest` line
alongside `Saved to …`; `post` takes that digest as `--confirm` and refuses to
publish a file whose bytes do not match it. Re-running on a PR is normal and
leaves several saved reviews behind, so "the review for PR #42" is ambiguous in
a way that "the review with this digest" is not — the digest is what carries an
approval from the body someone actually read to the bytes that get posted. It is
not a secret, and no refusal quotes it back: a caller that has lost it has also
lost the approval it stood for. A successful post is recorded on the PR's
manifest entry, so posting the same review twice needs an explicit `--again`.

`clean --pr` accepts the same references `review` does, with one difference
worth knowing: a **bare number is not scoped to the current repository**.
`review 42` resolves the repo from the directory you are in, while
`clean --pr 42` selects PR #42 in every repository the manifest knows about.
That is usually what is wanted when clearing up, and `/codex-pr-reviewer:clean`
names the repository each entry lives in before it asks — but pass
`owner/repo#42`, or add `--repo`, when only one is meant.

`clean --purge-reviews` is the only way to delete saved reviews, and it is
deliberately awkward. It is not implied by `--all` the way `--purge-clones` is:
a clone can be re-fetched, a review is the output of a paid run and cannot be
regenerated byte-for-byte. It takes `--confirm-reviews <digest>` over the exact
list a dry run printed, because the plan is shown by one process and carried out
by another — without that, a review saved during the confirmation, by a
background run or a sweep finishing, would be deleted having appeared in nothing
anyone approved. Reviews are matched on the whole filename rather than a
`<slug>-pr<N>-` prefix, since a repository whose name continues where that prefix
stops (`o/r-pr7-archive#9` against `o/r#7`) would otherwise be caught by it. A
review that will not delete holds its PR in the manifest, because reviews of a PR
absent from the manifest can never be selected again — which is also why every
run reports how many it kept.

A review that is *still running* is the other way that reachability is lost, and
the digest cannot catch it: the run has not written its file yet, so it appears
in no snapshot, and cleaning its PR meanwhile removes the manifest entry any
later `--purge-reviews` would have selected it through. So `review` records a
small marker under `runs/` before handing work to Codex — pid, host, start time,
and where it will save — and `clean` holds those entries back instead, worktree
and branches included, since the run is reading that checkout. A marker whose
process is gone stands for nothing and is swept; one older than six hours
expires, because a recycled pid must not be able to block cleanup forever.
`--include-running` overrides the guard for a marker left by a crashed run, and
then a finished review re-records its own PR so its output stays selectable —
a backstop, not a substitute: an overridden run may already have lost the
worktree it was reading.

The guard is not synchronization, and one window is left open deliberately: a
`clean` that took its snapshot before a review recorded itself cannot hold back
a marker that does not exist yet, so that review may still lose the worktree it
is reading and fail. The cost is bounded rather than avoided — the review
re-records its own PR when it saves, so an output that *was* produced stays
reachable. `prepare` is likewise free to refresh a worktree a review is reading,
which is what re-running on a PR mid-review does. Closing either properly means
locking, and a lock that outlives a crashed run is a worse failure than the one
it prevents.

`--context` and `--trust-worktree` were removed in 0.8.0, and passing either is an error rather than a silent no-op.

`--context` appended the PR title and description to the command as a positional prompt. `codex review` refuses that alongside `--base` — *the argument '--base <BRANCH>' cannot be used with '[PROMPT]'* — so every run that used it failed at argument parsing. It was documented, advertised in the command prompt, and had never once worked; nothing in the test suite caught it because nothing there invokes a real Codex.

`--trust-worktree` enabled project `.codex` configuration for the worktree, which is a repository fetched from the internet. That is a configuration file inside untrusted code being given effect, which is not something a flag should be able to ask for.

## Tests

```
node tests/unit.mjs          # pure helpers, no network
./tests/regression.sh        # synthetic repos + stub codex, no network
./tests/integration.sh       # real git/gh plumbing, never calls Codex
```

`regression.sh` pins the defects found in code review — the symlinked-entrypoint
guard, `--dry-run` side effects, manifest corruption handling, shared-clone
purging, review output hygiene, everything `post` must refuse, the
`--purge-reviews` guards, and both halves of the in-flight race: a clean holding
back a live run, and a review re-recording its PR when one is overridden. It
drives that case with a stub `codex` that runs a real `clean` mid-review, so the
concurrency is genuine rather than simulated. It runs entirely against synthetic
repositories in an isolated `XDG_CACHE_HOME`, so it needs no network or GitHub
account and never touches your real cache. Its failure cases are forced by
mechanisms that do not depend on who runs it — a directory where a file is
expected, not a read-only parent that root would ignore.

The integration suite is the one that matters: it prepares a real fork PR and
asserts that the worktree's diff against the pinned merge-base is byte-identical
to `gh pr diff` — same file list, same `+A/-D`. That is the property the whole
design rests on. It also checks idempotency and that `clean` removes exactly
what was created and nothing else. It never invokes Codex, so it costs nothing.

Point it at any public PR:

```
./tests/integration.sh cli/cli 13899
```

CI runs the two offline suites on every pull request and on pushes to `main`,
across Node 18 — the documented floor — and 22, on Linux and macOS. One leg also
runs `tests/version-guard.sh`, which fails the build when shipped plugin content
changed without the version moving: Claude Code resolves an install by version
and caches it, so a fixed prompt that keeps the old number reaches nobody who
already has the plugin. The integration suite runs
weekly and on demand instead: it needs the network and an upstream PR that still
exists, and neither of those should be able to block a commit. It stubs `codex`
there for the same reason the suite never calls it — the binary is needed only
to satisfy `doctor`'s preflight, which would otherwise turn every CI run into a
silent skip.

## License

[MIT](LICENSE)
