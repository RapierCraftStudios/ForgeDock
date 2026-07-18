#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# derive-finding-milestone.sh — Single source of truth for deriving the
#                                milestone a review-finding issue should
#                                inherit from the PR that spawned it.
#
# Usage:
#   derive-finding-milestone.sh <PR_NUMBER> [-R <owner/repo>]
#
#   PR_NUMBER    The number of the PR being reviewed (the one /review-pr or
#                /review-pr-staging is creating findings against).
#   -R owner/repo  Optional. Defaults to the current repo (gh's own default
#                  resolution) when omitted.
#
# Resolution (3-tier, first match wins — do NOT add a second copy of this
# logic anywhere else; both commands/review-pr.md and
# commands/review-pr-staging.md call this script rather than hand-rolling
# their own copy, specifically so the two specs cannot independently drift
# the way they did before this fix — see forge#2447 precedent
# (scripts/severity-to-priority.sh) and forge#2443 (this script)):
#
#   Tier 1 — PR's own milestone: `gh pr view <N> --json milestone`. Most
#            direct signal — if the PR itself was filed under a milestone,
#            that is authoritative.
#   Tier 2 — Originating issue's milestone: parse the PR body for
#            `Closes/Fixes/Resolves #N` (case-insensitive), then read that
#            issue's milestone. Covers the common /work-on shape where the
#            PR body says `Closes #1234` but the PR itself was never
#            assigned a milestone directly.
#   Tier 3 — Branch-slug match: if the PR's base or head branch starts with
#            `milestone/`, slugify the branch name (strip the `milestone/`
#            prefix) and look for a GitHub milestone whose slugified title
#            matches — exact match first, substring match as a fallback.
#            This is the path that fixes forge#2443's Instance B/C: a
#            milestone-lane PR whose findings had no `Closes #N` and no
#            milestone set directly, but whose *branch* names the
#            milestone.
#
# Output: the resolved milestone TITLE on stdout, or nothing (empty stdout)
#         if no tier resolves — this is a normal, common outcome (most
#         findings are fast-lane, no milestone), not an error.
#
# Exit codes:
#   0  success — milestone title printed to stdout, or nothing if none found
#   1  error (missing/invalid argument, or `gh` call failed outright —
#      fails loud rather than silently guessing)
#
# Example:
#   MILESTONE_TITLE=$(scripts/derive-finding-milestone.sh "$PR_NUMBER")
#   MILESTONE_FLAG=""
#   [ -n "$MILESTONE_TITLE" ] && MILESTONE_FLAG="--milestone $MILESTONE_TITLE"
#
# <!-- Added: forge#2443 -->

set -euo pipefail

PR_NUMBER="${1:-}"
GH_REPO_ARGS=()

if [ -z "$PR_NUMBER" ]; then
  echo "ERROR: Usage: derive-finding-milestone.sh <PR_NUMBER> [-R <owner/repo>]" >&2
  exit 1
fi

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "ERROR: PR_NUMBER must be numeric, got: $PR_NUMBER" >&2
  exit 1
fi

