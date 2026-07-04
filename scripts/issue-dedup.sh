#!/usr/bin/env bash
# issue-dedup.sh — Deterministic near-duplicate check for GitHub issue creation
#
# Usage:
#   issue-dedup.sh <title> [-R <owner/repo>] [--force]
#
#   <title>         : Proposed issue title (required, must be quoted if it contains spaces)
#   -R <owner/repo> : GitHub repository (optional, defaults to FORGE_REPO or current repo)
#   --force         : Skip dedup check and always allow creation (explicit override)
#
# Exit codes:
#   0 — No near-duplicate found. Creation is safe. Stdout is empty.
#   1 — Near-duplicate found. Stdout contains the matched issue number and title.
#       Callers MUST check exit code before running `gh issue create`.
#   2 — Usage error (missing required argument).
#
# Algorithm (deterministic — no LLM required):
#   1. Normalize the proposed title: lowercase, strip punctuation, split into tokens
#      of length ≥ 4 (short words are noise: "fix", "add", "the", etc.)
#   2. Query open issues: search GitHub using the 2 most distinctive title tokens
#      as the --search query (balances recall vs API cost)
#   3. For each candidate open issue, count shared tokens (length ≥ 4) between
#      the proposed title and the candidate title.
#   4. MATCH threshold: ≥ 3 shared tokens OR shared token count ≥ 50% of
#      the shorter title's token set — whichever fires first.
#   5. On match: print "DUPLICATE: #<N> <title>" to stdout, exit 1.
#   6. On no match: exit 0 (silent).
#
# Integration pattern (for command specs that call gh issue create):
#
#   DEDUP_RESULT=$(scripts/issue-dedup.sh "$PROPOSED_TITLE" "$GH_FLAG")
#   DEDUP_EXIT=$?
#   if [ $DEDUP_EXIT -eq 1 ]; then
#     echo "Near-duplicate detected: $DEDUP_RESULT"
#     echo "Comment on the existing issue instead of creating a new one."
#     echo "Use --force to override and create anyway."
#     exit 1
#   fi
#   gh issue create ...   # only runs when exit 0
#
# Notes:
#   - Closed issues are NOT matched (a regression should be filed fresh with a
#     "Regression of #N" reference; see issue.md Phase 2D).
#   - The --force flag is the explicit override path. Human decision is required
#     to use it — agents MUST NOT pass --force without user authorization.
#   - Token matching is case-insensitive and punctuation-agnostic.
#   - GitHub's --search flag performs a full-text search; the token query is a
#     tiebreaker against the full candidate list, not the sole filter.
#
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

# --------------------------------------------------------------------------- #
# Argument parsing
# --------------------------------------------------------------------------- #
PROPOSED_TITLE=""
GH_FLAG=""
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -R)
      shift
      GH_FLAG="-R $1"
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      exit 2
      ;;
    *)
      PROPOSED_TITLE="$1"
      shift
      ;;
  esac
done

if [[ -z "$PROPOSED_TITLE" ]]; then
  echo "Usage: issue-dedup.sh <title> [-R <owner/repo>] [--force]" >&2
  exit 2
fi

# Force override — skip all checks
if [[ "$FORCE" -eq 1 ]]; then
  exit 0
fi

# --------------------------------------------------------------------------- #
# Token normalization
# Lowercase, strip non-alphanumeric chars except spaces, split on whitespace,
# keep tokens of length >= 4 to filter out noise words.
# --------------------------------------------------------------------------- #
normalize_tokens() {
  local text="$1"
  echo "$text" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9 ]/ /g' \
    | tr -s ' ' '\n' \
    | awk 'length >= 4' \
    | sort -u
}

PROPOSED_TOKENS=$(normalize_tokens "$PROPOSED_TITLE")
PROPOSED_TOKEN_COUNT=$(echo "$PROPOSED_TOKENS" | grep -c . 2>/dev/null || echo 0)

if [[ "$PROPOSED_TOKEN_COUNT" -lt 1 ]]; then
  # Title has no meaningful tokens — skip dedup (cannot match)
  exit 0
fi

# Build a search query from the 2 most distinctive tokens (longest first)
SEARCH_TERMS=$(echo "$PROPOSED_TOKENS" | awk '{ print length, $0 }' | sort -rn | awk '{print $2}' | head -2 | tr '\n' ' ')
SEARCH_QUERY=$(echo "$SEARCH_TERMS" | xargs)

# --------------------------------------------------------------------------- #
# Query open issues
# --------------------------------------------------------------------------- #
CANDIDATES=$(gh issue list $GH_FLAG \
  --state open \
  --search "$SEARCH_QUERY" \
  --limit 30 \
  --json number,title \
  --jq '.[] | "\(.number)\t\(.title)"' 2>/dev/null || true)

if [[ -z "$CANDIDATES" ]]; then
  exit 0
fi

# --------------------------------------------------------------------------- #
# Token overlap matching
# For each candidate, count shared tokens between proposed and candidate titles.
# Match if: shared_count >= 3  OR  shared_count >= 50% of the shorter token set.
# --------------------------------------------------------------------------- #
MATCH_NUMBER=""
MATCH_TITLE=""

while IFS=$'\t' read -r CAND_NUMBER CAND_TITLE; do
  [[ -z "$CAND_NUMBER" ]] && continue

  CAND_TOKENS=$(normalize_tokens "$CAND_TITLE")
  CAND_TOKEN_COUNT=$(echo "$CAND_TOKENS" | grep -c . 2>/dev/null || echo 0)

  # Shared token count: intersection of proposed and candidate token sets
  SHARED_COUNT=$(comm -12 \
    <(echo "$PROPOSED_TOKENS") \
    <(echo "$CAND_TOKENS") \
    | grep -c . 2>/dev/null || echo 0)

  # Shorter token set size (for percentage threshold)
  if [[ "$PROPOSED_TOKEN_COUNT" -le "$CAND_TOKEN_COUNT" ]]; then
    SHORTER=$PROPOSED_TOKEN_COUNT
  else
    SHORTER=$CAND_TOKEN_COUNT
  fi

  # 50% threshold: shared >= ceil(shorter / 2)
  HALF_THRESHOLD=$(( (SHORTER + 1) / 2 ))

  if [[ "$SHARED_COUNT" -ge 3 ]] || [[ "$SHARED_COUNT" -ge "$HALF_THRESHOLD" && "$SHORTER" -ge 2 ]]; then
    MATCH_NUMBER="$CAND_NUMBER"
    MATCH_TITLE="$CAND_TITLE"
    break
  fi
done <<< "$CANDIDATES"

# --------------------------------------------------------------------------- #
# Output result
# --------------------------------------------------------------------------- #
if [[ -n "$MATCH_NUMBER" ]]; then
  echo "DUPLICATE: #${MATCH_NUMBER} ${MATCH_TITLE}"
  exit 1
fi

exit 0
