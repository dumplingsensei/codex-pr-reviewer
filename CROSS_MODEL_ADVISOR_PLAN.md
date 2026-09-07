# Continuous cross-model advisors for Claude Code

> Planning update: the terminal-settings replacement at the end of this document supersedes the conversational setup and reconfiguration design below for the next change. The original implementation plan is retained for context. The terminal replacement is planned, not implemented.

## Context

Build a **new sibling plugin, `cross-model-advisor`**, in this marketplace. It should provide the useful combination from OMP's advisors: independent reviewers observe the ongoing primary session, investigate the project for themselves, and send concise findings back while Claude is working. This is not another pull-request reviewer or a Stop-hook completion gate.

User decisions:
- Support **direct API-key and OAuth authentication**, with no installed advisor CLI backends.
- **Advise while working**. Never automatically wake a stopped session. Findings completed too late remain available for the next user turn.
- Give advisors **read-only project tools**, not just a forwarded transcript and not a general shell.

The existing `plugins/codex-pr-reviewer` remains behaviorally unchanged at `0.9.16`. Marketplace metadata is `0.9.17`; the new plugin starts at `1.0.0`, with independent versioning.

Claude Code does not expose OMP's live token/reasoning stream through these hooks. Observe authoritative user/tool hook payloads immediately and incrementally read **visible** transcript messages when available. Do not claim token-level observation or access to hidden reasoning. Advice reaches the next user/tool boundary, not an arbitrary instant during model generation.

## Approach

### 1. Establish the new plugin and its distribution contract

Create `plugins/cross-model-advisor/` with a standard `.claude-plugin/plugin.json`, `hooks/hooks.json`, user-invoked skills, `src/` modules, and committed `dist/` executables. Use ESM JavaScript with JSDoc, matching the repository's Node implementation style. Keep this runtime separate from `pr-workspace.mjs`; the existing plugin has no reusable advisor, provider, or IPC runtime.

Runtime baseline: **Claude Code 2.1.252 or newer; Node 22.19.0 or newer; macOS and Linux**. Use mature `UserPromptSubmit`, `PreToolUse`, and `PostToolUse` hooks rather than making correctness depend on `PostToolBatch` detection. Do not add a second PostToolBatch/fallback delivery path. Unsupported Node/host/OS is a clear `doctor` error; ordinary hooks remain fail-open and do not start providers.

Pin production dependencies to `@earendil-works/pi-ai@0.85.1` and `ignore@7.0.8`; pin `esbuild@0.28.2` for builds and commit the npm lockfile. Bundle only selected direct provider adapters and their OAuth flows/model assets. No MCP SDK or advisor subprocess transport. Users install without npm bootstrap or a build; a cold plugin-only copy must work without source/node_modules.

Keep `package.json`, `package-lock.json`, and the build script in **`tooling/cross-model-advisor/`**, outside the installable marketplace source. Claude automatically runs npm dependency installation for a cached plugin containing root package manifests; bundling alone does not suppress that. The build resolves dependencies from this tooling directory and emits into the plugin's `dist/`. Ship no root package manifest in the plugin. Tests exercise bundled modules/executables, not unbundled source imports that depend on a developer node_modules tree.

Produce four executable entry points: lightweight hook/control, session worker, explicit terminal-owned auth helper, and offline setup helper. Hooks must not eagerly load SDKs or launch login flows. Child workers use `process.execPath`. Include dependency licenses. Write a compact plugin-owned advisor prompt; credit OMP as design inspiration without copying its prompt corpus or agent framework.

Add the marketplace entry pointing to `./plugins/cross-model-advisor`. Advance marketplace metadata from `0.9.16` to `0.9.17`, leaving the existing plugin entry and manifest at `0.9.16`. Update release checks so each marketplace plugin version matches its own manifest; marketplace metadata is independently versioned. Extend the version guard to enumerate marketplace source directories instead of hard-coding one plugin, retaining each plugin's own existing stamp checks. Do not introduce new duplicate version strings in skills.

Configuration and installation instructions belong in the plugin README and marketplace listing. Document provider/auth distinctions, external disclosure, private token storage, no-wake behavior, runtime requirements, and exact command examples.

### 2. Make activation explicit, session-bound, and configurable

Ship seven user-only skills with `disable-model-invocation: true` and no `context: fork`:
- `/cross-model-advisor:on`: validate configuration and enable configured advisors; report provider/model names, root, limits, and external-provider disclosure. No advisor model call merely to run the command.
- `/cross-model-advisor:off`: cancel running reviews, stop future reviews, and discard pending injection candidates. Retain accepted findings in the local inbox for inspection.
- `/cross-model-advisor:status`: show enabled/paused/busy state per advisor, pending/emitted findings, usage when reported, and sanitized last errors. “Emitted” is locally acknowledged hook output, not confirmed receipt by Claude. This is also the human-visible inbox.
- `/cross-model-advisor:doctor`: offline runtime/config/key-variable/stored-OAuth/model/bundle/IPC checks. Resolve the plugin root from the worker's source/bundle/module layout when its environment variable is absent; genuine bundle failures make the overall result fail. No remote entitlement claim, token refresh, paid request, login, installation, or secrets in output.
- `/cross-model-advisor:setup`: choose providers, supported auth methods, offline-catalog models, and advisor instructions with AskUserQuestion. Preview and confirm before a revision-checked private atomic config save. Preserve unrelated settings and existing slot identities; never collect key values, run OAuth, or activate automatically. New API slots/key-variable names require a new Claude session so the worker inherits the selected variables.
- `/cross-model-advisor:login [provider-slot]`: with no argument, list configured slots without reading credentials and use AskUserQuestion to choose an OAuth slot. Then show the exact installed auth helper command for the user's own terminal. Explicit validated slots remain supported. Browser/device authorization and manual callback input must not pass through Claude's transcript.
- `/cross-model-advisor:logout <provider-slot>`: delete that slot's local credential under the same serialization lock used for refresh. Local logout does not revoke the upstream grant or cancel already authorized requests.

Bind session helpers to Claude's session identity (`CLAUDE_CODE_SESSION_ID` or `CLAUDE_SESSION_ID`) and `CLAUDE_PLUGIN_DATA`. Reuse the stored session root. When no state exists, use `CLAUDE_PROJECT_DIR`, otherwise hook payload `cwd` or a command's working directory. Cwd never selects the session, and later cwd changes never rebind its root. Do not select the newest transcript or a global current-session file. The four session-control skills have fixed argument-less helper commands. Auth helpers use a validated slot, with argument-less `list` for the login picker. Setup uses offline `catalog`, bounded `models`, and stdin `save`; auth/setup do not require session identity. Never interpolate raw `$ARGUMENTS`. Limit pre-approval to each skill's own helper operations.

