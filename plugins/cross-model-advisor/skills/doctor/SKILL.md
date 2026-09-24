---
name: doctor
description: Check runtime, configuration, provider availability, bundle, and IPC without calling paid models.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" doctor --plugin-data "${CLAUDE_PLUGIN_DATA}")
---

Diagnose whether cross-model advisors can run in **this session** (`${CLAUDE_SESSION_ID}`).

This skill has no arguments. Do not append user text to the helper.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" doctor --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

The helper reads session identity from `CLAUDE_CODE_SESSION_ID` (or `CLAUDE_SESSION_ID`). Plugin data comes only from the `--plugin-data` path Claude Code substituted above: the Bash tool does not export this plugin's `CLAUDE_PLUGIN_DATA`, and another plugin may have exported its own. It reuses the stored session root. For a new session without stored state, it uses `CLAUDE_PROJECT_DIR` when available, otherwise the command's working directory. Run the command exactly as written. Do not pass other paths, session ids, or `$ARGUMENTS`, or export replacement identity variables.

## Report

Show the helper's stdout. It should cover:

- Node and host/OS versus the runtime baseline (Claude Code 2.1.252+, Node 22.19.0+, macOS or Linux)
- configuration file `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cross-model-advisor.json`
- presence of named key variables (names only, never values)
- configured providers: slot, upstream id, kind, availability, and a static error when unavailable
- bundle completeness (`control.mjs`, `worker.mjs`, `auth-control.mjs`, `setup-control.mjs`) and IPC access

OAuth availability is offline credential status only. If a slot is unavailable, do not start login from this skill.

Missing bundle entries make both `bundle.ok` and the overall `ok` false.
Without `CLAUDE_PLUGIN_ROOT`, the worker resolves its plugin root from its own
file location, not the project directory. After a plugin update, restart Claude
to replace any already-running worker before diagnosing the updated bundle.

Do **not**:

- make a paid model request
- start a login flow, print a token, or install anything
- print API keys, tokens, or credential file contents
- enable advisors (`on`) or start a review
- run `status` or `off`

If the helper exits non-zero, show stderr and stop.
