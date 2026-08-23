#!/usr/bin/env bash
#
# Regression tests for defects found in code review.
#
# Every case here is a bug that shipped once. They run against synthetic git
# repositories and a stub `codex` inside an isolated XDG_CACHE_HOME, so the
# suite needs no network, no GitHub auth, and never touches the real cache.
#
#   tests/regression.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/plugins/codex-pr-reviewer/scripts/pr-workspace.mjs"
# One codex stub, shared with the CI workflow. See tests/stubs/codex.
STUBS="$ROOT/tests/stubs"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/cpr-regression.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

export XDG_CACHE_HOME="$SANDBOX/cache"
CACHE="$XDG_CACHE_HOME/codex-pr-reviewer"

pass=0
fail=0

check() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok   %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n       got      %s\n       expected %s\n' "$label" "$actual" "$expected"
    fail=$((fail + 1))
  fi
}

contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf '  ok   %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n       output did not contain: %s\n' "$label" "$needle"
    fail=$((fail + 1))
  fi
}

note() { printf '\n%s\n' "$1"; }

# A clean is two steps by design: a dry run shows the plan, and the confirmed
# run has to name the plan it was shown. `cclean` is that pair, so these tests
# exercise the same path the slash command takes rather than a shortcut past it.
plan_digest() {
  node "$SCRIPT" clean "$@" --dry-run --json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try { process.stdout.write(String(JSON.parse(raw).planDigest ?? "")); } catch {}
    });'
}
cclean() {
  local digest
  digest="$(plan_digest "$@")"
  if [[ -n "$digest" ]]; then
    node "$SCRIPT" clean "$@" --confirm-plan "$digest"
  else
    node "$SCRIPT" clean "$@"
  fi
}

# The same two steps as an executable, for the codex stub further down: that
# runs as its own /bin/sh process and inherits no functions from here.
mkdir -p "$SANDBOX"
cat >"$SANDBOX/cclean.sh" <<CCLEAN
#!/bin/sh
digest=\$(node "$SCRIPT" clean "\$@" --dry-run --json 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try { process.stdout.write(String(JSON.parse(raw).planDigest ?? "")); } catch {}
  });')
if [ -n "\$digest" ]; then
  exec node "$SCRIPT" clean "\$@" --confirm-plan "\$digest"
fi
exec node "$SCRIPT" clean "\$@"
CCLEAN
chmod +x "$SANDBOX/cclean.sh"

# ---------------------------------------------------------------------------

note "invocation through a symlink still runs main()"
# Regression: argv[1] keeps symlinks while import.meta.url is realpath-resolved,
# so the direct-invocation guard was false and every command silently no-opped.
mkdir -p "$SANDBOX/link"
ln -sf "$SCRIPT" "$SANDBOX/link/pw.mjs"
out="$(node "$SANDBOX/link/pw.mjs" help 2>&1)"
contains "symlinked entrypoint produces output" "$out" "pr-workspace.mjs"

note "manifest integrity"
mkdir -p "$CACHE"
# Regression: a corrupt manifest was swallowed and silently replaced with an
# empty one, orphaning every branch and ref recorded in the user's repos.
printf '{"version":1,"entries":[{"key":"o/r#1"' >"$CACHE/manifest.json"
out="$(node "$SCRIPT" list 2>&1)"
contains "corrupt manifest is reported" "$out" "not valid JSON"
check "corrupt manifest is backed up" "$(ls "$CACHE"/manifest.json.corrupt-* 2>/dev/null | wc -l | tr -d ' ')" "1"

# Regression: MANIFEST_VERSION was written but never checked, so a newer
# manifest was silently downgraded instead of refused.
printf '{"version":99,"entries":[]}' >"$CACHE/manifest.json"
out="$(node "$SCRIPT" list 2>&1)"
contains "future manifest version is refused" "$out" "version 99"
rm -f "$CACHE"/manifest.json*

note "argument parsing"
# Regression: commandReview parsed argv, then prepare() re-parsed it with a
# narrower schema, so any flag before the PR ref was read as the PR ref.
out="$(node "$SCRIPT" review --effort high 42 --repo o/r --dry-run 2>&1)"
if [[ "$out" == *"Could not read"* ]]; then
  printf '  FAIL flag before the PR ref is still misparsed\n'
  fail=$((fail + 1))
else
  printf '  ok   flag before the PR ref parses\n'
  pass=$((pass + 1))
fi
contains "--effort reaches the codex command" "$out" 'model_reasoning_effort="high"'

# Codex reads AGENTS.md from its working directory before it starts, and that
# directory is the pull request. Left on, a PR rewrites the instructions of the
# reviewer sent to inspect it; review.md's anti-injection rules bind Claude, not
# this child process.
contains "project documents are disabled for the review" "$out" "project_doc_max_bytes=0"

# Both flags were removed rather than repaired: --context appended a positional
# prompt that `codex review --base` rejects outright ("the argument '--base
# <BRANCH>' cannot be used with '[PROMPT]'"), so it had never worked; and
# --trust-worktree enabled project .codex config from an internet-fetched PR.
out="$(node "$SCRIPT" review 42 --repo o/r --context --dry-run 2>&1)"
contains "--context is gone, not silently ignored" "$out" "Unknown option"
out="$(node "$SCRIPT" review 42 --repo o/r --trust-worktree --dry-run 2>&1)"
contains "--trust-worktree is gone" "$out" "Unknown option"

note "--dry-run has no side effects"
# Regression: the dry-run check sat after prepare(), so it fetched, branched
# and built a worktree before printing the command it "would" run.
rm -rf "$CACHE"
out="$(node "$SCRIPT" review o/r#7 --repo o/r --dry-run 2>&1)"
contains "dry-run prints a codex command" "$out" "codex -C"
check "dry-run created nothing on disk" \
  "$(find "$CACHE" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')" "0"

# ---------------------------------------------------------------------------
# The remaining cases need a real repository. Build a synthetic one with a
# pull ref, so no network or GitHub account is involved.

note "clean is precise (synthetic repo)"
UPSTREAM="$SANDBOX/upstream"
mkdir -p "$UPSTREAM" && git -C "$UPSTREAM" init --quiet -b main
git -C "$UPSTREAM" config user.email t@t && git -C "$UPSTREAM" config user.name t
echo base >"$UPSTREAM/f.txt"
git -C "$UPSTREAM" add -A && git -C "$UPSTREAM" commit --quiet -m base
git -C "$UPSTREAM" checkout --quiet -b feature
echo change >>"$UPSTREAM/f.txt"
git -C "$UPSTREAM" add -A && git -C "$UPSTREAM" commit --quiet -m change
git -C "$UPSTREAM" update-ref refs/pull/7/head refs/heads/feature
git -C "$UPSTREAM" checkout --quiet main

