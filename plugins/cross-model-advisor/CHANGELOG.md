# Changelog

Versions are this plugin's, in `plugins/cross-model-advisor/.claude-plugin/plugin.json`.
They move independently of `codex-pr-reviewer` and of marketplace metadata.
Claude Code resolves an install by that number and caches it, so every change to
anything under `plugins/cross-model-advisor/` moves it — `tests/version-guard.sh`
fails the build otherwise.

## 2.1.17

- You now see what the advisors found when the gate sends Claude back: a
  summary of every finding, the round, and any advisor that did not finish.
  Before, the findings reached only Claude, so you learned of them from
  Claude's reply, if at all.
- A clean review says so (`no findings from <advisors>`) instead of ending
  silently, so a reviewed turn is distinguishable from a skipped one.
- A turn that changed files but could not be reviewed now tells you why: a
  failed snapshot, diff, or ignored-paths listing, a snapshot missing from the
  prompt, or no usable advisor (missing key, session review limit). These used
  to let Claude stop without a word.

## 2.1.16

- 2.1.15's shorter `login` skill dropped a rule: questions need 2 to 4
  options, so a last page with a single slot needs **Cancel** added. The
  `setup` skill had the same gap, and there it was reachable: ten providers
  page 3, 3, 3, then 1. Both now state the rule. Found by the cross-model
  advisor on 2.1.15.

## 2.1.15

- The `login` skill prompt is about half as long (~950 to ~450 tokens), with
  every rule kept once: a validated slot, OAuth slots only, the formatter's
  command shown verbatim, and nothing run under Claude.

## 2.1.14

- 2.1.13 told the setup skill to read `add.md`, which lives in the plugin
  cache outside the project, so reading it would stop for a permission prompt,
  and a model change pointed at it too. The steps now come from `H guide add`,
  which the skill already pre-approves, and model search is inline. Found by
  the cross-model advisor on 2.1.13.

## 2.1.13

- **Chat setup uses far fewer tokens.** A one-field change cost over 5k
  tokens. The skill prompt is about 40% shorter and names the helper path
  once; the add-advisor steps moved to `add.md`, read only on that path.
  `summary` shrinks from about 840 to 140 tokens: provider listings move to a
  new `providers` command, preset texts stay in the helper (`apply` takes
  `instructionsPreset`, and the preview still shows the full text), and the
  revision is a 16-character prefix. `efforts` returns values only. The
  preview goes inside the Save question, and the next change is offered
  directly instead of asking "anything else?" first.

## 2.1.12

- 2.1.11 scoped the catalog check to the advisors a change selects, but the
  reasoning check still covered every advisor, so one saved with a since
  retired model and a non-default effort blocked unrelated changes such as
  gate settings. Both checks, and the one the final save runs, now cover only
  advisors whose model, provider, or effort the change sets. Repairing or
  removing such an advisor already worked and still does. Found by the
  cross-model advisor on 2.1.11.

## 2.1.11

Three fixes to 2.1.10's chat setup, found by the cross-model advisor:

- A model change sends `model` and `reasoningEffort` in one `set`. The skill
  asked for one field at a time, so moving to a model without the current
  effort was refused either way.
- The catalog check covers only models the change selects. An advisor saved
  earlier whose model has since left the pinned catalog blocked every change,
  including gate settings and that advisor's own repair.
- The preview shows values whole. It cut text at 120 characters, so custom
  instructions could be saved without being seen in full.

## 2.1.10

- **Setup in Claude Code.** `/cross-model-advisor:setup` now adds and changes
  advisors (account, model, effort, role) and gate settings through Claude
  Code's question menu instead of printing a terminal command. Each change is
  one structured `apply` through the helper, previewed with `--dry-run`, and
  saved only when you choose Save, under the menu's lock and revision check.
  Key values are never asked for, only variable names. Models must exist in
  the offline catalog (an unknown id used to pass with effort Default). Custom
  endpoints and anything else stay in the terminal menu, which setup still
  prints on request. New helper commands: `summary`, `efforts`, `apply`.

## 2.1.9

- **Gate settings in the menu.** The settings menu's home screen has a
  **Gate settings** entry for mode, max rounds (1 to 5), auto-on projects,
  and skip patterns, so `gate.autoOn` and `gate.skipWhenOnly` no longer need
  hand-edited JSON. Lists take one entry per line; a relative path or a
  negated pattern is refused before save, and an emptied list removes its key.
  Quitting with unsaved gate edits asks first, as advisor edits always did.

## 2.1.8

