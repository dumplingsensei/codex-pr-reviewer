---
name: status
description: Show this session's advisor state, inbox findings, usage, and sanitized last errors.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" status)
---

Show the human-visible inbox and advisor state for **this session only** (`${CLAUDE_SESSION_ID}`).

This skill has no arguments. Do not append user text to the helper.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" status
```

The helper reads session identity from `CLAUDE_CODE_SESSION_ID`, the frozen project root from `"$CLAUDE_PROJECT_DIR"`, and plugin data from `"$CLAUDE_PLUGIN_DATA"`. Do not pass paths, session ids, or `$ARGUMENTS`.

## Report

Show the helper's stdout without summarizing away fields. Cover:

- enabled / paused / busy per advisor
- pending and emitted findings (the local inbox)
- usage when the helper reported it
- sanitized last errors

**Emitted** means locally acknowledged hook output, not confirmed receipt by Claude. Do not describe emission as delivered.

This command must not start reviews, replace the user's task, or call `on` / `off` / `doctor`. Do not print secrets.

If the helper exits non-zero, show stderr and stop.