# The host repo must live under <cache>/repos/ or the purge guard is never
# reached and a "clone survived" assertion would pass for the wrong reason.
HOST="$CACHE/repos/o__r"
mkdir -p "$CACHE/repos"
git clone --quiet "$UPSTREAM" "$HOST"
WT="$CACHE/worktrees/o__r/pr-7"
# Worktrees live at <cache>/worktrees/<owner>__<repo>/pr-<n>, and `clean` will
# not recursively delete a path that is not there. Fixtures used to invent
# convenient paths, which meant they exercised a layout prepare never produces.
git -C "$HOST" fetch --quiet origin '+refs/pull/7/head:refs/codex-pr-reviewer/pr/7'
git -C "$HOST" branch --force codex-pr/7-base "$(git -C "$HOST" merge-base origin/main refs/codex-pr-reviewer/pr/7)"
git -C "$HOST" worktree add --quiet --force -B codex-pr/7 "$WT" refs/codex-pr-reviewer/pr/7
# `clean` deletes a branch only when its tip is still the commit the manifest
# recorded, so these have to be the real OIDs rather than placeholders.
OID_7="$(git -C "$HOST" rev-parse refs/heads/codex-pr/7)"
OID_7_BASE="$(git -C "$HOST" rev-parse refs/heads/codex-pr/7-base)"

# Two entries sharing one repoDir, so the shared-clone case is exercised.
mkdir -p "$CACHE"
cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#7","repo":"o/r","number":7,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$WT","repoDir":"$HOST","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/7","baseBranch":"codex-pr/7-base",
  "refs":["refs/codex-pr-reviewer/pr/7"],"headSha":"$OID_7","mergeBase":"$OID_7_BASE",
  "baseRefName":"main","additions":1,"deletions":0,"changedFiles":1,
  "preparedAt":"2026-01-01T00:00:00.000Z"},
 {"key":"o/r#9","repo":"o/r","number":9,"title":"t9","url":"u9","state":"OPEN","author":"a",
  "worktree":"$CACHE/worktrees/o__r/pr-9","repoDir":"$HOST","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/9","baseBranch":"codex-pr/9-base","refs":[],
  "headSha":"0","mergeBase":"0","baseRefName":"main","additions":1,"deletions":0,
  "changedFiles":1,"preparedAt":"2026-01-01T00:00:00.000Z"}
]}
JSON

# Regression: a missing worktree directory caused `list` to delete the manifest
# entry, destroying the only record of branches/refs in the user's real repo.
out="$(node "$SCRIPT" list 2>&1)"
contains "list flags a missing worktree" "$out" "worktree directory is gone"
check "list kept both entries" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key"')" "2"

# Regression: --purge-clones deleted a cached clone shared by another entry,
# leaving that entry's worktree dead but still advertised.
# Regression: only the reviews list was digest-bound, so everything else was
# re-selected by the confirmed run. A PR prepared between the dry run and the
# confirmation matched the same selector — `--all` most obviously — and was
# removed without ever appearing in the plan anyone approved.
STALE_PLAN="$(plan_digest --pr o/r#9)"
out="$(node "$SCRIPT" clean --pr o/r#7 --confirm-plan "$STALE_PLAN" 2>&1)"
contains "a digest for a different plan is refused" "$out" "no longer what that plan digest described"
out="$(node "$SCRIPT" clean --pr o/r#7 2>&1)"
contains "cleaning without a plan digest is refused" "$out" "without \`--confirm-plan"
check "and nothing was removed" \
  "$(git -C "$HOST" branch --list 'codex-pr/7*' | wc -l | tr -d ' ')" "2"

out="$(cclean --pr o/r#7 --purge-clones 2>&1)"
contains "shared clone is kept" "$out" "still used by another prepared PR"
check "clone survives on disk" "$([[ -d "$HOST" ]] && echo yes || echo no)" "yes"
check "target branches are gone" \
  "$(git -C "$HOST" branch --list 'codex-pr/7*' | wc -l | tr -d ' ')" "0"

# Regression: a failed branch deletion was swallowed and the manifest entry
# dropped anyway, so the leftover branch could never be cleaned.
git -C "$HOST" worktree add --quiet --force -B codex-pr/9 "$CACHE/worktrees/o__r/pr-9" main
git -C "$HOST" branch --force codex-pr/9-base main
git -C "$HOST" checkout --quiet -b blocker codex-pr/9-base 2>/dev/null || true
git -C "$HOST" checkout --quiet codex-pr/9-base
cclean --pr o/r#9 >"$SANDBOX/clean.out" 2>&1
status=$?
contains "failed deletion is reported" "$(cat "$SANDBOX/clean.out")" "could not remove"
check "clean exits nonzero on partial failure" "$status" "1"
check "entry retained for retry" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key": "o/r#9"')" "1"

# ---------------------------------------------------------------------------

note "review output hygiene (stub codex)"
# A codex whose --version fails, so the footer's `|| "codex"` fallback is
# exercised, and whose review run exits nonzero having still printed a body.
hygiene_codex() {
  env CPR_STUB_VERSION= CPR_STUB_VERSION_EXIT=3 \
      CPR_STUB_RUN_BODY="P1 finding" CPR_STUB_RUN_EXIT=2 \
      PATH="$STUBS:$PATH" "$@"
}

git -C "$HOST" checkout --quiet main
# `review --no-prepare` now checks the worktree is still the one that was
# prepared — it exists, it is a worktree of its own, and its HEAD and base are
# the commits the manifest recorded. So the fixture is a real worktree at real
# OIDs rather than a directory and two invented hashes.
git -C "$HOST" fetch --quiet origin '+refs/pull/7/head:refs/codex-pr-reviewer/pr/7'
git -C "$HOST" worktree add --quiet --force -B codex-pr/o__r/7 "$WT" refs/codex-pr-reviewer/pr/7
git -C "$HOST" branch --force codex-pr/o__r/7-base \
  "$(git -C "$HOST" merge-base origin/main refs/codex-pr-reviewer/pr/7)"
WT_HEAD="$(git -C "$WT" rev-parse HEAD)"
WT_BASE="$(git -C "$HOST" rev-parse refs/heads/codex-pr/o__r/7-base)"
cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#7","repo":"o/r","number":7,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$WT","repoDir":"$HOST","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/o__r/7","baseBranch":"codex-pr/o__r/7-base","refs":[],
  "headSha":"$WT_HEAD","mergeBase":"$WT_BASE","baseRefName":"main",
  "additions":1,"deletions":0,"changedFiles":1,"preparedAt":"2026-01-01T00:00:00.000Z"}
]}
JSON

# Regression: streamed review text shared stdout with the --json payload.
out="$(hygiene_codex node "$SCRIPT" review o/r#7 --repo o/r --no-prepare --json 2>/dev/null)"
if printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{JSON.parse(s);})' 2>/dev/null; then
  printf '  ok   review --json emits parseable JSON\n'; pass=$((pass + 1))
else
  printf '  FAIL review --json is polluted by review text\n'; fail=$((fail + 1))
fi

# Regression: the wrapper returned codex's exit status, so a sweep marked
# healthy PRs as failed whenever codex exited nonzero.
hygiene_codex node "$SCRIPT" review o/r#7 --repo o/r --no-prepare >/dev/null 2>&1
check "wrapper exits 0 when the review was saved" "$?" "0"

# Regression: `?? "codex"` could not catch the "" from a failed version probe,
# leaving an empty model name in a footer meant for public PR comments.
saved="$(ls -t "$CACHE"/reviews/*.md 2>/dev/null | head -1)"
contains "footer names a model" "$(cat "$saved")" "Automated review by codex"

# Regression: --no-prepare took the manifest entirely on trust. The gap between
# preparing and reviewing is where a clean runs, where somebody opens the
# directory, where a branch gets checked out elsewhere — and a review of
# whatever is there now, labelled with the head the manifest remembers, is wrong
# about which commits it read.
git -C "$WT" checkout --quiet --detach HEAD~1 2>/dev/null || git -C "$WT" commit --quiet --allow-empty -m moved
out="$(hygiene_codex node "$SCRIPT" review o/r#7 --repo o/r --no-prepare 2>&1)"
contains "a moved worktree head is refused" "$out" "not the"
contains "and says how to fix it" "$out" "--no-prepare"
git -C "$WT" checkout --quiet -B codex-pr/o__r/7 "$WT_HEAD"

