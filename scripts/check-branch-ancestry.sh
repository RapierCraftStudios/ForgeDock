#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-branch-ancestry.sh — Flag merge commits that bring in history from outside the PR base.
#
# Usage: check-branch-ancestry.sh <branch-or-HEAD> <base-ref>
#
# For every merge commit in <base-ref>..<branch>, each parent other than the first must be an
# ancestor of <base-ref>. Merging the base itself into the branch (a base sync) passes; merging
# a milestone or other foreign branch fails.
#
# Exit codes:
#   0  clean (no merges, or only base-sync merges)
#   1  foreign merge(s) found; each printed as "<merge-sha> <foreign-parent-sha> <subject>"
#   2  error (bad usage, unresolvable ref, git failure) — callers MUST treat as a failure, never a pass
#
# Known limit (unchanged from the old check): a fast-forward onto a foreign branch, or a merge
# whose foreign line is the FIRST parent, is not detected.
# Portable to bash 3.2: no mapfile, no grep -P, no state accumulated inside piped subshells.

set -u

if [ "$#" -ne 2 ] || [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  echo "usage: check-branch-ancestry.sh <branch-or-HEAD> <base-ref>" >&2
  exit 2
fi
BRANCH="$1"
BASE="$2"

git rev-parse --verify --quiet "${BRANCH}^{commit}" >/dev/null 2>&1 || { echo "check-branch-ancestry: cannot resolve branch ref '${BRANCH}'" >&2; exit 2; }
git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1 || { echo "check-branch-ancestry: cannot resolve base ref '${BASE}'" >&2; exit 2; }

MERGES=$(git rev-list --merges "${BASE}..${BRANCH}" 2>/dev/null) || { echo "check-branch-ancestry: git rev-list failed" >&2; exit 2; }

FOREIGN=0
for M in $MERGES; do
  LINE=$(git rev-list --parents -n 1 "$M" 2>/dev/null) || { echo "check-branch-ancestry: cannot read parents of $M" >&2; exit 2; }
  PARENTS=$(printf '%s\n' "$LINE" | cut -d' ' -f3-)
  SUBJECT=$(git log -n 1 --format=%s "$M" 2>/dev/null)
  for P in $PARENTS; do
    git merge-base --is-ancestor "$P" "$BASE" >/dev/null 2>&1
    rc=$?
    if [ "$rc" -eq 1 ]; then
      printf '%s %s %s\n' "$M" "$P" "$SUBJECT"
      FOREIGN=1
    elif [ "$rc" -ne 0 ]; then
      echo "check-branch-ancestry: merge-base --is-ancestor failed (rc=$rc) for $P" >&2
      exit 2
    fi
  done
done

[ "$FOREIGN" -eq 0 ] || exit 1
exit 0
