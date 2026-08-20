#!/usr/bin/env bash
#
# Fails when shipped plugin content changed without the plugin version moving.
#
# Claude Code resolves an install by version and caches it, so a change to a
# command prompt that keeps the old number reaches nobody who already has the
# plugin: the updater has no reason to fetch a version it believes it holds.
# The prompts are where the posting and cleanup rules live, which makes "fixed
# but undelivered" the failure mode worth a red build.
#
#   tests/version-guard.sh [base-ref]
#
set -uo pipefail

BASE="${1:-}"
PLUGIN_JSON="plugins/codex-pr-reviewer/.claude-plugin/plugin.json"

if [[ -z "$BASE" ]]; then
  if ! BASE="$(git rev-parse --verify --quiet HEAD^)"; then
    echo "  SKIP — no parent commit to compare against"
    exit 0
  fi
fi

version_at() {
  git show "$1:$PLUGIN_JSON" 2>/dev/null \
    | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{
        try{process.stdout.write(String(JSON.parse(r).version??""))}catch{}})'
}

# Everything a user installs, minus the manifest whose version is the subject.
changed="$(git diff --name-only "$BASE" HEAD -- plugins/codex-pr-reviewer/ \
  | grep -v "^${PLUGIN_JSON}$" || true)"

if [[ -z "$changed" ]]; then
  echo "  ok   no shipped plugin content changed"
  exit 0
fi

before="$(version_at "$BASE")"
after="$(version_at HEAD)"

if [[ -z "$after" ]]; then
  echo "  FAIL could not read the version from $PLUGIN_JSON at HEAD"
  exit 1
fi

if [[ "$before" == "$after" ]]; then
  echo "  FAIL shipped plugin content changed but the version stayed at $after:"
  printf '         %s\n' $changed
  echo "       Bump $PLUGIN_JSON (and the literals tests/unit.mjs keeps in step)."
  exit 1
fi

echo "  ok   shipped content changed and the version moved $before -> $after"