# `codex review --base` diffs the working tree, not the commit. An uncommitted
# edit is therefore reviewed as part of the pull request while HEAD and the base
# both still match the manifest — and the saved review carries the real PR's
# title and head over findings about content the PR does not contain. The one
# failure here that needs no attacker and no race.
echo "SECRET BACKDOOR" >>"$WT/f.txt"
out="$(hygiene_codex node "$SCRIPT" review o/r#7 --repo o/r --no-prepare 2>&1)"
contains "an uncommitted edit is refused" "$out" "uncommitted change"
contains "and the first one is named" "$out" "f.txt"
git -C "$WT" checkout --quiet -- f.txt

# An untracked file counts too: it is in the tree codex is pointed at.
printf 'x\n' >"$WT/dropped-in.txt"
out="$(hygiene_codex node "$SCRIPT" review o/r#7 --repo o/r --no-prepare 2>&1)"
contains "an untracked file is refused" "$out" "uncommitted change"
rm -f "$WT/dropped-in.txt"

# Regression: the head and base probes read `.stdout.trim()` and ignored git's
# exit status, so a command that could not answer produced "" — falsy — and the
# comparison guarding it was skipped. Verification passed precisely when it
# could not verify.
out="$(hygiene_codex node "$SCRIPT" review o/r#7 --repo o/r --no-prepare 2>&1)"
check "a clean worktree still passes" "$(printf '%s' "$out" | grep -c 'uncommitted change')" "0"

# The same check, one step earlier: the directory is not there at all.
mv "$WT" "$WT.moved"
out="$(hygiene_codex node "$SCRIPT" review o/r#7 --repo o/r --no-prepare 2>&1)"
contains "a worktree that is gone is refused" "$out" "is gone"
mv "$WT.moved" "$WT"

note "batch clean of two PRs sharing one cached clone"
# Regression: the shared-clone guard compared against post-batch survivors, so
# with --all the FIRST entry deleted the clone and every later entry in the same
# batch silently skipped its branch/ref removal — and reported success anyway.
git -C "$HOST" checkout --quiet main 2>/dev/null
for n in 21 22; do
  git -C "$HOST" fetch --quiet origin "+refs/pull/7/head:refs/codex-pr-reviewer/pr/$n"
  git -C "$HOST" branch --force "codex-pr/$n" refs/codex-pr-reviewer/pr/"$n"
  git -C "$HOST" branch --force "codex-pr/$n-base" main
done
# Both entries point at the same two commits, so one pair of OIDs describes both.
OID_HEAD="$(git -C "$HOST" rev-parse refs/heads/codex-pr/21)"
OID_BASE="$(git -C "$HOST" rev-parse refs/heads/codex-pr/21-base)"
cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#21","repo":"o/r","number":21,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$CACHE/worktrees/o__r/pr-21","repoDir":"$HOST","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/21","baseBranch":"codex-pr/21-base",
  "refs":["refs/codex-pr-reviewer/pr/21"],"headSha":"$OID_HEAD","mergeBase":"$OID_BASE",
  "baseRefName":"main","additions":1,"deletions":0,"changedFiles":1,
  "preparedAt":"2026-01-01T00:00:00.000Z"},
 {"key":"o/r#22","repo":"o/r","number":22,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$CACHE/worktrees/o__r/pr-22","repoDir":"$HOST","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/22","baseBranch":"codex-pr/22-base",
  "refs":["refs/codex-pr-reviewer/pr/22"],"headSha":"$OID_HEAD","mergeBase":"$OID_BASE",
  "baseRefName":"main","additions":1,"deletions":0,"changedFiles":1,
  "preparedAt":"2026-01-01T00:00:00.000Z"}
]}
JSON

out="$(cclean --all 2>&1)"
# The second entry must report its own branches, not silently skip them.
contains "later entry still removes its branches" "$out" "branch codex-pr/22"
contains "later entry still removes its refs" "$out" "refs/codex-pr-reviewer/pr/22"
check "clone is purged exactly once" \
  "$(printf '%s' "$out" | grep -c "^  - clone ")" "1"
check "clone is gone" "$([[ -d "$HOST" ]] && echo present || echo gone)" "gone"
check "manifest is emptied" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key"')" "0"

note "a recursive delete does not trust the path it was handed"
# The manifest is a JSON file in a cache directory: hand-edited when something
# goes wrong, and writable by anything running as this user. `clean` fed
# entry.worktree straight to rmSync(recursive) without checking it was a path
# this plugin could have created.
rm -rf "$CACHE"; mkdir -p "$CACHE" "$SANDBOX/precious"
printf 'do not delete me\n' >"$SANDBOX/precious/keep.txt"
cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#31","repo":"o/r","number":31,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$SANDBOX/precious","repoDir":"$SANDBOX/none","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/o__r/31","baseBranch":"codex-pr/o__r/31-base","refs":[],
  "headSha":"0","mergeBase":"0","baseRefName":"main","additions":1,"deletions":0,
  "changedFiles":1,"preparedAt":"2026-01-01T00:00:00.000Z"}
]}
JSON
# Writes a one-entry manifest with the four attacker-controlled fields varied,
# so each rejection branch is exercised rather than only the path one.
bad_entry() {
  cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#31","repo":$1,"number":$2,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$SANDBOX/precious","repoDir":"$SANDBOX/none","remote":"origin","mode":"clone",
  "headBranch":$3,"baseBranch":"codex-pr/o__r/31-base","refs":$4,
  "headSha":"0","mergeBase":"0","baseRefName":"main","additions":1,"deletions":0,
  "changedFiles":1,"preparedAt":"2026-01-01T00:00:00.000Z"}
]}
JSON
}

bad_entry '"o/r"' 31 '"codex-pr/o__r/31"' '[]'
out="$(cclean --all 2>&1)"
contains "a worktree outside the cache layout is refused" "$out" "is not where one for o/r#31 belongs"

# Recomputing the path is not enough by itself: `pr-${number}` with a traversal
# in it normalizes out of the cache, so an entry naming that path on both sides
# compares equal to itself. The number is rejected as a value first.
bad_entry '"o/r"' '"1/../../../tmp/x"' '"codex-pr/o__r/31"' '[]'
out="$(cclean --all 2>&1)"
contains "a traversal in the PR number is refused" "$out" "is not a positive integer"

# Branches and refs are deleted outright, in the user's own repository, and
# were never namespace-checked at all — `refs/heads/main` would have been fed
# straight to `update-ref -d`.
bad_entry '"o/r"' 31 '"main"' '[]'
out="$(cclean --all 2>&1)"
contains "a branch outside the plugin namespace is refused" "$out" "is outside \`codex-pr/\`"

bad_entry '"o/r"' 31 '"codex-pr/o__r/31"' '["refs/heads/main"]'
out="$(cclean --all 2>&1)"
contains "a ref outside the plugin namespace is refused" "$out" "is outside \`refs/codex-pr-reviewer/\`"

check "and the directory is still there" \
  "$([[ -f "$SANDBOX/precious/keep.txt" ]] && echo kept || echo deleted)" "kept"
