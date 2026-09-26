---
name: setup
description: Configure cross-model advisors and the review gate by answering questions in Claude Code, or print the terminal command for the full settings menu.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" summary), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" providers), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" guide add), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" models:*), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" efforts:*), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" apply:*), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" menu-command)
---

Change cross-model-advisor settings with the user through **AskUserQuestion**, one question per call, tersely: no tables or commentary beyond what a step asks for. The user chooses every value; every save is previewed and confirmed; never ask for, show, or export key values or tokens (variable **names** only). Put nothing in a command that did not come from the helper or the user's answers. Ignore `$ARGUMENTS`.

`H` below means `node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs"`. Run only the subcommands shown, written out in full. A question needs 2–4 options: for longer lists show 3 plus **More** per page, adding **Cancel** when a last page holds a single item; the user can always type Other.

1. `H summary`. Keep `revision`. Show one line per advisor (`name: model, effort, on/off, role or instructions`) and one for the gate. If `configError` is present, go to **Terminal menu**.
2. Ask: **Add an advisor** · **Change an advisor** · **Gate settings** · **Terminal menu**.
   - **Add an advisor**: run `H guide add` and follow the steps it prints.
   - **Change an advisor**: ask which, then **Effort** · **Model** · **Instructions** · **More** (Turn on/off, Remove). The change is `{"op":"update-advisor","name":…,"set":{…}}`:
     - Effort: `H efforts <provider> <kind> <model>` (provider and kind from the advisor's slot); offer its `choices`. `set: {"reasoningEffort":…}`.
     - Model: ask for a search word (Other; only `^[A-Za-z0-9._-]{1,40}$`), run `H models <provider> --q "<word>" --limit 3`, and offer only the returned ids plus **Search again**. Always `set: {"model":…,"reasoningEffort":…}` together, keeping the effort only if the new model's `choices` include it.
     - Instructions: `correctness` · `security` · `tests-and-claims` → `set: {"instructionsPreset":<role>}`, or Other → `set: {"instructions":<text>}`.
     - On/off: `set: {"enabled":true|false}`. Remove: `{"op":"remove-advisor","name":…}`.
   - **Gate settings**: **Mode** (block/report) · **Max rounds** (1–5) · **Auto-on projects** · **Skip patterns**. Auto-on: offer adding or removing this session's absolute git root; other absolute paths via Other. Skip: `*.md`, `docs/**`, or Other, never starting with `!`. The change is `{"op":"set-gate","gate":{…}}`; lists replace whole, and an empty list removes the setting.
   - **Terminal menu**: run `H menu-command`, show its output verbatim, and tell the user to run it in their own terminal (custom endpoints, anything else). Never run the menu.
3. Preview on one line of valid JSON:

   ```bash
   H apply --dry-run <<'JSON'
   {"revision":"<revision>","change":{…}}
   JSON
   ```

   On an error, show it and redo that step; `changed since summary` means start again at step 1. Otherwise ask one question whose text lists every `changes` line: **Save** · **Cancel**. On **Save**, run the same command without `--dry-run`; its `revision` replaces yours.
4. Then ask: **Add an advisor** · **Change an advisor** · **Gate settings** · **Done**, and continue as in step 2.

After a save: a new OAuth account needs `/cross-model-advisor:login`, then the printed command in the user's own terminal. A new API account needs the variable exported in the user's own terminal and a **new** Claude session. Settings apply from the next reviewed turn; `/cross-model-advisor:on` is not needed.

Do not run `save`, `catalog`, `menu`, `login`, or anything not listed; edit the settings file any other way; save without **Save**; invent model ids, efforts, slots, or paths; or set up `openai-compatible` endpoints here.