- **`/cross-model-advisor:review [base-ref]`.** An on-demand review of
  uncommitted changes (untracked files included), or of everything since a
  ref's merge base, committed and uncommitted. It uses the gate's advisors,
  tools, evidence rules, exclusions, review cap, and 270-second budget, works
  whether the gate is on or off, and reports without blocking. The gate and
  the command share one advisor loop. The ref is checked for shape and
  resolved with `--end-of-options`.

## 2.1.7

- **Auto-on.** `gate.autoOn` in your own config lists absolute project roots;
  a new SessionStart hook turns the gate on there without
  `/cross-model-advisor:on` and shows a one-line notice (never context for
  Claude). `/cross-model-advisor:off` wins for the rest of that session, even
  after a resume. A project cannot list itself; only this user file can.
- **Skip docs-only turns.** `gate.skipWhenOnly` takes gitignore patterns such
  as `*.md`; a turn whose changed files all match is not reviewed. Unlike
  `exclude`, the files stay visible to advisors in other turns.
- An older plugin rejects a config that uses either key.

## 2.1.6

- **Short credentials are redacted.** A name ending in a credential word
  (`GITHUB_TOKEN`, `DB_PASSWORD`, `CLIENT_SECRET`) now has its value redacted
  whatever its length, so `DB_PASSWORD=hunter2` no longer passes. Names that
  only contain the word (`MAX_TOKENS`, `TOKEN_LIMIT`) keep the 8-character
  rule, and comparisons like `GITHUB_TOKEN === undefined` are left alone.
  Found by the plugin's own advisor reviewing the 2.1.4 change.

## 2.1.5

- **Large turns get reviewed.** A review could send at most 60,000 characters,
  but the diff alone may be 61,440, so large turns failed with `context-limit`
  before the advisor saw anything. The limit is now 240,000 (the model's own
  window still applies), and a test pins the diff, request, and final message
  to half of it. A read too large for what remains is withheld with a note to
  read a narrower range, and its lines stop counting as evidence.
- **No false stale-lock errors.** When a credential lock was released just as
  another process checked it, the waiter read a vanished owner file as
  corrupt and failed, telling you to delete a lock that was already gone. It
  now waits and retries. Seen as 2 to 5 failures per 640 updates across 8
  processes, and as a failed CI run on 2.1.4.

## 2.1.4

- **Git-ignored files.** Advisor tools now exclude every path git ignores,
  including `.git/info/exclude` and the global excludes file, not only
  `.gitignore` matches. The diff already did.
- **Credential files.** `.npmrc`, `.netrc`, `.envrc`, `.pypirc`, `.pgpass`,
  `.git-credentials`, SSH keys, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `.ssh`,
  `.aws`, and `.gnupg` are excluded. Redaction also catches names like
  `GITHUB_TOKEN=` and well-known token formats (`ghp_`, `npm_`, `sk-`, `AKIA`).
- **WATCHDOG.md** moves out of the system prompt into the review data, fenced
  and labelled as untrusted.

## 2.1.3

- **Duplicates.** Findings that differ only in markdown or sentence punctuation
  now merge. Code punctuation still counts, so `i < n` and `i > n` stay apart.
- **Tool limit.** `maxToolCallsPerReview` now counts only read, list, and
  search, and the advisor is told the limit. Past it, a read is refused once so
  the advisor can still report; findings made before a cutoff are kept. A
  10-file turn used to fail outright when all 8 calls went to reading.

## 2.1.2

- **Failed advisors are named when the others found something.** When some
  advisors failed and the rest sent Claude back, the findings went to Claude
  and nothing told you part of the review was missing. A notice now names the
  advisors that did not review the turn and why. It is shown to you, not
  Claude. In `report` mode the same line comes first in the findings summary,
  so truncating a long summary cannot drop it.

## 2.1.1

- **Partial failures are shown.** When some advisors fail and the rest find
  nothing, the turn used to end silently, like a clean pass. It now shows
  which advisors did not review it and why. The outcome in `status` is
  still `passed`.
- **Advisors share the Stop hook's time.** Advisors queued behind
  `limits.maxConcurrentAdvisors` could add up past the hook's 300 seconds;
  for example, three advisors one at a time at `reviewTimeoutSeconds: 120`.
  Claude Code then killed the hook before it saved anything. All advisors
  now share a 270-second budget. Each one's timeout is cut to what remains,
  and one that would start after it runs out is recorded as a timeout.
  Existing configurations stay valid.

## 2.1.0

The offline model catalog moves to `@earendil-works/pi-ai` 0.87.1.

