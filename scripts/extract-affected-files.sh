#!/usr/bin/env bash
# extract-affected-files.sh — Positionally-scoped affected-file extraction for
# /orchestrate Phase 3C Layer 1 (see commands/orchestrate/phase-3-dependency.md)
#
# Usage:
#   extract-affected-files.sh <issue_number> -R <owner/repo>
#   extract-affected-files.sh <issue_number> "-R <owner/repo>"   (single pre-joined token also accepted)
#
# Output (stdout):
#   Line 1:   PROVENANCE=contract-deliverables | affected-files-section | body-fallback | none | error
#   Line 2+:  one extracted file path per line (zero lines when PROVENANCE=none or error)
#
# Exit codes:
#   0 — Extraction completed (including the zero-files/PROVENANCE=none case — that is
#       a valid, expected outcome, NOT an error; callers must not treat exit 0 as proof
#       that files were found).
#   2 — Usage error (missing issue number, malformed -R value).
#
# Extraction rules (forge#2436, extended forge#2848):
#   0. Highest-confidence path — the issue's FORGE:CONTRACT comment (if one exists),
#      scoped to ONLY its own "### Deliverables" section. A contract deliverables table
#      states *intent to change* ("I will edit this file"), whereas an investigation's
#      Affected Files list and especially a raw issue body routinely name files as
#      *context* ("this interacts with X", "similar to the check in Y"). Preferring the
#      contract is what stops a cohort of issues that merely cite the same file from
#      being serialized against each other (forge#2848).
#      -> PROVENANCE=contract-deliverables
#
#      TEMPORAL CAVEAT — do not over-claim this source: FORGE:CONTRACT is posted at
#      *build* time (work-on/build.md Phase B2), which is AFTER /orchestrate Phase 3
#      builds the DAG. On a cold first-pass plan no contract exists yet, so this path is
#      inert by construction. It pays off only on the paths that re-extract later: wake /
#      re-plan after compaction, mid-batch re-derivation (phase-4-execution.md's DONE-arm
#      DROP handling), and IN_PROGRESS predecessors built in an earlier wave or session.
#
#      FALL-THROUGH RULE (load-bearing — see forge#2848 risk table): a contract that
#      exists but whose Deliverables section yields ZERO paths MUST fall through to the
#      INVESTIGATOR path below. A contract is an *upgrade* over the investigator source,
#      never a replacement for it — blackholing to `none` here would fire Layer 4's
#      conservative serialization for exactly the mid-batch issues this change exists to
#      un-serialize, i.e. the bug being fixed, inverted. Note this is deliberately NOT
#      the same shape as the INVESTIGATOR->body relationship in rule 2, which does NOT
#      fall through on zero files (see rule 2's own note, forge#2382).
#   1. Primary path — the issue's FORGE:INVESTIGATOR comment (if one exists), scoped to
#      ONLY its own "### Affected Files" section. Capture stops at the next markdown
#      heading of any level, so paths mentioned in "### Evidence", "### Root Cause",
#      "### Related Issues", etc. are never collected.
#      -> PROVENANCE=affected-files-section
#      NOTE (forge#2382): unlike rule 0, an INVESTIGATOR comment that EXISTS but yields
#      zero paths does NOT fall through to rule 2 — an investigation that scoped its own
#      Affected Files section to nothing is a confirmed-empty result, not a missing one.
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
#   4. PROVENANCE=error — distinct from `none` (forge#2504): emitted when a `gh`
#      invocation itself fails (non-zero exit — network error, auth expiry, rate
#      limit) AND no file path was recovered from any path (including a fallback
#      attempted after a failed primary call). `none` means "we confirmed there is
#      nothing to extract"; `error` means "we could not confirm that — a `gh` call
#      failed, so this result is inconclusive, not a verified empty result." A `gh`
#      failure that is followed by a *successful* fallback yielding real files still
#      reports the normal `body-fallback` provenance — `error` only fires when the
#      failure actually cost us data.
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

