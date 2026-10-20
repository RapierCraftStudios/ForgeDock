#!/usr/bin/env bash
# acceptance-red-green.sh — red-green proof for one acceptance test: it must FAIL on the base commit and PASS on head.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: acceptance-red-green.sh --repo-path <worktree> --base-ref <ref> --test-cmd "<cmd>" [--timeout <sec>]
# Runs <cmd> in <worktree> (head) first. Only when head RAN does it create a detached base worktree at
# `git merge-base HEAD <base-ref>` (under mktemp -d, never inside the repo), overlay head's changed test files
# onto it, link head's untracked dependency trees (every node_modules next to a tracked package.json, a root .venv),
# and run <cmd> there. Each run is classified with classify-test-run.sh.
# Prints exactly one line on stdout:   BASE=<FAILED|RAN|RAN_NOTHING|UNRUNNABLE|SKIPPED> HEAD=<FAILED|RAN|RAN_NOTHING|UNRUNNABLE>
#   FAILED      the run executed and failed
#   RAN         the run executed and passed
#   RAN_NOTHING the runner exercised nothing
#   UNRUNNABLE  could not execute (timeout 124, not executable 126/127, worktree/overlay/classifier failure)
#   SKIPPED     base was not run because head did not PASS (never a missing file: head's new test files are overlaid)
# Never prints a verdict on success of cleanup: the base worktree is removed on every exit path (trap + explicit remove).
# Callers map: HEAD=RAN BASE=FAILED -> proof; BASE=RAN -> passes on base (gate FAIL); anything else that is not a proof -> DEGRADED/FAIL.
# Exit: 0 line printed | 2 usage error (stdout empty so callers fail closed)
# Bash 3.2 portable.
set -uo pipefail

REPO=""; BASE_REF=""; CMD=""; TMO=300
while [ $# -gt 0 ]; do
  case "$1" in
    --repo-path) REPO="${2-}"; shift 2 ;;
    --base-ref) BASE_REF="${2-}"; shift 2 ;;
    --test-cmd) CMD="${2-}"; shift 2 ;;
    --timeout) TMO="${2-}"; shift 2 ;;
    *) echo "usage: acceptance-red-green.sh --repo-path <dir> --base-ref <ref> --test-cmd <cmd> [--timeout <sec>]" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -d "$REPO" ] && [ -n "$BASE_REF" ] && [ -n "$CMD" ] || { echo "usage: acceptance-red-green.sh --repo-path <dir> --base-ref <ref> --test-cmd <cmd> [--timeout <sec>]" >&2; exit 2; }
case "$TMO" in ''|*[!0-9]*) TMO=300 ;; esac
CLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/classify-test-run.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/forge-redgreen.XXXXXX") || { echo "BASE=UNRUNNABLE HEAD=UNRUNNABLE"; exit 0; }
BASE_WT="$WORK/base"; ADDED=false
cleanup() {
  [ "$ADDED" = "true" ] && git -C "$REPO" worktree remove --force "$BASE_WT" >/dev/null 2>&1
  ADDED=false
  rm -rf "$WORK"
  git -C "$REPO" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

TIMEOUT_BIN=$(command -v timeout || command -v gtimeout || true)

# run_in <dir> -> prints the classification word
run_in() {
  local dir="$1" out="$WORK/out.$$.txt" rc cls
  if [ -n "$TIMEOUT_BIN" ]; then ( cd "$dir" && "$TIMEOUT_BIN" "$TMO" bash -c "$CMD" ) >"$out" 2>&1; rc=$?
  else ( cd "$dir" && bash -c "$CMD" ) >"$out" 2>&1; rc=$?; fi
  case "$rc" in 124|126|127) echo UNRUNNABLE; return ;; esac
  cls=$(bash "$CLS" "$rc" "$out" 2>/dev/null)
  case "$cls" in FAILED|RAN|RAN_NOTHING) echo "$cls" ;; *) echo UNRUNNABLE ;; esac
}

HEAD_RES=$(run_in "$REPO")
if [ "$HEAD_RES" != "RAN" ]; then echo "BASE=SKIPPED HEAD=$HEAD_RES"; exit 0; fi

BASE_SHA=$(git -C "$REPO" merge-base HEAD "$BASE_REF" 2>/dev/null)
[ -n "$BASE_SHA" ] && git -C "$REPO" worktree add --detach "$BASE_WT" "$BASE_SHA" >/dev/null 2>&1 && ADDED=true
if [ "$ADDED" != "true" ]; then echo "BASE=UNRUNNABLE HEAD=$HEAD_RES"; exit 0; fi

# Overlay: head's changed test files onto base (a new test file does not exist at base; running without it is a false red).
is_test_path() {
  case "$1" in
    /*|..|../*|*/../*|*/..) return 1 ;;
  esac
  case "$1" in
    test/*|tests/*|spec/*|__tests__/*|*/test/*|*/tests/*|*/spec/*|*/__tests__/*|*.test.*|*_test.*|*.spec.*|*_spec.*|*/test_*|test_*) return 0 ;;
  esac
  return 1
}
OVERLAY_OK=true
CHANGED=$( { git -C "$REPO" diff --name-only "$BASE_SHA" 2>/dev/null; git -C "$REPO" ls-files --others --exclude-standard 2>/dev/null; } | sort -u )
while IFS= read -r f; do
  [ -n "$f" ] || continue
  is_test_path "$f" || continue
  [ -f "$REPO/$f" ] && [ ! -L "$REPO/$f" ] || continue   # deleted at head, or a symlink: never copied
  mkdir -p "$BASE_WT/$(dirname "$f")" && cp -p "$REPO/$f" "$BASE_WT/$f" 2>/dev/null && [ -f "$BASE_WT/$f" ] || OVERLAY_OK=false
done <<< "$CHANGED"
# Untracked dependency trees (never in git): link head's so a missing install is not mistaken for a red run (#4334):
# every node_modules next to a tracked package.json (workspace packages too, e.g. apps/web/node_modules) and a root .venv.
DEPS=$( { git -C "$REPO" ls-files -- package.json '*/package.json' 2>/dev/null | while IFS= read -r p; do
  d=$(dirname "$p"); [ "$d" = "." ] && echo node_modules || echo "$d/node_modules"; done; echo .venv; } | sort -u )
while IFS= read -r t; do
  [ -n "$t" ] || continue
  case "$t" in */node_modules/*) continue ;; esac   # a package.json inside an installed tree
  [ -d "$REPO/$t" ] && [ ! -e "$BASE_WT/$t" ] && [ ! -L "$BASE_WT/$t" ] || continue
  mkdir -p "$BASE_WT/$(dirname "$t")" 2>/dev/null && ln -s "$REPO/$t" "$BASE_WT/$t" 2>/dev/null
done <<< "$DEPS"

if [ "$OVERLAY_OK" != "true" ]; then BASE_RES=UNRUNNABLE; else BASE_RES=$(run_in "$BASE_WT"); fi
cleanup   # explicit; the EXIT trap is the backstop
echo "BASE=$BASE_RES HEAD=$HEAD_RES"
exit 0
