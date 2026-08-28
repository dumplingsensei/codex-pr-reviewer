# Changelog

Versions are the plugin's, in `plugins/codex-pr-reviewer/.claude-plugin/plugin.json`.
Claude Code resolves an install by that number and caches it, so every change to
anything under `plugins/` moves it — `tests/version-guard.sh` fails the build
otherwise.

## 0.9.15

Reviews can now verify cross-repository dependency claims against explicitly
approved pull requests. `review` detects repository-qualified references only as
untrusted suggestions, asks before fetching them, and accepts the repeatable
`--context-pr owner/repo#N` flag for direct approval. Codex remains scoped to the
primary PR; context repositories are evidence, not additional finding targets.

Each context is independently pinned and verified. Open PRs expose the
contributor head and its merge-base diff. Merged PRs additionally expose
GitHub's exact `mergeCommit` in a separate landed worktree, so effective behavior
is not inferred from a contributor head that may differ after a squash merge,
conflict resolution, or merge queue. Generated developer instructions tell
Codex which worktrees are approved, prohibit network and sibling-cache
discovery, and require unresolved material claims to appear under
`Verification limits`.

The real review run uses `--strict-config`, not only the capability probe, so a
Codex version that ignores `developer_instructions` cannot consume a paid review
without its evidence boundary. Merged-commit materialization happens only for
approved context PRs; reviewing a merged primary remains possible when its base
branch has been deleted. Path redaction processes longer roots first, preventing
`pr-4` from relabelling primary citations under `pr-42`.

Context paths are redacted from saved output, active-run markers protect every
evidence worktree from cleanup, and cleanup verifies and removes landed
worktrees and branches with the same digest-bound plan as primary checkouts.
Unit and synthetic regression coverage exercise reference parsing, instruction
generation, path hygiene, merged-head/landed divergence, active-run protection,
and cleanup.

## 0.9.14

The correction 0.9.13 started, finished where it was left.

That release removed a promise about permission prompts from the read side —
under `permissions.defaultMode: auto` a read-only command outside the grant
simply runs, so a prompt is not the boundary the prompts described. It
deliberately did not touch the passages about *posting*, on the grounds that a
`gh` write is a different question and this release had not tested it. That was
the right call about evidence and the wrong place to stop: the untested claim
stayed in three files, and it was the stronger of the two. `README.md` and the
shipped `plugins/codex-pr-reviewer/README.md` both said a comment is "posted
through a `gh` that was never pre-approved — so you see the permission prompt,"
and `review.md` ended its publishing section by handing the job of the
checkpoint to that prompt: "let it be one rather than adding a second of your
own."

Two things are wrong with it rather than one. Whether a write prompts is the
permission mode's call, the same fact 0.9.13 established. And `gh` is not
necessarily the route — a session that has finished the command may reach GitHub
through an MCP tool instead, which the grant never covered and no `gh` prompt
would ever appear for.

What the plugin actually controls is the text, so that is what the three
passages now describe: you see the exact comment first, only that text is
posted, and the route and its prompts belong to the session rather than to any
guarantee made here. `review.md` says the same thing to the model, in the place
where it used to lean on the prompt. The step that matters is unchanged and was
never the prompt: a comment is written from the findings step 7 confirmed, and
shown in full before it goes anywhere.

Also pinned: `--profile` reaches Codex as `-p`, asserted on the dry run's argv
for the first time. Codex now carries two unrelated things called a profile —
the config-layer one this flag has always selected, and the filesystem
permission profiles that are the current candidate for confining the reviewer's
reads. The second does not compose with the `-s read-only` this script passes,
so any future read-confinement work has to touch the same argv this flag lives
in. The test is there to make that a decision someone makes rather than a
regression someone ships.

One CI fix, found by dispatching the workflow by hand for the first time since
`packaging-drift` was added — that job passes, and the run went red anyway. The
version guard is handed `event.pull_request.base.sha || event.before`, and a
manual dispatch has neither, so it received an empty string and fell back to
comparing `HEAD` against `HEAD^`. That is a different question: 0.9.13 shipped
as a bump followed by a fix to `review.md`, so against `HEAD^` the guard saw
shipped content changed with the version standing still and failed a release
that was correct. The step now runs only for a push or a pull request, the two
events that have a base worth diffing, and the script skips an all-zero base
rather than reporting "nothing changed" for a branch whose first push it cannot
diff — a pass that checked nothing, on exactly the push most likely to carry a
new prompt.

