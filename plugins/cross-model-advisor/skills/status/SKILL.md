---
name: status
description: Show this session's advisor state, inbox findings, usage, and sanitized last errors.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" status --plugin-data "${CLAUDE_PLUGIN_DATA}")
---

Show the human-visible inbox and advisor state for **this session only** (`${CLAUDE_SESSION_ID}`).

This skill has no arguments. Do not append user text to the helper.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" status --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

The helper reads session identity from `CLAUDE_CODE_SESSION_ID` (or `CLAUDE_SESSION_ID`). Plugin data comes only from the `--plugin-data` path Claude Code substituted above: the Bash tool does not export this plugin's `CLAUDE_PLUGIN_DATA`, and another plugin may have exported its own. It reuses the stored session root. For a new session without stored state, it uses `CLAUDE_PROJECT_DIR` when available, otherwise the command's working directory. That frozen root is immutable for this session: later cwd or worktree changes never rebind it. Run the command exactly as written. Do not pass other paths, session ids, or `$ARGUMENTS`, or export replacement identity variables.

## Report

Show the helper's stdout without summarizing away fields. Cover:

- session `enabled` / `paused`, and the frozen `projectRoot`
- per advisor: `state` (idle, busy, paused, unavailable, disabled), configured `enabled` versus `available`, provider, model, and `reasoningEffort`
- pending and emitted findings (the local inbox)
- usage when the helper reported it
- sanitized last errors

Configured enabled-but-unavailable is distinct from intentionally disabled. Disabled advisors may still appear; report them as disabled, not as missing.

**Emitted** means locally acknowledged hook output, not confirmed receipt by Claude. Do not describe emission as delivered.

If stdout has `"ok": false`, report the helper's `error` and stop. Shared codes `busy`, `protocol`, and `config` are diagnostics: do not retry with `on`, reconstruct configuration, or start reviews. `root` means the stored session root is immutable and mismatched; do not pass a different path.

This command must not start reviews, replace the user's task, or call `on` / `off` / `doctor` / `setup`. Model or reasoning-effort changes in the terminal menu do not require this command or `doctor`. Do not print secrets.

If the helper exits non-zero, show stderr and stop.