Use one trusted user configuration file: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cross-model-advisor.json`. JSON schema version is `1`; reject unknown keys and malformed entries before enabling. Define:

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

The uppercase model value above is documentation notation, not a shipped runnable default. Ship a schema and an example requiring the user to choose real models. No silent default provider/model or use of Claude's current credentials. Advisor names are unique, restricted identifiers. Advisor instructions are literal strings from the trusted user config, not executable commands.

API `provider` values: `openai`, `anthropic`, `google`, `openrouter`, `zai`, `xai`, `moonshotai`, `kimi-coding`, `openai-compatible`. Each requires an explicit `apiKeyEnv` variable name; never persist its value. Compatible endpoints additionally require HTTPS (except explicit loopback), Chat Completions, and model metadata `contextWindow`, `maxTokens`, `reasoning`, `input`, optional pricing. No endpoint guessing or provider/model fallback.

OAuth provider IDs: `openai-codex`, `github-copilot`, `xai`, `kimi-coding`. Entries have `kind: "oauth"` and `provider`, never `apiKeyEnv`. Slot names are distinct from upstream provider IDs and own separate credentials. Keep Kimi API (`moonshotai`) and Kimi Coding distinct. Reject old CLI entries; never import CLI/OMP/Claude credentials.

Anthropic remains API-key-only. Antigravity was considered, but its terms expressly prohibit third-party OAuth access; Gemini API (`google`) is supported and must not be labelled Antigravity subscription access. SDK support for other subscription flows does not establish vendor endorsement or remove account/organization restrictions.

At activation, freeze the canonical project root established for the session. Resolve it from stored state first; a new session uses `CLAUDE_PROJECT_DIR`, hook `cwd`, or the command's initial working directory. Refuse `/`, the home directory, or a missing root. A later cwd/worktree move does not broaden it: when a hook reports a cwd outside the root, pause observation/review and require explicit `off`, followed by a new session rooted there. Added directories do not grant advisor access.

Optional project customization is limited to `WATCHDOG.md` (review priorities, at most 8 KiB) and `.cross-model-advisorignore` (additional excluded paths). Project files cannot select providers, endpoints, credentials, binaries, budgets, or auto-enable the plugin. Treat project guidance as untrusted data, below the advisor's system instructions and tool policy.

Activation enables only successfully validated advisors and reports every unavailable advisor by name; if none are usable, remain disabled. No silent provider substitution. Configuration is snapshotted by `on`; edits take effect on the next explicit `on`.

### 3. Implement a serialized per-session worker and observation lifecycle

Use a single detached Node worker per session. Keep session state under `${CLAUDE_PLUGIN_DATA}/sessions/<validated-session-id>/`, with directories `0700`, files `0600`, atomic writes, and no state in the working tree. Set the worker's umask to `077` so its children also create private files. Use a short Unix socket in a private `mkdtemp` directory to avoid socket path-length failures; its locator and random control capability belong only in the private session directory. Do not bind a network listener for worker/tool IPC.

A hook/control client reads bounded JSON stdin, validates identity, contacts the worker, and waits only for an enqueue/drain acknowledgement—not a provider. Use a 200 ms warm IPC deadline; a cold startup may use at most 1 second. Hook configuration timeout is 2 seconds, except SessionEnd at 1 second. On parse/startup/IPC errors, exit 0 with empty stdout; record a rate-limited sanitized local error. Never manufacture a successful review.

Coordinate cold starts with atomic directory creation plus a ready handshake containing a new worker generation and capability; never reuse a stale PID as authority. The worker serializes event ingestion, queue claims, and state transitions. It owns provider cancellation, so ordinary hooks never signal arbitrary stored PIDs. If the worker dies, a later hook can replace it under the startup lock; interrupted reviews are marked interrupted, not replayed automatically.

Classify control turns before draining, task replacement, or scheduling. Recognize all seven exact namespaced commands; `off` immediately disables/cancels. Defer other slash prompts until UserPromptExpansion resolves attribution. Setup/login/logout helper, question, and reporting turns are control-only and cannot become advisor observations, drain findings, or replace the real task. Preserve explicit inbox display via status and ordinary observation of other slash commands.

Hook actions:

| Hook | Behavior |
|---|---|
| `SessionStart` | Register exact session/transcript/root. Startup, clear, fork, or resumed host process starts disabled. A compact-source event preserves activation and acknowledges the existing compaction transition; never increment generation a second time. |
| `UserPromptSubmit` | Classify control/slash prompts first. For a real task prompt, claim ready prior findings, record prompt/ID, cancel superseded work, and schedule the new observation if enabled. |
| `UserPromptExpansion` | Resolve deferred slash-command classification. No drain, permission decision, or provider call for plugin control commands. |
| `PreToolUse` | Record tool intent and drain previously ready findings. Do not grant/deny permissions or change tool input. |
| `PostToolUse` | Record authoritative tool completion and drain ready findings. Parallel hook calls are serialized by the worker, not by assumptions about arrival order. |
| `PostToolUseFailure` | Record the actual failure/interruption when present; no invented success. It may drain through the same permitted additionalContext mechanism. |
| `Stop` | Record `last_assistant_message` and mark primary idle. Existing advisor work may finish and persist a pending finding. Do not start a final-only review and print nothing. |
| `StopFailure` | Record the error, mark idle, cancel reviews dependent on the failed turn; print nothing. |
| `PreCompact` | Cancel in-flight reviews and suspend scheduling; retain the old task/context pending the outcome. Do not advance generation or assume a summary exists. |
| `PostCompact` | Install the completed `compact_summary`, advance generation once, clear obsolete advisor histories, and resume event-driven scheduling. Never inject here. |
| `SessionEnd` | Request cancellation and worker shutdown; print nothing and return within the host budget. Retain accepted pending findings, not provider processes. |

Main-thread events only: skip when `agent_id` is set. A parent `Agent` tool completion is observable normally. No separate advisor teams or recursive observation of advisor subprocesses.

For compaction, keep a transition record containing the pre-compaction observation boundary, prior generation, and completed-summary identity. Duplicate PostCompact/SessionStart(compact) notifications acknowledge that record. If compaction is blocked, the next ordinary prompt/tool event without a new compact summary clears suspension and retains the prior generation. If PostCompact is missed but SessionStart(compact) arrives, recover the bounded summary from the transcript before resuming; if unavailable, pause reviews with `context-unavailable` until a real prompt or completed summary restores usable task context. Never erase later user steering when installing an earlier compaction summary.

Deduplication identity: session + generation + `prompt_id` + `tool_use_id` + event phase for tool events; transcript UUID/source UUID for transcript-only messages. Preserve both intent and outcome even if PostToolUse arrives before a delayed PreToolUse client. Assign monotonic observation sequence numbers in the worker. Do not dedupe all parallel tools by `prompt_id` alone.

Hook payloads are the live authority because `transcript_path` is asynchronously flushed. Incremental transcript reading only supplements visible user/assistant text and mid-turn user steering. Use the supplied path, UUID/cursor, bounded tail reads, and support incomplete trailing JSON lines, truncation, replacement, compaction, and absent bookkeeping UUIDs. Recognize string/block user content, assistant text/tool_use, tool_result linkage, human queued-command attachments, and compact summaries. Filter sidechains, thinking blocks, plugin-generated feedback/control traffic, and duplicate hook-observed tools. Unknown record types produce a local diagnostic and an observation-gap marker, not arbitrary serialized payload disclosure or invented content. An unreadable transcript does not disable authoritative hook observation.

Never reread the entire growing transcript at every hook. Maintain the cursor in the worker; a restarted worker reads at most the last 256 KiB and records a gap if earlier context is unavailable. Persist the bounded latest actual user request and compact summary separately, so large tool output cannot push the task outside the recovery window. If neither persisted context nor the tail supplies an actual task, continue recording hooks but pause reviews with `context-unavailable` until a real user prompt restores it.

An observation contains event IDs, user/visible assistant text, tool name, project-relative target paths, bounded command text where available, outcome/error summary, cwd, and timestamps. Do not automatically send Read output bodies, Write/Edit bodies, full shell output, MCP payloads, environment variables, raw hook JSON, or reasoning. Advisors fetch relevant source through the controlled tools. Cap user/assistant text at 8 KiB per message and each tool summary at 1 KiB; label truncation explicitly. Sanitize configured key values and obvious credential assignments before external transmission. This is disclosure minimization, not a promise to detect every secret in prose.

Scheduling: one in-flight review per advisor; up to two advisors run concurrently by default. Debounce new observations for 750 ms. While an advisor is busy, coalesce pending observations into one next update rather than queueing every hook. Do not drop the latest user instruction or report an unobserved gap as reviewed. No timer-only model requests: timers may debounce real events or expire work, never poll the project/model. Stop makes the session idle and suppresses follow-on queued updates; it does not revoke an already running bounded review.

Each advisor owns separate bounded history, cursors, fingerprints, usage, and failure state. Retain complete assistant/tool-result groups, never another advisor's private history. Bound context to 60,000 characters and the selected model's input allowance, reserving output/tool headroom. Evict oldest complete groups without a summarizer; pause with context-limit if required current context cannot fit.

On new user prompt, stop scheduling the old prompt's queued work and abort its in-flight review. Findings already accepted remain pending, labelled with their source prompt. On compaction, cancel old-generation work; retain accepted findings in the inbox, but do not automatically inject pre-compaction candidates. On resume, retained late findings may be delivered on the first actual user prompt after evidence freshness checks; no resumed provider activity without `on`. A fork gets a fresh disabled session and does not inherit its parent's queue or capabilities.

Claude provides no reliable user-interrupt hook. Do not infer an immediate Esc cancellation guarantee: bounded in-flight reviews may finish, but cannot wake Claude. A new prompt, off, compaction, SessionEnd, or the 90-second review deadline cancels them. An idle worker exits after two minutes without events once no review is running. Reconstruct in-memory context from the transcript on a later restart, not from persisted provider reasoning.

Persist only non-secret activation, its fingerprint, bounded latest actual task/summary, cursors/counters, dedupe fingerprints, and accepted findings. Worker-only restart restores snapshot A even after config B edits; only on applies B. Resolve named keys again without storing values. OAuth tokens live in the separate auth store, never in snapshots. Provider conversations, source tool results, and reasoning remain memory-only. Retain session metadata/findings for seven days; prune only expired plugin directories, never live sessions. No raw-payload debug dumps.

### 4. Share one read-only tool policy across every backend

The worker owns filesystem scope; SDK providers do not. Export one schema/dispatcher for:
- `read({path, offset?, limit?})`: numbered UTF-8 text, default 200 lines, at most 500 lines and 64 KiB returned; refuse files over 1 MiB or binary content.
- `list({path?, depth?})`: project-relative entries only, depth 1 by default, maximum depth 3 and 200 entries; deterministic ordering.
- `search({query, path?, caseSensitive?})`: literal text search, not arbitrary regex; maximum 50 matches and 64 KiB returned, bounded to 10 MiB scanned per call. Report incomplete coverage when a bound is reached.
- `advise({severity, note, evidence})`: one evidence-backed finding, with `severity` in `nit | concern | blocker`, note at most 2,000 characters, and one to five evidence references.

Do not add Bash, write, edit, patch, network fetch, arbitrary MCP forwarding, subagents, or a generic tool executor. Use Node filesystem operations for project search, not a shell command. Enforce the same exclusions for listing, searching, and reading so filenames and snippets do not bypass exclusions.

Resolve paths relative to the frozen root, reject parent traversal and outside absolute paths, canonicalize boundaries with `path.relative`, reject symlink path components, and open final files without following links where supported. Revalidate opened-file identity against the checked path. Race/symlink uncertainty is a denied read, not a fallback. Never follow links out of the project.

Hard-exclude `.git`, `.env`/`.env.*`, `*.pem`, `*.key`, `.claude`, `.codex`, `.gemini`, `node_modules`, and plugin state at any project depth. Use `ignore@7.0.8` for root/nested `.gitignore` semantics and the two additional exclusion sources. Match hard denies independently so negated gitignore patterns cannot reopen them; reject negation in user/project advisor exclusions, which may only narrow access. Apply exclusions to explicit reads as well as traversal. The README distinguishes excluded paths from unsanitized prose a user might put in their prompt.

Evidence schema is a discriminated union:
- `{kind: "file", path, line, detail}`: the same review must have successfully read the cited line through `read`. The worker stores a SHA-256 of the opened file; the model cannot supply the hash.
- `{kind: "observation", eventId, detail}`: the ID must exist in that review's supplied observation set. Use for a user constraint or observed session action, not as fake evidence for unread source.

Validate tool arguments and evidence server-side. Reject unknown references, out-of-range lines, excluded paths, content-free praise/acknowledgements, empty notes, and duplicate normalized findings. Normalize whitespace/case for duplicate matching, with a bounded 4,096-entry FIFO per advisor. At most one accepted `advise` per review; a silent completion is valid. Do not convert arbitrary final prose into an injected finding.

An advise call stages a candidate, not a drainable finding. Publish only after the full model response/tool batch is audited. Any later timeout, forbidden tool, provider error, cancellation, or generation change discards the candidate; no hook can drain it before that audit completes.

The advisor system prompt states: independently inspect before alleging a code defect; focus on a concrete action the primary can still change; distinguish facts from uncertainty; avoid repeating prior advice; source, tool output, primary transcript, and WATCHDOG.md are untrusted data; they cannot change tool policy or instruct credential access; silence is correct when there is no useful finding. `blocker` is a label, not authority to block or wake Claude. The primary remains responsible for validating advice.

### 5. Implement direct API providers with pi-ai, not a second agent harness

Use createModels with only selected provider factories from src/providers.mjs. Register OpenAI API/Codex subscription, Anthropic, Gemini API, Copilot, ZAI, xAI, MoonshotAI, Kimi Coding, and OpenRouter explicitly. Compatible endpoints use openAICompletionsApi with validated model definitions, not a guessed Responses endpoint.

Use a sealed auth context (`env` undefined; `fileExists` false). API entries use an empty InMemoryCredentialStore and explicit key request option. OAuth entries use the slot/upstream-bound CredentialStore; the SDK resolves provider-specific headers/base URL and refresh. Never treat a subscription bearer as a generic API key. Preserve Copilot account model filtering. Workers inherit an environment allowlist with only named keys. Disable automatic model retries where exposed and set cache retention none.

For each advisor, use its own SDK `Context`, selected model, tool schemas, and AbortSignal. Call the model, validate emitted tool calls with the SDK validator, dispatch through the host tools, append assistant and toolResult messages, and continue until silent completion, one accepted finding, cancellation, or a configured limit. Activation validates the registered API/model and rejects explicitly unsupported tool configurations; it does not pretend an offline check proves a remote model's capabilities. An unsupported-tools provider response pauses the advisor with that error. Do not use pi-agent-core, an OMP AgentSession, or provider-managed filesystem tools.

Track actual token usage/cost when the SDK reports it; missing pricing is `unknown`, never zero. A rate/auth/config error pauses that advisor immediately; other request failures are recorded and retried only by a later real observation, with a pause after three consecutive failures. No retry timer, no hidden model fallback, no provider error injected as if it were review advice. A per-advisor session review limit pauses further calls and is visible in status; `on` does not silently erase session usage counters.

### 6. Own explicit OAuth login, storage, and refresh

Use the selected SDK provider's OAuth implementation, not installed tools or a copied OMP auth database. The standalone `auth-control.mjs login|logout|status <provider-slot>` helper loads the trusted user config. `list` returns configured slot/provider/auth/advisor metadata without reading credentials. `login-command <provider-slot>` only formats the terminal command. Login requires the user's terminal; print authorization URLs/device codes, never credential payloads. Manual callback/secret input is terminal-owned. Handle cancellation and callback port conflicts without broadening redirect destinations. Hooks, setup, and doctor must not initiate interactive authorization.

Store credentials under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cross-model-advisor/credentials`, keyed by validated configured slot and bound to the upstream provider ID. Use private 0700 directories, 0600 files, bounded envelope validation, symlink refusal, atomic writes, and cross-process serialization. Refresh reads the current token under the lock; never double-refresh a rotated token or resurrect a logout. Live lock ownership must not be stolen merely because a timeout elapsed. Abortable lock waits remain bounded by operation deadlines.

