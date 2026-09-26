# cross-model-advisor

A review gate for Claude Code built from models of other families. When Claude
finishes a turn that changed files, the advisors you configure (OpenAI or
Codex, Gemini, xAI, OpenRouter, Kimi, Copilot, and others) review exactly what
git measured, inspect the surrounding code themselves, and either send Claude
back to address concerns or show their findings to you.

The idea of a second model from another family watching the work comes from
Oh My Pi's advisors. Claude Code's hooks cannot stream a turn to an outside
model or steer it mid-run, so this plugin reviews the finished turn instead.
It does not copy OMP's prompts or vendor its agent framework.

## Commands

| Command | What it does |
|---|---|
| `/cross-model-advisor:on` | Validate configuration and turn the gate on for this session. Reports the git project root, gate mode, each advisor's availability, and what is sent to external providers. Makes no model request. |
| `/cross-model-advisor:off` | Turn the gate off for this session, even where `gate.autoOn` would turn it on. The last review stays visible in `status`. |
| `/cross-model-advisor:review [base-ref]` | Review uncommitted changes, or everything since a ref's merge base, with the same advisors and rules as the gate. Reports findings; never blocks or edits. Works with the gate on or off. |
| `/cross-model-advisor:status` | Show whether the gate is on, the last review (outcome, round, every finding with evidence, each advisor's result), the last turn that was skipped and why, and per-advisor usage and errors. |
| `/cross-model-advisor:doctor` | Check the runtime, configuration, git, key-variable presence, advisor availability, and bundle. No model request, token refresh, or login. |
| `/cross-model-advisor:setup` | Add or change advisors and gate settings through Claude Code's question menu, previewing each change and saving only on your confirmation; or print the terminal command for the full menu. |
| `/cross-model-advisor:login [provider-slot]` | Choose a configured OAuth slot when no argument is supplied, or name one directly. Get its terminal login command; never paste tokens or callback URLs into Claude. |
| `/cross-model-advisor:logout <provider-slot>` | Remove that slot's local OAuth credential. This does not revoke the provider-side grant. |

The session commands run the plugin's helpers by full path. Claude Code
substitutes `${CLAUDE_PLUGIN_DATA}` into the skill text; it does not export it
to Bash commands, and another plugin may export its own, so the path is always
passed explicitly:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs" on --plugin-data "${CLAUDE_PLUGIN_DATA}"
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" off --plugin-data "${CLAUDE_PLUGIN_DATA}"
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" status --plugin-data "${CLAUDE_PLUGIN_DATA}"
node "${CLAUDE_PLUGIN_ROOT}/dist/gate.mjs" doctor --plugin-data "${CLAUDE_PLUGIN_DATA}"
```

Requires **Claude Code 2.1.252 or newer**, **Node 22.19.0 or newer**, and
**macOS or Linux**. Unsupported Node/host/OS is a `doctor` error; ordinary hooks
stay fail-open and do not start providers. Windows is not supported.

Install from the marketplace (user scope):

```
/plugin marketplace add dumplingsensei/codex-pr-reviewer
/plugin install cross-model-advisor@dumplingsensei-plugins
```

The installed plugin is already bundled. There is no `npm install`, build, or
network bootstrap at install time. From a local checkout,
`claude --plugin-dir ./plugins/cross-model-advisor` loads it without the cache.

## How the gate works

1. **When you submit a prompt**, a lightweight hook records a git snapshot of
   the whole working tree: a tree object of tracked and untracked files, with
   `.gitignore` honoured, written through a private temporary index. Your
   index, branch, HEAD, and stash are never touched; no model or SDK is used.
   A message sent before the turn ends joins it, keeping the first snapshot.
2. **When Claude finishes the turn**, the Stop hook snapshots again. If nothing
   changed, or this exact change was already reviewed, Claude stops as usual.
   Plugin commands like this page's are never reviewed, and subagents are not
   reviewed separately.
3. **The review.** Every enabled advisor, in parallel, receives your request,
   Claude's final message (as a claim to check, not evidence), and the diff
   between the two snapshots, minus excluded paths. Committing during the turn
   does not change what is measured, and your earlier uncommitted work is not
   part of it. Advisors may read, list, and search that snapshot, and report up
   to five findings each, every one backed by evidence: a line they actually
   read, or the request, final message, or a file's diff.
4. **The outcome.**
   - `gate.mode: "block"` (default): any `concern` or `blocker` sends Claude
     back with the findings (you see them too), labelled as unverified claims
     from other models that it should check, fix, or rebut. Claude keeps
     working, and the next Stop reviews the whole turn again with the earlier
     findings attached. After `gate.maxRounds` rounds (default 2), Claude may
     stop and you are told so. A rebuttal without further edits is accepted.
   - Only `nit`s, or `gate.mode: "report"`: Claude stops, and the findings are
     shown to you.
   - Nothing found: Claude stops, and you are told which advisors found nothing.
5. **Failures fail open.** A timeout, provider error, failed login, or no usable
   advisor lets Claude stop, tells you what was not reviewed and why, and records
   the error for `status`. A failed review is never reported as a pass.

You wait for the review: a turn that changed files ends 10 to 120 seconds later
than it otherwise would, and sometimes with another round of fixes. A turn that
changed nothing costs nothing.

The project must be a git work tree. The gate needs git to measure what
changed, so `on` refuses a project outside one. Snapshots of untracked files
are ordinary loose objects in your repository's object store, which
`git gc` collects.

## Configuration

`/cross-model-advisor:setup` asks in Claude Code, previews, and saves only on
your confirmation; for custom endpoints it prints a command for **your own terminal**:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/setup-control.mjs" menu-command
```

Run its output in a real TTY. It is one line that pins the configuration
directory the menu edits:

```sh
CLAUDE_CONFIG_DIR="/home/you/.claude" node "/absolute/path/to/cross-model-advisor/dist/setup-control.mjs" menu
```

The menu edits saved settings only. The gate reads them at every Stop, so a
save applies from the next reviewed turn in every session.

### Settings menu

Navigation, search, editing, and local session controls run in Node. The menu
does not call Claude or an advisor model, fetch remote catalogs, or probe
account entitlement. Models come from the pinned SDK's offline catalog.
Compatible endpoints still require explicit URL and model metadata.

- **Add advisor.** Each advisor has a unique name, a provider slot, a model
  id, literal instructions, `enabled`, and `reasoningEffort`. Removal is
  explicit and confirmed. Removing an advisor does not delete its provider
  slot or OAuth credentials. Removing a shared slot requires resolving every
  advisor that still names it.
- **Provider accounts.** Select one or more upstream providers, then only the
  required per-slot auth and model fields. Reusing a slot keeps its identity;
  another account is a separate explicit slot. Dual-auth providers choose API
  versus OAuth. API configuration collects variable **names**, never key values.
- **Models.** Searchable by id and display name. Do not invent ids. For an
  existing compatible slot, offer only that slot's configured models; for a
  new compatible endpoint, collect required metadata.
- **Reasoning effort.** Per advisor, not per credential slot. Two advisors can
  share a model and account with different efforts. Picker labels come from
  the offline chooser (Default, Off, and aliases such as
  `Minimal — sent as Low`). See [Reasoning effort](#reasoning-effort).
- **Instructions.** Bounded multiline editor, stored literally. Not a shell
  command, template, or generated prompt.
- **Enabled versus unavailable.** Disable an advisor without removing it.
  Disabled advisors stay editable. Enabled-but-unavailable (missing login,
  missing key variable, unsupported effort or model) is a distinct visible
  state.
- **Empty configuration.** Version 2 allows empty `providers` and `advisors`
  while references stay valid. Empty or all-disabled setups start no reviews.
- **Unrelated settings.** Existing slots, credentials, `exclude`, and `limits`
  stay unchanged unless an action explicitly changes them. Logout is a
  separate credential command.

Home actions are **Add advisor**, **Provider accounts**, **Gate settings**, **Save**, and **Quit**.
Leaving a dirty menu offers **Discard** or **Return**. No file write occurs
until **Save**. A revision conflict keeps the
draft for inspection and refuses overwrite: reload or discard, not merge or
force-save. An interrupted save may leave `cross-model-advisor.json.lock` in
the Claude config directory. Remove that directory only after verifying no
setup save is running; setup never steals an existing lock.

The offline helper still exposes `setup-control.mjs catalog`,
`setup-control.mjs models <provider-id> [--q QUERY] [--offset N] [--limit N]`,
and `setup-control.mjs save` with stdin `{ "revision": "...", "config": { ... } }`
for non-menu use. Use the catalog's revision (`null` for a missing file);
never submit key values.

### Keys and logins

**New or changed API key-variable names** must be exported in your own
terminal before you start Claude. Hooks inherit Claude's environment from when
it started, so a running session cannot see a newly exported key; start a new
session.

**OAuth.** Model-only edits reuse the existing slot credential. Changing a
slot's upstream provider does not transfer the grant. The menu's explicit
login suspends and fully releases the terminal to the existing auth helper,
then restores the menu. Save a new or changed slot before login. Discarding
later UI edits does not undo a completed login or logout. Codes and tokens
never appear in Claude, the launcher, or config output.

### Schema

One trusted user file:

`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cross-model-advisor.json`

Schema version is `2`. Version-1 files open without being rewritten. The first
explicit Save publishes version 2, with `enabled` and `reasoningEffort` on
every advisor (version-1 input normalizes to enabled and `default`). An older
plugin cannot read version 2. Unknown keys and malformed entries are rejected
before any review. There is no silent default provider or model, and the
plugin never uses Claude's current credentials. The gate reads the file at
every Stop, so edits apply from the next reviewed turn.

`USER_SELECTED_MODEL` below is documentation notation, not a shipped runnable
default. Choose real model IDs. An example and schema also ship under
`plugins/cross-model-advisor/config/`.

```json
{
  "version": 2,
  "providers": {
    "openai-api": {
      "kind": "api", "provider": "openai", "apiKeyEnv": "OPENAI_API_KEY"
    },
    "codex-login": { "kind": "oauth", "provider": "openai-codex" },
    "gemini-api": { "kind": "api", "provider": "google", "apiKeyEnv": "GEMINI_API_KEY" }
  },
  "advisors": [
    {
      "name": "correctness", "provider": "openai-api", "model": "USER_SELECTED_MODEL",
      "instructions": "Look for observable correctness failures and missed edge cases.",
      "enabled": true,
      "reasoningEffort": "default"
    },
    {
      "name": "architecture", "provider": "codex-login", "model": "USER_SELECTED_MODEL",
      "instructions": "Look for avoidable complexity and violations of existing project conventions.",
      "enabled": true,
      "reasoningEffort": "default"
    }
  ],
  "exclude": [],
  "limits": {
    "maxConcurrentAdvisors": 2,
    "reviewTimeoutSeconds": 90,
    "maxToolCallsPerReview": 8,
    "maxOutputTokens": 1500,
    "maxReviewsPerAdvisorPerSession": 40
  },
  "gate": { "mode": "block", "maxRounds": 2 }
}
```

`gate.mode` is `block` or `report`; `gate.maxRounds` (1 to 5) bounds how many
times one prompt can be sent back. `limits.reviewTimeoutSeconds` (at most 240)
is each advisor's deadline; all advisors share 270 of the hook's 300 seconds.
`gate.autoOn` lists absolute project roots where the gate turns on at session
start (`off` still wins); `gate.skipWhenOnly` (gitignore patterns, e.g. `*.md`)
skips turns whose changed files all match. Only this file can set either.

### Reasoning effort

`advisors[].reasoningEffort` is one of `default`, `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, or `max`. The picker is offline and model-specific.

- **Default** leaves the previous provider request unchanged. It does not mean
  reasoning is disabled.
- **Off** is offered only when that model and transport can actually disable
  thinking. Mandatory-thinking models omit it. Some catalog entries that list
  Off are still excluded when the adapter would not disable (for example
  Copilot Chat Completions that never send a thinking field, and Gemini 2.5
  Pro).
- Native aliases are labelled as such (`Minimal — sent as Low`), not as a
  second native level.
- Enable-only formats (ZAI by default, and other transports with
  `supportsReasoningEffort` false) send thinking enabled or disabled and do
  not emit `reasoning_effort`.
- Non-reasoning models, and compatible endpoints without paired thinking
  metadata, are not configurable: Default only.
- Switching provider or model keeps the saved effort only if it is still
  supported. Otherwise choose a supported value or Default before Save. There
  is no silent clamp, drop, or upgrade.
- Thinking budgets cannot raise `limits.maxOutputTokens`. An effort whose
  budget would not leave answer space fails instead of expanding the
  configured limit. Other SDK adapters that do honor an output ceiling still
  cannot grow it to fit thinking.
- The Codex adapter does not forward a hard remote output-token ceiling. That
  is an existing transport limitation; there is no setting that adds one.

Reasoning text is not shown in the menu, status, or logs as a consequence of
this setting.

All model calls are direct SDK requests. No installed Codex, Gemini, or other
advisor executable is required or launched.

| Service | Provider ID | Authentication |
|---|---|---|
| OpenAI API | `openai` | API key |
| OpenAI Codex subscription | `openai-codex` | OAuth |
| Anthropic | `anthropic` | API key |
| Gemini API | `google` | API key |
| GitHub Copilot | `github-copilot` | OAuth |
| ZAI Coding API | `zai` | API key |
| xAI | `xai` | API key or OAuth |
| Moonshot / Kimi API | `moonshotai` | API key |
| Kimi Coding | `kimi-coding` | API key or OAuth |
| OpenRouter | `openrouter` | API key |
| OpenAI-compatible endpoint | `openai-compatible` | API key |

**API keys** (`kind: "api"`): every entry requires `apiKeyEnv` as the *name* of
an environment variable, never the key value. `openai-compatible` also requires
`baseUrl` (HTTPS except explicit localhost/loopback) and per-model metadata:
`contextWindow`, `maxTokens`, `reasoning`, `input`, and optional `pricing`.
Tunable reasoning on a compatible model additionally requires paired
`thinkingFormat` (`openai`, `openrouter`, or `zai`) and a complete
`thinkingLevelMap` covering `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, and `max`. Optional `supportsReasoningEffort` is valid only with that
pair (`true`: send native `reasoning_effort`; `false`: enable-only and must
not emit `reasoning_effort`). Omitted is not filled on disk; the resolver
defaults openai/openrouter to true and zai to false. `reasoning: true` alone
is not tunable. Wire protocol is OpenAI Chat Completions.

The pinned `zai` adapter targets `https://api.z.ai/api/coding/paas/v4`.
For a different ZAI API endpoint or regional service, configure an explicit
`openai-compatible` provider with its own endpoint and model metadata; no
subscription, endpoint, or regional fallback is inferred.

**OAuth** (`kind: "oauth"`): each entry selects a supported provider, without
`apiKeyEnv`. The configured slot (`codex-login` above) owns its credential and is
bound to the upstream provider ID. Two slots can use separate accounts. Changing
a slot's upstream provider does not reuse its previous token.

Run the login command in your own terminal using the installed plugin path
reported by `/cross-model-advisor:login codex-login`:

```sh
node "/absolute/path/to/cross-model-advisor/dist/auth-control.mjs" login codex-login
node "/absolute/path/to/cross-model-advisor/dist/auth-control.mjs" status codex-login
node "/absolute/path/to/cross-model-advisor/dist/auth-control.mjs" logout codex-login
```

Use the same `CLAUDE_CONFIG_DIR` as Claude Code. Browser login opens the default
browser (`open` on macOS, `xdg-open` on Linux), with a printed URL as fallback.
Headless device-code login keeps manual browser instructions. Successful login
releases terminal input and returns to the shell. Login is never started by hooks,
`on`, `doctor`, or catalog navigation. The settings menu may hand off to this
same helper after an explicit login action, then reacquire the terminal. After
login, the advisor is available from the next reviewed turn.
Missing, expired, revoked, or insufficiently entitled credentials never cause
fallback to an API key, another account, or another provider. `doctor` checks
local credential availability, not remote account validity. Token refresh happens
only when a requested review needs it. Subscription usage is not priced as an
ordinary API bill.

Provider subscriptions and available models are not interchangeable. OAuth
support uses the pinned SDK's provider-specific flows, not a claim of vendor
endorsement or universal entitlement. Your account and organization must permit
the selected integration.

Copilot login in the pinned SDK may enable unconfigured models on your personal
account. The terminal helper discloses this and requires explicit consent before
starting that login. Refresh does not enable models; account/organization model
restrictions still apply.

**Not offered:** Claude.ai subscription OAuth and Antigravity OAuth.
[Anthropic prohibits third-party Claude.ai login](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).
[Google prohibits third-party Antigravity OAuth access](https://antigravity.google/terms/);
its [FAQ recommends Gemini API credentials for third-party agents](https://antigravity.google/docs/faq/#why-cant-i-use-third-party-software-eg-claude-code-openclaw-opencode-with-my-antigravity-login).
The `google` provider is the Gemini API, not access to an Antigravity subscription.

Old `kind: "cli"` entries are rejected. Replace them with an explicitly selected
API/OAuth provider and log in separately; existing CLI credentials are not imported.

Advisor names are unique identifiers matching `^[a-z][a-z0-9-]{0,63}$`.
Instructions are literal strings, not commands, appended to the reviewer
prompt. Only advisors configured `enabled: true` that validate offline review a
turn; `on` names every unavailable one, and if none are usable the gate stays
off. No silent provider substitution.

Optional project files, neither of which can select providers, endpoints,
credentials, binaries, budgets, or auto-enable the plugin:

- `WATCHDOG.md` — review priorities, at most 8 KiB, treated as untrusted data.
- `.cross-model-advisorignore` — additional excluded paths. Negation is
  rejected; these entries may only narrow access.

`on` freezes the session's project root: the git top level containing
`CLAUDE_PROJECT_DIR`, or the command's working directory. `/`, the home
directory, and a missing root are refused. The gate snapshots that root at
every turn regardless of where Claude later `cd`s.

## Security and disclosure

For every reviewed turn, your request, Claude's final message, the diff, and
source the advisor tools read are sent to the **external providers you
configured**. That is intentional. Exclusions prevent
tool access to credential files (`.env*`, `*.pem`, `*.key`, `*.p12`, `.npmrc`,
`.netrc`, `.envrc`, SSH keys, `.ssh`, `.aws`), `.git`, `.claude`, `.codex`,
`.gemini`, `node_modules`, plugin state, anything git ignores (including
`.git/info/exclude`), `.cross-model-advisorignore`, and user exclusions.
The same exclusions filter the diff: an excluded file that changed is named,
but its content is never sent. They do not promise to strip secrets from prose
you put in a prompt or from an allowed source file.

**Direct-provider trust boundary.** The hook helpers and bundled SDK are trusted local
code under the same OS user. Model-visible investigation is limited to the host
tools; there is no native advisor shell, filesystem tool, or MCP bridge.
Provider model/auth endpoints are the intentional network destinations.

**Credentials.** API keys stay in named environment variables. OAuth tokens are
stored under the Claude configuration directory (normally outside the project):
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cross-model-advisor/credentials`, in private
`0600` files within `0700` directories. This is a permission-protected local token
store, not encryption or an OS sandbox against other processes under your user.
Writes are atomic and refresh/logout is serialized across processes. Locks are
never stolen automatically: a crashed operation can leave `<slot>.lock` in the
credential directory. If the helper reports a stale lock, verify that no auth
operation for that slot is running before manually removing that lock directory,
then retry. Do not remove the credential JSON file to repair a lock.
The plugin does not read credentials from OMP, Claude Code, Codex, Gemini, or
ambient SDK credential stores. Tokens are never part of a review, a finding, or
session state.

Provider conversations are memory-only and last one review. The last review's
findings and session metadata have seven-day local retention. There are no native advisor CLI
recordings. External providers apply their own retention and account policies.

## Reporting a security problem

This plugin sends each reviewed turn's diff and selected project files to external
providers you configure and stores OAuth credentials under your OS user, so it
has a threat model worth reading:
[SECURITY.md](https://github.com/dumplingsensei/codex-pr-reviewer/blob/main/SECURITY.md).
It says what is in scope, what is known and deliberately accepted, and how to
report privately — through
[GitHub's private vulnerability reporting](https://github.com/dumplingsensei/codex-pr-reviewer/security/advisories/new),
not a public issue.

Full marketplace listing, runtime notes, and the sibling `codex-pr-reviewer`
plugin live in the
[repository README](https://github.com/dumplingsensei/codex-pr-reviewer#readme).
