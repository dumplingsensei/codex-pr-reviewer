---
name: review
description: Review uncommitted changes, or everything since a git ref, with the configured cross-model advisors. Reports findings; never blocks Claude or edits code.
disable-model-invocation: true
argument-hint: "[base-ref]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs" review --plugin-data "${CLAUDE_PLUGIN_DATA}"), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs" review --plugin-data "${CLAUDE_PLUGIN_DATA}" --base:*)
---

Review with this session's configured advisors (`${CLAUDE_SESSION_ID}`), whether or not the gate is on.

## Run

Arguments: `$ARGUMENTS`

- **No arguments:** review uncommitted changes (HEAD against the working tree, untracked files included):

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs" review --plugin-data "${CLAUDE_PLUGIN_DATA}"
  ```

- **One git ref** (such as `main` or `origin/main`): review everything since HEAD's merge base with it, committed and uncommitted:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs" review --plugin-data "${CLAUDE_PLUGIN_DATA}" --base "<ref>"
  ```

  Put the ref inside the double quotes exactly as given. If the arguments are anything other than one ref (several words, spaces, or shell characters), run nothing and say the command takes one optional git ref.

Claude Code substitutes the plugin-data path; do not pass other paths or session ids. The scope's diff (minus excluded paths) goes to the configured external providers, and a review can take up to 270 seconds, so run it with a Bash timeout of 300000 ms.

## Report

If the result has `"ok": false`, report `error` and `message` and stop: `config` means the configuration is missing or invalid (point to `/cross-model-advisor:setup`); `git` or `base` means the scope could not be read. If it has a `note`, say it: nothing was sent to a model.

Otherwise show, without dropping fields:

- the `scope`, the `files` reviewed, `omitted` files (excluded, content withheld), and `unshown` files (past the diff size limit)
- each advisor's result or error
- every finding, most severe first, with its advisor, severity, note, and evidence

Findings are other AI models' unverified claims. Before calling one real, read the lines it cites and say for each whether it is confirmed, refuted, or unverified, and why. Do not edit code from this command; offer fixes and let the user decide.
