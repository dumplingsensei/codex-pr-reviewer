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
WT="$SANDBOX/wt-7"
git -C "$HOST" fetch --quiet origin '+refs/pull/7/head:refs/codex-pr-reviewer/pr/7'
git -C "$HOST" branch --force codex-pr/7-base "$(git -C "$HOST" merge-base origin/main refs/codex-pr-reviewer/pr/7)"
git -C "$HOST" worktree add --quiet --force -B codex-pr/7 "$WT" refs/codex-pr-reviewer/pr/7

# Two entries sharing one repoDir, so the shared-clone case is exercised.
mkdir -p "$CACHE"
cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#7","repo":"o/r","number":7,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$WT","repoDir":"$HOST","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/7","baseBranch":"codex-pr/7-base",
  "refs":["refs/codex-pr-reviewer/pr/7"],"headSha":"0","mergeBase":"0",
  "baseRefName":"main","additions":1,"deletions":0,"changedFiles":1,
  "preparedAt":"2026-01-01T00:00:00.000Z"},
 {"key":"o/r#9","repo":"o/r","number":9,"title":"t9","url":"u9","state":"OPEN","author":"a",
  "worktree":"$SANDBOX/wt-9","repoDir":"$HOST","remote":"origin","mode":"clone",
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
out="$(node "$SCRIPT" clean --pr o/r#7 --purge-clones 2>&1)"
contains "shared clone is kept" "$out" "still used by another prepared PR"
check "clone survives on disk" "$([[ -d "$HOST" ]] && echo yes || echo no)" "yes"
check "target branches are gone" \
  "$(git -C "$HOST" branch --list 'codex-pr/7*' | wc -l | tr -d ' ')" "0"

# Regression: a failed branch deletion was swallowed and the manifest entry
# dropped anyway, so the leftover branch could never be cleaned.
git -C "$HOST" worktree add --quiet --force -B codex-pr/9 "$SANDBOX/wt-9" main
git -C "$HOST" branch --force codex-pr/9-base main
git -C "$HOST" checkout --quiet -b blocker codex-pr/9-base 2>/dev/null || true
git -C "$HOST" checkout --quiet codex-pr/9-base
node "$SCRIPT" clean --pr o/r#9 >"$SANDBOX/clean.out" 2>&1
status=$?
contains "failed deletion is reported" "$(cat "$SANDBOX/clean.out")" "could not remove"
check "clean exits nonzero on partial failure" "$status" "1"
check "entry retained for retry" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key": "o/r#9"')" "1"

# ---------------------------------------------------------------------------

note "review output hygiene (stub codex)"
mkdir -p "$SANDBOX/stub"
cat >"$SANDBOX/stub/codex" <<'STUB'
#!/bin/sh
case "$1" in --version) exit 3 ;; esac
echo "P1 finding"
exit 2
STUB
chmod +x "$SANDBOX/stub/codex"

git -C "$HOST" checkout --quiet main
cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#7","repo":"o/r","number":7,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$WT","repoDir":"$HOST","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/7","baseBranch":"codex-pr/7-base","refs":[],
  "headSha":"abcdef1234567890","mergeBase":"abcdef1234567890","baseRefName":"main",
  "additions":1,"deletions":0,"changedFiles":1,"preparedAt":"2026-01-01T00:00:00.000Z"}
]}
JSON

# Regression: streamed review text shared stdout with the --json payload.
out="$(PATH="$SANDBOX/stub:$PATH" node "$SCRIPT" review o/r#7 --repo o/r --no-prepare --json 2>/dev/null)"
if printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{JSON.parse(s);})' 2>/dev/null; then
  printf '  ok   review --json emits parseable JSON\n'; pass=$((pass + 1))
else
  printf '  FAIL review --json is polluted by review text\n'; fail=$((fail + 1))
fi

# Regression: the wrapper returned codex's exit status, so a sweep marked
# healthy PRs as failed whenever codex exited nonzero.
PATH="$SANDBOX/stub:$PATH" node "$SCRIPT" review o/r#7 --repo o/r --no-prepare >/dev/null 2>&1
check "wrapper exits 0 when the review was saved" "$?" "0"

