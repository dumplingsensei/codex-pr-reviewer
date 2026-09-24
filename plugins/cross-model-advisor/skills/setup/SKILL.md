---
name: setup
description: Print the exact terminal command to open the cross-model-advisor settings menu. Never run the menu under Claude.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" menu-command --plugin-data "${CLAUDE_PLUGIN_DATA}")
---

Show the exact command the user must run **in their own terminal** to configure providers, models, reasoning effort, and advisor instructions. Never execute the interactive menu, start a TTY, or run `setup-control.mjs menu`.

This skill has no required arguments. Ignore `$ARGUMENTS`. Do not interpolate user text into the shell. Do not edit configuration from Claude.

## Command

Only this helper, exactly as written (Claude Code substitutes the plugin-data path), with no other flags, paths, session ids, or exported identity variables:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" menu-command --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

Show its stdout verbatim. It is one posix-quoted line with no extra flags:
`CLAUDE_CONFIG_DIR=<abs> CLAUDE_CODE_SESSION_ID=<id-or-empty> CLAUDE_PLUGIN_DATA=<abs-or-empty> CLAUDE_SESSION_ID='' CLAUDE_PROJECT_DIR='' node <abs-setup-control.mjs> menu`.
`CLAUDE_CONFIG_DIR` is always pinned. `CLAUDE_SESSION_ID` and `CLAUDE_PROJECT_DIR`
are always empty so a leftover shell cannot retarget Apply. The
`CLAUDE_CODE_SESSION_ID` / `CLAUDE_PLUGIN_DATA` pair is set only when this
skill's environment has a validated session id (`^[A-Za-z0-9._-]{1,128}$`) and
an absolute plugin-data path; otherwise those two are empty as well. The
formatter does not read configuration, credentials, or the private IPC capability.

Do not reconstruct the command, inspect environment variables, or tell the user to rely on `CLAUDE_PLUGIN_ROOT` in their terminal.

If the helper exits non-zero, show stderr and stop.

Tell the user to run the printed command in a real terminal. The menu cannot run inside Claude tools.

Reusing that printed command later does not require another slash turn. A command captured from this skill keeps the same session target. Empty `CLAUDE_SESSION_ID` and `CLAUDE_PROJECT_DIR` on that line prevent a leftover shell from retargeting Apply. With empty `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PLUGIN_DATA`, the menu is a defaults editor only: it does not infer a session from the working directory, a transcript, or directory timestamps.

## After printing

Setup does not activate automatically, collect key values, or start login.

- **OAuth.** Run `/cross-model-advisor:login` in Claude to choose a slot, then run its printed command in the user's own terminal, or use the menu's explicit login handoff after the slot is saved. After authorization, `/cross-model-advisor:on` or the menu's **Enable** (shown only when the live session is off) can enable advisors in **this** session when the worker already has the needed environment.
- **New or changed API key-variable names** (new API provider, new compatible endpoint, or a different `apiKeyEnv`): in **their own terminal**, export each named variable (names only from the config). Then start a **new Claude session** and run `/cross-model-advisor:on` there, or reopen the menu from that new session to **Save & Apply**. Restart even if those variables were already exported: a worker started by earlier hooks in this session may have an allowlist that omits the new names.
- If both OAuth and API changed: login in the terminal, export named keys in the terminal, then a new Claude session before `/on` or **Save & Apply**.

## Do not

- run `setup-control.mjs menu` (or any interactive menu) via Bash or other tools
- run `catalog`, `models`, or `save`
- collect or print API keys, tokens, authorization codes, or credential files, and never run `export` or otherwise set those variables from Claude
- call provider APIs, refresh OAuth, or fetch remote model lists
- pick a default model id or edit configuration from Claude
- activate (`on`), disable (`off`), or run `doctor` / `status` / `login` / `logout`
- pass other flags, paths, session ids, or embed `$ARGUMENTS` in a shell command
- reconstruct the printed command