check "the entry stays for a retry" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key"')" "1"
rm -rf "$CACHE" "$SANDBOX/precious"

note "doctor checks the codex interface, not just that codex exists"
# Regression in spirit: --context shipped broken across several releases because
# nothing asked the binary whether it accepted what the plugin was building.
# `--help` exits 0 for a subcommand that does not exist, so the flag text is the
# only usable signal.
# Self-contained: this block runs before the doctorstub directory further down
# exists, so without its own `gh` it falls through to whatever is on PATH — which
# passed locally against an authenticated gh and failed in CI against one that
# is installed but not logged in. A preflight test that depends on the ambient
# toolchain is testing the machine, not the code.
mkdir -p "$SANDBOX/preflight"
cat >"$SANDBOX/preflight/gh" <<'STUB'
#!/bin/sh
case "$1" in
  --version) echo "gh version 0.0.0 (stub)" ;;
  auth) echo "  - Active account: true (account stub-user)" ;;
esac
exit 0
STUB
chmod +x "$SANDBOX/preflight/gh"
# Named, so the two assertions below cannot end up describing different stubs.
without_base() {
  env CPR_STUB_PROBE_BASE=no PATH="$SANDBOX/preflight:$STUBS:$PATH" "$@"
}
out="$(without_base node "$SCRIPT" doctor 2>&1)"
contains "a codex without --base is refused" "$out" "does not accept --base"
contains "and the remedy names the upgrade" "$out" "npm install -g @openai/codex"
check "and doctor fails rather than warning" \
  "$(without_base node "$SCRIPT" doctor >/dev/null 2>&1; echo $?)" "1"

# A codex whose `review --help` never answers is a different problem from one
# that answers without --base, and telling someone to reinstall the CLI cannot
# fix a crash or a hang.
out="$(CPR_STUB_PROBE_ERR="error: could not connect" CPR_STUB_PROBE_EXIT=70 \
  PATH="$SANDBOX/preflight:$STUBS:$PATH" node "$SCRIPT" doctor 2>&1)"
contains "a probe that fails is not reported as a missing flag" "$out" "exited 70"
check "and does not send the user to reinstall" \
  "$(printf '%s' "$out" | grep -c 'npm install -g @openai/codex')" "0"

# The same stub, answering with --base. Asserted on doctor's exit status, not on
# the absence of one message: "no complaint about --base" is also satisfied by a
# doctor that fell over for some entirely unrelated reason.
check "a codex that accepts --base passes the preflight" \
  "$(PATH="$SANDBOX/preflight:$STUBS:$PATH" node "$SCRIPT" doctor >/dev/null 2>&1; echo $?)" "0"

note "concurrent manifest writers do not lose each other's entries"
# Regression: writing was atomic — temp file, rename over — but mutating was
# not. Every change reads the whole manifest, edits one entry, and writes it all
# back, so two overlapping ones meant the second silently discarded the first.
# `sweep` prepares several PRs at once and a background review re-records its
# own entry, so this is the normal case, not a rare one. A lost entry is a
# branch and a worktree in a real repository that nothing has a record of.
rm -rf "$CACHE"
# The module path goes through the environment, not argv: `node -e` puts the
# first argument in argv[1], where it would match the module's own path and
# satisfy the direct-invocation guard — running main() instead of importing.
for i in $(seq 1 8); do
  # --input-type=module: `node -e` is CommonJS by default, where top-level
  # await is a syntax error. Node 22 tolerates it, Node 18 — the documented
  # floor — does not, which is what the floor leg of the matrix is for.
  CPR_MODULE="$SCRIPT" CPR_N="$i" node --input-type=module -e '
    const { mutateManifest } = await import(process.env.CPR_MODULE);
    const number = Number(process.env.CPR_N);
    mutateManifest((m) => ({
      ...m,
      entries: [...m.entries, { key: `o/r#${number}`, repo: "o/r", number, preparedAt: new Date().toISOString() }]
    }));
  ' &
done
wait
check "all 8 concurrent writers survived" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key"')" "8"
check "the lock file is released" \
  "$(ls "$CACHE"/manifest.json.lock 2>/dev/null | wc -l | tr -d ' ')" "0"
rm -rf "$CACHE"

note "a clean removes the generation it cleaned, not the key"
# Regression: `clean` did its work from a snapshot and then removed manifest
# entries by key. A PR prepared again in between has the same key and an
# entirely different worktree and branches, so the new record was deleted and
# what it described was left recorded nowhere.
rm -rf "$CACHE"; mkdir -p "$CACHE"
cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#41","repo":"o/r","number":41,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$CACHE/worktrees/o__r/pr-41","repoDir":"$SANDBOX/none","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/o__r/41","baseBranch":"codex-pr/o__r/41-base","refs":[],
  "headSha":"0","mergeBase":"0","baseRefName":"main","additions":1,"deletions":0,"changedFiles":1,
  "preparedAt":"2026-01-01T00:00:00.000Z","generation":"gen-one"}
]}
JSON
PLAN="$(plan_digest --all)"
# Stand in for a prepare that lands mid-clean: same key, a new generation.
cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#41","repo":"o/r","number":41,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$CACHE/worktrees/o__r/pr-41","repoDir":"$SANDBOX/none","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/o__r/41","baseBranch":"codex-pr/o__r/41-base","refs":[],
  "headSha":"0","mergeBase":"0","baseRefName":"main","additions":1,"deletions":0,"changedFiles":1,
  "preparedAt":"2026-02-02T00:00:00.000Z","generation":"gen-two"}
]}
JSON
out="$(node "$SCRIPT" clean --all --confirm-plan "$PLAN" 2>&1)"
contains "a re-prepared PR invalidates the confirmed plan" "$out" "no longer what that plan digest described"
check "and its record survives" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"generation": "gen-two"')" "1"
rm -rf "$CACHE"

note "saved reviews are identifiable on disk"
# `post` was removed in 0.9.0 and with it every assertion about publishing.
# What is still worth pinning down is that a saved review is recognisable as
# one — the marker and the name are what `clean --purge-reviews` selects on,
# and what tells a person opening the file whether the run actually finished.
REVIEWS="$CACHE/reviews"
# Saved reviews are named `<slug>-pr<N>-<stamp>.md`, and the stamp is part of
# what identifies one.
STAMP="2026-01-01T00-00-00-000Z"
mkdir -p "$REVIEWS"
printf '<!-- codex-pr-reviewer exit=0 -->\n# Codex review\n\nP1: a real finding.\n' >"$REVIEWS/o__r-pr7-$STAMP.md"
printf '<!-- codex-pr-reviewer exit=1 -->\n# Codex review\n\nReview was interrupted.\n' >"$REVIEWS/o__r-pr8-$STAMP.md"

contains "a review records the exit status of its run" \
  "$(head -1 "$REVIEWS/o__r-pr7-$STAMP.md")" "exit=0"
contains "a failed run is distinguishable on disk" \
  "$(head -1 "$REVIEWS/o__r-pr8-$STAMP.md")" "exit=1"
rm -f "$CACHE/manifest.json"