## 0.9.13

Two corrections to `review`, both found by running the command against a live
pull request rather than by reading it again.

The first is a sentence that was untrue. The prompt told the model that a command
outside the pre-approved set "has to be put to the user as a permission prompt,"
and offered that prompt as the boundary to treat as one. Under
`permissions.defaultMode: auto` no prompt appears — a read-only command outside
the grant simply runs — so the boundary the prompt pointed at was not there, and
a model that believed the description would have thought itself inside a fence
that does not exist. The scoping is still worth keeping; what it is not is
self-announcing. It is now described as a rule the model keeps rather than a wall
that stops it. Step 7 gains the matching detail: `Read`, `Grep` and `Glob` are
the pre-approved way to read and stay preferred, and a shell read used in their
place inherits the same limits and no others — read-only, rooted at the worktree,
never `gh`, never running the pull request's own code.

The same sentence shipped in `README.md` and — as a stated security property — in
`SECURITY.md`. Both now describe what the mode actually does, since a security
document that promises a checkpoint nobody will see is the worst place of the
three to leave it. The passages saying a `gh` write prompts before a comment is
posted are untouched: those concern posting rather than reading, and whether
`auto` treats them the same way is a separate question this release did not
test.

The second is precision. Vetting already demanded a `file:line` behind every
verdict, and was producing numbers that drifted, almost always by one: an `await`
cited to the comment above it, a `yield` cited to its own closing brace. The
reasoning was sound and the verdicts held either way, but a citation exists so a
reader can check it, and one that lands on a brace cannot be checked. Citations
now carry a few words of the line's real text alongside the number, which makes
the drift self-correcting — a quote that comes out as a brace, a comment or a
blank line is the number reporting its own error. The rule is bounded to
citations that drifted off the defect — when the comment or the delimiter is
itself what the finding is about, it is the right line, and quoting it is what
shows the reader the problem.

## 0.9.12

`review` no longer stops at printing. It now reads the code each of Codex's
findings names and marks it confirmed, refuted, or unverified, with a `file:line`
behind every verdict — refutations included, since a verdict with nothing behind
it is another unchecked claim, only yours instead of Codex's. Three buckets
rather than a confidence score: nothing here posts automatically, so there is no
threshold for a number to clear, and a "confirmed" that means *I looked* is worth
more than one that means *I feel*. The step belongs at the end of the command
because that is the only cheap moment for it — the worktree is on disk, `prepare`
has already said what the PR touches, and `Read`, `Grep` and `Glob` are granted.
Anything later has to fetch the pull request again and reviews it afresh rather
than checking these findings. `--no-vet` skips it, and like `--wait` and
`--background` it is acted on by the prompt, never forwarded to the script. So
does `--dry-run`, which prepares no worktree and so leaves nothing to read the
findings against.

Every citation resolves against the worktree `prepare` reported and nothing
else. Codex prints absolute paths inside that worktree and the wrapper echoes
them unchanged; stripping happens on the way to disk, so the saved copy is
worktree-relative and the two shapes mean the same file. Either resolved against
the working directory the user invoked from would read their own checkout — for
a pull request against their own repository the same paths exist there with
different contents, so the read succeeds, the line is present, and the verdict is
about the wrong file. Only a citation that still lands outside the worktree once
resolved is reported as pointing outside the pull request rather than followed.

A review that was cut short is vetted as a fragment or not at all. The wrapper
exits 0 for anything that ran and was saved, so a Codex that timed out or
overflowed the output cap looks like success from outside; the saved file is
where it says otherwise. Both of its signals are read precisely: the first
line's `exit=<n>` is Codex's own status and reads `exit=0` on every ordinary
review, so anything other than exactly `exit=0` is what matters rather than the
marker being there — read as a string, since a Codex killed by a signal has no
exit code at all and the marker then reads `exit=null`,
and the wrapper's note is matched as a whole line — a review whose subject is
truncation quotes `cut short` inside its own findings, which a search of the
file would otherwise take for the note. With neither signal it is a complete
review. With either, vetting says the findings are partial before it starts.

