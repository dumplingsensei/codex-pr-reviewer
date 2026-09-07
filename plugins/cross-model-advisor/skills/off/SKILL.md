---
name: off
description: Disable cross-model advisors for this session, cancel reviews, and discard pending injections.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" off)
---

Disable cross-model advisors for **this session only** (`${CLAUDE_SESSION_ID}`).

This skill has no arguments. Do not append user text to the helper.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" off
```

The helper reads session identity from `CLAUDE_CODE_SESSION_ID`, the frozen project root from `"$CLAUDE_PROJECT_DIR"`, and plugin data from `"$CLAUDE_PLUGIN_DATA"`. Do not pass paths, session ids, or `$ARGUMENTS`.

## Report

Show the helper's stdout. After `off`:

- running reviews are cancelled
- future reviews are stopped
- pending injection candidates are discarded
- accepted findings stay in the local inbox for `/cross-model-advisor:status`

Do not start an advisor model call. Do not drain or restate inbox findings unless the helper printed them. Do not run `on`, `status`, or `doctor`.

If the helper exits non-zero, show stderr and stop.
