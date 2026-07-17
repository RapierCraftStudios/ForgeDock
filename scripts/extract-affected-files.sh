#!/usr/bin/env bash
# extract-affected-files.sh — Positionally-scoped affected-file extraction for
# /orchestrate Phase 3C Layer 1 (see commands/orchestrate/phase-3-dependency.md)
#
# Usage:
#   extract-affected-files.sh <issue_number> -R <owner/repo>
#   extract-affected-files.sh <issue_number> "-R <owner/repo>"   (single pre-joined token also accepted)
#
# Output (stdout):
#   Line 1:   PROVENANCE=affected-files-section | body-fallback | none
#   Line 2+:  one extracted file path per line (zero lines when PROVENANCE=none)
#
# Exit codes:
#   0 — Extraction completed (including the zero-files/PROVENANCE=none case — that is
#       a valid, expected outcome, NOT an error; callers must not treat exit 0 as proof
#       that files were found).
#   2 — Usage error (missing issue number, malformed -R value).
#
# Extraction rules (forge#2436):
#   1. Primary path — the issue's FORGE:INVESTIGATOR comment (if one exists), scoped to
#      ONLY its own "### Affected Files" section. Capture stops at the next markdown
#      heading of any level, so paths mentioned in "### Evidence", "### Root Cause",
#      "### Related Issues", etc. are never collected.
#      -> PROVENANCE=affected-files-section
#   2. Fallback path — used ONLY when no FORGE:INVESTIGATOR comment exists at all.
#      Scoped to a deliverables-shaped heading in the raw issue body:
#      "## Affected Files", "## Deliverables", or "### Files to change". Capture stops
#      at the next markdown heading of any level, so "## Context", "## Prior art",
#      "## Related", "## Root Cause", etc. are never scanned.
#      -> PROVENANCE=body-fallback
#   3. If neither path yields a scoped section containing a recognized file path:
#      PROVENANCE=none, zero files. This is intentional — phase-3-dependency.md's
#      Layer 4 conservative-serialization fallback fires when file extraction yields
#      fewer than 2 paths, and a confident-but-wrong list (the pre-fix behavior of
#      scraping the whole body/comment) defeated that safety net. Yielding nothing
#      when there is nothing to justify is strictly safer than yielding something
#      wrong (forge#2436).
#
# Extension regex covers: py|tsx?|jsx?|sql|json|ya?ml|mjs|js|sh|md — the repo's
# dominant file types. mjs/js/sh/md were previously missing, which meant the
# "primary" INVESTIGATOR-comment path silently extracted nothing for most
# ForgeDock issues (a .mjs/.md-heavy repo), so the unscoped body fallback was
# the path that actually determined DAG edges in practice (forge#2436).
#
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

EXT_REGEX='`[^`]*\.(py|tsx?|jsx?|sql|json|ya?ml|mjs|js|sh|md)`'