Tokens are permission-protected, not encrypted or protected from malicious code already running as the same OS user. Do not import ambient credentials, persist tokens in session state, emit raw OAuth errors, or fall back to a key/account/provider on auth failure. Local status reports stored credential metadata, not remote validity. Reviews resolve/refresh within their existing deadline; authentication failure pauses the advisor. Subscription cost is unknown unless actual billed cost is available, not the API catalog price.

### 7. Emit findings at permitted boundaries, without a completion gate

Accepted findings receive a host-generated ID, advisor/provider/model provenance, source prompt/generation/observation range, evidence versions, and status (`pending`, `claimed`, `emitted`, `stale`, `discarded`). Keep an inbox record independently of injection status so fail-open emission cannot erase the accepted finding.

Before delivery, verify file evidence still matches its recorded hash. Changed/missing evidence makes the candidate stale; retain it visibly in the inbox, do not inject it, and let the next real observation trigger re-review. Observation-only findings remain explicitly labelled with their source prompt; do not present a previous task's assumption as a current instruction.

Only UserPromptSubmit, PreToolUse, PostToolUse, and PostToolUseFailure may return:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "<bounded, factual external-advisor envelope>"
  }
}
```

Use the actual event name. Do not return permissionDecision, decision:block, continue:false, exit 2, Stop additionalContext, asyncRewake, a channel notification, or a monitor message. The worker never writes to Claude's terminal, transcript, PTY, socket, or API.

Drain up to three findings per hook response, severity then age ordered, with a total maximum of 8,000 characters including envelopes. Escape boundary delimiters, strip terminal control characters, and identify every finding as untrusted external analysis, not a new user request or system instruction. Include provenance, evidence, source age, and a short factual reminder that the claim has not been validated by the primary.

Serialize claims in the worker so simultaneous healthy hooks cannot emit the same note. Use a short claim lease: prepare bounded JSON, write it to stdout, then acknowledge over IPC; failed/expired claims return to pending. The host has no receipt protocol: a crash can duplicate an emission, and a host timeout after local acknowledgement can discard it entirely. Document **best-effort injection**, not exactly-once or at-least-once receipt. Preserve stable IDs; `emitted` means locally written/acknowledged, never host-confirmed. The durable inbox retains the finding regardless of injection outcome.

If a finding finishes after the last tool boundary, the worker persists it; Stop always prints nothing. Injection is attempted only when the user next submits a real task prompt or another genuine tool boundary occurs. No extra primary model call is caused by a completed advisor alone.

### 8. Integrate release checks without changing the existing reviewer contract

Keep focused lifecycle/confinement/auth regression coverage under tests/cross-model-advisor using Node's built-in test runner and scripted direct providers. No extra test framework, source-text assertions, or incidental wording tests.

Keep the existing Node 18/22 reviewer matrix. Add a separate new-plugin job on Node 22.19+ for Linux and macOS: `npm ci` in `tooling/cross-model-advisor`, build, focused tests, and cold-bundle smoke. Run existing reviewer unit/regression suites once after integration. Extend strict Claude validation to the root marketplace and both plugin directories; retain the existing pinned validator lane and add the new runtime-baseline smoke where host execution is available. If the old validator cannot parse valid new metadata, update only that validator pin to 2.1.252 with the recorded failure as evidence, not the reviewer Node floor.

Add `/tooling/cross-model-advisor` to npm dependency updates. Build into a temporary directory and compare to committed dist. Verify installation through an isolated local marketplace/cache—not only `--plugin-dir`—does not trigger npm bootstrap. Validate each marketplace entry against its installed directory and license. No release/tag/publish command is part of implementation.

## Critical files

1. `plugins/cross-model-advisor/hooks/hooks.json` — lifecycle subscriptions and the no-wake boundary.
2. `plugins/cross-model-advisor/src/worker.mjs` — session ownership, observation order, bounded scheduling, cancellation, and note delivery.
3. `plugins/cross-model-advisor/src/tools.mjs` — read-only confinement and evidence validation for every direct provider.
4. `plugins/cross-model-advisor/src/backends/api.mjs`, `src/providers.mjs`, `src/auth.mjs`, `src/auth-control.mjs` — selected direct transports and explicit credential lifecycle with no ambient fallback.
5. `.claude-plugin/marketplace.json` — sibling installation and independent plugin versioning; associated release checks must enumerate it.

## Verification

### Behavioral regression coverage

Keep tests that defend these observable failure modes:
- Two parallel PostToolUse hooks cannot lose observations or normally deliver the same finding twice; reversed intent/completion arrival preserves both facts.
- Off cannot drain before disabling; all session/auth commands and their reporting turns cannot replace the actual task or start reviews.
- A slow advisor completes after Stop: Stop stdout is empty, no wake mechanism is emitted, the next user prompt receives the retained finding, and a fork cannot receive it.
- Off/new prompt/compaction/SessionEnd abort the right work. The full PreCompact/PostCompact/SessionStart(compact) sequence increments once, a blocked compaction preserves context, and a missed summary pauses rather than invents context. Esc is not falsely treated as Stop.
- Partial JSONL, transcript lag, duplicate tool records, queued human messages, compact summary, cursor loss, and sidechains preserve the actual user constraint without leaking reasoning/raw payloads.
- Activate with config A, edit B, replace the worker: A remains active. Move the actual task outside the final 256 KiB with large tool output: recovery retains the bounded persisted task or pauses safely.
- Traversal, outside paths, symlinks, ignored secrets, search/list bypasses, binary/oversized files, and stale evidence are rejected consistently for every provider.
- Invalid evidence, content-free/duplicate advice, two advise calls in one review, timeout, rate/auth error, unknown usage, context/tool/session limits, and a dead worker produce the specified state rather than fake findings or loops.
- A model response contains a valid advise followed by a forbidden tool or later error: no intervening hook can drain that provisional candidate.
- A claim crash before stdout permits redelivery; an ambiguous crash preserves the ID; acknowledgement followed by host timeout is not reported as confirmed receipt. Successful concurrent drains do not duplicate.
- Independent auth stores/workers serialize refresh; logout cannot resurrect a credential. Slot/upstream mismatches and symlink substitution fail closed. Auth errors and helper output contain no token values.
- API/OAuth config resolves only its explicit credential source; expiry, revocation, missing login, or Copilot entitlement denial never selects an ambient key or another provider.
- Each plugin's marketplace version is checked independently; existing PR-reviewer commands and their tests remain unchanged in behavior.

### Actual runtime proof, not only mocks

Run these acceptance scenarios after the direct-auth migration. Offline fixtures prove local transport/auth behavior, not live account entitlements.

1. **Installed bundle:** isolated local marketplace install without npm bootstrap; cold plugin-only doctor, hook IPC, loopback read/advise/no-wake review, auth helper status/logout/nonterminal rejection, and resolution of selected provider/auth modules without source/node_modules.
2. **Claude host surface:** in a throwaway trusted project, load with `claude --plugin-dir ./plugins/cross-model-advisor`, point the advisor config at the loopback scripted server, and invoke `on`. Ask Claude to read two files in parallel, inspect one more file, then finish. The scripted advisor requests a project read and emits one evidence-backed concern. Inspect the real transcript/debug output: the finding enters as additionalContext at a later tool boundary, not as a new user message; Claude receives it before finishing. Repeat with delayed advice that finishes after Stop; verify no extra primary request until a real next user prompt. Exercise off, interrupt, compact, resume, and fork in the actual host. Raw captures stay temporary and contain no production repository data.
3. **Direct auth/provider boundary:** exercise real bundled SDK transports with scripted fetch/loopback responses and dummy credentials. Cover requested provider auth headers/body, slot-bound OAuth refresh, Copilot model restrictions, and staged tool audit. Exercise terminal login with a local scripted authorization server in a throwaway environment; do not copy or print production tokens. Real provider login requires explicit user participation and account entitlement.
4. **Repository checks:** focused tests, existing node tests/unit.mjs and bash tests/regression.sh, generalized version guard, strict validation for marketplace/both plugins, and deterministic temporary rebuild comparison. Shared suites run after parallel writers finish.

The authenticated Claude smoke proves host injection semantics; offline fixtures do not. Report unperformed live provider logins separately from local transport correctness. No paid probe in doctor/startup.

## Assumptions and contingencies

- The plugin observes the **main Claude session**, including parent-visible subagent results, not every subagent's private transcript. It never observes hidden reasoning or a continuous token stream.
- Delivery is opportunistic at real user/tool boundaries. A text-only answer with no later tool boundary may finish before advice is ready; the plugin preserves the finding rather than waking Claude. This is the selected user behavior, not a missing Stop gate.
- Provider-specific OAuth grants and entitlements are external prerequisites, not generic bearer tokens. Offline availability is not proof of remote account validity.
- API keys, explicit login, and user-selected model IDs are prerequisites. Do not create accounts, install advisor CLIs, copy ambient tokens, broaden permissions, or change the main Claude model.
- Prompt/project text intentionally sent to an external advisor can contain user-provided sensitive information. Exclusions prevent tool access to designated files; they cannot promise universal secret removal from prose or from an allowed source file.
- Provider context stays in memory; findings/session metadata have seven-day retention; OAuth credentials persist separately until logout. External providers apply their own retention policies.
- Worker/SDK/auth helper are trusted local code under the same OS user. Tool confinement and private credential permissions do not isolate against malicious same-user processes.
- No runtime daemon survives independently forever: no idle model polling, no task-completion loop, bounded review deadlines, worker idle expiry, and SessionEnd cancellation.

### Grounding references

- [Claude hooks](https://code.claude.com/docs/en/hooks): concurrent tool hooks, additionalContext, transcript lag, Stop waking behavior, interrupt and SessionEnd limits.
- [Claude skills](https://code.claude.com/docs/en/skills): explicit user invocation and session/plugin path substitutions.
- [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference): install layout, persistent plugin data, command-hook exec arguments.
- [Pi AI 0.85.1 package](https://www.npmjs.com/package/@earendil-works/pi-ai/v/0.85.1) and [source](https://github.com/earendil-works/pi/tree/v0.85.1/packages/ai): provider registry, explicit auth, Context/tool execution, Node requirement.
- [Anthropic authentication restrictions](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use): no third-party Claude.ai subscription login.
- [Antigravity terms](https://antigravity.google/terms/) and [FAQ](https://antigravity.google/docs/faq/#why-cant-i-use-third-party-software-eg-claude-code-openclaw-opencode-with-my-antigravity-login): third-party OAuth prohibition and Gemini API alternative.

## Terminal settings menu — next implementation plan

### Approved direction and scope

Replace Claude-driven setup with a plugin-owned terminal menu. The user is comfortable opening that menu in their own terminal. This section is the implementation plan for that approved direction; it does not authorize or claim implementation.

- Keep `/cross-model-advisor:setup` as a thin launcher that prints the exact installed command.
- All navigation, search, editing, saving, and local session controls run deterministically in Node, without Claude or advisor inference.
- Opening the slash skill can still cost a Claude turn. Reusing the printed terminal command does not. Existing advisors can independently incur normal review costs while their Claude session is working.
- Use OMP-style searchable lists and direct settings actions, not an embedded OMP agent, web application, or new server.
- Support advisor add/edit/enable/disable/remove, provider/auth selection, model selection, model-specific reasoning effort, and literal instructions.
- Keep persistent user defaults separate from the snapshot active in a particular Claude session.
- Preserve existing provider slots, authentication, exclusions, limits, and unrelated sessions unless an explicit action changes them.
- Keep `/status` and `/doctor` as diagnostics, not steps required for every model change.
- Do not change the main Claude model or the existing PR-reviewer plugin.

### Grounded starting point

The current implementation already supplies most non-UI primitives:

| Existing code | Reuse / required change |
|---|---|
| `src/setup-control.mjs`: `runSetup`, `listModels`, revision/lock/atomic-save helpers | Reuse offline catalogs and the single config writer; expose shared operations for the menu rather than reconstructing JSON through Claude or subprocess stdout. |
| `src/auth-control.mjs`: `runAuth`, terminal interaction, `loginHint` | Reuse explicit OAuth and terminal cleanup. Extract shared command quoting only where both launchers need it; do not copy a second auth implementation. |
| `src/config.mjs` and `config/schema.json` | Currently reject `enabled` and empty advisor/provider collections; require a deliberate schema update. |
| `src/control.mjs`: identity resolution, worker startup, hook stdout/ack | Reuse exact-session identity and private IPC. Add an explicit settings client and a safe publication boundary. |
| `src/worker.mjs`: `handleOn`, cancellation, `publicationAllowed` | Current `on` reloads activation without cancelling old reviews or fencing their findings. It is not safe to call unchanged as terminal Apply. |
| `src/session/state.mjs`, `src/session/findings.mjs` | Persist settings revisions and advisor epochs; fence pending findings and outstanding hook deliveries. |
| `tooling/cross-model-advisor/build.mjs` | Already bundles four executables, including setup and auth. Keep four; no installation-time dependency bootstrap. |
| `src/backends/api.mjs` and pinned SDK reasoning helpers | Current reviews call provider-specific `models.complete` without reasoning options. Reuse `getSupportedThinkingLevels`, model mappings, and SDK transport translation; adding a generic field to the current call is not sufficient. |

Planning-time runtime evidence: `node plugins/cross-model-advisor/dist/setup-control.mjs models openai-codex --q luna` returned exactly `gpt-5.6-luna` / `GPT-5.6 Luna`. This verifies the existing offline picker source, not a terminal menu or remote model entitlement.

### User interaction

The home screen shows:

```text
Cross-model advisors
Defaults: <config path>                 Saved / Unsaved changes
Target: <session id> · <frozen root>     Running / Off / Unavailable

