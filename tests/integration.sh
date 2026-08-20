#!/usr/bin/env bash
#
# Integration tests for pr-workspace.mjs.
#
# These exercise the real git/gh plumbing against a public repository, but
# deliberately never invoke Codex — so the suite is free and fast. The one
# thing it cannot prove is that Codex produces a good review; it proves that
# what Codex would be handed is exactly GitHub's diff.
#
# Requires: gh (authenticated), git, node, network access.
#
#   tests/integration.sh [owner/repo] [pr-number]
#
set -uo pipefail

REPO="${1:-cli/cli}"
PR="${2:-13899}"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/plugins/codex-pr-reviewer/scripts/pr-workspace.mjs"

# Isolate the cache BEFORE anything can write to it or trap on it. Without this
# the cleanup trap below runs `clean` against the real cache, so merely invoking
# this script — including down the preflight's SKIP path, which exits 0 and
# still fires the trap — could delete a worktree, branches, refs, and manifest
# entry belonging to a review the user actually wanted.
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/cpr-integration.XXXXXX")"
export XDG_CACHE_HOME="$SANDBOX/cache"

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

note() { printf '\n%s\n' "$1"; }

cleanup() {
  # Both are scoped to the sandbox: XDG_CACHE_HOME is exported above, and every
  # prepare below passes --clone, so no repository outside $SANDBOX is ever
  # registered and there is nothing of the user's for this to reach.
  node "$SCRIPT" clean --pr "$REPO#$PR" --purge-clones >/dev/null 2>&1 || true
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

# Reads one field from the prepare JSON. Field-at-a-time rather than a single
# `read` across a space-separated line, which corrupts paths containing spaces.
field() {
  printf '%s' "$META" | node -e "
    let raw = '';
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => process.stdout.write(String(JSON.parse(raw)['$1'] ?? '')));"
}

note "preflight"
if ! node "$SCRIPT" doctor >/dev/null 2>&1; then
  node "$SCRIPT" doctor 2>&1 | sed 's/^/    /'
  # A skip is not a failure when a person runs this on a machine without a
  # logged-in toolchain. It *is* a failure in CI, where a silent skip turns the
  # only test of the real git/gh plumbing into a job that proves nothing.
  if [[ -n "${CPR_REQUIRE_TOOLCHAIN:-}" ]]; then
    echo "  FAIL toolchain unhealthy and CPR_REQUIRE_TOOLCHAIN is set"
    exit 1
  fi
  echo "  SKIP — doctor reports an unhealthy toolchain"
  exit 0
fi
echo "  ok   toolchain healthy"

note "prepare $REPO#$PR"
META="$(node "$SCRIPT" prepare "$REPO#$PR" --clone --json 2>/dev/null)"
if [[ -z "$META" ]]; then
  echo "  FAIL prepare produced no JSON"
  exit 1
fi
WT="$(field worktree)"
BASE_BRANCH="$(field baseBranch)"
HEAD_SHA="$(field headSha)"
REPO_DIR="$(field repoDir)"
echo "  ok   prepared at $WT"

note "the worktree is the PR head"
check "HEAD == headRefOid" \
  "$(git -C "$WT" rev-parse HEAD)" \
  "$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)"

note "the diff is exactly GitHub's diff"
OURS="$(git -C "$WT" diff --name-only "$BASE_BRANCH" -- | sort | tr '\n' ',')"
THEIRS="$(gh pr diff "$PR" --repo "$REPO" --name-only | sort | tr '\n' ',')"
check "changed file list" "$OURS" "$THEIRS"

OURS_STAT="$(git -C "$WT" diff --numstat "$BASE_BRANCH" -- | awk '{a+=$1;d+=$2} END {print "+"a" -"d}')"
THEIRS_STAT="$(gh pr view "$PR" --repo "$REPO" --json additions,deletions --jq '"+\(.additions) -\(.deletions)"')"
check "additions/deletions" "$OURS_STAT" "$THEIRS_STAT"

note "prepare is idempotent"
node "$SCRIPT" prepare "$REPO#$PR" --clone >/dev/null 2>&1
check "second run exits 0" "$?" "0"
check "head unchanged" "$(git -C "$WT" rev-parse HEAD)" "$HEAD_SHA"

note "list reports the entry"
check "entry present" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c "\"key\": \"$REPO#$PR\"")" \
  "1"

note "clean removes exactly what it created"
node "$SCRIPT" clean --pr "$REPO#$PR" >/dev/null 2>&1
check "worktree gone" "$([[ -e "$WT" ]] && echo present || echo gone)" "gone"
check "branches gone" \
  "$(git -C "$REPO_DIR" branch --list "codex-pr/$PR" "codex-pr/$PR-base" | wc -l | tr -d ' ')" \
  "0"
check "refs gone" \
  "$(git -C "$REPO_DIR" for-each-ref "refs/codex-pr-reviewer/pr/$PR" | wc -l | tr -d ' ')" \
  "0"
check "manifest entry gone" \
  "$(node "$SCRIPT" list --json 2>/dev/null | grep -c "\"key\": \"$REPO#$PR\"")" \
  "0"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
