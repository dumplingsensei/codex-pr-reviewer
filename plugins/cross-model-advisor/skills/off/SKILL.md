---
name: off
description: Turn off the cross-model review gate for this Claude session.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" off --plugin-data "${CLAUDE_PLUGIN_DATA}")
---

Turn off the review gate for **this session only** (`${CLAUDE_SESSION_ID}`). This skill has no arguments; do not append user text to the helper.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" off --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

Run it exactly as written. Claude Code substitutes the plugin-data path; do not pass other paths or session ids.

## Report

Say that the gate is off for this session and that turns will no longer be reviewed. The last review's findings stay visible in `/cross-model-advisor:status`. If the result has `"ok": false`, report `message` and stop.