Background mode returns to the review. Step 4 recommends it for nearly every
real pull request and step 5 ends the turn on launching it, so showing the
result and checking it had no trigger on the path most reviews take: the command
recommended a mode in which its own last two steps never ran. The turn the task
reports back in picks up where the launch left off.

Whether a finding is true and whether it is this pull request's problem are
asked separately, because collapsing them is how a real defect disappears. A
finding that a linter would catch, or one on lines the PR never touched, is not
refuted — it is true and out of scope, and it stays confirmed with a label
saying which. Refuted is reserved for checked and untrue, which is rarer than it
looks: behaviour that is plainly the point of the pull request, and claims
contradicted by code a few lines away that Codex did not read.

`--dry-run` is also named in the step that parses arguments now. It was
advertised in the argument hint and acted on in two later steps while appearing
in neither the recognized list nor the list of flags the script never sees,
which left the prompt contradicting itself about a flag it was already using.

The publishing rule is now scoped to the command instead of the session. It read
as a standing refusal, and because a command's instructions stay in context after
it finishes, Claude went on declining to help — waiting for the user to post by
hand — even when asked directly and after the reasoning had been heard. Nothing
publishes while `review` or `sweep` is running, and `review` still holds no `gh`
grant at all, so a pull request whose text asks to be approved has nowhere to go;
that property is the part worth keeping and it is unchanged. Afterwards the
instructions stop being a prohibition and become care: the full text is shown
first, only that text is posted, the raw review never is, and approval attaches
to a comment the user has read rather than to a general yes about the review. The
`gh` that would post it is still not pre-approved, so the permission prompt
remains the checkpoint rather than one Claude adds on top of it.

No new capability came with any of this. No `gh` grant, no `publish` subcommand,
no script change, and no dependency on another plugin — the checking is Claude
reading the worktree with grants `review` already held.

`sweep` does not vet, and now says so instead of leaving the difference to be
inferred: a digest across a batch is already the summary, and per-PR checking
multiplies the cost of output nobody reads line by line. A digest that reads as
checked is worse than one that admits it is not.

Unit coverage pins the three places a Claude-side flag has to be named — the
argument hint, the parsed list, and the sentence saying the script never sees it
— and asserts that none of them reaches a scripted invocation, with the
invocation scan asserted non-empty so a regex that stopped matching cannot make
the rest vacuously true.

## 0.9.11

The upgrade remedy now names the copy of Codex that PATH resolves, instead of a
package. `npm install -g @openai/codex` was said unconditionally, and on a
machine with more than one Codex it can update an install the shell never
reaches — a standalone one under `~/.local/bin` sitting ahead of an npm one
under a Homebrew prefix is ordinary, not exotic. The person followed the advice,
nothing changed, and the fault read as the plugin's rather than the binary's.

`doctor` resolves the `codex` entries on PATH the way `spawnSync` does, and the
remedy for a Codex without `review --base` names the first of them — the one a
review would actually run — along with any behind it, which updating does
nothing for. Where that binary offers `codex update` the remedy says so, because
the binary knows how it was installed and the shell resolves the command to the
same copy this plugin spawns. Where it does not, the package name stays, said as
the guess it is and pinned to the path it has to reach. The probe runs only on
the way to the remedy, so a healthy toolchain costs nothing extra, and nothing
is ever updated on the user's behalf.

## 0.9.10

Ctrl-Z now suspends Codex with the wrapper instead of leaving the detached
Codex process group working behind a stopped deadline and output reader. The
wrapper handles job control separately from termination: on SIGTSTP it stops
the whole Codex group with SIGSTOP, then suspends with its normal SIGTSTP
disposition; after `fg`/SIGCONT it continues the group before returning to the
event loop. Repeated suspend/resume cycles keep working, and the handlers still
leave through the same cleanup path as the other signals.

