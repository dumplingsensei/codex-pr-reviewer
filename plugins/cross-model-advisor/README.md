# cross-model-advisor

Independent advisors observe the current Claude Code session, inspect the
project themselves, and send concise findings back while Claude is working.
This is not a pull-request reviewer and not a Stop-hook completion gate.

The design is inspired by Oh My Pi's advisors. It does not copy OMP's prompt
corpus or vendor its agent framework.

## Commands

| Command | What it does |
|---|---|
| `/cross-model-advisor:on` | Validate configuration and enable configured advisors for this session. Reports provider/model names, project root, limits, and external-provider disclosure. Does not call an advisor model just to run the command. |
| `/cross-model-advisor:off` | Cancel running reviews, stop future reviews, and discard pending injection candidates. Accepted findings stay in the local inbox. |
| `/cross-model-advisor:status` | Show enabled/paused/busy state per advisor, pending/emitted findings, usage when reported, and sanitized last errors. This is the human-visible inbox. |
| `/cross-model-advisor:doctor` | Check runtime versions, configuration, key-variable presence, stored OAuth availability, bundle completeness, and IPC access. No model request, token refresh, login flow, installation, or key printing. |
| `/cross-model-advisor:setup` | Choose one or more providers, supported authentication methods, models, and advisor instructions. Preview and confirm before saving configuration. |
| `/cross-model-advisor:login [provider-slot]` | Choose a configured OAuth slot when no argument is supplied, or name one directly. Get its terminal login command; never paste tokens or callback URLs into Claude. |
| `/cross-model-advisor:logout <provider-slot>` | Remove that configured provider slot's local OAuth credential. This does not revoke the provider-side grant or cancel an already authorized request. |

The four session commands run this plugin's control helper by full path:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" on
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" off
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" status
node "${CLAUDE_PLUGIN_ROOT}/dist/control.mjs" doctor
```

Doctor checks the four required executables in the plugin's `dist/`, using
`CLAUDE_PLUGIN_ROOT` when supplied or the executing worker's location otherwise.
This is independent of the project directory and Git tracking. Missing entries
make both `bundle.ok` and the overall `ok` false. Restart Claude after updating
the plugin so an already-running worker loads the new code.

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

## Configuration

Run `/cross-model-advisor:setup` to configure advisors through Claude's question
UI instead of hand-editing JSON. Provider selection supports multiple services;
large provider/model lists are paginated. Models come from the pinned SDK's
offline catalog, not a remote entitlement check. Compatible endpoints require
explicit endpoint and model metadata.

Setup keeps existing slots, advisors, exclusions, and limits unless you
explicitly replace or remove them. It previews the complete configuration,
requires save confirmation, writes a private `0600` file atomically, and rejects
stale revisions rather than overwriting a detected intervening edit. No API key
values or OAuth credentials are collected, and no advisors activate automatically.

For OAuth, run `/cross-model-advisor:login` in Claude to select a configured slot,
then run the printed login command in your own terminal. For new API slots or
changed key-variable names, export the named keys in your terminal and start a
**new Claude session** before `/cross-model-advisor:on`. This is required even
when the variables were already exported: an existing worker may have started
before those names were configured. OAuth-only changes can use `on` in the
current session after authorization.

The offline helper also exposes `setup-control.mjs catalog`,
`setup-control.mjs models <provider-id> [--q QUERY] [--offset N] [--limit N]`,
and `setup-control.mjs save` with stdin `{ "revision": "...", "config": { ... } }`.
Use the catalog's revision (`null` for a missing file); never submit key values.
An interrupted save may leave `cross-model-advisor.json.lock` in the Claude
config directory. Remove that directory only after verifying no setup save is
running; setup never steals an existing lock.

One trusted user file:

`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cross-model-advisor.json`

Schema version is `1`. Unknown keys and malformed entries are rejected before
enable. There is no silent default provider or model, and the plugin never uses
Claude's current credentials. `/cross-model-advisor:on` snapshots the file;
edits take effect on the next explicit `on`.

`USER_SELECTED_MODEL` below is documentation notation, not a shipped runnable
default. Choose real model IDs. An example and schema also ship under
`plugins/cross-model-advisor/config/`.

```json
{
  "version": 1,
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
      "instructions": "Look for observable correctness failures and missed edge cases."
    },
    {
      "name": "architecture", "provider": "codex-login", "model": "USER_SELECTED_MODEL",
      "instructions": "Look for avoidable complexity and violations of existing project conventions."
    }
  ],
  "exclude": [],
  "limits": {
    "maxConcurrentAdvisors": 2,
    "reviewTimeoutSeconds": 90,
    "maxToolCallsPerReview": 8,
    "maxOutputTokens": 1500,
    "maxReviewsPerAdvisorPerSession": 40
  }
}
```

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
`contextWindow`, `maxTokens`, `reasoning`, `input`, and optional `pricing`. Its
wire protocol is OpenAI Chat Completions.

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
`on`, or `doctor`. After login, run `on` to enable an unavailable advisor.
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
Instructions are literal strings, not commands. Activation enables only
successfully validated advisors and names every unavailable advisor; if none are
usable, the session stays disabled. No silent provider substitution.

Optional project files, neither of which can select providers, endpoints,
credentials, binaries, budgets, or auto-enable the plugin:

- `WATCHDOG.md` — review priorities, at most 8 KiB, treated as untrusted data.
- `.cross-model-advisorignore` — additional excluded paths. Negation is
  rejected; these entries may only narrow access.

The session root is recovered from stored state; for a new session it comes from
`CLAUDE_PROJECT_DIR`, the hook's `cwd`, or a command's initial working directory.
Activation freezes its canonical path. `/`, the home directory, and a missing
root are refused. A later cwd/worktree move outside
that root pauses observation until `off` and a new session rooted there.

## How advice is delivered

Advisors investigate with four read-only tools (`read`, `list`, `search`,
`advise`). They do not get a shell, writes, network fetch, or Claude's hidden
reasoning. Hook payloads are the live authority; visible transcript text is
supplementary.

Findings are injected only at `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
and `PostToolUseFailure`, as `additionalContext`. The plugin never returns a
permission decision, `continue: false`, Stop output, or any wake mechanism.