# An optional line-reference suffix is accepted and stripped: review findings cite
# `file.md:211`, `file.sh:104-114,162` or `file.md:~1685`, which the strict form missed,
# leaving every finding-batch DAG on the low-confidence body fallback (field test).
EXT_REGEX='`[^`]*\.(py|tsx?|jsx?|sql|json|ya?ml|mjs|js|sh|md)(:~?[0-9][0-9,~-]*)?`'

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
extract_contract_section() {
  # forge#2848 — same sentinel shape as the two helpers below, targeting the
  # FORGE:CONTRACT comment's "### Deliverables" table. The `/^### Deliverables/`
  # heading and the awk sentinel are the ones already proven in-tree at
  # commands/work-on/build.md:218 and :258; only the path-extraction step differs
  # (this script uses grep -oE via extract_paths, never build.md's grep -oP —
  # forge#2436 removed the PCRE dependency on purpose, see extract_paths below).
  awk '
    /^### Deliverables/ { p=1; next }
    /^#/ { p=0 }
    p { print }
  ' <<< "$1"
}

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
  grep -oE "$EXT_REGEX" <<< "$1" 2>/dev/null | tr -d '`' | sed -E 's/:~?[0-9][0-9,~-]*$//' | sort -u || true
}

PROVENANCE="none"
FILES=""
GH_CALL_FAILED=0

# --------------------------------------------------------------------------- #
# Highest-confidence path: FORGE:CONTRACT comment, scoped to its own Deliverables
# section (forge#2848). Runs AHEAD of the INVESTIGATOR path because a deliverables
# table states intent to change, while an Affected Files list may name files that
# are merely relevant. See rule 0 in the header for the temporal caveat (a contract
# only exists post-build, so this is inert on a cold first-pass plan).
#
# Uses the same `if ! VAR=$(cmd); then GH_CALL_FAILED=1; fi` idiom as the calls
# below — never `|| true` — so a failed contract fetch stays distinguishable from
# "no contract exists" and can still escalate to PROVENANCE=error if nothing else
# recovers real data (forge#2504).
# --------------------------------------------------------------------------- #
if ! CONTRACT_BODY=$(gh api "repos/${REPO}/issues/${NUM}/comments" \
  --jq '[.[] | select(.body | contains("FORGE:CONTRACT"))] | last | .body // ""' 2>/dev/null); then
  GH_CALL_FAILED=1
  echo "WARNING: gh api call failed while fetching comments for issue #$NUM (repo: $REPO) — cannot confirm whether a FORGE:CONTRACT comment exists; treating as inconclusive, not empty" >&2
  CONTRACT_BODY=""
fi

if [[ -n "$CONTRACT_BODY" ]]; then
  SCOPED=$(extract_contract_section "$CONTRACT_BODY")
  FILES=$(extract_paths "$SCOPED")
  if [[ -n "$FILES" ]]; then
    PROVENANCE="contract-deliverables"
  fi
fi

# --------------------------------------------------------------------------- #
# Primary path: FORGE:INVESTIGATOR comment, scoped to its own Affected Files section
#
# Guarded on `-z "$FILES"` so the contract path above FALLS THROUGH when it yielded
# zero paths (no contract, no Deliverables section, or a deliverables table naming no
# recognized file extension). The guard wraps the whole INVESTIGATOR/body block from
# the outside, leaving the INVESTIGATOR->body-fallback relationship inside it
# byte-identical — that inner relationship deliberately does NOT fall through on zero
# files (forge#2382), and this change must not alter it.
# --------------------------------------------------------------------------- #
if [[ -z "$FILES" ]]; then

