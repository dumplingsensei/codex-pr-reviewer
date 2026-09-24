---
name: on
description: Validate configuration and turn on the cross-model review gate for this Claude session only.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs" on --plugin-data "${CLAUDE_PLUGIN_DATA}")
---

Turn on the review gate for **this session only** (`${CLAUDE_SESSION_ID}`). This skill has no arguments; do not append user text to the helper.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs" on --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

Run it exactly as written. Claude Code substitutes the plugin-data path; the Bash tool does not export it, and another plugin may have exported its own. Do not pass other paths or session ids, and do not export identity variables.

## Report

Show the helper's result:

- whether the gate is `enabled`, and the git `projectRoot` it will review
- `gate.mode` (`block`: concerns and blockers send Claude back to address them; `report`: findings are only shown to the user) and `gate.maxRounds`
- each advisor's `enabled` versus `available`, with provider, model, and `reasoningEffort`; name every enabled-but-unavailable advisor and its `error`
- the `disclosure` text

If no advisor is available, the gate stays off. Say so; do not substitute another provider or model.

If the result has `"ok": false`, report `error` and `message` and stop. `git` means the project is not a git work tree, which the gate needs to see what changed. `config` means the configuration is missing or invalid: point the user to `/cross-model-advisor:setup`; do not write JSON or invent models.

This command makes no model request. The first review happens when a later turn changes files and Claude finishes. Do not run other plugin commands or inspect the project.
