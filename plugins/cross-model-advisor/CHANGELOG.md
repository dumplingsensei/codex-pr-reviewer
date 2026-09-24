# Changelog

Versions are this plugin's, in `plugins/cross-model-advisor/.claude-plugin/plugin.json`.
They move independently of `codex-pr-reviewer` and of marketplace metadata.
Claude Code resolves an install by that number and caches it, so every change to
anything under `plugins/cross-model-advisor/` moves it — `tests/version-guard.sh`
fails the build otherwise.

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