- **Added.** `gpt-6-sol` and `gpt-6-luna` on `openai`, `openai-codex`, and
  `github-copilot`; `grok-4.7` on `xai` and `github-copilot`;
  `claude-opus-5-5` on `anthropic` (`claude-opus-5.5` on `github-copilot`).
  OpenRouter's catalog also moved (GPT-6, Claude Opus 5.5, Grok 4.7, and
  others in; some previews and batch variants out).
- **Removed upstream.** `gpt-5.4` and `gpt-5.4-mini` on `openai-codex`, and
  `kimi-k2.5`, `kimi-k2-thinking`, `kimi-k2-thinking-turbo`,
  `kimi-k2-turbo-preview`, `kimi-k2-0905-preview`, and `kimi-k2-0711-preview`
  on `moonshotai`. An advisor that names one of these is now unavailable with
  `unknown model`; pick another model in the settings menu.
- **Codex Default.** SDK 0.87.1 sends reasoning `none` to Codex when no effort
  is given. Default still omits reasoning there, as documented, so it keeps
  meaning the provider's own default rather than reasoning off.

## 2.0.0

The plugin now reviews Claude's work after a turn instead of watching it
live. Claude Code's hooks cannot stream a turn to another model or steer it
mid-run, so live observation only ever delivered advice at the next tool call
or prompt, often after Claude had finished.