Suspension counts against the original monotonic deadline. If the deadline
passes while the job is stopped, continuing the job resumes Codex first and the
overdue timeout then ends it immediately; suspending a review never grants it a
fresh allowance. Regression coverage pins both that ordering and the process
states on the supported POSIX platforms. Windows remains unsupported and is
unchanged.

## 0.9.9

Bounds on a Codex run: a 45-minute timeout signalling the whole process group
with SIGTERM then SIGKILL (`CPR_CODEX_TIMEOUT_MS`), and a cap on the output
retained for the saved document, which was an unbounded string. Diagnostic
notes stay out of the value that decides whether a review happened, so an
output-less timeout is a failure rather than a review whose only content is the
note saying there is none.

Ctrl-C, SIGTERM and SIGHUP now reach that group instead of killing the wrapper
alone. The signal is forwarded, the run marker is cleared on the way out, and it
is re-raised so the exit status is the signal's — 130 for an interrupt, which is
what a `for pr in …; do` loop reads as the person stopping it rather than the
review failing on its own. Nothing is saved for a review that did not finish.
What it waits for before settling is the process group emptying, not just Codex
exiting: clearing the marker while a descendant still reads the worktree is the
same harm by a narrower path. A second Ctrl-C stops waiting and kills. The
marker also records Codex's pid beside the wrapper's, which is the only thing
that covers a wrapper killed outright, where no handler runs at all.

Both bounds are also the size they claim to be now. `CPR_CODEX_TIMEOUT_MS` is
validated and clamped to the run marker's TTL: `Number(env) || default` let a
negative value — and anything past 2³¹−1 ms — reach `setTimeout`, which treats a
delay it cannot use as "now", so a mistyped deadline killed every review the
instant it began, and a deadline past the TTL outlived the marker keeping a
`clean` off the worktree it was running longer in. A value that is not a
positive number is refused before the run rather than quietly becoming 45
minutes. The output cap counts bytes rather than UTF-16 code units, and is
enforced on the chunk that crosses it rather than the one after, so a run that
stops on that chunk is still marked cut short; a cap landing inside a multi-byte
character drops the partial sequence rather than rendering it as a replacement
character. `CPR_CODEX_MAX_OUTPUT_BYTES` sets it.

The wait for `close` is bounded as well. `close` waits on every holder of the
inherited stdout pipe rather than on Codex alone, so a descendant that outlived
Codex without letting go held a review that had already finished open
indefinitely, terminal and all. Past a grace, whatever still holds the pipe is
ended — which also means the run marker is not cleared while something is still
reading the worktree.

Deferred out of 0.9.8 rather than written after it. Three rounds of Codex review
returned sixteen findings across the release; by the third every other area had
gone quiet and this one held the only P1, so it was taken out so the security
work could land. All four findings it was parked on are fixed above.

A fourth round, this one against the fixes themselves, returned three more — and
every one of them is the same invariant at a site that had not been given it:
Codex's process group has to be gone before the run marker is released. The
deadline settled on `close` and walked away from the SIGKILL it had armed, since
an unreferenced timer does not outlive the process that armed it. `runIsLive`
asked after two processes and never after the group they led, so a descendant
outliving both read as a finished review and freed `clean` to take the worktree
it was reading. And SIGQUIT was missing from the forwarded signals, which left
Ctrl-\ as one key on the keyboard that still reproduced the whole parked P1.
Each is fixed with a regression case that fails without it.

A fifth round returned three more, and this time two of them were the end of the
line rather than another site. A cap of `0.5` passed "positive and finite" and
then reached `Buffer.subarray`, which truncates a fractional endpoint to nothing
while the counter advances by the fraction — so the cap retained no bytes at all
and the run reported no review while Codex was producing one. Both settings take
whole numbers now. And the bound on `close` was not a bound: a descendant that
leaves the process group never receives the signal meant to end it, and the wait
had no other end. It settles once the group is empty — which it already is when
the holder is outside it — keeps what Codex produced, and says what happened.
Releasing the read end is half of that: settling a promise does not end a process
whose pipe handle is still keeping the loop alive, which is the same hang wearing
a different hat.

**Deliberately left. These are limits, not defects waiting on a fix here:**