# --------------------------------------------------------------------------- #
# Argument parsing — mirrors scripts/issue-dedup.sh's -R / -R\ * case arms
# exactly (forge#1533, forge#1563: trailing/malformed -R values must be a
# usage error, never silently misread by callers as "extraction found
# nothing").
# --------------------------------------------------------------------------- #
NUM=""
REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    "")
      # Empty-string token — e.g. a caller quoting an unset/empty $GH_FLAG.
      # Treat as "no repo flag supplied", not as the issue number.
      shift
      ;;
    -R)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for -R" >&2
        exit 2
      fi
      REPO="$1"
      shift
      ;;
    -R\ *)
      # Single pre-joined token, e.g. "-R owner/repo" — produced when a caller
      # quotes an already-composed $GH_FLAG variable ("$GH_FLAG") instead of
      # passing -R and the repo as two separate argv tokens.
      #
      # Guard: a valid repo token always contains '/' (owner/repo format).
      # If the value after "-R " has no '/', treat the whole token as
      # malformed input rather than guessing (this script takes no other
      # positional string argument that could plausibly start with "-R ").
      _rval="${1#-R }"
      if [[ "$_rval" == */* ]]; then
        REPO="$_rval"
        shift
      else
        echo "Malformed -R value: $1" >&2
        exit 2
      fi
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      exit 2
      ;;
    *)
      NUM="$1"
      shift
      ;;
  esac
done

if [[ -z "$NUM" ]]; then
  echo "Usage: extract-affected-files.sh <issue_number> -R <owner/repo>" >&2
  exit 2
fi

# --------------------------------------------------------------------------- #
# Scoped section extraction — turn capture on at a target heading, off at the
# next markdown heading of any level. Same sentinel-based awk pattern already
# used elsewhere in this command family (see phase-3-dependency.md's sibling
# command work-on/build.md Phase 3C.5: `awk '/^### Deliverables/{p=1; next}
# /^### /{p=0} p'`), generalized here to stop at ANY heading level so a
# deeper sub-heading inside a deliverables section still closes capture
# rather than leaking into unrelated prose.
# --------------------------------------------------------------------------- #
extract_investigator_section() {
  awk '
    /^### Affected Files/ { p=1; next }
    /^#/ { p=0 }
    p { print }
  ' <<< "$1"
}

extract_body_fallback_section() {
  awk '
    /^## Affected Files/ || /^## Deliverables/ || /^### Files to change/ { p=1; next }
    /^#/ { p=0 }
    p { print }
  ' <<< "$1"
}

extract_paths() {
  # -E (POSIX extended regex), not -P (PCRE): the pattern below needs only
  # alternation and `?` grouping, both supported by -E, and -P depends on a
  # UTF-8 locale being active (`grep: -P supports only unibyte and UTF-8
  # locales` otherwise) — a portability trap the original inline pseudocode
  # in phase-3-dependency.md carried (forge#2436) and that this script fixes
  # by not needing PCRE at all.
  grep -oE "$EXT_REGEX" <<< "$1" 2>/dev/null | tr -d '`' | sort -u || true
}

# --------------------------------------------------------------------------- #
# Primary path: FORGE:INVESTIGATOR comment, scoped to its own Affected Files section
# --------------------------------------------------------------------------- #
PROVENANCE="none"
FILES=""

# NOTE: deliberately no `| tail -1` here — `gh api --jq`'s raw-string output
# for a multi-line `.body` field embeds literal newlines, so isolating "the
# last comment" by taking the last output LINE would instead truncate to
# only the last line of the (possibly only) comment's body, breaking the
# heading-scoped awk extraction below. In practice Phase 1 of the pipeline
# deletes any partial FORGE:INVESTIGATOR comment before reposting (see
# work-on/investigate.md), so at most one such comment exists per issue at
# any time — matching the original Layer 1 pseudocode, which also consumed
# this stream directly with no last-comment isolation.
INVESTIGATOR_BODY=$(gh api "repos/${REPO}/issues/${NUM}/comments" \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' 2>/dev/null || true)

if [[ -n "$INVESTIGATOR_BODY" ]]; then
  SCOPED=$(extract_investigator_section "$INVESTIGATOR_BODY")
  FILES=$(extract_paths "$SCOPED")
  if [[ -n "$FILES" ]]; then
    PROVENANCE="affected-files-section"
  fi
else
  # --------------------------------------------------------------------------- #
  # Fallback path: raw issue body, scoped to a deliverables-shaped heading.
  # Only reached when NO FORGE:INVESTIGATOR comment exists at all (matches the
  # original Layer 1 contract: "For issues WITHOUT an investigation comment,
  # fall back to parsing the issue body").
  # --------------------------------------------------------------------------- #
  ISSUE_BODY=$(gh issue view "$NUM" -R "$REPO" --json body --jq '.body' 2>/dev/null || true)
  if [[ -n "$ISSUE_BODY" ]]; then
    SCOPED=$(extract_body_fallback_section "$ISSUE_BODY")
    FILES=$(extract_paths "$SCOPED")
    if [[ -n "$FILES" ]]; then
      PROVENANCE="body-fallback"
    fi
  fi
fi

echo "PROVENANCE=$PROVENANCE"
if [[ -n "$FILES" ]]; then
  printf '%s\n' "$FILES"
fi

exit 0
