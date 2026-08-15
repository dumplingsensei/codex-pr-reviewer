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

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