Enabled  Advisor        Provider slot       Model
[x]      architecture   codex-login         gpt-5.6-luna
[x]      correctness    openai-api          <configured model>

Add advisor   Provider accounts   Save defaults   Save & Apply   Quit
```

The values above illustrate layout; they are not new defaults.

- Enter an advisor to change its model, provider slot, instructions, or name. Space toggles its configured enabled state. Removal is explicit and confirmed.
- Model selection is searchable by ID and display name, highlights the current model, and preserves the current choice on Escape. No provider/auth wizard for a model-only edit.
- A typical switch is: open advisor → search/select model → Save & Apply. The final action names the target session; no conversational confirmation or full-config questionnaire.
- Provider setup supports selecting multiple upstream providers, then only the required per-slot auth/model fields. Reusing a slot preserves its identity; adding another account creates a separate explicit slot.
- Dual-auth providers show API versus OAuth explicitly. API configuration collects variable names, never key values. Compatible endpoints require their existing explicit URL and model metadata; never invent catalog entries.
- Instructions use a bounded multiline terminal editor, stored literally. They are not shell commands, templates, or model-generated prompts.
- Leave `exclude` and `limits` unchanged; a general policy editor is outside this change.
- Escape returns to the parent view. Leaving a dirty menu offers Discard or Return. No config write occurs until Save or Save & Apply.
- A revision conflict preserves the draft for inspection but refuses overwrite. Offer reload/discard, not automatic merge or a force-save.
- Require a real input/output TTY. Handle resize, narrow screens, scrolling, Unicode, paste, Ctrl-C, EOF, and SIGTERM. Restore raw mode, cursor, listeners, and any alternate screen on every exit.
- Treat provider names and user text as display data: terminal control sequences must not execute. Display sanitization must not silently modify saved instructions.

Use a small dedicated terminal module with Node readline/key events and ANSI rendering. Keep it separate from config/auth/session logic, with no new UI framework initially. Exercise real terminal width and input behavior before committing to renderer details; do not assume JavaScript string length equals terminal columns.

### Provider- and model-specific reasoning effort

Add **Reasoning effort** beside Model in each advisor's editor and show its saved/active value in the menu and status. Effort belongs to the advisor, not the shared credential slot: two advisors can use the same model/account with different efforts.

- Persist `advisors[].reasoningEffort` in schema v2: `default`, `off`, or a pinned SDK thinking level. Version-1 migration uses `default`, preserving the current request behavior rather than enabling reasoning or choosing a higher effort.
- **Default and Off are distinct.** Default leaves the existing provider request behavior unchanged; it does not promise reasoning is disabled. Offer Off only where the exact model/transport supports disabling, and verify the actual wire behavior.
- Derive selectable levels from the resolved offline model using the pinned SDK's `getSupportedThinkingLevels(model)` and `thinkingLevelMap`, with the owning API/auth route and compatibility metadata. Do not infer support from a provider name or `model.reasoning` alone, and do not offer a universal low/medium/high list.
- SDK levels are normalized settings, not universal provider parameter names or values. Show aliases explicitly, such as `Minimal — sent as Low`, and show the effective native level/budget where determinable. Do not label a mapped value as a distinct native effort.
- On a provider/model switch, retain the setting only if it is still supported. If unsupported, require an explicit replacement or Default before Save & Apply. If its native mapping changes, display that change in the preview. Never silently clamp, drop, or upgrade a user's effort.
- Non-reasoning models show `Not configurable` and preserve Default semantics. Unknown compatible endpoints offer only Default until explicit, validated capability/format metadata establishes supported controls. Their existing boolean `reasoning` metadata is insufficient; do not add arbitrary request-field overrides.
- Opening the picker and resolving capabilities remain offline. Catalog metadata is not proof of remote entitlement or a server accepting an undocumented effort.

**Translation boundary:** extend the backend's common request-option resolution for both API and OAuth advisors. The pinned SDK distinguishes provider-specific `complete` options from normalized `completeSimple` reasoning options. Use its supported normalized adapter for explicit levels where it preserves the plugin's contracts; preserve the current raw-option behavior for Default. Verify explicit Off separately rather than assuming an omitted option disables thinking. Keep provider syntax translation in the SDK, not in menu code or a second hand-maintained provider table.

Examples of the distinct SDK option families, not a universal wire schema:

| Model/API family | Provider-specific control |
|---|---|
| OpenAI Responses / Codex / Chat Completions | Reasoning effort, with model-specific values; Responses and Chat Completions serialize differently. |
| Anthropic | Adaptive-thinking effort for supported models; enabled thinking plus a token budget for budget-based models. |
| Google | Thinking configuration with a supported level or token budget, depending on the model. |
| OpenRouter and other compatible adapters | Model/route-specific compatibility format; for example nested reasoning effort or thinking enable/type controls, not necessarily OpenAI's `reasoning_effort`. |

Planning-time offline SDK probe confirmed: `gpt-5.6-luna` exposes normalized Off/Minimal/Low/Medium/High/XHigh/Max but maps Minimal to native Low; `kimi-coding/k3` exposes only Low/High/Max; `xai/grok-4.3` exposes Off/Low/Medium/High and maps Off to `none`. These are evidence from pinned SDK 0.85.1, not hard-coded UI lists or live-provider verification.

Budget-based reasoning requires explicit care: inspect SDK budget conversion and any automatic response-token expansion. Preserve configured token/context/time limits; do not silently increase the review ceiling to accommodate thinking. Reject an incompatible effort/budget with an actionable explanation. Verify enough permitted answer space remains and expose bounded/effective budget behavior rather than implying qualitative efforts consume identical resources across providers.

Apply effort consistently across every model call in the review/tool loop. Include it in the active snapshot, settings comparison, and per-advisor epoch: an effort-only change cancels/fences affected old work just like a model change, preserves credentials and session usage limits, and leaves unrelated advisors running. No reasoning text is added to menu/status/logs or persisted as a consequence of this setting.

### Entry points and ownership

Reuse `dist/setup-control.mjs`:

- `menu-command`: format a safely quoted command for the user's terminal, following the existing login-command pattern. Capture the installed helper path and the applicable config directory. If invoked in Claude, include validated session identity and plugin-data location, never the private IPC capability or a credential value.
- `menu`: open the terminal UI. Without explicit session context, operate as a defaults editor with Apply unavailable; never infer a session from cwd, newest transcript, or directory timestamps.
- Keep the existing offline `catalog`, `models`, and revision-checked `save` operations as thin callers of the same shared service, not a second config implementation.
- Replace the setup skill's AskUserQuestion workflow and its catalog/models/save tool grants with the single launcher operation. It must not run the interactive menu in Claude's captured Bash tool.
- Session communication belongs in the control client, not UI rendering or direct state-file mutation. UI code consumes sanitized results; the worker remains the only owner of runtime activation.

Suggested source split: retain `setup-control.mjs` for CLI dispatch, extract the existing config/catalog operations into `setup-store.mjs`, and put terminal views/input handling in `setup-menu.mjs`. These are planned modules, not additional executable entry points.

### Configuration and authentication

Use config schema version **2**, rather than silently changing the meaning of strict version 1:

- Add boolean `advisors[].enabled`. Version-1 input normalizes once with all existing advisors enabled. Version-2 saves include the explicit field.
- Add advisor-level `reasoningEffort` with Default migration and model/transport-aware semantic validation as specified above. Extend compatible-model capability metadata only with the validated fields needed for supported reasoning formats.
- Permit empty advisors and providers when references remain valid. An empty configuration is a valid disabled setup, not a corrupt file.
- Continue rejecting unknown keys, invalid provider references, unsupported auth combinations, duplicate names, oversized documents, and malformed compatible metadata.
- Read existing version-1 configs without writing during menu open. On explicit Save, write normalized version 2 through the existing revision-checked, private atomic writer.
- Update the runtime validator, JSON schema, example, and snapshot handling together. An older plugin cannot read version 2; document the upgrade boundary instead of adding a compatibility shim.
- Removing an advisor does not delete its provider slot or OAuth credentials. Removing a shared slot requires resolving every advisor reference first. Logout is a separate explicit credential action.
- Preserve enabled-but-unavailable versus intentionally disabled as distinct visible states; disabled advisors remain editable in the menu/status.

OAuth login runs only after an explicit terminal action, using the existing auth helper. Suspend and fully release menu input while the auth process owns the terminal, then restore the menu. Login for a new/changed slot requires saving that slot first; explain that discarding later UI edits does not undo a completed login/logout.

Model-only edits reuse existing slot credentials. Provider/auth changes do not transfer grants between upstream providers or silently borrow credentials. Catalog navigation and Apply do not refresh OAuth or make paid probes; explicit login may perform the normal authorization network flow.

**API environment boundary:** keep the current security model. A live worker cannot acquire newly exported variables from another terminal. Model changes using its existing available key variables can apply in place; new/missing API key-variable names or changed values require a fresh Claude session with those variables exported. Show this before claiming a successful live change. Do not introduce API-key transport over IPC, persist key values, or restart a worker under a different terminal environment as an implicit workaround.

### Save and session-scoped Apply

Save changes only user defaults. Other active sessions retain their snapshots; future explicit activation can read the new defaults.

Save & Apply is two explicit operations, not a falsely advertised cross-process transaction:

1. Save with the draft's expected file revision.
2. Apply that exact saved revision to the displayed session, guarded by its worker identity and expected settings revision.
3. Report `Saved and applied`, `Saved; not applied`, or `Not saved`. If Apply fails, do not undo a global save that another editor/session may already have observed.

The bound session must have a live, compatible worker and a matching frozen root/config location. A missing/ended target is not permission to resurrect it, create a new session, or redirect elsewhere. Defaults editing remains available. An idle-expired worker can become available after ordinary Claude activity; the menu then explicitly refreshes that same target.

Worker replacement or conflicting on/off/settings changes invalidate the captured target revision. Refresh and show the changed target state before another Apply; do not silently retry against a replacement. A normal task prompt is not itself a settings conflict.

Proposed private Apply request contains the expected worker generation, expected settings revision, and saved config revision. The worker reads and validates the corresponding config, checks identity/root/runtime, and returns the resulting revision and per-advisor availability. No credentials, observations, or findings travel in the menu's Apply result.

Apply preserves the session's on/off state. For an off session, offer a separately labelled explicit Enable action; never enable as a side effect of selecting a model or saving. Reuse the same transition implementation for `/on` and terminal activation so the safety fix is not menu-only. Disabled-all/empty configurations start no reviews.

Prepare and validate before mutating activation. Invalid config, stale revision, unsafe target, or an unresolved publication barrier leaves the active snapshot unchanged. Preview/report unavailable enabled advisors explicitly; never continue the previous model while displaying the newly selected one as active. Retain the existing per-advisor availability policy rather than silently substituting providers.

Applying settings does not replay the last task, generate a synthetic observation, drain findings into the terminal, wake Claude, or start a provider call solely to test the choice. New reviews start at subsequent ordinary observation boundaries.

### Safe model transitions and the hook-output race

Introduce a persisted settings revision plus per-advisor configuration epochs, separate from the existing compaction generation. Increment an affected advisor's epoch on model/provider/reasoning-effort/instructions/enable changes, removal, and re-addition. Switching A → B → A must not make the first A's work current again.

On successful Apply:

- Cancel affected reviews and clear their queued/coalesced work. Clear affected provider conversation history, but do not reset session usage/review budgets through model toggles.
- Preserve unrelated advisors' reviews/history and every other session. Shared tool-policy changes, if supplied by an external config editor, affect all relevant advisors.
- Check the reserved advisor epoch at tool/publication/completion boundaries. A late callback must not publish, restore old history, clear a replacement review, or schedule an old specification.
- Make pending old-epoch findings non-deliverable while retaining already-emitted history. Finding selection must check epoch eligibility; cancellation alone is insufficient.
- Persist the active snapshot and epoch metadata so worker replacement cannot re-enable old pending findings.

There is an additional cross-process race: `control.mjs` currently receives hook stdout, writes it, then acknowledges the claim. The worker can process Apply between those steps. Incrementing a generation or deleting a claim cannot retract bytes already held by that hook client.

**Required publication barrier:** a successful Apply must not precede emission of an affected old-epoch envelope still held by a hook client. Track issued deliveries until stdout completion is acknowledged or the issuing client is proven unable to emit. Return bounded `busy` from Apply while such a delivery is unresolved; allow ack processing to continue rather than waiting inside the serialized worker handler.

- Lease expiry alone is not proof that the client stopped holding stdout. Do not use the existing two-second lease as a safe-to-apply timer.
- Include sufficient client/epoch metadata in the claim protocol and persist unresolved delivery ownership across worker replacement. An ambiguous client remains a barrier, not permission to force success.
- Acknowledge completed stdout writes, not merely a call to `stdout.write`.
- After the barrier clears, atomically serialize the epoch/snapshot transition with new claims. Delayed old review completions still fail their epoch check.
- Older workers/claims lacking the required protocol metadata cannot promise safe live Apply. Require a compatible fresh Claude session, not a fallback to the old `on`.
- Findings emitted before the successful Apply boundary may already be in Claude's context and cannot be removed. Never describe those as retracted.

Prove this protocol with a paused hook client before investing in menu polish. If the proposed ownership/ack barrier cannot establish that boundary under crash/restart, resolve the protocol first; do not weaken the guarantee to “wait for lease expiry.”

### Implementation order and parallel ownership

1. **Configuration foundation:** schema-v2 normalization, enabled/empty semantics, and extraction of the existing catalog/save service. Own `src/config.mjs`, `src/setup-store.mjs`, `src/setup-control.mjs`, `config/schema.json`, and `config/example.json`.
2. **Safe transition protocol:** settings/epoch metadata, delivery ownership barrier, cancellation, pending-finding fences, and shared activation logic. Own `src/worker.mjs`, `src/session/state.mjs`, `src/session/findings.mjs`, and `src/session/constants.mjs`.
3. **Explicit terminal session client:** launcher-bound identity, guarded Apply request, completed-write acknowledgement, safe target refresh, and sanitized results. Own `src/control.mjs`, `src/session/ipc.mjs`, and `src/session/paths.mjs`; coordinate the protocol with step 2 before editing.
4. **Terminal menu and auth handoff:** searchable views, draft lifecycle, model/effort shortcuts, multiline instructions, Save/Apply states, and existing OAuth terminal handoff. Own `src/setup-menu.mjs`, `src/setup-control.mjs`, and `src/auth-control.mjs` after step 1 releases setup-control.
5. **Reasoning capability and transport integration:** offline model-specific choices, explicit alias/default/off semantics, SDK request mapping, and token-budget enforcement. Own `src/backends/api.mjs`, `src/providers.mjs`, and the relevant provider transport tests. Agree the normalized effort/capability contract with config, menu, and worker owners first; no competing translation table.
6. **Skill/distribution integration:** replace conversational setup, update settings/status documentation and changelog, advance only the advisor/marketplace versions as appropriate, and rebuild the same four entry points. Keep the old reviewer unchanged.
7. **Behavioral verification:** integrate focused regressions with real PTY and cold-installed-bundle smoke; run shared repository gates once after writers finish.

Steps 1 and 2 can start concurrently with agreed normalized-config and epoch contracts. Step 3 can proceed alongside them after the IPC contract is fixed. Steps 4 and 5 depend on agreed config/capability interfaces and can proceed alongside session work with disjoint ownership. One integration owner resolves shared files and release artifacts. Parallel writers skip builds/tests/formatters; the integration owner runs verification after their edits settle.

### Acceptance criteria

The implementation is complete only when all of these hold:

1. In a real terminal, change an existing Codex advisor to `gpt-5.6-luna`, save/apply, and observe that exact active model without a Claude questionnaire, manual JSON, or another login.
2. Navigate/filter/edit/save/cancel with provider inference disabled. No menu operation invokes Claude, an advisor completion, remote model discovery, or an entitlement probe.
3. Add multiple providers/advisors, choose supported auth explicitly, edit multiline instructions, toggle advisors, and remove the last advisor. Unrelated slots, credentials, exclusions, and limits remain intact.
4. A model-only OAuth change leaves the existing credential untouched. Explicit login hands off/restores the real terminal and never exposes codes/tokens to Claude or config output.
5. Existing v1 config opens without mutation; explicit save yields valid v2. Empty/disabled-only configs run no advisors; malformed/unknown fields still fail safely.
6. Two menus editing the same revision cannot overwrite each other. Cancel, non-TTY invocation, interrupted input, and failed saves leave disk/runtime unchanged as applicable.
7. Save alone changes no active session. Save & Apply affects only the named session; wrong root, missing identity, stale worker, ended target, and conflicting settings are visible failures, not retargeting.
8. A saved-but-rejected Apply is clearly distinguished from success. New API-variable requirements are reported truthfully; no environment/credential leakage or implicit worker replacement.
9. With two running advisors, switch one during a delayed review. Its old review, queued work, history callbacks, and pending findings cannot become current; the other advisor continues unaffected. Repeat A → B → A and remove/re-add.
10. Pause a hook after it receives an old-model envelope but before stdout. Apply cannot report success ahead of that emission. Repeat beyond lease expiry, on ack failure, client death, and worker restart; already-emitted history stays labelled honestly.
11. Stop/compaction/off/SessionEnd races preserve existing no-wake and confinement rules. Applying settings while idle/off does not schedule a paid review by itself.
12. Real PTY smoke covers narrow/resize/Unicode/paste, Escape/Ctrl-C/EOF/SIGTERM, auth handoff, and terminal restoration. Do not substitute source-text assertions for terminal behavior.
13. A cold installed plugin-only copy opens the menu and runs local scripted review/apply scenarios without source/node_modules/npm bootstrap. Paths containing spaces/quotes work; capabilities/credentials never appear in the launcher.
14. Existing relevant config/auth/IPC/lifecycle tests, shared reviewer checks, strict manifests, version guard, and deterministic bundle comparison pass after integration. Keep permanent tests for the transition/conflict/privacy failures, not incidental wording or renderer implementation.
15. The real terminal effort picker changes with the exact model/provider route, distinguishes Default from supported Off, exposes aliases, and refuses unsupported selections without a silent downgrade. An effort-only Save & Apply updates only the intended advisor/session and fences its old work.
16. Using actual bundled SDK transports with scripted HTTP/fetch and dummy credentials, verify outgoing reasoning fields/values for OpenAI/Codex, adaptive and budget-based Anthropic, level/budget-based Google, OpenRouter, and the selected compatible-format families. Include a non-reasoning model, unsupported/mandatory-thinking Off, aliased levels, and Default preserving the prior request. Assert provider-observable bodies, not mock echoes of generic options.
17. Verify thinking budgets cannot silently enlarge configured token ceilings or violate context/answer constraints; incompatible settings fail visibly before a paid call. Effort survives save/reload/worker replacement, applies on follow-up tool-loop calls, and neither leaks reasoning text nor resets review/usage budgets.

Report live provider authorization separately from local/scripted proof; no production credentials or paid probes are needed for implementation verification. After smoke proof, update affected docs/examples/changelog, remove throwaway scripts and processes, and leave unrelated user work intact. No commit, push, or release is part of this planning request.