- **A descendant that leaves the process group cannot be contained.** `setsid`
  puts one beyond every signal a parent can send and beyond the probe that asks
  whether the group is empty. Containing it needs a cgroup or a Job Object;
  POSIX offers a parent nothing stronger than the process group. The wrapper
  bounds its own wait instead of pretending otherwise, and says so on the way
  out.
- **Ctrl-Z does not suspend Codex.** SIGTSTP goes to the wrapper's foreground
  group and Codex is deliberately not in it, so Node stops while Codex runs on
  with its watchdog frozen. Forwarding suspension and propagating SIGCONT is job
  control — a different subject from bounding a run, and its own change.
- **Windows.** Ending a process tree there needs a Job Object or `taskkill /T
  /F`, and without one the direct kill leaves whatever holds the pipe behind.
  The README says Windows is not tested and not supported, and this does not
  change that.

## 0.9.8

Findings from an external review of 0.9.7, plus one defect found while checking
its claims.

- **Command grants were never being applied.** Every command pre-approved
  `pr-workspace.mjs` with an unquoted rule, while the prompts invoke the script
  quoted — and Bash rules match the command text, quotes included. The rule
  therefore matched nothing the prompts ever wrote, so every helper call fell
  through to a permission prompt and the narrowing the README described was not
  in effect. The rules now carry the quotes the prompts use, verified against
  the real matcher rather than assumed.
- **Grants are scoped by subcommand.** `review` and `sweep` may run `doctor`,
  `prepare`, and `review`; `list` may run `list`; `clean` may run `clean`. The
  wildcard they replaced pre-approved every subcommand from every command, so a
  review session could run `clean` — worktrees, branches, and refs — without
  crossing a permission boundary. `tests/unit.mjs` now pins the whole matrix,
  including that each prompt only invokes what it grants.
- **`clean` no longer takes a `git` grant.** It verifies its own removals and
  reports what is still in the repository afterwards, so the `git -C` rule that
  existed for two read-only checks — and that also matched `reset`, `branch -D`,
  and `config` — is gone. An entry with anything remaining is an incomplete
  removal: non-zero exit, record kept, retryable.
- **A pull request cannot point the reviewer out of its worktree.** Every git
  this plugin runs sets `core.symlinks=false`, so a symlink in the diff is
  checked out as a small regular file holding the link text. `-s read-only`
  bounds writes, not reads, on every platform, so a link was a path into
  anything the account could read. The index still records mode 120000, so the
  diff and `status` are unchanged.
- **Host and base identity are checked with the head.** The remote must be on
  the host that served the PR's metadata, read off the API's own URL rather than
  guessed; and the fetched base must contain GitHub's `baseRefOid`. Ancestry,
  not equality — a base branch legitimately advances between the API call and
  the fetch, and demanding equality would abort on ordinary traffic.
- **Bounding a Codex run is deferred.** There is still no timeout and no cap on
  retained output. That work was written here and taken out again: three rounds
  of Codex review found six defects in it, the last of them caused by the fix
  before — spawning Codex in its own process group let the timeout reach its
  descendants, and stopped Ctrl-C reaching them, so an interrupted review left
  Codex running behind a marker naming a dead pid that `clean` would read as
  finished. It is a reliability improvement sitting in a release of security
  fixes, and it was the only part still generating findings, so it moved to its
  own branch rather than holding the rest up. Outstanding there: forward
  termination signals to the group, clamp the configured timeout below the run
  marker's TTL, count the output cap in bytes and enforce it on the chunk that
  crosses it, and either support Windows process trees or keep the platform
  unsupported.
- **`doctor`'s host fallback is asserted against a stated `GH_HOST`.** The test
  read whatever the environment had, so running the suite in an Enterprise
  shell failed on a code path behaving exactly as designed.
- **macOS and Linux are the supported platforms**, stated in the README rather
  than implied by the CI matrix. Windows is untested: the read-only sandbox
  reads the whole filesystem there, and the process handling assumes POSIX.

Found by a Codex review of this branch, which is the workflow this plugin
exists for:

