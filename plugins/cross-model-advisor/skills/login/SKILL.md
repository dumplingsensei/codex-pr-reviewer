---
name: login
description: Choose a configured OAuth advisor slot and print the terminal command to log it in. Never run login under Claude.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/auth-control.mjs" list), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/auth-control.mjs" login-command *)
---

Print the command the user runs **in their own terminal** to log in one OAuth slot: a provider key in `cross-model-advisor.json` such as `codex`, not a model id. Never run the login, start a browser or device-code flow, or read credentials, tokens, or environment values. Be terse.

1. **Slot.** If `$ARGUMENTS` is exactly one identifier matching `^[a-z][a-z0-9-]{0,63}$`, use it. If it is anything else nonempty, ask for the slot name and stop. If it is empty, run `node "${CLAUDE_PLUGIN_ROOT}/dist/auth-control.mjs" list`; on failure show stderr, point to `/cross-model-advisor:setup`, and stop. Offer only slots with `"kind": "oauth"` through AskUserQuestion (label: the slot; description: its provider and advisors). With one slot, offer it and **Cancel**; with more than 4, show 3 plus **More** and page. No OAuth slot, a cancellation, or an unlisted answer ends here (with no OAuth slot, point to `/cross-model-advisor:setup`).
2. **Command.** Run `node "${CLAUDE_PLUGIN_ROOT}/dist/auth-control.mjs" login-command "<slot>"` with that validated slot, show its stdout verbatim without rebuilding it, and tell the user to run it in a real terminal to finish the browser or device-code step. On failure, show stderr and stop.

Do not run `login`, `logout`, `status`, `doctor`, `on`, `off`, or `setup`; pass other flags, paths, or session ids; put `$ARGUMENTS` in a command unvalidated; offer API slots or slots `list` did not return; or print keys, tokens, or codes.
