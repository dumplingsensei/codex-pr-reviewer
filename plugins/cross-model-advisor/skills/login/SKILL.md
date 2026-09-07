---
name: login
description: Print the terminal command to log an OAuth advisor slot in. Never run login under Claude.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/auth-control.mjs" login-command *)
---

Show the exact command the user must run **in their own terminal** to log in an OAuth provider slot. Only run the noninteractive `login-command` formatter below: it reads no configuration or credentials and cannot start OAuth. Never execute the login command it prints.

The slot is the configured provider key from `cross-model-advisor.json` (for example `codex`), not a model id.

## Slot

Treat `$ARGUMENTS` as the requested slot, but never copy it into a shell command. It must be exactly one identifier matching `^[a-z][a-z0-9-]{0,63}$`. If it is empty, contains extra text, or does not match, ask for the configured slot and stop. Do not guess.

## Command

After validation, run this formatter with the validated identifier in place of the quoted `SLOT` placeholder:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/auth-control.mjs" login-command "SLOT"
```

Show its stdout verbatim. The formatter resolves and shell-quotes the installed helper and Claude configuration paths; do not reconstruct the command, inspect environment variables, or tell the user to rely on `CLAUDE_PLUGIN_ROOT` in their terminal.

If the formatter exits non-zero, report stderr and stop.

Tell the user to run the printed command in a real terminal so they can complete browser or device-code prompts. Login cannot run inside Claude tools.

## Do not

- run `auth-control.mjs login` (or any login helper) via Bash or other tools
- start a browser, device-code, or callback flow
- read credential files, tokens, or environment values
- print API keys, access tokens, refresh tokens, or authorization codes
- run `logout`, `status`, `doctor`, `on`, or `off`
- pass extra flags, paths, or session ids
- embed `$ARGUMENTS` in a shell command

If the slot is missing or invalid, ask for the configured slot name and stop. Do not print a command with an unvalidated slot.
