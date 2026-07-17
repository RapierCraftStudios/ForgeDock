#!/usr/bin/env bash
# issue-dedup.sh — Deterministic near-duplicate check for GitHub issue creation
#
# Usage:
#   issue-dedup.sh <title> [-R <owner/repo>] [--force] [--exclude <N,N,...>]
#   issue-dedup.sh <title> ["-R <owner/repo>"] [--force] [--exclude <N,N,...>]   (single pre-joined -R token also accepted)
#
#   <title>           : Proposed issue title (required, must be quoted if it contains spaces)
#   -R <owner/repo>   : GitHub repository, as two argv tokens (optional, defaults to
#                       FORGE_REPO or current repo)
#   "-R <owner/repo>" : GitHub repository, as ONE pre-joined token (e.g. when a caller
#                       passes an already-composed $GH_FLAG variable quoted as "$GH_FLAG").
#                       Both forms are accepted. A title that happens to start with "-R "
#                       but lacks the "/" separator (e.g. "-R login is broken") is
#                       correctly detected by the parser and treated as a title, not a
#                       repo flag. See the -R\ * case arm guard in the arg-parsing loop.
#   --force           : Skip dedup check and always allow creation (explicit override)
#   --exclude <N,N,...> : Comma-separated issue numbers to remove from the candidate
#                       set BEFORE token matching runs. Accepts either "--exclude N,N"
#                       (two argv tokens) or "--exclude=N,N" (one pre-joined token).
#                       Intended for callers that are about to create an issue that is a
#                       deliberate supersede of other, already-open issues (e.g. a P3
#                       review-finding batch issue restating its own member findings) —
#                       those members would otherwise always collide with the new title
#                       by construction. This is NOT a --force equivalent: it narrows the
#                       candidate set, it does not disable the check. Any OTHER open issue
#                       (not in the exclusion list) is still matched normally, so a batch
#                       title that happens to duplicate an unrelated existing issue is
#                       still caught. See commands/issue.md Phase 2D for the integration
#                       contract. <!-- Added: forge#2432 -->
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
#   3. Remove any --exclude'd issue numbers from the candidate set.
#   4. For each remaining candidate open issue, count shared tokens (length ≥ 4)
#      between the proposed title and the candidate title.
#   5. MATCH threshold: ≥ 3 shared tokens OR shared token count ≥ 50% of
#      the shorter title's token set — whichever fires first.
#   6. On match: print "DUPLICATE: #<N> <title>" to stdout, exit 1.
#   7. On no match: exit 0 (silent).
#
# Integration pattern (for command specs that call gh issue create):
#
#   DEDUP_RESULT=$(scripts/issue-dedup.sh "$PROPOSED_TITLE" "$GH_FLAG" 2>&1)
#   # ^ $GH_FLAG is typically already composed as "-R owner/repo" and quoted here,
#   #   producing ONE argv token — the parser accepts this joined form directly
#   #   (see the -R\ * case arm below). An unset/empty $GH_FLAG quotes to an empty
#   #   token, which the parser also treats as "no repo flag" rather than a title.
#   DEDUP_EXIT=$?
#   if [ $DEDUP_EXIT -eq 1 ]; then
#     echo "Near-duplicate detected: $DEDUP_RESULT"
#     echo "Comment on the existing issue instead of creating a new one."
#     echo "Use --force to override and create anyway."
#     exit 1
#   elif [ $DEDUP_EXIT -eq 2 ]; then
#     echo "Dedup check usage error: $DEDUP_RESULT"
#     echo "Do NOT proceed to issue creation — fix the invocation and retry."
#     exit 2
#   fi
#   gh issue create ...   # only runs when exit 0
#
#   Callers MUST explicitly branch on exit 2 (usage error) as a hard stop, not
#   just exit 1 (duplicate found). Silently falling through on any non-1 exit
#   code — including redirecting stderr to /dev/null — means a malformed
#   invocation (bad flag, missing argument) is indistinguishable from "no
#   duplicate found" and proceeds to create a possibly-duplicate issue with
#   zero operator-visible signal.
#
# Notes:
#   - Closed issues are NOT matched (a regression should be filed fresh with a
#     "Regression of #N" reference; see issue.md Phase 2D).
#   - The --force flag is the explicit override path. Human decision is required
#     to use it — agents MUST NOT pass --force without user authorization.
#   - The --exclude flag is NOT a --force equivalent and requires no human
#     authorization: it narrows the candidate set to exclude specific already-
#     known issue numbers (e.g. a batch's own declared members), it does not
#     disable the check. Any other open issue is still matched normally.
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
EXCLUDE_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    "")
      # Empty-string token — e.g. a caller quoting an unset/empty $GH_FLAG
      # ("$GH_FLAG" -> ""). Treat as "no repo flag supplied", not as a title.
      shift
      ;;
    -R)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for -R" >&2
        exit 2
      fi
      GH_FLAG="-R $1"
      shift
      ;;
    -R\ *)
      # Single pre-joined token, e.g. "-R owner/repo" — produced when a caller
      # quotes an already-composed $GH_FLAG variable ("$GH_FLAG") instead of
      # passing -R and the repo as two separate argv tokens. Both call shapes
      # are valid integration patterns used across commands/*.md callers.
      #
      # Guard: a valid repo token always contains '/' (owner/repo format).
      # If the value after "-R " has no '/', the token is a positional title
      # that happens to start with "-R " (e.g. "-R login is broken") — treat
      # it as the title instead. This prevents argv-flag-title-collision (#1625).
      _rval="${1#-R }"
      if [[ "$_rval" == */* ]]; then
        GH_FLAG="$1"
        shift
      else
        PROPOSED_TITLE="$1"
        shift
      fi
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --exclude)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --exclude" >&2
        exit 2
      fi
      EXCLUDE_ARG="$1"
      shift
      ;;
    --exclude=*)
      EXCLUDE_ARG="${1#--exclude=}"
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
  echo "Usage: issue-dedup.sh <title> [-R <owner/repo>] [--force] [--exclude <N,N,...>]" >&2
  exit 2
fi

# Force override — skip all checks
if [[ "$FORCE" -eq 1 ]]; then
  exit 0
fi

# --------------------------------------------------------------------------- #
# Exclusion set (--exclude N,N,N)
# Narrows the candidate set BEFORE token matching — does NOT disable the gate.
# Non-numeric/malformed tokens are silently dropped rather than treated as a
# usage error, since callers typically build this list programmatically from
# a bash array of issue numbers (e.g. a batch's own member issues) and should
# not have to pre-validate it. Same "|| true" pattern as the grep -c hazard
# documented below — a filter that legitimately matches nothing must not trip
# `set -e`.
# --------------------------------------------------------------------------- #
EXCLUDE_SET=""
if [[ -n "$EXCLUDE_ARG" ]]; then
  EXCLUDE_SET=$(echo "$EXCLUDE_ARG" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -E '^[0-9]+$' || true)
fi

is_excluded() {
  local num="$1"
  [[ -z "$EXCLUDE_SET" ]] && return 1
  grep -qxF "$num" <<< "$EXCLUDE_SET"
}

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
# grep -c always prints a numeric count (including "0") even when it matches
# nothing — it just exits 1 in that case. `|| echo 0` would append a SECOND
# "0" line on top of grep's own "0" output, corrupting the numeric comparison
# below. `|| true` only suppresses the non-zero exit under `set -e`.
PROPOSED_TOKEN_COUNT=$(echo "$PROPOSED_TOKENS" | grep -c . || true)

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

  # Excluded candidates (e.g. a batch issue's own declared members) are removed
  # from the candidate set entirely — they never reach token matching, so they
  # can never produce a false "DUPLICATE" against the very issue meant to
  # supersede them. Any other open issue is still matched normally below.
  if is_excluded "$CAND_NUMBER"; then
    continue
  fi

  CAND_TOKENS=$(normalize_tokens "$CAND_TITLE")
  # Same double-fallback hazard as PROPOSED_TOKEN_COUNT above — see comment there.
  CAND_TOKEN_COUNT=$(echo "$CAND_TOKENS" | grep -c . || true)

  # Shared token count: intersection of proposed and candidate token sets
  SHARED_COUNT=$(comm -12 \
    <(echo "$PROPOSED_TOKENS") \
    <(echo "$CAND_TOKENS") \
    | grep -c . || true)

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