- **A push URL no longer vouches for a fetch remote.** `git remote -v` prints
  both, and the parser kept whichever matched, so a remote fetching from a
  mirror and pushing to GitHub satisfied the new host check and then fetched
  from the mirror — the substitution the check was added to stop. Only the
  `(fetch)` URL is read now, and it is parsed rather than split, since a remote
  URL may contain spaces.
- **A cached clone is checked against its `origin`** before being refreshed into
  service, so one that has been repointed is re-cloned rather than reused. Only
  a positive mismatch disqualifies it: an origin that cannot be parsed is
  absence of evidence, and rejecting on it would re-clone on every run for
  anyone whose git rewrites URLs. Replacing a clone that manifest entries still
  live in is refused outright and names them — the removal takes the git
  directory every linked worktree there depends on, including one a paid review
  may be reading.

  This briefly namespaced the clone path by host as well. That was reverted: the
  manifest key, worktree path and branch names all still came from the slug, so
  storage moved and identity did not, and on every existing install the previous
  clone became referenced by nothing and unreachable by any `clean` — a
  guaranteed leak for everyone in exchange for a collision almost nobody hits.
  Two hosts serving one slug still share prepared state, now recorded in
  SECURITY.md as a known limitation; separating them properly needs the host in
  every identity and a migration, which is its own change.
- **A worktree from an older checkout is rebuilt rather than refreshed.**
  `core.symlinks=false` governs how a link is written, so it does nothing to one
  already on disk: an unchanged blob is not rewritten by `checkout --force`, and
  git under that setting reads the existing link as clean, so the upgrade path
  kept exactly the escape the setting removes.
- **A registered worktree is recognised as one.** The check compared a resolved
  path against git's, which reports physical paths, so any symlink in the cache
  path — a symlinked `~/.cache`, macOS's `/var` — made every re-run tear the
  worktree down and check it out again. Re-running cheaply is a documented
  property and quietly was not one. Both comparisons go through one helper now,
  which resolves via the nearest existing ancestor: the same question is asked
  in `clean` after the directory is gone, where `realpath` returns the string it
  was handed and the two sides stop agreeing.
- **The live-symlink check covers the path reviews actually take.** It ran only
  in `prepare`, while the documented flow is `review --no-prepare`, so a
  worktree prepared before `core.symlinks=false` existed reached Codex with its
  links intact. It is read as bytes rather than text, too: git allows any byte
  but NUL and `/` in a filename, and decoding as UTF-8 turned a link whose name
  is not valid UTF-8 into a path that does not exist — which the check read as
  no link at all. Covered on Linux in CI; macOS rejects such a name outright.
- **An unknown flag is an error.** It used to become a positional, on the
  grounds that `#42` had to survive — which it does anyway, having no leading
  dash. What actually arrived there were typos: `--modle gpt-5.6` was read as
  the pull request and the review ran at the default model. `--effort` is
  validated too, being the one value interpolated into a quoted `-c` string.
- **A degraded manifest entry fails before the paid run, not after.**
  `--no-prepare` checked `headSha` and `mergeBase` only where they were present,
  while the saved document quotes both unconditionally — so an entry missing one
  bought a full review and then threw while writing it.
- **`doctor` no longer calls every install in use stale.** Claude Code writes
  `.in_use/<pid>` into the installed copy to record which versions are live, so
  it exists in the cache and never in the marketplace source — and comparing it
  reported `stale: true` for any plugin that was actually being used. The remedy
  that warning prints could not clear it either, since the file returns on the
  next run. `review.md` and `sweep.md` both put that signal in front of the user,
  so an always-on version of it is the same as having none. `.in_use` joins
  `UNCOMPARED`; the exclusion is exactly that path, and a real difference sitting
  beside the marker is still found.
- A marker that cannot be written now says so: the review proceeds, but
  unprotected from a concurrent `clean`, and that is worth a line.
- `keptReviews` counts review documents rather than directory entries, so a
  `.DS_Store` is no longer reported as a saved review.
- CI pins `@anthropic-ai/claude-code` for the pull request gate — it published
  twelve times in ten days, and `--strict` fails on rules that move between
  releases — with a scheduled job validating against `latest`, since Dependabot
  cannot carry a version inside a `run:` block.
