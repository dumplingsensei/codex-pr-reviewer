---
name: setup
description: Configure cross-model advisors and the review gate by answering questions in Claude Code, or print the terminal command for the full settings menu.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" summary), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" models:*), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" efforts:*), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" apply:*), Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" menu-command)
---

Change the cross-model-advisor settings with the user, one change at a time, through **AskUserQuestion**. The settings file decides where code is sent, so: the user chooses every value; each save is previewed and confirmed first; key **values**, tokens, and codes are never asked for, shown, or exported (only environment-variable **names**). Ignore `$ARGUMENTS`, and never put text you did not get from the helpers or the user's answers into a command.

The helper is `node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs"`. It works offline and never reads credentials. Run only the subcommands below, exactly as written.

## 1. Read the settings

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" summary
```

Keep `revision`. Show the advisors in a short table (name, provider · model, effort, on/off, first words of instructions) and the gate (mode, max rounds, auto-on projects, skip patterns). If `configError` is set, say so and go to **Terminal menu**.

## 2. Ask what to change

AskUserQuestion, one question: **Add an advisor**, **Change an advisor**, **Gate settings**, **Terminal menu**. AskUserQuestion allows 2–4 options per question and up to 4 questions per call; the user can always type **Other**. When a list is longer than 4, show 3 plus **More**, and page.

### Add an advisor

1. **Account.** Offer the existing `slots` (as `slot — provider (kind)`) and **New account**. For a new account, offer providers from `providers` (by `name`; page as needed; `openai-compatible` is not listed — a custom endpoint means **Terminal menu**). If its `auth` has both `api` and `oauth`, ask which. For `api`, ask for the environment variable **name** that holds the key, offering its `suggestedApiKeyEnv`; accept only `^[A-Za-z_][A-Za-z0-9_]*$`, and if the answer looks like a key value instead of a name, discard it without repeating it and ask again. New slot id: `<provider>-api` or `<provider>-login`, with a numeric suffix if taken.
2. **Model.** Ask for a search word (Other; accept only `^[A-Za-z0-9._-]{1,40}$`, otherwise ask again), then run `node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" models <provider-id> --q "<word>" --limit 3` and offer the matching ids (plus **Search again**). Use only ids the helper returned.
3. **Effort and role**, in one AskUserQuestion call after the model is known:
   - Effort: run `node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" efforts <provider-id> <api|oauth> <model-id>` and offer its `choices` values (`default` first).
   - Role: offer the three `presets` (`correctness`, `security`, `tests-and-claims`), each described by its first sentence, or Other for custom instructions. Suggest a role no current advisor has.
4. **Name.** Default to the role name (`security`, …), made unique; must match `^[a-z][a-z0-9-]{0,63}$`.

Change: `{ "op": "add-advisor", "slot": { "id", "kind", "provider", "apiKeyEnv"? }, "advisor": { "name", "provider": <slot id>, "model", "reasoningEffort", "instructions" } }` — omit `slot` when using an existing one; `instructions` is the preset's full text or the user's own.

### Change an advisor

Pick the advisor, then what to change: **Model**, **Effort**, **Instructions**, **Turn on/off**, or **Remove**. Gather the value as in **Add**. Change: `{ "op": "update-advisor", "name", "set": { <one of model, reasoningEffort, instructions, enabled> } }`, or `{ "op": "remove-advisor", "name" }`. A model change keeps the effort only if `efforts` still lists it; otherwise ask again.

### Gate settings

Pick **Mode** (`block` / `report`), **Max rounds** (1–5), **Auto-on projects**, or **Skip patterns**. For auto-on, offer to add or remove this session's project root (the absolute git root of the working directory) and let the user type other absolute paths. For skip patterns, offer common ones (`*.md`, `docs/**`) or Other; never a pattern starting with `!`. Change: `{ "op": "set-gate", "gate": { <fields> } }`; lists are replaced whole, and an empty list removes the setting.

### Terminal menu

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" menu-command
```

Show its output verbatim and tell the user to run it in their own terminal (custom OpenAI-compatible endpoints, and anything this flow does not cover). Never run the menu itself.

## 3. Preview, confirm, save

Preview with the `revision` from step 1:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" apply --dry-run <<'JSON'
{"revision": "<revision>", "change": { … }}
JSON
```

Write the JSON on that one line (valid JSON: escape quotes and newlines in instructions), built only from helper output and the user's validated answers.

On an error, show it and go back to the step it names; `The configuration changed since summary` means start over at step 1. Otherwise show every line of `changes`, then AskUserQuestion: **Save** / **Cancel**. Only on **Save**, run the same command without `--dry-run`, with the same JSON. Report the saved `changes`, then offer another change (back to step 2) or **Done**.

## After saving

- New **OAuth** account: the user runs `/cross-model-advisor:login` and then the printed command in their own terminal; the advisor is unavailable until then.
- New **API** account: the user exports that variable in their own terminal and starts a **new** Claude session; hooks keep the environment Claude started with.
- Saved settings apply from the next reviewed turn in every session. The gate does not need `/cross-model-advisor:on` again.

## Do not

- ask for, print, store, or `export` key values, tokens, authorization codes, or credential files
- run `save`, `catalog`, `menu`, `login`, or any command not listed above; edit the settings file any other way; or save without the user choosing **Save**
- invent model ids, efforts, slots, or paths the helpers or the user did not give
- set up a custom endpoint (`openai-compatible`) here
