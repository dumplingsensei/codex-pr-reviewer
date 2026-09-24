---
name: on
description: Validate configuration and enable cross-model advisors for this Claude session only.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" on --plugin-data "${CLAUDE_PLUGIN_DATA}")
---

Enable cross-model advisors for **this session only** (`${CLAUDE_SESSION_ID}`).

This skill has no arguments. Do not append user text to the helper.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" on --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

The helper reads session identity from `CLAUDE_CODE_SESSION_ID` (or `CLAUDE_SESSION_ID`). Plugin data comes only from the `--plugin-data` path Claude Code substituted above: the Bash tool does not export this plugin's `CLAUDE_PLUGIN_DATA`, and another plugin may have exported its own. It reuses the stored session root. For a new session without stored state, it uses `CLAUDE_PROJECT_DIR` when available, otherwise the command's working directory. That frozen root is immutable for this session: later cwd or worktree changes never rebind it. Run the command exactly as written. Do not pass other paths, session ids, or `$ARGUMENTS`, or export replacement identity variables.

## Report

Show the helper's stdout to the user. Include every field it reports:

- session `enabled` after this command
- the frozen session `projectRoot` and limits
- each advisor's configured `enabled` versus `available`, with provider, model, and `reasoningEffort`
- which advisors are intentionally disabled (`enabled: false`) versus configured enabled but unavailable (`enabled: true` and `available: false`), by name, and why (`error`)
- external-provider disclosure (configured API keys are sent to those providers; the plugin does not use Claude's credentials)
- that the plugin does not persist provider conversations; injection is best-effort and never wakes a stopped session

Configured-enabled but unavailable is not the same as intentionally disabled. Do not describe a disabled advisor as unavailable, or an unavailable advisor as disabled.

If none are usable (no advisor has `available: true`), the session stays disabled. Say so. Do not substitute another provider or model.

If stdout has `"ok": false`, report the helper's `error` and stop. Shared activation codes:

- `busy`: a prior delivery is still in flight; the active snapshot is unchanged. The user can retry this same command later. Do not start reviews or invent a workaround.
- `protocol`: this live worker cannot promise a safe activation. The user needs a fresh compatible Claude session. Do not reconstruct setup or call a different helper.
- `config`: configuration is invalid, missing, or not the expected file. Do not reconstruct JSON or invent models.
- `root`: the stored session root does not match or is unsafe. Do not pass a different path, export a replacement root, or start from cwd.

This command must not start an advisor model call. Do not run `doctor`, `status`, `off`, or `setup`. Terminal model or reasoning-effort changes do not require this command, `doctor`, or `status`. Do not inspect the project to "help" enablement. Do not print secret values or key file contents.

If the helper exits non-zero, show stderr and stop.