- README: the safety section claimed a command could reach posting, which none
  has since 0.9.0, and described `clean`'s grant as two read-only `git` rules
  when it was one that could mutate. The `clean` usage omitted the required
  `--confirm-plan`. `list` gained the untrusted-input rules the other commands
  carry — it renders pull request titles from a GitHub-wide search.

## 0.9.7

- The marketplace is named `dumplingsensei-plugins`, and the copyright holder in
  both `LICENSE` files is the handle rather than a personal name. The repository
  is public now, and the marketplace name is the one string a user has to type,
  so it should not carry more than it needs to. The plugin's own name and its
  commands are unchanged; the install line is
  `/plugin install codex-pr-reviewer@dumplingsensei-plugins`.
- The shipped `LICENSE` is plugin content, so this moves the version even though
  no behaviour did.

## 0.9.6

- The installed plugin's README links to the security policy and to the private
  reporting path. `SECURITY.md` lives at the repository root and is not
  packaged, so a link was the only route an installed copy could offer, and it
  did not have one.
- One Codex stub, `tests/stubs/codex`, shared by the regression suite and the CI
  workflow. The preflight contract was written out six times across two
  languages; the workflow's copy is invisible to the regression suite, so a new
  probe could pass every local test and fail the integration job with "toolchain
  unhealthy". `tests/unit.mjs` now fails if either consumer writes its own again.

## 0.9.5

The two concurrency findings from the same Codex review.

- The manifest lock reclaims a stale lock by `rename`, not by deleting it. Two
  waiters could both stat the same old file, both judge it stale, and the second
  then delete the fresh lock the first had just acquired — putting both inside
  the critical section, which is exactly what the lock exists to prevent. Only
  one racer's rename moves the inode. Release is now conditional on the lock
  still carrying this acquisition's token, so a holder that overran does not
  take somebody else's.
- Manifest entries carry a `generation`, and `clean` removes the generation it
  cleaned rather than the key. A PR prepared again while a clean was running has
  the same key and a different worktree; removing by key deleted that new record
  and left its worktree and branches recorded nowhere. The generation is part of
  the plan digest too, so a re-prepare between the dry run and the confirmation
  now invalidates the plan rather than being swept up by it.

## 0.9.4

Validation fixes found by a Codex review of 0.9.3.

- `review --no-prepare` rejects a worktree with uncommitted changes. `codex
  review --base` diffs the working tree, so an edit was reviewed as part of the
  pull request while HEAD and the base still matched the manifest — producing a
  review labelled with the real PR's head over content the PR does not contain.
  The head and base probes also ignored git's exit status, so verification
  passed exactly when it could not verify; `gitOutOrNull` makes that impossible
  to write by accident.
- `clean` validates an entry before anything is deleted, not immediately before
  `rmSync`. The previous check ran after `git worktree remove --force`, `git
  branch -D`, and `git update-ref -d` had already been handed the same
  unvalidated fields — and branches and refs were never namespace-checked at
  all, so a manifest naming `refs/heads/main` would have deleted it. The PR
  number is validated as a value, since a traversal inside it moves the
  recomputed path out of the cache and makes the containment check compare a
  crafted path with itself.
- `list` and `sweep` pass `--sort created --order desc` to `gh search prs`,
  which defaults to best-match: a capped search returned an arbitrary `N`, and
  sorting afterwards cannot recover rows the API never sent. `list` also sorts
  the merged union before slicing, rather than after.

## 0.9.3

Fixes two defects in 0.9.2, both found by review of that commit.

- The Codex interface probe read only the text of `codex review --help` and
  ignored its exit status. `run()` returns status 124 with a synthetic
  "timed out" line on a timeout, and a crash returns whatever the binary wrote —
  neither contains `--base`, so a hung or broken Codex was reported as one that
  does not support the flag, with a remedy telling the user to reinstall. The
  two are now separate diagnoses.
- The test covering the passing case asserted that doctor's output did *not*
  contain one specific complaint, which any failure for any other reason also
  satisfies. It now asserts the exit status.

## 0.9.2