# Regression: `?? "codex"` could not catch the "" from a failed version probe,
# leaving an empty model name in a footer meant for public PR comments.
saved="$(ls -t "$CACHE"/reviews/*.md 2>/dev/null | head -1)"
contains "footer names a model" "$(cat "$saved")" "Automated review by codex"

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
cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#21","repo":"o/r","number":21,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$SANDBOX/wt-21","repoDir":"$HOST","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/21","baseBranch":"codex-pr/21-base",
  "refs":["refs/codex-pr-reviewer/pr/21"],"headSha":"0","mergeBase":"0",
  "baseRefName":"main","additions":1,"deletions":0,"changedFiles":1,
  "preparedAt":"2026-01-01T00:00:00.000Z"},
 {"key":"o/r#22","repo":"o/r","number":22,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$SANDBOX/wt-22","repoDir":"$HOST","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/22","baseBranch":"codex-pr/22-base",
  "refs":["refs/codex-pr-reviewer/pr/22"],"headSha":"0","mergeBase":"0",
  "baseRefName":"main","additions":1,"deletions":0,"changedFiles":1,
  "preparedAt":"2026-01-01T00:00:00.000Z"}
]}
JSON

out="$(node "$SCRIPT" clean --all 2>&1)"
# The second entry must report its own branches, not silently skip them.
contains "later entry still removes its branches" "$out" "branch codex-pr/22"
contains "later entry still removes its refs" "$out" "refs/codex-pr-reviewer/pr/22"
check "clone is purged exactly once" \
  "$(printf '%s' "$out" | grep -c "^  - clone ")" "1"
check "clone is gone" "$([[ -d "$HOST" ]] && echo present || echo gone)" "gone"
check "manifest is emptied" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key"')" "0"