# NOTE: deliberately no `| tail -1` here — `gh api --jq`'s raw-string output
# for a multi-line `.body` field embeds literal newlines, so isolating "the
# last comment" by taking the last output LINE would instead truncate to
# only the last line of the (possibly only) comment's body, breaking the
# heading-scoped awk extraction below. In practice Phase 1 of the pipeline
# deletes any partial FORGE:INVESTIGATOR comment before reposting (see
# work-on/investigate.md), so at most one such comment exists per issue at
# any time — matching the original Layer 1 pseudocode, which also consumed
# this stream directly with no last-comment isolation.
#
# forge#2504: `VAR=$(cmd 2>/dev/null || true)` discarded gh's exit code
# entirely, so a genuine `gh` failure (network error, auth expiry, rate
# limit) was indistinguishable from "gh succeeded, output legitimately
# empty." Use `if ! VAR=$(cmd); then ... fi` instead — exempt from
# `set -e` because it's an `if` condition, so no `|| true` is needed — and
# track the failure in GH_CALL_FAILED so it can be reflected in PROVENANCE
# below rather than silently defaulting to "none". Same idiom already
# established in scripts/transition-label.sh (forge#1991/PR #1996), adapted
# here because this script must always complete (exit 0) rather than abort,
# so failures are surfaced via a new PROVENANCE=error value instead of a
# non-zero exit.
if ! INVESTIGATOR_BODY=$(gh api "repos/${REPO}/issues/${NUM}/comments" \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' 2>/dev/null); then
  GH_CALL_FAILED=1
  echo "WARNING: gh api call failed while fetching comments for issue #$NUM (repo: $REPO) — cannot confirm whether a FORGE:INVESTIGATOR comment exists; treating as inconclusive, not empty" >&2
  INVESTIGATOR_BODY=""
fi

if [[ -n "$INVESTIGATOR_BODY" ]]; then
  SCOPED=$(extract_investigator_section "$INVESTIGATOR_BODY")
  FILES=$(extract_paths "$SCOPED")
  if [[ -n "$FILES" ]]; then
    PROVENANCE="affected-files-section"
  fi
else
  # --------------------------------------------------------------------------- #
  # Fallback path: raw issue body, scoped to a deliverables-shaped heading.
  # Reached both when NO FORGE:INVESTIGATOR comment exists (the original Layer 1
  # contract: "For issues WITHOUT an investigation comment, fall back to parsing
  # the issue body") AND when the primary gh call above failed (in which case we
  # genuinely don't know if a comment exists, so attempting the fallback gives a
  # chance at real data rather than giving up immediately).
  # --------------------------------------------------------------------------- #
  if ! ISSUE_BODY=$(gh issue view "$NUM" -R "$REPO" --json body --jq '.body' 2>/dev/null); then
    GH_CALL_FAILED=1
    echo "WARNING: gh issue view call failed for issue #$NUM (repo: $REPO) — cannot confirm the issue body's Affected Files section; treating as inconclusive, not empty" >&2
    ISSUE_BODY=""
  fi
  if [[ -n "$ISSUE_BODY" ]]; then
    SCOPED=$(extract_body_fallback_section "$ISSUE_BODY")
    FILES=$(extract_paths "$SCOPED")
    if [[ -n "$FILES" ]]; then
      PROVENANCE="body-fallback"
    fi
  fi
fi
fi  # end contract fall-through guard (forge#2848) — the INVESTIGATOR/body block
    # above is intentionally left un-indented so it stays byte-identical to its
    # pre-forge#2848 form; only the surrounding guard is new.

# forge#2504: only escalate to "error" when neither path yielded real data AND
# at least one gh call genuinely failed along the way. A failed primary call
# followed by a successful fallback that found files must still report
# body-fallback (real data recovered) — never overwrite that with "error".
if [[ "$PROVENANCE" == "none" && "$GH_CALL_FAILED" -eq 1 ]]; then
  PROVENANCE="error"
fi

echo "PROVENANCE=$PROVENANCE"
if [[ -n "$FILES" ]]; then
  printf '%s\n' "$FILES"
fi

exit 0