- **When.** A prompt records a git snapshot of the working tree through a
  private temporary index (the user's index, HEAD, and stash are untouched).
  When Claude finishes, the Stop hook snapshots again and reviews the
  difference. Turns that change nothing, diffs already reviewed, plugin
  commands, and subagents are not reviewed.
- **What advisors see.** The request, Claude's final message as a claim, and
  the turn's diff minus excluded paths, plus the existing read-only tools. Up
  to five evidence-backed findings per advisor; advisors run in parallel and
  duplicates merge.
- **What happens.** `gate.mode: "block"` (default) sends Claude back on any
  concern or blocker, labelled as unverified claims from other models to fix
  or rebut; the next Stop re-reviews the whole turn with the earlier findings,
  up to `gate.maxRounds` (default 2). Nits, and `gate.mode: "report"`, are
  shown to the user instead. Failures let Claude stop and say the turn was not
  reviewed.
- **Removed.** The per-session worker and its socket, transcript following,
  mid-run injection, the delivery barrier, and settings epochs. The settings
  menu has Save only: the gate reads configuration at every Stop, so there is
  nothing to apply to a live session. `limits.reviewTimeoutSeconds` is now at
  most 240, inside the Stop hook's 300-second timeout.
- **Requires git.** `on` refuses a project outside a git work tree.
- **Reviewer prompt.** A problem Claude mentions in its final message but
  leaves in the code is still reported; only a fix in the diff excuses it. An
  input the request did not mention but the code mishandles is at least a nit.
  Findings are about the code only: how Claude worded its reply, or whether it
  followed instructions about the reply's format, is not a finding.

## 1.2.0

The session skills (`on`, `off`, `status`, `doctor`) and `setup`'s
`menu-command` now name this plugin's data directory with
`--plugin-data "${CLAUDE_PLUGIN_DATA}"`, which Claude Code substitutes into
skill text. The helpers used to read `CLAUDE_PLUGIN_DATA` from the Bash tool's
environment, which Claude Code does not set for plugins, and which another
plugin's SessionStart can export for every Bash command through
`CLAUDE_ENV_FILE` (openai/codex-plugin-cc does). With that plugin installed,
`on` enabled a session under the other plugin's directory: `status` reported
the advisor enabled and available while the hooks, which do receive the right
directory, never scheduled a review. Hooks still take the host-provided value.

A review cancelled while persisting its reservation (by a new prompt, `off`,
or Apply) now stops before calling the provider. It previously went on, and
was handed the newer prompt's task instead of the one it was reserved for.

Replace conversational `/cross-model-advisor:setup` with a plugin-owned
terminal settings menu. The slash skill only prints a safely quoted
`setup-control.mjs menu-command` for the user's own terminal; it does not
open a TTY inside Claude, interpolate `$ARGUMENTS`, or edit configuration.
Reusing that printed command does not cost another Claude turn and does not
infer a session from the working directory or a transcript. The printed line
always pins empty `CLAUDE_SESSION_ID` and `CLAUDE_PROJECT_DIR` so a leftover
shell cannot retarget Apply. Opening the slash skill still can cost a turn.

The menu adds, edits, enables, disables, and removes advisors; selects
multiple providers and the required auth/model fields; sets model-specific
reasoning effort; and edits literal instructions. Empty or all-disabled
configurations are valid and start no reviews. Persistent defaults stay
separate from a named session's snapshot: **Save defaults** writes user
config only; **Save & Apply** targets the captured live session and
preserves on/off unless **Enable** is used (shown only when that session is
off). Notices are `Saved defaults.`, `Saved and applied.`,
`Saved; not applied: …`, and `Not saved: …`. A rejected Apply does not undo
a save another session may already have observed. Stale or replaced workers,
busy hook deliveries, wrong root, and missing identity fail visibly rather
than retargeting. Workers that lack the settings protocol need a fresh
Claude session; live Apply is not a fallback to `/on`.

Configuration schema is version 2. Opening a version-1 file does not write;
the first explicit Save publishes version 2 (`enabled` and `reasoningEffort`
on every advisor). An older plugin cannot read version 2. Version-1 input
normalizes to enabled advisors with `reasoningEffort: "default"`.

Reasoning Default leaves the previous request unchanged; Off is offered only
where the transport can disable thinking. Native aliases and enable-only
formats are shown rather than labelled as distinct native levels.
Compatible endpoints stay Default-only until paired `thinkingFormat` /
`thinkingLevelMap` metadata is present; optional `supportsReasoningEffort`
selects native `reasoning_effort` versus enable-only. Incompatible thinking
budgets fail instead of raising `limits.maxOutputTokens`. The Codex adapter
still does not forward a remote output-token ceiling; that existing gap is
unchanged.

OAuth login still uses the existing terminal auth helper. The menu suspends
while that helper owns the terminal, then restores. Model-only edits reuse
the slot credential. New or missing API key-variable names cannot be
injected into a live worker: Apply reports unavailable and requires a new
Claude session with those variables exported. The launcher never prints
capabilities, credentials, or key values.

## 1.1.1

Fix doctor's bundle root inference when `CLAUDE_PLUGIN_ROOT` is absent. Both
`dist/worker.mjs` and `dist/modules/worker.mjs` now resolve the plugin root
instead of checking a nonexistent `dist/dist` directory. Explicit plugin-root
overrides remain supported; project/session identity is unchanged.

A genuinely missing bundle entry now makes the overall doctor `ok` false,
not merely `bundle.ok`. Cover environment-free installed bundles, generated
worker modules, explicit roots, and incomplete bundles in regression checks.

## 1.1.0

Add `/cross-model-advisor:setup`: choose multiple providers, supported
authentication methods, explicit offline-catalog models, and advisor
instructions through Claude's question UI. Preview before saving; preserve
unrelated configuration and protect writes with revision checks, serialization,
and private atomic publication. API keys stay in named environment variables,
never in chat or configuration values.

Bare `/cross-model-advisor:login` now offers configured OAuth slots, including
pagination and cancellation, then prints the selected terminal login command.
API slots are not offered for OAuth login. Setup and its question turns remain
control-only and cannot replace the task or trigger advisor reviews.

Document the new-session requirement after adding API slots or changing key
variable names, so the worker inherits the selected environment variables.

## 1.0.1

Session commands no longer require `CLAUDE_PROJECT_DIR` in Claude's Bash tool.
Existing sessions recover their stored project root; new sessions use the
available project environment, hook cwd, or initial command cwd. Worker restarts
and later directory changes cannot silently rebind a stored session root.

Command failures now report actionable, sanitized stderr diagnostics and exit 1.
Hook failures remain silent and fail-open. No credential values or raw filesystem
error paths are printed.

## 1.0.0

Initial release of `cross-model-advisor`. Independent advisors observe the
current Claude Code session through `UserPromptSubmit`, `PreToolUse`, and
`PostToolUse` hooks, inspect the project with read-only host tools, and inject
findings at the next permitted user/tool boundary.

Advisors make direct SDK calls authenticated with explicit API keys or
provider-scoped OAuth. Providers include OpenAI/Codex, Anthropic, Gemini API,
GitHub Copilot, ZAI, xAI, Moonshot/Kimi, Kimi Coding, OpenRouter, and explicitly
configured OpenAI-compatible endpoints. No installed advisor CLI or MCP bridge.
There is no silent default provider, model, credential source, or auth fallback.
Explicit login/logout helpers own private credentials and serialized token refresh;
background hooks never start a login flow. Configuration lives in
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cross-model-advisor.json` and is snapshotted
by `/cross-model-advisor:on`.
Browser authorization opens the default browser, with a manual URL fallback.
Completion cancels pending manual input and releases stdin so the helper exits.

The plugin never wakes a stopped session. Injection is best-effort: `emitted`
means locally written and acknowledged, not confirmed receipt by Claude.
Provider context remains in memory; the plugin's inbox is retained for seven days.

Requires Claude Code 2.1.252 or newer and Node 22.19.0 or newer, on macOS and
Linux. Users install the bundled plugin without `npm install` or a build.