**No-wake.** A stopped session is never restarted. Advice that finishes after
the last tool boundary is kept for the next real user prompt or tool event. Stop
always prints nothing.

**Best-effort receipt.** The host has no receipt protocol. `status` "emitted"
means the helper locally wrote the envelope and acknowledged it — not that
Claude confirmed seeing it. A crash before stdout can redeliver; an
acknowledgement followed by a host timeout can drop the injection entirely
while the durable inbox still holds the finding. This is not exactly-once or
at-least-once delivery.

`blocker` is a label, not authority to block Claude. The primary session remains
responsible for validating advice.

## Security and disclosure

Prompt text, observations, and source the advisor tools read are sent to the
**external provider you configured**. That is intentional. Exclusions prevent
tool access to designated files (`.git`, `.env` / `.env.*`, `*.pem`, `*.key`,
`.claude`, `.codex`, `.gemini`, `node_modules`, and plugin state), plus paths
matched by `.gitignore`, `.cross-model-advisorignore`, or user exclusions.
They do not promise to strip secrets from prose you put in a prompt or from an
allowed source file.

**Direct-provider trust boundary.** The worker and bundled SDK are trusted local
code under the same OS user. Model-visible investigation is limited to the host
tools; there is no native advisor shell, filesystem tool, or MCP bridge.
Provider model/auth endpoints are the intentional network destinations.

**Credentials.** API keys stay in named environment variables. OAuth tokens are
stored under the Claude configuration directory (normally outside the project):
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cross-model-advisor/credentials`, in private
`0600` files within `0700` directories. This is a permission-protected local token
store, not encryption or an OS sandbox against other processes under your user.
Writes are atomic and refresh/logout is serialized across workers. Locks are
never stolen automatically: a crashed operation can leave `<slot>.lock` in the
credential directory. If the helper reports a stale lock, verify that no auth
operation for that slot is running before manually removing that lock directory,
then retry. Do not remove the credential JSON file to repair a lock.
The plugin does not read credentials from OMP, Claude Code, Codex, Gemini, or
ambient SDK credential stores. Tokens are not part of observations, findings,
or session snapshots.

Provider conversation context is memory-only; accepted findings and session
metadata have seven-day local retention. There are no native advisor CLI
recordings. External providers apply their own retention and account policies.

## Reporting a security problem

This plugin sends session observations and selected project files to external
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
