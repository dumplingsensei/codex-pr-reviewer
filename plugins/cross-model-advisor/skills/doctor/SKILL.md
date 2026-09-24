---
name: doctor
description: Check the runtime, configuration, git, provider availability, and bundle for the review gate, without calling a model.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs" doctor --plugin-data "${CLAUDE_PLUGIN_DATA}")
---

Diagnose whether the review gate can run in **this session** (`${CLAUDE_SESSION_ID}`). This skill has no arguments; do not append user text to the helper.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs" doctor --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

Run it exactly as written. Claude Code substitutes the plugin-data path; do not pass other paths or session ids.

## Report

Report `ok`, then each failing area and its message: runtime (Node 22.19.0 or newer on macOS or Linux), configuration, git (the project must be a git work tree), API key variables that are missing (names only), advisors that are unavailable and why, and missing bundle files.

Doctor is offline. It does not call a model, refresh OAuth, or log in, and an `available` advisor is not proof that the remote account accepts requests. Do not print secret values or credential files.
