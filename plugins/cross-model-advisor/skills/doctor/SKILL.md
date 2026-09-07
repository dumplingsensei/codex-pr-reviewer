---
name: doctor
description: Check runtime, configuration, provider availability, bundle, and IPC without calling paid models.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" doctor)
---

Diagnose whether cross-model advisors can run in **this session** (`${CLAUDE_SESSION_ID}`).

This skill has no arguments. Do not append user text to the helper.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" doctor
```

The helper reads session identity from `CLAUDE_CODE_SESSION_ID`, the frozen project root from `"$CLAUDE_PROJECT_DIR"`, and plugin data from `"$CLAUDE_PLUGIN_DATA"`. Do not pass paths, session ids, or `$ARGUMENTS`.

## Report

Show the helper's stdout. It should cover:

- Node and host/OS versus the runtime baseline (Claude Code 2.1.252+, Node 22.19.0+, macOS or Linux)
- configuration file `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cross-model-advisor.json`
- presence of named key variables (names only, never values)
- configured providers: slot, upstream id, kind, availability, and a static error when unavailable
- bundle completeness (`control.mjs`, `worker.mjs`, `auth-control.mjs`) and IPC access

OAuth availability is offline credential status only. If a slot is unavailable, do not start login from this skill.

Do **not**:

- make a paid model request
- start a login flow, print a token, or install anything
- print API keys, tokens, or credential file contents
- enable advisors (`on`) or start a review
- run `status` or `off`

If the helper exits non-zero, show stderr and stop.
