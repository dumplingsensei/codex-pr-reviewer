# Add an advisor

Continue the setup skill (`H`, one question per call, terse). Then preview and save as in its step 3.

1. **Account.** Offer the existing slots (`slot — provider (kind)`) and **New account**. For a new account run `H providers` and offer them by `name`; a custom endpoint means the **Terminal menu**. If `auth` has both `api` and `oauth`, ask which. For `api`, ask for the environment-variable **name** that holds the key, offering its `env`; accept only `^[A-Za-z_][A-Za-z0-9_]*$`, and if an answer looks like a key value instead of a name, discard it without repeating it and ask again. The slot id is `<provider>-api` or `<provider>-login`, with a number added if taken.
2. **Model.** Ask for a search word (Other; accept only `^[A-Za-z0-9._-]{1,40}$`), run `H models <provider> --q "<word>" --limit 3`, and offer the returned ids plus **Search again**. Use only returned ids.
3. **Effort and role**, in one AskUserQuestion call: effort from `H efforts <provider> <kind> <model>` (`default` first); role `correctness` · `security` · `tests-and-claims`, or Other for the user's own instructions. Suggest a role no current advisor has.
4. **Name.** The role name, made unique; `^[a-z][a-z0-9-]{0,63}$`.

The change is:

```json
{"op":"add-advisor","slot":{"id":…,"kind":…,"provider":…,"apiKeyEnv":…},"advisor":{"name":…,"provider":<slot id>,"model":…,"reasoningEffort":…,"instructionsPreset":<role>}}
```

Omit `slot` when using an existing one, and `apiKeyEnv` for OAuth. For the user's own text, send `"instructions":<text>` instead of `instructionsPreset`.
