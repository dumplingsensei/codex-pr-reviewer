---
name: setup
description: Print the exact terminal command to open the cross-model-advisor settings menu. Never run the menu under Claude.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" menu-command)
---

Show the exact command the user must run **in their own terminal** to configure providers, models, reasoning effort, and advisor instructions. Never execute the interactive menu, start a TTY, or run `setup-control.mjs menu`.

This skill has no required arguments. Ignore `$ARGUMENTS`. Do not interpolate user text into the shell. Do not edit configuration from Claude.

## Command

Only this helper, with no extra flags, paths, session ids, or exported variables:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" menu-command
```

Show its stdout verbatim. It is one posix-quoted line, `CLAUDE_CONFIG_DIR=<abs> node <abs-setup-control.mjs> menu`, pinning the configuration directory the menu edits. The formatter does not read configuration or credentials.

Do not reconstruct the command, inspect environment variables, or tell the user to rely on `CLAUDE_PLUGIN_ROOT` in their terminal.

If the helper exits non-zero, show stderr and stop.

Tell the user to run the printed command in a real terminal. The menu cannot run inside Claude tools.

Reusing that printed command later does not require another slash turn. The menu edits saved settings only. The review gate reads them at every Stop, so a save applies from the next reviewed turn in every session.

## After printing

Setup does not activate automatically, collect key values, or start login.

- **OAuth.** Run `/cross-model-advisor:login` in Claude to choose a slot, then run its printed command in the user's own terminal, or use the menu's login handoff after the slot is saved.
- **New or changed API key-variable names**: in **their own terminal**, export each named variable (names only from the config), then start a **new Claude session**. Hooks inherit Claude's environment from when it started, so a running session cannot see a newly exported key.
- To start reviewing, run `/cross-model-advisor:on` in the Claude session.

## Do not

- run `setup-control.mjs menu` (or any interactive menu) via Bash or other tools
- run `catalog`, `models`, or `save`
- collect or print API keys, tokens, authorization codes, or credential files, and never run `export` or otherwise set those variables from Claude
- call provider APIs, refresh OAuth, or fetch remote model lists
- pick a default model id or edit configuration from Claude
- activate (`on`), disable (`off`), or run `doctor` / `status` / `login` / `logout`
- pass extra flags, paths, session ids, or embed `$ARGUMENTS` in a shell command
- reconstruct the printed command