note "clean --purge-reviews cannot overreach"
# Three defects found reviewing the change that added the flag, each of them
# fatal to a file that cannot be regenerated: a prefix match that reached
# another repository's reviews, a plan recomputed by the process that acts on
# it, and a failed deletion that cleared its manifest entry anyway.
rm -rf "$CACHE"
PURGE_WT="$CACHE/worktrees/o__r/pr-7"
mkdir -p "$REVIEWS" "$PURGE_WT"
mk_review() { printf '<!-- codex-pr-reviewer exit=0 -->\n# Codex review\n\nP1: a finding.\n' >"$1"; }
plan_field() {
  node "$SCRIPT" clean --all --purge-reviews --dry-run --json >"$SANDBOX/plan.json" 2>/dev/null
  node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
    const v=j[process.argv[2]];console.log(Array.isArray(v)?v.length:v)' "$SANDBOX/plan.json" "$1"
}
write_manifest() {
  cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#7","repo":"o/r","number":7,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$PURGE_WT","repoDir":"$SANDBOX/none","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/7","baseBranch":"codex-pr/7-base","refs":[],
  "headSha":"0","mergeBase":"0","baseRefName":"main","additions":1,"deletions":0,
  "changedFiles":1,"preparedAt":"2026-01-01T00:00:00.000Z"}
]}
JSON
}
write_manifest
mk_review "$REVIEWS/o__r-pr7-$STAMP.md"
mk_review "$REVIEWS/o__r-pr7-2026-02-02T00-00-00-000Z.md"
mk_review "$REVIEWS/o__r-pr7-archive-pr9-$STAMP.md"   # o/r-pr7-archive#9, not o/r#7
mk_review "$REVIEWS/o__other-pr3-$STAMP.md"

check "the plan covers this PR's reviews only" "$(plan_field reviews)" "2"
DIGEST="$(plan_field reviewsDigest)"

out="$(cclean --all --purge-reviews 2>&1)"
contains "purging without a confirmed snapshot is refused" "$out" "--confirm-reviews"
check "a refused run deletes nothing" "$(ls "$REVIEWS" | wc -l | tr -d ' ')" "4"
out="$(cclean --all --purge-reviews --confirm-reviews 000000000000 2>&1)"
contains "a digest for another set is refused" "$out" "not the ones that digest approved"
check "still nothing deleted" "$(ls "$REVIEWS" | wc -l | tr -d ' ')" "4"

# The plan is shown by one process and carried out by another. A review saved in
# between — a background review, a sweep finishing — was in nobody's plan.
mk_review "$REVIEWS/o__r-pr7-2026-03-03T00-00-00-000Z.md"
out="$(cclean --all --purge-reviews --confirm-reviews "$DIGEST" 2>&1)"
contains "a review saved after the plan aborts the run" "$out" "not the ones that digest approved"
check "and that review is still there" \
  "$([[ -f "$REVIEWS/o__r-pr7-2026-03-03T00-00-00-000Z.md" ]] && echo present || echo gone)" "present"

# A review that could not be deleted must hold its PR in the manifest: reviews
# of a PR no longer recorded there can never be selected again.
#
# The obstruction is a directory sitting where a review file is expected, which
# `unlink` refuses for every user. A read-only parent directory would not do:
# root ignores directory permissions, so the suite would pass as you and fail in
# any container that runs it as root.
OBSTRUCTION="$REVIEWS/o__r-pr7-2026-04-04T00-00-00-000Z.md"
mkdir "$OBSTRUCTION"
DIGEST="$(plan_field reviewsDigest)"
out="$(cclean --all --purge-reviews --confirm-reviews "$DIGEST" 2>&1)"
contains "a failed review deletion is reported" "$out" "could not remove review"
check "its entry stays for a retry" "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key"')" "1"
check "the reviews that could be deleted were" \
  "$(ls "$REVIEWS" | grep -c '^o__r-pr7-2026-0[123]-')" "0"

# Cleared, the retry finishes the job — including a review saved since.
rmdir "$OBSTRUCTION"
mk_review "$REVIEWS/o__r-pr7-2026-05-05T00-00-00-000Z.md"
DIGEST="$(plan_field reviewsDigest)"
out="$(cclean --all --purge-reviews --confirm-reviews "$DIGEST" 2>&1)"
check "the retry removes what is left" "$(printf '%s' "$out" | grep -c '^  - review ')" "1"
check "another repo's colliding review survives" \
  "$([[ -f "$REVIEWS/o__r-pr7-archive-pr9-$STAMP.md" ]] && echo present || echo gone)" "present"
check "an unrelated review survives" \
  "$([[ -f "$REVIEWS/o__other-pr3-$STAMP.md" ]] && echo present || echo gone)" "present"
check "the manifest is empty" "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key"')" "0"

# Without the flag, reviews are untouched and no confirmation is needed.
write_manifest
mkdir -p "$PURGE_WT"
out="$(cclean --all 2>&1)"
check "a plain clean keeps every review" "$(ls "$REVIEWS" | wc -l | tr -d ' ')" "2"
contains "and says so" "$out" "Kept 2 saved reviews"

# What survives has to be reported on every path that reports a clean. The
# documented flow runs with --json, where the prose line is never reached, and
# those survivors are exactly the ones no later --purge-reviews can select.
kept_json() {
  node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
    console.log(j.keptReviews ? j.keptReviews.count : "absent")' "$1"
}
write_manifest
mkdir -p "$PURGE_WT"
cclean --all --json >"$SANDBOX/cleaned.json" 2>/dev/null
check "a --json clean reports what it kept" "$(kept_json "$SANDBOX/cleaned.json")" "2"
node "$SCRIPT" clean --all --purge-reviews --dry-run --json >"$SANDBOX/plan.json" 2>/dev/null
check "a --json dry run reports what would remain" "$(kept_json "$SANDBOX/plan.json")" "2"
# Nothing selected is still a run whose answer is "these reviews are still here".
out="$(cclean --all 2>&1)"
contains "an empty clean still reports them" "$out" "Kept 2 saved reviews"
contains "and says there was nothing to clean" "$out" "Nothing to clean."
rm -f "$CACHE/manifest.json"

note "a review in flight is not cleaned out from under itself"
# Regression: nothing recorded that a review was running, so `clean` removed the
# worktree codex was reading and the manifest entry its output needs — and the
# review then wrote a file no later --purge-reviews could ever select, because
# selection starts from the manifest entry that had just been dropped.
rm -rf "$CACHE"
RUN_WT="$CACHE/worktrees/o__r/pr-7"
# $HOST lives under $CACHE, so the wipe above takes it too. This block builds
# its own host repo — and it has to be a real one, because the review below
# goes through --no-prepare, which will not run against a directory that merely
# looks like a prepared worktree.
RUN_HOST="$CACHE/repos/o__r"
mkdir -p "$CACHE" "$REVIEWS" "$SANDBOX/inflight-stub"

# Rebuilt between cases rather than mkdir'd back: the cleans below delete the
# clone as well as the worktree, and a --no-prepare review checks that what it
# is about to read is a real worktree at the commits the manifest recorded.
# Call this before inflight_manifest — the OIDs change each time.
remake_run_worktree() {
  rm -rf "$RUN_HOST" "$RUN_WT"
  mkdir -p "$RUN_HOST"
  git -C "$RUN_HOST" init --quiet -b main
  git -C "$RUN_HOST" config user.email t@t && git -C "$RUN_HOST" config user.name t
  echo base >"$RUN_HOST/f.txt"
  git -C "$RUN_HOST" add -A && git -C "$RUN_HOST" commit --quiet -m base
  git -C "$RUN_HOST" branch --force codex-pr/o__r/7-base main
  git -C "$RUN_HOST" worktree add --quiet --force -B codex-pr/o__r/7 "$RUN_WT" main
  RUN_HEAD="$(git -C "$RUN_WT" rev-parse HEAD)"
  RUN_BASE="$(git -C "$RUN_HOST" rev-parse refs/heads/codex-pr/o__r/7-base)"
}
remake_run_worktree

