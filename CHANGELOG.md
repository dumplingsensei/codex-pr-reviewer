# Changelog

Versions are the plugin's, in `plugins/codex-pr-reviewer/.claude-plugin/plugin.json`.
Claude Code resolves an install by that number and caches it, so every change to
anything under `plugins/` moves it — `tests/version-guard.sh` fails the build
otherwise.

## 0.9.10 — unreleased

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
