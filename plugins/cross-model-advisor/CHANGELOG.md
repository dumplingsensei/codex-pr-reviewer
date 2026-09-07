# Changelog

Versions are this plugin's, in `plugins/cross-model-advisor/.claude-plugin/plugin.json`.
They move independently of `codex-pr-reviewer` and of marketplace metadata.
Claude Code resolves an install by that number and caches it, so every change to
anything under `plugins/cross-model-advisor/` moves it — `tests/version-guard.sh`
fails the build otherwise.

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
