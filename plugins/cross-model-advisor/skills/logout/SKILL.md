---
name: logout
description: Log out a configured OAuth advisor slot without printing secrets.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/auth-control.mjs" logout *)
---

Log out **one configured OAuth slot** for this plugin. The slot is the provider key from `cross-model-advisor.json`.

This helper deletes stored OAuth credentials for that slot. It does not call a model.

## Slot

Treat `$ARGUMENTS` as the requested slot, but never copy it into a shell command. It must be exactly one identifier matching `^[a-z][a-z0-9-]{0,63}$`. If it is empty, contains extra text, or does not match, ask for the configured slot and stop. Do not guess.

## Run

After validation, run the helper with the validated identifier in place of the quoted `SLOT` placeholder. Do not append extra flags, paths, or session ids. Do not export extra environment.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/auth-control.mjs" logout "SLOT"
```

## Report

Show the helper's stdout. It should confirm the slot was logged out.

Do **not**:

- print API keys, tokens, authorization codes, or credential file contents
- run `login` (login is terminal-only)
- run `on`, `off`, `status`, or `doctor`
- start a review or inspect the project
- embed `$ARGUMENTS` in a shell command

If the helper exits non-zero, show stderr and stop.
