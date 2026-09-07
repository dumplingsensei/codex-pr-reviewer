# Changelog

Versions are this plugin's, in `plugins/cross-model-advisor/.claude-plugin/plugin.json`.
They move independently of `codex-pr-reviewer` and of marketplace metadata.
Claude Code resolves an install by that number and caches it, so every change to
anything under `plugins/cross-model-advisor/` moves it — `tests/version-guard.sh`
fails the build otherwise.

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