shift
while [ $# -gt 0 ]; do
  case "$1" in
    -R)
      if [ $# -lt 2 ]; then
        echo "ERROR: -R requires a value <owner/repo>" >&2
        echo "Usage: derive-finding-milestone.sh <PR_NUMBER> [-R <owner/repo>]" >&2
        exit 1
      fi
      if ! [[ "$2" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
        echo "ERROR: -R value must be owner/repo format, got: $2" >&2
        exit 1
      fi
      GH_REPO_ARGS=(-R "$2")
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# --- Tier 1: PR's own milestone -------------------------------------------
# stderr is routed to a separate temp file (not merged via 2>&1) so that a
# 0-exit gh call's stdout is never polluted with incidental stderr text
# (e.g. a gh CLI update notice) ahead of the jq -r parse below. Mirrors the
# GH_STDERR_TMP pattern already used in scripts/classify-lane.sh.
# Restricted to owner-only permissions (chmod 600) since the file transiently
# holds gh CLI stderr text; and trap-cleaned on EXIT (mirrors the idiom
# already in production at scripts/doctor-pipeline-state.sh) so a
# signal-interrupted run (SIGINT/SIGTERM while `gh pr view` is in flight)
# doesn't leak the temp file — the two explicit rm -f calls below still run
# on their normal/error paths; the trap is a no-op in those cases and only
# matters for exit paths those calls don't cover. <!-- Fixes: forge#2532, forge#2533 -->
GH_STDERR_TMP=$(mktemp)
chmod 600 "$GH_STDERR_TMP"
trap 'rm -f "$GH_STDERR_TMP"' EXIT
PR_JSON=$(gh pr view "$PR_NUMBER" "${GH_REPO_ARGS[@]+"${GH_REPO_ARGS[@]}"}" \
  --json milestone,body,baseRefName,headRefName 2>"$GH_STDERR_TMP") || {
  echo "ERROR: failed to fetch PR #$PR_NUMBER — check PR number and repo flag" >&2
  cat "$GH_STDERR_TMP" >&2
  rm -f "$GH_STDERR_TMP"
  exit 1
}
rm -f "$GH_STDERR_TMP"

MILESTONE_TITLE=$(echo "$PR_JSON" | jq -r '.milestone.title // empty')
if [ -n "$MILESTONE_TITLE" ]; then
  echo "$MILESTONE_TITLE"
  exit 0
fi

# --- Tier 2: originating issue's milestone (Closes/Fixes/Resolves #N) -----
# Portable (non-PCRE) extraction — grep -oP is not supported by Git Bash's
# grep build on Windows, so use a bash regex + BASH_REMATCH instead of a
# lookbehind (same convention as scripts/code-index.sh).
PR_BODY=$(echo "$PR_JSON" | jq -r '.body // empty')
SOURCE_ISSUE=""
PR_BODY_LOWER=$(echo "$PR_BODY" | tr '[:upper:]' '[:lower:]')
if [[ "$PR_BODY_LOWER" =~ (closes|fixes|resolves)[[:space:]]*#([0-9]+) ]]; then
  SOURCE_ISSUE="${BASH_REMATCH[2]}"
fi

if [ -n "$SOURCE_ISSUE" ]; then
  ISSUE_MILESTONE=$(gh issue view "$SOURCE_ISSUE" "${GH_REPO_ARGS[@]+"${GH_REPO_ARGS[@]}"}" \
    --json milestone --jq '.milestone.title // empty' 2>/dev/null || echo "")
  if [ -n "$ISSUE_MILESTONE" ]; then
    echo "$ISSUE_MILESTONE"
    exit 0
  fi
fi

# --- Tier 3: branch-slug match ---------------------------------------------
BASE_BRANCH=$(echo "$PR_JSON" | jq -r '.baseRefName // empty')
HEAD_BRANCH=$(echo "$PR_JSON" | jq -r '.headRefName // empty')

MILESTONE_BRANCH=""
if echo "$BASE_BRANCH" | grep -qE "^milestone/"; then
  MILESTONE_BRANCH="$BASE_BRANCH"
elif echo "$HEAD_BRANCH" | grep -qE "^milestone/"; then
  MILESTONE_BRANCH="$HEAD_BRANCH"
fi

if [ -n "$MILESTONE_BRANCH" ]; then
  BRANCH_SLUG=$(echo "$MILESTONE_BRANCH" | sed 's|^milestone/||')

  # Resolve owner/repo for the milestones API call: use -R's value if given,
  # otherwise gh's own default-repo resolution (the `:owner/:repo` REST
  # placeholder gh substitutes from the current git remote / repo context).
  if [ ${#GH_REPO_ARGS[@]} -gt 0 ]; then
    MILESTONES_REPO="${GH_REPO_ARGS[1]}"
  else
    MILESTONES_REPO=":owner/:repo"
  fi
  ALL_MILESTONES=$(gh api "repos/${MILESTONES_REPO}/milestones" 2>/dev/null || echo "")

  if [ -n "$ALL_MILESTONES" ] && [ "$ALL_MILESTONES" != "[]" ]; then
    MATCH=$(echo "$ALL_MILESTONES" | jq -r --arg slug "$BRANCH_SLUG" \
      '.[] | select((.title | ascii_downcase | gsub("[^a-z0-9]+"; "-")) == $slug) | .title' | head -1)
    if [ -z "$MATCH" ]; then
      MATCH=$(echo "$ALL_MILESTONES" | jq -r --arg slug "$BRANCH_SLUG" \
        '.[] | select((.title | ascii_downcase | gsub("[^a-z0-9]+"; "-")) | test($slug)) | .title' | head -1)
    fi
    if [ -n "$MATCH" ]; then
      echo "$MATCH"
      exit 0
    fi
  fi
fi

# No tier resolved — normal outcome, empty stdout, success exit.
exit 0