inflight_manifest() {
  cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#7","repo":"o/r","number":7,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$RUN_WT","repoDir":"$RUN_HOST","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/o__r/7","baseBranch":"codex-pr/o__r/7-base","refs":[],
  "headSha":"$RUN_HEAD","mergeBase":"$RUN_BASE","baseRefName":"main",
  "additions":1,"deletions":0,"changedFiles":1,"preparedAt":"2026-01-01T00:00:00.000Z"}
]}
JSON
}
json_at() {
  node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
    const v=process.argv[2].split(".").reduce((o,k)=>(o == null ? o : o[k]), j);
    console.log(Array.isArray(v) ? v.length : String(v))' "$1" "$2"
}

inflight_manifest
mk_review "$REVIEWS/o__r-pr7-$STAMP.md"
# A marker for a review that really is running, written the way the script does.
sleep 120 &
LIVE_PID=$!
node -e 'const fs=require("node:fs"),os=require("node:os"),[,dir,pid,saving]=process.argv;
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(`${dir}/o__r-pr7-${pid}.json`, JSON.stringify({
    key:"o/r#7",repo:"o/r",number:7,pid:Number(pid),host:os.hostname(),
    startedAt:new Date().toISOString(),reviewPath:saving}))' \
  "$CACHE/runs" "$LIVE_PID" "$REVIEWS/o__r-pr7-$STAMP.md"

node "$SCRIPT" clean --all --purge-reviews --dry-run --json >"$SANDBOX/inflight-plan.json" 2>/dev/null
check "the plan removes nothing while a review runs" \
  "$(json_at "$SANDBOX/inflight-plan.json" wouldRemove)" "0"
check "and plans no review deletion" "$(json_at "$SANDBOX/inflight-plan.json" reviews)" "0"
check "the running review is reported" "$(json_at "$SANDBOX/inflight-plan.json" running)" "1"
check "and marked as held" "$(json_at "$SANDBOX/inflight-plan.json" running.0.held)" "true"

out="$(cclean --all --purge-reviews 2>&1)"
contains "a real run holds the entry back" "$out" "Held back 1 entry"
contains "and names the PR it held" "$out" "o/r#7"
contains "and how to override it" "$out" "--include-running"
check "it does not claim there was nothing to clean" \
  "$(printf '%s' "$out" | grep -c 'Nothing to clean')" "0"
# An empty deletion set is nothing to approve, so the digest is not demanded.
check "and asks for no confirmation it has no subject for" \
  "$(printf '%s' "$out" | grep -c 'confirm-reviews')" "0"
check "the held entry stays in the manifest" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key": "o/r#7"')" "1"
check "the worktree being read survives" \
  "$([[ -d "$RUN_WT" ]] && echo present || echo gone)" "present"
check "so does its saved review" "$(ls "$REVIEWS" | wc -l | tr -d ' ')" "1"

# A cached clone shared with a held entry has to survive the batch too: it is the
# repository the running review is reading, and --all implies --purge-clones.
HELD_CLONE="$CACHE/repos/o__r"
mkdir -p "$HELD_CLONE" "$CACHE/worktrees/o__r/pr-8"
cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#7","repo":"o/r","number":7,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$RUN_WT","repoDir":"$HELD_CLONE","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/7","baseBranch":"codex-pr/7-base","refs":[],
  "headSha":"0","mergeBase":"0","baseRefName":"main","additions":1,"deletions":0,
  "changedFiles":1,"preparedAt":"2026-01-01T00:00:00.000Z"},
 {"key":"o/r#8","repo":"o/r","number":8,"title":"t8","url":"u8","state":"OPEN","author":"a",
  "worktree":"$CACHE/worktrees/o__r/pr-8","repoDir":"$HELD_CLONE","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/8","baseBranch":"codex-pr/8-base","refs":[],
  "headSha":"0","mergeBase":"0","baseRefName":"main","additions":1,"deletions":0,
  "changedFiles":1,"preparedAt":"2026-01-01T00:00:00.000Z"}
]}
JSON
out="$(cclean --all 2>&1)"
contains "the entry with no review running is still cleaned" "$out" "o/r#8"
contains "and the shared clone is kept for the held one" "$out" "still used by another prepared PR"
check "so the repository being reviewed survives" \
  "$([[ -d "$HELD_CLONE" ]] && echo present || echo gone)" "present"
check "and only the held entry is left" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key"')" "1"

# The override exists so a leaked guard can never wedge cleanup — and it says so.
inflight_manifest
out="$(cclean --all --include-running 2>&1)"
contains "--include-running says what it is overriding" "$out" "still running"
check "and cleans the entry anyway" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key"')" "0"

# A killed review leaves its marker behind. A pid that is gone means the run is:
# it must hold nothing back, and the marker must not survive the next clean.
kill "$LIVE_PID" 2>/dev/null
wait "$LIVE_PID" 2>/dev/null
remake_run_worktree
inflight_manifest
out="$(cclean --all 2>&1)"
check "a dead run holds nothing back" "$(printf '%s' "$out" | grep -c 'Held back')" "0"
check "and its marker is swept" "$(ls "$CACHE/runs" 2>/dev/null | wc -l | tr -d ' ')" "0"
check "the entry is cleaned" "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key"')" "0"

