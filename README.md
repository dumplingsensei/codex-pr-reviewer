# dumplingsensei-plugins

Claude Code plugins. Install the marketplace once, then each plugin separately:

```
/plugin marketplace add dumplingsensei/codex-pr-reviewer
/plugin install codex-pr-reviewer@dumplingsensei-plugins
/plugin install cross-model-advisor@dumplingsensei-plugins
```

| Plugin | What it does |
|---|---|
| [cross-model-advisor](#cross-model-advisor) | When Claude finishes a turn that changed files, advisors from other model families review the diff and send Claude back to address their concerns. |
| [codex-pr-reviewer](#codex-pr-reviewer) | Fetch a GitHub PR into an isolated worktree and review it with Codex. |

Each plugin's manifest defines its version; marketplace metadata is versioned separately. Changing one plugin does not move the other.

## Status

Written for my own use, published in case it is useful. It is tested and it works. It is not maintained on a schedule, and I am not promising that it will be.

- **Bug reports are welcome and may not get fixed.** File one anyway with a reproduction — it tells the next person what to expect, whether or not I act on it.
- **Pull requests are welcome and may not get merged.** If something matters to you and I am slow, fork it; that is what the MIT license is for.
- **Security reports are the exception.** Those get a reply — see [SECURITY.md](SECURITY.md).
- A quiet stretch means I have not had time, not that this is abandoned. If it ever is, this section will say so.

# cross-model-advisor

A review gate built from models of other families. When Claude finishes a turn that changed files, the advisors you configure review what git measured for that turn (your request, Claude's final message, and the diff), inspect the surrounding code through read-only tools, and send Claude back to fix or rebut evidence-backed concerns. Turns that change nothing are not reviewed.

The idea of a second model from another family comes from Oh My Pi's advisors. Claude Code's hooks cannot stream a turn to an outside model or steer it mid-run, so this plugin reviews the finished turn instead. It does not copy OMP's prompts or vendor its agent framework.

Shipped documentation, including how the gate works and configuration examples: [plugins/cross-model-advisor/README.md](plugins/cross-model-advisor/README.md). Changelog: [plugins/cross-model-advisor/CHANGELOG.md](plugins/cross-model-advisor/CHANGELOG.md).

## Runtime

**Claude Code 2.1.252 or newer; Node 22.19.0 or newer; git; macOS and Linux.** The project must be a git work tree. Unsupported Node/host/OS is a `doctor` error; hooks fail open. Windows is not tested and not supported.

Users install the bundled plugin without `npm install`, a build, or network bootstrap. From a local checkout:

```
claude --plugin-dir ./plugins/cross-model-advisor
```

## Commands

| Command | What it does |
|---|---|
| `/cross-model-advisor:on` | Validate configuration and turn the gate on for this session. Reports the git project root, gate mode, each advisor's availability, and what is sent to external providers. Makes no model request. |
| `/cross-model-advisor:off` | Turn the gate off for this session. The last review stays visible in `status`. |
| `/cross-model-advisor:status` | Show the last review (outcome, round, findings with evidence, each advisor's result), the last skipped turn and why, and per-advisor usage and errors. |
| `/cross-model-advisor:doctor` | Check the runtime, configuration, git, key-variable presence, advisor availability, and bundle. No model request, token refresh, or login. |
| `/cross-model-advisor:setup` | Print the exact terminal command for the settings menu. Does not open the menu inside Claude or edit configuration. |
| `/cross-model-advisor:login [provider-slot]` | Choose a configured OAuth provider, or name its slot directly, then get the terminal login command. Complete authorization in your terminal, not in Claude's transcript. |
| `/cross-model-advisor:logout <provider-slot>` | Delete that slot's local OAuth credential. |

The session commands run the plugin's helpers by full path, naming the plugin-data directory that Claude Code substitutes into the skill (it is not exported to Bash commands, and another plugin may export its own):

```
node "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs" on --plugin-data "${CLAUDE_PLUGIN_DATA}"
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" off --plugin-data "${CLAUDE_PLUGIN_DATA}"
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" status --plugin-data "${CLAUDE_PLUGIN_DATA}"
node "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs" doctor --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

## Configuration and provider selection

Start with `/cross-model-advisor:setup`: it prints a safely quoted command for your own terminal that opens the settings menu (`CLAUDE_CONFIG_DIR=<dir> node <abs>/setup-control.mjs menu`). Its home actions are **Add advisor**, **Provider accounts**, **Save**, and **Quit**. The gate reads the saved file at every Stop, so a save applies from the next reviewed turn in every session. Manual JSON remains supported. Setup neither collects key values nor starts OAuth by itself. When adding API slots or changing key-variable names, export the keys in your own terminal and start a new Claude session: hooks inherit Claude's environment from when it started.

One trusted user file: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cross-model-advisor.json`. Schema version is `2`. Version-1 files open without being rewritten; the first explicit Save publishes version 2. Unknown keys are rejected. There is no silent default provider or model, and the plugin never uses Claude's current credentials. `gate.mode` is `block` (default: concerns and blockers send Claude back) or `report` (findings are only shown to you); `gate.maxRounds` (default 2) bounds how many times one prompt is sent back.

Choose providers yourself:

- **API key** (`kind: "api"`): `openai`, `anthropic`, `google`, `openrouter`, `zai`, `xai`, `moonshotai`, `kimi-coding`, or `openai-compatible`. Each requires `apiKeyEnv` as an environment-variable name, never a key value. `openai-compatible` also requires `baseUrl` (HTTPS except localhost/loopback) and per-model `contextWindow`, `maxTokens`, `reasoning`, `input`, and optional `pricing`. Tunable reasoning needs paired `thinkingFormat` (`openai` | `openrouter` | `zai`) and a complete `thinkingLevelMap`; optional `supportsReasoningEffort` is valid only with that pair. `reasoning: true` alone is not tunable.
- **OAuth** (`kind: "oauth"`): `openai-codex`, `github-copilot`, `xai`, or `kimi-coding`. Explicit login, private slot-scoped credential storage, serialized refresh, and no API-key fallback. The settings menu hands off to the same terminal auth helper. No advisor CLI installation or subprocess transport.

Kimi API (`moonshotai`) and Kimi Coding are separate services. `google` is the Gemini API, not Antigravity subscription access. Anthropic and Antigravity subscription OAuth are not offered because their providers prohibit third-party use. See the [provider matrix and authentication guidance](plugins/cross-model-advisor/README.md#configuration).

Advisors name a configured provider, a user-chosen model id, literal instructions, `enabled`, and `reasoningEffort` (`default` preserves the previous request; `off` is offered only where thinking can actually be disabled). Compatible thinking budgets cannot raise `limits.maxOutputTokens`. The Codex adapter does not forward a hard remote output-token ceiling. Example and schema: `plugins/cross-model-advisor/config/`. `WATCHDOG.md` and `.cross-model-advisorignore` in a project may narrow review focus and tool access; they cannot select providers, credentials, binaries, or auto-enable the plugin.

## Security and credentials

For every reviewed turn, your request, Claude's final message, the diff, and source the advisor tools read go to the **external providers you configured**. Exclusions block tool access to `.git`, `.env` / `.env.*`, keys, `.claude` / `.codex` / `.gemini`, `node_modules`, and ignore files, and the same rules filter the diff: an excluded file that changed is named but its content is never sent. They do not strip secrets from prose in a prompt or from an allowed file.

The hook helpers and bundled SDK are trusted local code under the same OS user. Model-visible investigation is restricted to `read` / `list` / `search` / `advise`; no advisor shell, write access, or MCP bridge is exposed.

OAuth credentials live under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cross-model-advisor/credentials` (normally outside the project), with private directory/file permissions and atomic serialized writes. They are not encrypted against your OS user and are never copied from Claude, OMP, or other tools. Provider conversations last one review and stay in memory; the last review is kept locally for seven days. External providers have their own retention policies.

**Fail-open.** A timeout, provider error, or failed login lets Claude stop, says the turn was not reviewed, and is recorded for `status`. It is never reported as a pass.

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
| `/codex-pr-reviewer:review <pr> [--context-pr owner/repo#N]…` | Fetch a PR, review it, and check the findings against the code. `<pr>` is `42`, `owner/repo#42`, or a URL. Repeat `--context-pr` for approved cross-repository evidence. |
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
   └─ codex --strict-config -C <worktree> -s read-only review --base codex-pr/42-base
```

- **`--base` pinned to a branch at the merge-base** makes the review see exactly what GitHub's "Files changed" tab shows, whether Codex reads `--base` with two-dot or three-dot semantics. Verified against `gh pr diff`: identical file lists, identical `+225/-18` totals.
- **`refs/codex-pr-reviewer/*` instead of branches:** refs outside `refs/heads/` are never checked out, so a forced update succeeds even when a stale worktree sits on the old commit. That is what makes re-running idempotent.
- **A worktree** never touches the branch you are on, survives a dirty working tree, and holds several PRs at once — none of which `gh pr checkout` can do.

Fork PRs need no extra remotes: GitHub serves `refs/pull/<N>/head` from the base repository.
Cross-repository evidence is opt-in. The review command scans only added diff lines for repository-qualified references, shows them as untrusted suggestions, and asks once which—if any—to use before fetching another repository. `--context-pr owner/repo#N` supplies that approval explicitly and is repeatable up to four contexts. Codex still reviews only the primary PR: context worktrees can establish or refute its dependency claims, but defects confined to a context PR are not findings against the primary.

For an open context PR, Codex gets its pinned contributor head and merge-base diff. For a merged context PR, it also gets a separate worktree pinned to GitHub's `mergeCommit`; that landed tree is authoritative for effective behavior because merge queues, conflict resolution, or squash-merge changes can make it differ from the contributor head.

## Safety

- **PR content is untrusted input.** Every Codex run passes `-s read-only` explicitly rather than trusting config defaults, the plugin never runs the PR's build, tests, or hooks, and the prompts tell Claude to treat diff text as data, never instructions.
- **The reviewer's instructions cannot come from the PR.** Codex reads `AGENTS.md` and its fallbacks from its working directory — which *is* the pull request — so reviews run with `project_doc_max_bytes=0`. The prompts' anti-injection rules bind Claude and are not inherited by the Codex process, which is why this is enforced on the command line.
- **Checkout cannot execute the PR either.** Fetching writes attacker-authored bytes into a tree before Codex's sandbox exists, and git runs hooks and filters during that write. Every git this plugin causes to run — including the one `gh` spawns — gets `core.hooksPath` aimed at an empty directory and neutralised LFS filters via `GIT_CONFIG_*`. Without it, a repository that configures hooks into the tree, which is what Husky does, lets a PR touching `.husky/post-checkout` run a script the moment its worktree appears.
- **Nothing is published, by any command.** Reviews print to your terminal and save to disk. No subcommand or flag comments on a PR, and `review` holds no `gh` grant at all, so a PR whose text asks to be approved has nowhere to go — see [Publishing is out of scope](#publishing-is-out-of-scope).
- **Each command is granted only the subcommands it uses.** `review` and `sweep` pre-approve `pr-workspace.mjs` by full path and only its `doctor`, `prepare`, and `review` subcommands; `list` gets `list`; `clean` gets `clean`. So `clean` — the one destructive subcommand — is not reachable from a review, and no command reaches `gh` directly, where a grant would also carry `gh pr review`, `gh pr merge`, and `gh api`. `sweep` and `list` additionally hold read-only `gh` subcommands for finding pull requests. `clean` holds nothing else at all: it verifies its own removals, so the `git -C` grant it used to need — a prefix that also matched `reset`, `branch -D`, and `config` — is gone. Pre-approval is not a sandbox: `allowed-tools` grants permission rather than removing capability, so `node -e` stays callable. Whether it also becomes *visible* is your permission mode's call — under `auto`, a read-only command outside the grant simply runs — so the narrow rules are scoping the prompts are written to keep rather than a wall that stops them.
- **Local paths are stripped** from saved review output, so a comment you paste never leaks your filesystem layout.
- **Cleanup is precise.** The plugin records what it created in a manifest and `clean` removes only that, deleting a branch only while it still points at the recorded commit. Saved reviews survive every clean unless `--purge-reviews` names them.
- **A review in flight is left alone.** Cleanup holds back the primary PR and every approved context — head worktrees, merged landed snapshots, branches, and shared clones — and says which, rather than deleting state out from under a paid run. A guard, not a lock: see [Script reference](#script-reference).
- **What is fetched is what GitHub says it is.** Metadata and code arrive by different paths, so all three ends are tied together: the remote must be on the same host that served the PR's metadata, the fetched head must equal the API's `headRefOid`, and the fetched base must contain its `baseRefOid`. The base is checked by ancestry rather than equality, because a base branch legitimately moves between the API call and the fetch. Any of the three failing stops the run and points at `--clone`.
- **A pull request cannot point the reviewer out of its own worktree.** `-s read-only` bounds what Codex may write, not what it may read, so a symlink committed in a diff would be a path into the rest of your filesystem. Every git this plugin runs sets `core.symlinks=false`, which checks such a link out as a small regular file holding the link text — the target becomes a string to review instead of a path to follow. The diff is unaffected: the index still records the entry as a symlink, so the review sees exactly GitHub's diff and the worktree is not dirty. The setting is forced per-process rather than written into anyone's repository, so a plain `git status` you run yourself inside a worktree will report symlink entries as modified; the plugin's own git, which is the one that checks, does not.
- **A review cannot run forever.** Codex is stopped after 45 minutes (`CPR_CODEX_TIMEOUT_MS` to change it), signalling its whole process group, and the output kept for the saved document is capped — so a wedged or runaway run cannot hold a worktree indefinitely or exhaust memory. Both cases say so in the saved review rather than looking like a short one.
- **A failed run is visible as one.** Codex can exit nonzero and still print a body, and an interrupted run emits `Review was interrupted…`, so "the file exists" was never evidence a review happened. The exit status is written into the saved document's first line as `exit=<n>`.
- **Process success is not evidence coverage.** A review can exit successfully while an external compatibility claim remains unverified. The reviewer must name material limits separately; sweep preserves that state instead of reporting it as a clean verdict.
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
manifest.json                            what the plugin created, for precise cleanup
repos/owner__repo/                       cached clones (only for repos you lack locally)
worktrees/owner__repo/pr-42/             the PR head checkout Codex reads
worktrees/owner__repo/pr-42-landed/      a merged context's exact landed tree
reviews/owner__repo-pr42-*.md            saved review documents
runs/owner__repo-pr42-<pid>.json         every checkout a review is currently reading
```

## Script reference

The commands are thin; the git and `gh` choreography lives in one zero-dependency script.

```
pr-workspace.mjs doctor  [--json]
                 prepare <pr> [--repo owner/repo] [--clone] [--json]
                 review  <pr> [--repo …] [--context-pr owner/repo#N]…
                              [--model M] [--effort E] [--profile P]
                              [--no-prepare] [--dry-run] [--json]
                 list    [--repo owner/repo] [--json]
                 clean   [--pr N | --repo owner/repo | --all | --older-than DAYS]
                         --confirm-plan <digest> [--purge-clones]
                         [--purge-reviews --confirm-reviews <digest>]
                         [--include-running] [--dry-run] [--json]
```

`--confirm-plan` is required for any `clean` that is not a `--dry-run`: the digest binds the run to the plan a dry run printed. An unknown flag is an error rather than a silent positional, so a mistyped `--modle` stops the command instead of being read as the pull request to review.

`review --dry-run` prints the exact `codex` command it would run, without running it:

```
$ pr-workspace.mjs review cli/cli#14057 --context-pr cli/go-gh#236 --dry-run
codex --strict-config -C <cache>/worktrees/cli__cli/pr-14057 -s read-only \
  -c project_doc_max_bytes=0 -c developer_instructions='<generated evidence policy>' \
  review --base codex-pr/14057-base --title 'PR #14057: docs: recommend nix-shell …'
```

**`sweep` reviews smallest first** (`additions + deletions` ascending, tie-broken on file count), because each PR in a batch is a separate paid run. For `cli/cli` at the time of writing, `--limit 5` costs 27 lines of churn smallest-first against 352 newest-first. `--order newest` gives queue order; skipped PRs are named before the run.

**`clean` is the one destructive subcommand** and will not act on a plan it was not shown: a dry run prints a `planDigest` over every entry, worktree, branch, ref, and flag, and the real run must name it with `--confirm-plan`. A clean is two processes with a human confirmation in between, and a selector like `--all` re-evaluated in the second would sweep up whatever was prepared during the pause.

- **A bare `--pr N` is not scoped to the current repository.** `review 42` resolves the repo from the directory you are in; `clean --pr 42` selects PR #42 in *every* repository the manifest knows about. The command names each entry's repository before asking — but pass `owner/repo#42`, or add `--repo`, when only one is meant.
- **`--purge-reviews` is deliberately awkward,** and not implied by `--all` the way `--purge-clones` is: a clone can be re-fetched, a review is the output of a paid run. It takes `--confirm-reviews <digest>` over the exact list a dry run printed, so a review saved during the confirmation is not deleted having appeared in nothing anyone approved. Matching is on the whole filename rather than a `<slug>-pr<N>-` prefix, which would otherwise catch `o/r-pr7-archive#9` for `o/r#7`.
- **A running review holds all of its evidence back.** `review` records a marker under `runs/` — pid, host, start time, destination, primary PR, and context PRs — before handing work to Codex, and `clean` skips every named entry, including a merged context's landed worktree and branch. A marker whose process is gone is swept; one older than six hours expires, so a recycled pid cannot block cleanup forever. `--include-running` overrides the guard for a crashed run.
- **One window stays open deliberately.** A `clean` whose snapshot predates a review's marker cannot hold back what does not exist yet, so that review may still lose a worktree it is reading; `prepare` is likewise free to refresh a worktree mid-review. The cost is bounded rather than avoided — a review re-records its primary PR and contexts when it saves, so output that *was* produced stays reachable. Closing either means locking, and a lock that outlives a crashed run is the worse failure.

`--context` and `--trust-worktree` were removed in 0.8.0, and passing either is an error rather than a silent no-op. `--context` appended the PR title and description as a positional prompt, which `codex review` refuses alongside `--base` — *the argument '--base <BRANCH>' cannot be used with '[PROMPT]'* — so every run that used it failed at argument parsing, documented and advertised and never once working. `--trust-worktree` gave effect to `.codex` configuration inside a repository fetched from the internet, which is not something a flag should be able to ask for.

## Tests

```
node tests/unit.mjs          # reviewer helpers, marketplace versions, version-guard
./tests/regression.sh        # synthetic repos + stub codex, no network
./tests/integration.sh       # real git/gh plumbing, never calls Codex
node --test tests/cross-model-advisor/*.test.mjs   # advisor focused suites and cold-bundle smoke
```

Both suites and the CI workflow share one Codex stub, `tests/stubs/codex`; `unit.mjs` fails the build if a second copy appears.

`regression.sh` pins the defects found in code review — the symlinked-entrypoint guard, `--dry-run` side effects, manifest corruption, shared-clone purging, output hygiene, the retired flags, the `--purge-reviews` guards, and both halves of the in-flight race, that last driven by a stub `codex` that runs a real `clean` mid-review so the concurrency is genuine. It runs against synthetic repositories in an isolated `XDG_CACHE_HOME`, so it needs no network or GitHub account and never touches your real cache.

`integration.sh` is the one that matters: it prepares a real fork PR and asserts the worktree's diff against the pinned merge-base is byte-identical to `gh pr diff` — same file list, same `+A/-D`. That is the property the whole design rests on. It also checks idempotency and that `clean` removes exactly what was created, and never invokes Codex, so it costs nothing. Point it at any public PR:

```
./tests/integration.sh cli/cli 13899
```

CI runs the reviewer offline suites on every pull request and push to `main`, across Node 18 — the documented floor — and 22, on Linux and macOS. A separate job on Node 22.19.0, Linux and macOS, runs `npm ci` and `npm run build` in `tooling/cross-model-advisor`, then `node --test tests/cross-model-advisor/*.test.mjs` (focused suites including cold-bundle smoke) and diffs a clean `--outdir` rebuild against committed `dist/`. One reviewer leg runs `tests/version-guard.sh`, which enumerates every marketplace plugin and fails when that plugin's shipped content changed without its own version moving. Pass a base ref for CI's committed comparison; add `--worktree` to compare the current checkout, including untracked files. The integration suite runs weekly and on demand, needing the network and an upstream PR that still exists.

## Security, changelog, license

Reporting a vulnerability, scope, and known-and-accepted issues: [SECURITY.md](SECURITY.md). Release notes: [CHANGELOG.md](CHANGELOG.md) for `codex-pr-reviewer`, [plugins/cross-model-advisor/CHANGELOG.md](plugins/cross-model-advisor/CHANGELOG.md) for `cross-model-advisor`. Licensed [MIT](LICENSE).