note "post refuses everything that must never reach a PR"
# The rules deciding what may be published used to live only in review.md, where
# a stale prompt, a slip, or text inside a reviewed diff could get around them.
# Each case below is one of those rules, now enforced where none of that applies.
REVIEWS="$CACHE/reviews"
# Saved reviews are named `<slug>-pr<N>-<stamp>.md`, and the stamp is part of
# what identifies one: see the collision case below.
STAMP="2026-01-01T00-00-00-000Z"
mkdir -p "$REVIEWS" "$SANDBOX/ghstub"
printf '<!-- codex-pr-reviewer -->\n# Codex review\n\nP1: a real finding.\n' >"$REVIEWS/o__r-pr7-$STAMP.md"
printf '<!-- codex-pr-reviewer -->\n# Codex review\n\n_Codex produced no review output._\n' >"$REVIEWS/o__r-pr8-$STAMP.md"
printf 'handwritten\n' >"$REVIEWS/o__r-pr9-$STAMP.md"
printf 'elsewhere\n' >"$SANDBOX/outside.md"
GOOD="$(node -e 'const {createHash}=require("node:crypto"),fs=require("node:fs");
  console.log(createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex").slice(0,12))' \
  "$REVIEWS/o__r-pr7-$STAMP.md")"

out="$(node "$SCRIPT" post o/r#8 --repo o/r --review "$REVIEWS/o__r-pr8-$STAMP.md" --confirm "$GOOD" 2>&1)"
contains "a failed review cannot be posted" "$out" "that review failed"
out="$(node "$SCRIPT" post o/r#9 --repo o/r --review "$REVIEWS/o__r-pr9-$STAMP.md" --confirm "$GOOD" 2>&1)"
contains "a file this plugin did not write is refused" "$out" "not a review this plugin generated"
out="$(node "$SCRIPT" post o/r#7 --repo o/r --review "$SANDBOX/outside.md" --confirm "$GOOD" 2>&1)"
contains "a path outside the reviews directory is refused" "$out" "not inside"
# Containment is decided on the resolved path, not on the spelling of it, so a
# `..` that lands back inside is fine and one that escapes is not. --dry-run
# keeps this case off the network: nothing below has stubbed `gh` yet.
out="$(node "$SCRIPT" post o/r#7 --repo o/r --review "$REVIEWS/../reviews/o__r-pr7-$STAMP.md" --dry-run 2>&1)"
contains "a traversal that lands inside is accepted" "$out" "gh pr comment 7"
out="$(node "$SCRIPT" post o/r#8 --repo o/r --review "$REVIEWS/o__r-pr7-$STAMP.md" --confirm "$GOOD" 2>&1)"
contains "a review of another PR is refused" "$out" "a different pull request"
# A repository name can continue where the `<slug>-pr<N>-` prefix stops. This is
# a review of o/r-pr7-archive#9; a prefix test reads it as one of o/r#7 and
# publishes another repository's review to the wrong pull request.
printf '<!-- codex-pr-reviewer -->\n# Codex review\n\nP1: from the archive repo.\n' \
  >"$REVIEWS/o__r-pr7-archive-pr9-$STAMP.md"
COLLIDE="$(node -e 'const {createHash}=require("node:crypto"),fs=require("node:fs");
  console.log(createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex").slice(0,12))' \
  "$REVIEWS/o__r-pr7-archive-pr9-$STAMP.md")"
out="$(node "$SCRIPT" post o/r#7 --repo o/r --review "$REVIEWS/o__r-pr7-archive-pr9-$STAMP.md" --confirm "$COLLIDE" 2>&1)"
contains "a repo whose name extends the prefix is refused" "$out" "a different pull request"
out="$(node "$SCRIPT" post "o/r-pr7-archive#9" --repo o/r-pr7-archive --review "$REVIEWS/o__r-pr7-archive-pr9-$STAMP.md" --dry-run 2>&1)"
contains "that same review reaches its own PR" "$out" "gh pr comment 9"
out="$(node "$SCRIPT" post o/r#7 --repo o/r --review "$REVIEWS/o__r-pr7-$STAMP.md" 2>&1)"
contains "posting without --confirm is refused" "$out" "Refusing to post without"
out="$(node "$SCRIPT" post o/r#7 --repo o/r --review "$REVIEWS/o__r-pr7-$STAMP.md" --confirm 0000 2>&1)"
contains "a truncated digest is refused" "$out" "too short"
out="$(node "$SCRIPT" post o/r#7 --repo o/r --review "$REVIEWS/o__r-pr7-$STAMP.md" --confirm 000000000000 2>&1)"
contains "a digest for another review is refused" "$out" "is not the one that digest"
# The digest is what carries an approval from the body that was shown. A failure
# must not hand it back, or the next call just quotes it and posts anyway.
check "no failure quotes the real digest" "$(printf '%s' "$out" | grep -c "$GOOD")" "0"

# --dry-run must not post, and must not leak the digest either.
cat >"$SANDBOX/ghstub/gh" <<'STUB'
#!/bin/sh
echo "https://github.com/o/r/pull/7#issuecomment-99"
echo "$@" >>"$GH_CALLS"
STUB
chmod +x "$SANDBOX/ghstub/gh"
export GH_CALLS="$SANDBOX/gh-calls.txt"
: >"$GH_CALLS"
out="$(PATH="$SANDBOX/ghstub:$PATH" node "$SCRIPT" post o/r#7 --repo o/r --review "$REVIEWS/o__r-pr7-$STAMP.md" --dry-run --json 2>&1)"
check "dry-run posts nothing" "$(wc -l <"$GH_CALLS" | tr -d ' ')" "0"
check "dry-run does not hand back the digest" "$(printf '%s' "$out" | grep -c "$GOOD")" "0"

# A prepared PR records what it published, so the same review cannot go twice.
cat >"$CACHE/manifest.json" <<JSON
{"version":1,"entries":[
 {"key":"o/r#7","repo":"o/r","number":7,"title":"t","url":"u","state":"OPEN","author":"a",
  "worktree":"$SANDBOX/wt-post","repoDir":"$SANDBOX/none","remote":"origin","mode":"clone",
  "headBranch":"codex-pr/7","baseBranch":"codex-pr/7-base","refs":[],
  "headSha":"0","mergeBase":"0","baseRefName":"main","additions":1,"deletions":0,
  "changedFiles":1,"preparedAt":"2026-01-01T00:00:00.000Z"}
]}
JSON
out="$(PATH="$SANDBOX/ghstub:$PATH" node "$SCRIPT" post o/r#7 --repo o/r --review "$REVIEWS/o__r-pr7-$STAMP.md" --confirm "$GOOD" 2>&1)"
contains "an approved review posts and returns the URL" "$out" "issuecomment-99"
contains "the post is recorded" "$(node "$SCRIPT" list --json 2>/dev/null)" "issuecomment-99"
out="$(PATH="$SANDBOX/ghstub:$PATH" node "$SCRIPT" post o/r#7 --repo o/r --review "$REVIEWS/o__r-pr7-$STAMP.md" --confirm "$GOOD" 2>&1)"
contains "the same review is not posted twice" "$out" "already posted"
out="$(PATH="$SANDBOX/ghstub:$PATH" node "$SCRIPT" post o/r#7 --repo o/r --review "$REVIEWS/o__r-pr7-$STAMP.md" --confirm "$GOOD" --again 2>&1)"
contains "--again allows a deliberate duplicate" "$out" "issuecomment-99"
rm -f "$CACHE/manifest.json"

note "clean --purge-reviews cannot overreach"
# Three defects found reviewing the change that added the flag, each of them
# fatal to a file that cannot be regenerated: a prefix match that reached
# another repository's reviews, a plan recomputed by the process that acts on
# it, and a failed deletion that cleared its manifest entry anyway.
rm -rf "$CACHE"
PURGE_WT="$SANDBOX/purge-wt"
mkdir -p "$REVIEWS" "$PURGE_WT"
mk_review() { printf '<!-- codex-pr-reviewer -->\n# Codex review\n\nP1: a finding.\n' >"$1"; }
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

out="$(node "$SCRIPT" clean --all --purge-reviews 2>&1)"
contains "purging without a confirmed snapshot is refused" "$out" "--confirm-reviews"
check "a refused run deletes nothing" "$(ls "$REVIEWS" | wc -l | tr -d ' ')" "4"
out="$(node "$SCRIPT" clean --all --purge-reviews --confirm-reviews 000000000000 2>&1)"
contains "a digest for another set is refused" "$out" "not the ones that digest approved"
check "still nothing deleted" "$(ls "$REVIEWS" | wc -l | tr -d ' ')" "4"

# The plan is shown by one process and carried out by another. A review saved in
# between — a background review, a sweep finishing — was in nobody's plan.
mk_review "$REVIEWS/o__r-pr7-2026-03-03T00-00-00-000Z.md"
out="$(node "$SCRIPT" clean --all --purge-reviews --confirm-reviews "$DIGEST" 2>&1)"
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
out="$(node "$SCRIPT" clean --all --purge-reviews --confirm-reviews "$DIGEST" 2>&1)"
contains "a failed review deletion is reported" "$out" "could not remove review"
check "its entry stays for a retry" "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key"')" "1"
check "the reviews that could be deleted were" \
  "$(ls "$REVIEWS" | grep -c '^o__r-pr7-2026-0[123]-')" "0"

# Cleared, the retry finishes the job — including a review saved since.
rmdir "$OBSTRUCTION"
mk_review "$REVIEWS/o__r-pr7-2026-05-05T00-00-00-000Z.md"
DIGEST="$(plan_field reviewsDigest)"
out="$(node "$SCRIPT" clean --all --purge-reviews --confirm-reviews "$DIGEST" 2>&1)"
check "the retry removes what is left" "$(printf '%s' "$out" | grep -c '^  - review ')" "1"
check "another repo's colliding review survives" \
  "$([[ -f "$REVIEWS/o__r-pr7-archive-pr9-$STAMP.md" ]] && echo present || echo gone)" "present"
check "an unrelated review survives" \
  "$([[ -f "$REVIEWS/o__other-pr3-$STAMP.md" ]] && echo present || echo gone)" "present"
check "the manifest is empty" "$(node "$SCRIPT" list --json 2>/dev/null | grep -c '"key"')" "0"

# Without the flag, reviews are untouched and no confirmation is needed.
write_manifest
mkdir -p "$PURGE_WT"
out="$(node "$SCRIPT" clean --all 2>&1)"
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
node "$SCRIPT" clean --all --json >"$SANDBOX/cleaned.json" 2>/dev/null
check "a --json clean reports what it kept" "$(kept_json "$SANDBOX/cleaned.json")" "2"
node "$SCRIPT" clean --all --purge-reviews --dry-run --json >"$SANDBOX/plan.json" 2>/dev/null
check "a --json dry run reports what would remain" "$(kept_json "$SANDBOX/plan.json")" "2"
# Nothing selected is still a run whose answer is "these reviews are still here".
out="$(node "$SCRIPT" clean --all 2>&1)"
contains "an empty clean still reports them" "$out" "Kept 2 saved reviews"
contains "and says there was nothing to clean" "$out" "Nothing to clean."
rm -f "$CACHE/manifest.json"

note "doctor detects a stale installed copy"
# Regression: an edited command prompt reached neither the installed copy nor a
# running session, and nothing said so. Every safety rule that decides whether a
# review may be posted lives in those prompts, so a silently stale install means
# --post is guarded by rules that are not the ones on disk.
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
cat >"$SANDBOX/doctorstub/codex" <<'STUB'
#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.0.0" ;;
  login) echo "Logged in using stub" >&2 ;;
esac
exit 0
STUB
chmod +x "$SANDBOX/doctorstub/gh" "$SANDBOX/doctorstub/codex"

doctor_json() {
  CLAUDE_CONFIG_DIR="$CONFIG" PATH="$SANDBOX/doctorstub:$PATH" \
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

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