# The other half of the race: a clean that overrides the guard — or that took its
# snapshot before this run recorded itself — leaves the finished review with no
# manifest entry, and a review whose PR is absent from the manifest can never be
# selected again. The stub below is that clean, running while codex "reviews".
remake_run_worktree
inflight_manifest
rm -f "$REVIEWS"/*.md
# The hook runs while codex is "reviewing", which is the whole point: it lists
# the run marker that exists only during a run, then performs the clean whose
# race with that run is what this section tests. Expanded here, so the paths are
# literal by the time the stub reads it.
INFLIGHT_HOOK="ls '$CACHE/runs' | sed 's/^/marker: /'
node '$SCRIPT' clean --all --purge-reviews --dry-run >'$SANDBOX/held-mid-review.out' 2>&1
'$SANDBOX/cclean.sh' --all --include-running >'$SANDBOX/override-mid-review.out' 2>&1"
inflight_codex() {
  env CPR_STUB_VERSION="codex-cli stub" \
      CPR_STUB_RUN_HOOK="$INFLIGHT_HOOK" \
      CPR_STUB_RUN_BODY="P1 finding from a review that outlived its manifest entry" \
      PATH="$STUBS:$PATH" "$@"
}

out="$(inflight_codex node "$SCRIPT" review o/r#7 --repo o/r --no-prepare 2>&1)"
contains "the marker is visible while the review runs" "$out" "marker: o__r-pr7-"
contains "a clean during the review holds the entry back" \
  "$(cat "$SANDBOX/held-mid-review.out")" "Held back 1 entry"
contains "the override reports what it took anyway" \
  "$(cat "$SANDBOX/override-mid-review.out")" "still running"
contains "the finished review re-records its PR" "$out" "Re-recorded o/r#7"
check "the entry is back in the manifest" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key": "o/r#7"')" "1"
check "so a later purge can still select the review" "$(plan_field reviews)" "1"
check "and the marker is gone once the review finished" \
  "$(ls "$CACHE/runs" 2>/dev/null | wc -l | tr -d ' ')" "0"

note "doctor detects a stale installed copy"
# Regression: an edited command prompt reached neither the installed copy nor a
# running session, and nothing said so. The rules a run follows — what it may
# fetch, what it may execute, what it may delete — live in those prompts, so a
# silently stale install means the session is following a copy nobody edited.
#
# Simulate Claude Code's layout: a marketplace holding the source, and a copy of
# it under <config>/plugins/cache/<marketplace>/<plugin>/<version>.
CONFIG="$SANDBOX/config"
MK="$SANDBOX/mk"
INSTALLED="$CONFIG/plugins/cache/test-mk/codex-pr-reviewer/9.9.9"
mkdir -p "$MK/.claude-plugin" "$MK/plugins" "$CONFIG/plugins" "$(dirname "$INSTALLED")"
cp -R "$ROOT/plugins/codex-pr-reviewer" "$MK/plugins/codex-pr-reviewer"
cp -R "$MK/plugins/codex-pr-reviewer" "$INSTALLED"
cat >"$MK/.claude-plugin/marketplace.json" <<JSON
{"name":"test-mk","owner":{"name":"t"},
 "plugins":[{"name":"codex-pr-reviewer","source":"./plugins/codex-pr-reviewer"}]}
JSON
cat >"$CONFIG/plugins/known_marketplaces.json" <<JSON
{"test-mk":{"source":{"source":"directory","path":"$MK"},"installLocation":"$MK"}}
JSON

# `gh` and `codex` are stubbed so the preflight stays offline; the assertions
# below are about the plugin check, but doctor's overall ok covers all four.
mkdir -p "$SANDBOX/doctorstub"
cat >"$SANDBOX/doctorstub/gh" <<'STUB'
#!/bin/sh
case "$1" in
  --version) echo "gh version 0.0.0 (stub)" ;;
  auth) echo "  - Active account: true (account stub-user)" ;;
esac
exit 0
STUB
chmod +x "$SANDBOX/doctorstub/gh"

doctor_json() {
  CLAUDE_CONFIG_DIR="$CONFIG" PATH="$SANDBOX/doctorstub:$STUBS:$PATH" \
    node "$1/scripts/pr-workspace.mjs" doctor --json 2>/dev/null
}
field() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const r=JSON.parse(s);const [head,tail]=process.argv[1].split(".");
    console.log(String(tail?r.checks.find(c=>c.name===head)[tail]:r[head]));
  })' "$1"
}

out="$(doctor_json "$INSTALLED")"
check "an in-sync copy is not stale" "$(printf '%s' "$out" | field stale)" "false"
contains "in-sync copy names its marketplace" "$(printf '%s' "$out" | field plugin.detail)" "matches test-mk"

# The source tree itself is never stale: `claude --plugin-dir <source>` and a
# symlinked install both run the very directory they would be compared against.
out="$(doctor_json "$MK/plugins/codex-pr-reviewer")"
contains "running from source is reported as such" \
  "$(printf '%s' "$out" | field plugin.detail)" "running from source"

# Now edit the source the way any prompt change does.
echo "- an edited safety rule" >>"$MK/plugins/codex-pr-reviewer/commands/review.md"
out="$(doctor_json "$INSTALLED")"
check "an edited prompt makes the copy stale" "$(printf '%s' "$out" | field stale)" "true"
contains "the changed prompt is named" "$(printf '%s' "$out" | field plugin.detail)" "commands/review.md"
remedy="$(printf '%s' "$out" | field plugin.remedy)"
contains "the remedy is runnable" "$remedy" "claude plugin update codex-pr-reviewer@test-mk"
contains "the remedy says to restart" "$remedy" "restart Claude Code"
# Warn-level: a stale copy still reviews correctly. Failing the preflight would
# stop every review during development, which is not what staleness costs.
check "staleness does not fail the preflight" "$(printf '%s' "$out" | field ok)" "true"

# A file dropped upstream is stale too — the command it defines still loads.
# Re-sync first, so the leftover is the only difference left to find.
cp "$MK/plugins/codex-pr-reviewer/commands/review.md" "$INSTALLED/commands/review.md"
printf 'a command deleted upstream\n' >"$INSTALLED/commands/removed.md"
out="$(doctor_json "$INSTALLED")"
check "a leftover file makes the copy stale" "$(printf '%s' "$out" | field stale)" "true"
check "the leftover is the only difference" \
  "$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).checks.find(c=>c.name==="plugin").changed.join(",")))')" \
  "commands/removed.md"

# An unknown marketplace layout must not fail the preflight: plenty of installs
# have no local source to compare against at all.
rm -f "$CONFIG/plugins/known_marketplaces.json"
out="$(doctor_json "$INSTALLED")"
check "no known marketplace is not stale" "$(printf '%s' "$out" | field stale)" "false"
contains "no source is stated plainly" "$(printf '%s' "$out" | field plugin.detail)" "no local source"

# ---------------------------------------------------------------------------

note "an unrecognized flag is an error, not a pull request"
# Regression: unknown flags fell through to positionals, on the stated grounds
# that `#42` had to survive — which it does anyway, having no leading dash.
# What actually landed there were typos: `--modle` was read as the PR to review
# and the run went ahead at the default model, silently.
out="$(node "$SCRIPT" review 42 --repo o/r --modle gpt-5.6 --dry-run 2>&1)"
contains "a mistyped flag is rejected" "$out" "Unknown option \`--modle\`"
out="$(node "$SCRIPT" review 42 --repo o/r --context --dry-run 2>&1)"
contains "a retired flag keeps its own explanation" "$out" "it appended a positional prompt"

note "--effort is validated before codex is paid for"
# It is the one option interpolated into a quoted `-c` string rather than
# passed as its own argv entry, so it has to be a value and not a fragment.
out="$(node "$SCRIPT" review 42 --repo o/r --effort 'high" -c foo="bar' --dry-run 2>&1)"
contains "a value that would break out of the quotes is refused" "$out" "is not a reasoning effort"
out="$(node "$SCRIPT" review 42 --repo o/r --effort xhigh --dry-run 2>&1)"
contains "a real effort still reaches codex" "$out" 'model_reasoning_effort="xhigh"'

# ---------------------------------------------------------------------------

note "prepare against a synthetic GitHub (stub gh)"
# The first fixture that drives `prepare` itself. Everything above hand-writes a
# manifest, which cannot reach the fetch, the identity checks, or the checkout —
# the three places the PR's own bytes are handled.
SYMUP="$SANDBOX/sym-upstream"
mkdir -p "$SYMUP" && git -C "$SYMUP" init --quiet -b main
git -C "$SYMUP" config user.email t@t && git -C "$SYMUP" config user.name t
echo base >"$SYMUP/f.txt"
git -C "$SYMUP" add -A && git -C "$SYMUP" commit --quiet -m base
git -C "$SYMUP" checkout --quiet -b feature
# The payload: a link out of the worktree, committed by the pull request.
ln -s /etc/passwd "$SYMUP/escape.txt"
echo change >>"$SYMUP/f.txt"
git -C "$SYMUP" add -A && git -C "$SYMUP" commit --quiet -m "add a link out of the tree"
git -C "$SYMUP" update-ref refs/pull/7/head refs/heads/feature
git -C "$SYMUP" checkout --quiet main

HEAD_OID="$(git -C "$SYMUP" rev-parse refs/pull/7/head)"
BASE_OID="$(git -C "$SYMUP" rev-parse refs/heads/main)"

# A `gh` that serves this one pull request and clones from the synthetic
# upstream, so `prepare` runs its real code path with no network.
#
# The fetch has to reach a local repository while the *identity* checks see what
# git would really contact, and those two cannot be reconciled with `insteadOf`:
# `git remote -v` reports the rewritten URL, which is the honest answer and the
# one the host check wants. So the fixture takes the cache-clone route instead,
# which is what preparing someone else's repository does anyway.
mkdir -p "$SANDBOX/ghstub"
cat >"$SANDBOX/ghstub/gh" <<'GHSTUB'
#!/bin/sh
case "${1:-}" in
  --version) echo "gh version 0.0.0 (stub)"; exit 0 ;;
  auth) echo "Logged in to github.com account stub"; exit 0 ;;
  pr) cat "$CPR_PR_JSON"; exit 0 ;;
  repo)
    # gh repo clone <slug> <dir> -- <git args…>
    [ "${2:-}" = "clone" ] || { echo "gh stub: unsupported $*" >&2; exit 1; }
    dir="$4"
    shift 4
    [ "${1:-}" = "--" ] && shift
    exec git clone "$@" "$CPR_UPSTREAM" "$dir"
    ;;
esac
echo "gh stub: unsupported $*" >&2
exit 1
GHSTUB
chmod +x "$SANDBOX/ghstub/gh"

write_pr_json() {
  cat >"$SANDBOX/pr.json" <<JSON
{"number":7,"title":"a pull request with a link","url":"https://github.com/o/r/pull/7",
 "state":"OPEN","isDraft":false,"isCrossRepository":false,"baseRefName":"main",
 "baseRefOid":"$1","headRefOid":"$HEAD_OID","author":{"login":"someone"},
 "additions":1,"deletions":0,"changedFiles":1}
JSON
}

# Runs from a directory that is not a repository, so the cache clone is chosen
# the way it is for any repository the user does not already have.
SYMCWD="$SANDBOX/not-a-repo"
mkdir -p "$SYMCWD"
prepare_sym() {
  ( cd "${CPR_TEST_CWD:-$SYMCWD}" && env PATH="$SANDBOX/ghstub:$STUBS:$PATH" \
      CPR_PR_JSON="$SANDBOX/pr.json" CPR_UPSTREAM="$SYMUP" \
      node "$SCRIPT" prepare o/r#7 "$@" 2>&1 )
}

write_pr_json "$BASE_OID"
out="$(prepare_sym)"
SYMWT="$CACHE/worktrees/o__r/pr-7"
check "prepare built the worktree" "$([[ -d "$SYMWT" ]] && echo yes || echo no)" "yes"

# Regression: `-s read-only` bounds what codex may write, not what it may read,
# so a symlink committed in a pull request was a path out of the worktree and
# into anything the account could read. core.symlinks=false makes it a file.
check "a symlink in the PR is not a symlink on disk" \
  "$([[ -L "$SYMWT/escape.txt" ]] && echo link || echo file)" "file"
check "it holds the link text instead of the target's contents" \
  "$(cat "$SYMWT/escape.txt")" "/etc/passwd"
# The index still records mode 120000, so the diff Codex is handed is unchanged
# and the worktree is not dirty — which `review --no-prepare` refuses outright.
#
# Both run with the setting the plugin forces on every git it causes to run,
# because that is the only git that ever reads this worktree. A git without it
# sees a plain file where the index says symlink and calls it modified, which is
# why this is set for the whole process rather than at checkout time.
symgit() { git -c core.symlinks=false -C "$SYMWT" "$@"; }
check "the checkout is still clean" \
  "$(symgit status --porcelain --untracked-files=all | wc -l | tr -d ' ')" "0"
check "the entry is still a symlink as far as the diff is concerned" \
  "$(symgit diff --raw codex-pr/o__r/7-base -- escape.txt | grep -c 120000)" "1"

note "identity: metadata and code have to be the same repository"
# Regression: the head was checked against the API and the base was not, so the
# review boundary could be computed from a history GitHub never described.
# Ancestry rather than equality: a base branch legitimately advances between the
# API call and the fetch, and equality would abort on ordinary traffic.
git -C "$SYMUP" checkout --quiet --orphan unrelated
git -C "$SYMUP" commit --quiet --allow-empty -m "a different line of development"
UNRELATED_OID="$(git -C "$SYMUP" rev-parse HEAD)"
git -C "$SYMUP" checkout --quiet main

write_pr_json "$UNRELATED_OID"
out="$(prepare_sym)"
contains "a base the fetch does not contain stops the run" "$out" "does not contain the base commit"
contains "and points at --clone" "$out" "--clone"

# A base that has simply moved on is not a mismatch: the recorded commit is
# still an ancestor of what was fetched.
git -C "$SYMUP" checkout --quiet main
echo more >>"$SYMUP/f.txt"
git -C "$SYMUP" commit --quiet -am "main moves on"
write_pr_json "$BASE_OID"
out="$(prepare_sym)"
contains "a base that merely advanced is accepted" "$out" "Preparing worktree"

note "a remote for the right repo on the wrong host is not that repo"
# Regression: every remote URL form normalized to the same owner/repo whatever
# host served it, so a mirror could supply the code for metadata that came from
# GitHub — the one invariant SECURITY.md names outright. The right response is
# not to fail: it is to stop treating that checkout as this repository, say so,
# and fetch from the host the metadata actually came from.
MIRROR="$SANDBOX/mirror"
git clone --quiet "$SYMUP" "$MIRROR"
git -C "$MIRROR" remote set-url origin "https://gitlab.example.com/o/r"
out="$(CPR_TEST_CWD="$MIRROR" prepare_sym)"
contains "the mismatch is named" "$out" "gitlab.example.com"
contains "and the host that did serve it is too" "$out" "github.com served this pull request"
contains "the run continues against the cache clone" "$out" "Preparing worktree"

note "a degraded manifest entry fails before the paid run"
# Regression: --no-prepare checked headSha and mergeBase only where they were
# present, while the saved document quotes both unconditionally — so an entry
# missing one bought a whole review and then threw while writing it.
node -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const entry of manifest.entries) if (entry.key === "o/r#7") delete entry.mergeBase;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
' "$CACHE/manifest.json"
out="$(env PATH="$STUBS:$PATH" CPR_STUB_RUN_BODY="a finding nobody should have paid for" \
  node "$SCRIPT" review o/r#7 --repo o/r --no-prepare 2>&1)"
contains "the missing field is named" "$out" "no usable \`mergeBase\`"
check "and codex was never run" "$(printf '%s' "$out" | grep -c 'nobody should have paid')" "0"

note "clean verifies its own removals"
# Regression: verification was two `git -C` commands in the prompt, and that
# grant is a prefix — it also matched reset, branch -D, and config. The run now
# reads the repository back itself, which is also the only place with no gap
# between the removal and the check.
out="$(cclean --pr o/r#7 2>&1)"
clean_status=$?
contains "a complete removal says so" "$out" "verified gone from the repository"
check "the worktree really is gone" "$([[ -e "$SYMWT" ]] && echo present || echo gone)" "gone"
check "clean exits zero when nothing remains" "$clean_status" "0"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
