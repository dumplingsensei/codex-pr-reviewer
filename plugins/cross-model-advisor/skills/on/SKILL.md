---
name: on
description: Validate configuration and enable cross-model advisors for this Claude session only.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" on)
---

Enable cross-model advisors for **this session only** (`${CLAUDE_SESSION_ID}`).

This skill has no arguments. Do not append user text to the helper.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" on
```

The helper reads session identity from `CLAUDE_CODE_SESSION_ID`, the frozen project root from `"$CLAUDE_PROJECT_DIR"`, and plugin data from `"$CLAUDE_PLUGIN_DATA"`. Do not pass paths, session ids, or `$ARGUMENTS`. Do not export extra environment.

## Report

Show the helper's stdout to the user. Include every field it reports:

- which advisors became enabled (provider and model names)
- which advisors were unavailable, by name, and why
- project root and limits
- external-provider disclosure (configured API keys are sent to those providers; the plugin does not use Claude's credentials)
- that the plugin does not persist provider conversations; injection is best-effort and never wakes a stopped session

If none are usable, the session stays disabled. Say so. Do not substitute another provider or model.

This command must not start an advisor model call. Do not run `doctor`, `status`, or `off`. Do not inspect the project to "help" enablement. Do not print secret values or key file contents.

If the helper exits non-zero, show stderr and stop.
