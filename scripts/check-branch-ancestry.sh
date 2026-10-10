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
# The first-parent line of <base-ref>..<branch> must also not carry foreign history: a branch cut
# from a milestone line (then, say, syncing the base) has no foreign non-first parent, so each
# first-parent commit is also checked against the milestone refs (refs/remotes/origin/milestone/*,
# refs/heads/milestone/*). A commit reachable from one of them but not from <base-ref> is foreign.
# Override the ref patterns with CHECK_BRANCH_ANCESTRY_FOREIGN_REFS (space-separated for-each-ref patterns).
#
# Known limit: foreign history on a branch with no milestone ref available locally is not detected.
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

# First-parent line: every commit must be absent from every milestone ref (other than base/branch themselves).
BASE_SHA=$(git rev-parse "${BASE}^{commit}") || exit 2
BRANCH_SHA=$(git rev-parse "${BRANCH}^{commit}") || exit 2
FP=$(git rev-list --first-parent "${BASE}..${BRANCH}" 2>/dev/null) || { echo "check-branch-ancestry: git rev-list --first-parent failed" >&2; exit 2; }
# shellcheck disable=SC2086
REFS=$(git for-each-ref --format='%(refname)' ${CHECK_BRANCH_ANCESTRY_FOREIGN_REFS:-refs/remotes/origin/milestone/ refs/heads/milestone/} 2>/dev/null) || { echo "check-branch-ancestry: git for-each-ref failed" >&2; exit 2; }
for F in $REFS; do
  F_SHA=$(git rev-parse --verify --quiet "${F}^{commit}" 2>/dev/null) || continue
  [ "$F_SHA" = "$BASE_SHA" ] || [ "$F_SHA" = "$BRANCH_SHA" ] && continue
  for C in $FP; do
    git merge-base --is-ancestor "$C" "$F_SHA" >/dev/null 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
      printf '%s %s first-parent history reachable from foreign ref %s\n' "$C" "$F_SHA" "$F"
      FOREIGN=1
    elif [ "$rc" -ne 1 ]; then
      echo "check-branch-ancestry: merge-base --is-ancestor failed (rc=$rc) for $C" >&2
      exit 2
    fi
  done
done

[ "$FOREIGN" -eq 0 ] || exit 1
exit 0