- `doctor` checks that the installed Codex speaks the interface this plugin
  builds against — that `codex review` accepts `--base` — rather than only that
  Codex exists and is logged in. Tested by capability, not by version number:
  the release that added `review --base` is not documented, and a renumbering
  would invalidate a floor anyway. `--context` is the case this is for; it
  shipped broken across several releases because nothing asked.
- Adds [SECURITY.md](SECURITY.md): what is in scope, what is known and accepted,
  and a private reporting path.

## 0.9.1

Hardening found by an external security review, in the places that survived
0.9.0's narrowing.

- `clean` recomputes where a worktree must be before deleting it recursively,
  and refuses any other path. The manifest is a JSON file in a cache directory;
  `rmSync(recursive)` on a path read straight out of it was only ever safe while
  nothing had edited it.
- Manifest read-modify-write is serialized by a lock file with a 10-second
  staleness cutoff. Writing was already atomic, which is a different problem:
  two overlapping mutations meant the second discarded the first, and `sweep`
  prepares several PRs at once.
- A manifest that cannot be read is no longer treated as absent. Only `ENOENT`
  means first run; a permissions or I/O error now says so instead of presenting
  as an empty queue.
- `review --no-prepare` checks that the worktree is still a worktree, still at
  the head that was prepared, and still based on the recorded merge-base.
- The cache is created `0700` and reviews and the manifest `0600`, and an
  existing cache is repaired. These were left to the process umask.
- `list` no longer throws on an entry missing a field.
- `sweep` gathers from the same two queues as `list` — review-requested *and*
  assigned — de-duplicates on `url` before taking `--limit`, and fetches the
  `createdAt` that `--order newest` sorts on and never had.
- `review --dry-run` no longer prepares a worktree first.
- The integration suite compares the whole patch against `gh pr diff`, byte for
  byte, rather than file names and totals. Blob-hash abbreviation is normalized;
  nothing else is.
- CI validates both plugin manifests, and the actions are pinned to commit SHAs
  rather than mutable major tags. Dependabot still carries the updates.

## 0.9.0

Removed `post` and everything that existed to make publishing safe: −295 lines.
Raw Codex output is a poor pull request comment — findings are advisory and some
are wrong — so the plugin stops at the review and the command prompts instruct
Claude not to publish by another route. Three open findings are answered by
deletion rather than a fix, along with the missing comment-size guard.

## 0.8.1

`clean`'s verification step pre-approved `git worktree list` and
`git branch --list`, neither of which matches a command beginning `git -C`.

## 0.8.0

Closed the holes an external security review found in guarantees the repository
was asserting.

- Codex runs with project documents disabled, so an `AGENTS.md` inside a pull
  request cannot rewrite the instructions of the reviewer reading it.
- Every git this plugin causes to run gets an empty `core.hooksPath` and
  neutralized LFS filters. Checkout writes attacker-authored bytes to disk
  before Codex's sandbox exists.
- The `node` grant is narrowed to this plugin's own script by full path.
- The fetched head is verified against GitHub's `headRefOid`.
- Branches are namespaced by repository; `prepare` will not move a branch it has
  no record of creating, and `clean` deletes one only at the recorded commit.
- `clean` binds the whole plan with `--confirm-plan`, not just the review list.
- Removed `--context`, which `codex review --base` had always rejected, and
  `--trust-worktree`.
- The integration suite isolates its cache before installing its cleanup trap.
  It could delete real prepared state, including on the skip path.
- Git floor raised to 2.19 for `clone --filter`. `LICENSE` ships inside the
  packaged plugin directory.

## 0.7.0

A review still running is left alone by `clean`, guarded by run markers with
liveness and a TTL.

## 0.6.0

`clean --purge-reviews` deletes saved reviews, bound by digest to the list a dry
run showed.

## 0.5.0

Posting rules moved from the command prompt into the script, where a stale
prompt or a hostile diff cannot argue with them.

## 0.4.0

`doctor` reports when the installed copy is older than its source, or older than
the prompts a session loaded.

## 0.1.0 – 0.3.0

Initial plugin: fetch a pull request into an isolated worktree, pin the diff to
the merge-base so it matches GitHub's "Files changed", and hand it to
`codex review`.
