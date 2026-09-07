#!/usr/bin/env bash
#
# Fails when shipped plugin content changed without that plugin's version moving.
#
# Claude Code resolves an install by version and caches it, so a change to a
# command prompt that keeps the old number reaches nobody who already has the
# plugin: the updater has no reason to fetch a version it believes it holds.
# Each marketplace plugin is checked independently against its own manifest.
# Marketplace metadata is versioned separately and is not this guard's subject.
#
#   tests/version-guard.sh [base-ref] [--worktree]
#
# Without --worktree, the comparison is committed HEAD against base — the CI
# behaviour. --worktree compares the current working tree (including untracked
# files) against base, which is what an uncommitted checkout needs.
#
set -uo pipefail

MARKETPLACE=".claude-plugin/marketplace.json"

WORKTREE=0
BASE=""
for arg in "$@"; do
  case "$arg" in
    --worktree) WORKTREE=1 ;;
    -*)
      echo "  FAIL unknown option: $arg"
      echo "       usage: tests/version-guard.sh [base-ref] [--worktree]"
      exit 1
      ;;
    *)
      if [[ -n "$BASE" ]]; then
        echo "  FAIL unexpected argument: $arg"
        echo "       usage: tests/version-guard.sh [base-ref] [--worktree]"
        exit 1
      fi
      BASE="$arg"
      ;;
  esac
done

# A branch created by this push has no commit before it, and GitHub says so with
# an all-zero sha rather than an empty string. Diffing against it fails, `changed`
# comes back empty, and the guard reports "no shipped plugin content changed" —
# a pass that checked nothing, on exactly the push most likely to carry a new
# prompt. Say it was skipped instead.
if [[ "$BASE" =~ ^0+$ ]]; then
  echo "  SKIP — no commit before this push to compare against"
  exit 0
fi

# The fallback answers a narrower question than the caller's: it is "did the last
# commit ship content without moving the version", which is right locally and
# wrong for a release that took two commits. CI passes a base explicitly for
# that reason.
if [[ -z "$BASE" ]]; then
  if ! BASE="$(git rev-parse --verify --quiet HEAD^)"; then
    echo "  SKIP — no parent commit to compare against"
    exit 0
  fi
fi

AFTER="HEAD"
if [[ "$WORKTREE" -eq 1 ]]; then
  AFTER="WORKTREE"
fi

read_tree_file() {
  local rev="$1" file="$2"
  if [[ "$rev" == "WORKTREE" ]]; then
    if [[ -f "$file" ]]; then
      cat "$file"
    fi
  else
    git show "$rev:$file" 2>/dev/null || true
  fi
}

json_version() {
  node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{
      try{process.stdout.write(String(JSON.parse(r).version??""))}catch{}})'
}

# name<TAB>source<TAB>marketplaceVersion  (source has no leading ./)
marketplace_plugins() {
  local rev="$1"
  read_tree_file "$rev" "$MARKETPLACE" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{
      try {
        const m = JSON.parse(r);
        for (const p of m.plugins || []) {
          if (!p || typeof p.name !== "string" || typeof p.source !== "string") continue;
          let s = p.source;
          if (s.startsWith("./")) s = s.slice(2);
          if (s.endsWith("/")) s = s.slice(0, -1);
          if (!s) continue;
          process.stdout.write(`${p.name}\t${s}\t${p.version ?? ""}\n`);
        }
      } catch {}
    })'
}

changed_files() {
  local source="$1" manifest="$2"
  {
    if [[ "$WORKTREE" -eq 1 ]]; then
      git diff --name-only "$BASE" -- "$source"
      git ls-files --others --exclude-standard -- "$source"
    else
      git diff --name-only "$BASE" HEAD -- "$source"
    fi
  } | grep -Fxv "$manifest" | grep -v '^$' | sort -u || true
}

after_marketplace="$(read_tree_file "$AFTER" "$MARKETPLACE")"
if [[ -z "$after_marketplace" ]]; then
  echo "  FAIL could not read $MARKETPLACE at ${AFTER}"
  exit 1
fi

plugin_rows="$(marketplace_plugins "$AFTER")"
if [[ -z "$plugin_rows" ]]; then
  echo "  FAIL $MARKETPLACE lists no plugins at ${AFTER}"
  exit 1
fi

status=0

while IFS=$'\t' read -r name source entry_version; do
  [[ -n "$name" ]] || continue
  manifest="${source}/.claude-plugin/plugin.json"
  before="$(read_tree_file "$BASE" "$manifest" | json_version)"
  after="$(read_tree_file "$AFTER" "$manifest" | json_version)"

  if [[ -z "$after" ]]; then
    echo "  FAIL could not read the version from $manifest at ${AFTER}"
    status=1
    continue
  fi

  if [[ "$entry_version" != "$after" ]]; then
    echo "  FAIL marketplace entry ${name} is ${entry_version} but ${manifest} is ${after}"
    status=1
  fi

  changed="$(changed_files "$source" "$manifest")"
  if [[ -z "$changed" ]]; then
    if [[ "$entry_version" == "$after" ]]; then
      echo "  ok   ${name}: no shipped plugin content changed"
    fi
    continue
  fi

  if [[ "$before" == "$after" ]]; then
    echo "  FAIL ${name}: shipped plugin content changed but the version stayed at $after:"
    # shellcheck disable=SC2086
    printf '         %s\n' $changed
    echo "       Bump $manifest (and any literals tests/unit.mjs keeps in step)."
    status=1
    continue
  fi

  echo "  ok   ${name}: shipped content changed and the version moved ${before:-none} -> $after"
done <<< "$plugin_rows"

if [[ "$status" -ne 0 ]]; then
  exit 1
fi
