---
name: login
description: Choose a configured OAuth advisor slot and print the terminal command to log it in. Never run login under Claude.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/auth-control.mjs" list), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/auth-control.mjs" login-command *)
---

Show the exact command the user must run **in their own terminal** to log in an OAuth provider slot. Never execute the login command, start a browser, or run `auth-control.mjs login`.

The slot is the configured provider key from `cross-model-advisor.json` (for example `codex`), not a model id. API slots cannot be logged in.

## Explicit slot

Treat `$ARGUMENTS` as the requested slot, but never copy it into a shell command.

If it is exactly one identifier matching `^[a-z][a-z0-9-]{0,63}$`, skip listing and go to **Command** with that identifier.

If it is nonempty but not exactly one such identifier, ask for the configured slot and stop. Do not guess, and do not print a command with an unvalidated slot.

## Bare login

If `$ARGUMENTS` is empty, list configured slots. Do not read credential files, tokens, or environment values yourself.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/auth-control.mjs" list
```

The helper prints JSON `{ "slots": [{ "slot", "provider", "kind", "advisors": [{ "name", "model" }] }] }`. It does not read credentials or start OAuth.

If the helper exits non-zero, show stderr, tell the user to run `/cross-model-advisor:setup`, and stop.

Parse stdout as JSON. OAuth-selectable slots are those with `"kind": "oauth"`. API slots (`"kind": "api"`) cannot be logged in; do not offer them.

If there are no OAuth slots, tell the user to run `/cross-model-advisor:setup` and stop. Do not invent slots or print a login command.

If there is at least one OAuth slot, use **AskUserQuestion** so the user picks one. Do not auto-select.

- Option `label` is the slot id. Option `description` names the upstream provider and associated advisor names/models.
- AskUserQuestion requires 2–4 options. With exactly one OAuth slot, offer that slot and `Cancel`. With 2–4 slots, offer those slots. With more than 4, paginate: show up to 3 slots plus `More`; on the last page show the remaining slots (add `Cancel` if only one remains).
- Selecting `More` displays the next page. Otherwise the chosen value must be one listed OAuth slot id. A cancellation, missing answer, or unlisted value stops without printing a command.

Then go to **Command** with that validated slot id.

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
- run `logout`, `status`, `doctor`, `on`, `off`, or `setup`
- pass extra flags, paths, or session ids
- embed `$ARGUMENTS` in a shell command
- offer API slots or invent an OAuth slot that `list` did not return

If configuration is missing or no OAuth slot is available, direct the user to `/cross-model-advisor:setup` and stop.
