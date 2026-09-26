# Review priorities for this repository

Two Claude Code plugins. **codex-pr-reviewer** checks out strangers' pull requests, so everything from a pull request is hostile. **cross-model-advisor** sends code to external models, so its config decides where code goes.

Must hold:

- **Nothing from a pull request runs outside the sandbox.** Hooks, filter and diff drivers, and symlinks stay neutralised for every git the script causes, including the one `gh` runs, and before the first file is written.
- **Excluded and git-ignored content never reaches a provider**, through tools, diffs, errors, or findings.
- **Secrets are names, never values**: not in config, logs, errors, findings, or skill output.
- **The gate fails open.** An error lets Claude stop, says the turn was not reviewed, and is recorded; it is never reported as a pass.
- **Settings are written only through the helper**: one change, previewed, confirmed, under the lock and revision check.

Releases: a change under `plugins/<name>/` bumps that plugin's version in its `plugin.json` and in `.claude-plugin/marketplace.json` (and the command stamps for codex-pr-reviewer), adds a changelog entry, and for cross-model-advisor rebuilds `dist/` from `src/`.

Tests: every fix ships a regression test that fails on the previous code. A test that would pass without the fix is a concern.

Skills are code: an instruction that the helper would refuse, or that needs a tool the skill does not pre-approve, is a bug.
