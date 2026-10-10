#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# classify-finding.sh — Deterministic review-pr §6B.5 note disposition.
#                        Decides whether one deduped review finding is filed
#                        as a standalone `review-finding` issue (ISSUE) or
#                        handled as a non-blocking note (NOTE).
#
# Usage:
#   classify-finding.sh --severity <S> [--confidence <C>] [--agent <A>]
#                       [--lineage none|review-finding] [--text <T> | --text-file <F>]
#                       [--inpr-diff <F> --file <P>] [--contract-scope <F> --contract-open <F> [--pr-files <F>] [--merge-issue <N>]]
#
#   --severity    CRITICAL | HIGH | MEDIUM | LOW (case-insensitive). Missing or
#                 unparseable → ISSUE (fail toward filing, never drop).
#   --confidence  CONFIRMED | LIKELY | POSSIBLE (case-insensitive). Missing is
#                 treated as not-POSSIBLE.
#   --agent       The `**Agent**:` value of the finding (e.g. "Security", "Auth").
#   --lineage     `review-finding` when the PR's linked issue (MERGE_ISSUE) carries
#                 the `review-finding` label — i.e. this PR is itself a fix for a
#                 review finding. Default `none`.
#   --text/--text-file  Finding title + body + affected file paths, used for the
#                 content-based safety exemption.
#   --inpr-diff <F> --file <P>  In-PR fix gate (#3387, narrowed): F is a file listing the
#                 PR's changed paths, one per line; P is the finding's file path. When both
#                 are given, a MEDIUM CONFIRMED finding whose path is in the PR diff is
#                 classified INPR_FIX — fix it on the PR before merge instead of filing it.
#                 Callers pass these only for the first fix round of an auto-merge review.
#
#   --contract-scope <F> --contract-open <F> --file <P>  Contract-declared scope gate: F is the TSV
#                 from `check-contract-scope.sh list` (disposition<TAB>path<TAB>issue). A finding
#                 whose path equals, or sits under, a `deferred` or `accepted-risk` item becomes
#                 `NOTE contract-deferred #N` / `NOTE contract-accepted-risk`. `--contract-open`
#                 lists the deferred issue numbers confirmed open, one per line; a deferred item
#                 demotes only when its number is listed (closed, unreadable or absent: no demotion).
#                 The caller lists a number only after verifying it is an open issue (not a PR) whose
#                 body carries `FORGE:DEFERRED_FROM: #<merge issue>` and the path.
#                 `--merge-issue <N>` is the PR's linked issue: `deferred → #N` never demotes (that
#                 issue is always open during review, so it is no follow-up).
#                 Never demoted: CRITICAL/HIGH, `not-affected` items, safety-exempt findings
#                 (security/billing keywords or a dedicated domain agent) under either disposition, and
#                 findings whose path is in `--inpr-diff` or `--pr-files` (this PR touched it; the
#                 contract excluded the sibling path, not regressions the PR introduced in it).
#                 `--pr-files <F>` is the PR's changed paths, one per line, supplied for this guard
#                 alone (it never triggers INPR_FIX). The gate runs after the severity and in-PR gates. Without the flags output is unchanged.
#
# Output (stdout, one line): `ISSUE <reason>`, `NOTE <reason>` or `INPR_FIX <reason>`.
# Exit codes: 0 classified, 2 usage error.
#
# Rules (forge#3060, tightened after the 2026-10-08 cascade audit):
#   1. HIGH/CRITICAL, or unparseable severity → ISSUE.
#   2. Safety exemption is CONTENT-based: the text matches the security/billing
#      keyword set, or the finding came from a dedicated, signal-selected domain
#      agent (Auth, Billing, Concurrency, Database) and is MEDIUM+ or CONFIRMED. Origin from the always-on
#      "General Security & Quality" agent alone NO LONGER exempts a finding —
#      that agent runs on every PR, so origin-based exemption filed nearly every
#      LOW note it raised (50 of 60 would-be notes in the audited batch).
#   3. Review-finding lineage (a fix for a finding): only MEDIUM findings that are
#      CONFIRMED, or LIKELY and safety-exempt, become issues. LOW is always a
#      NOTE — a fix for a finding must not mint a new generation of findings.
#   4. Otherwise: LOW, or POSSIBLE below HIGH, is a NOTE unless safety-exempt.
#
# NOTEs are never discarded silently: review-pr §6B.5 fixes them in-PR, lists
# them in the PR body, or records a drop reason in the review summary.
#
# Portable: bash 3.2 (macOS /bin/bash), BSD and GNU grep/tr. No network.

set -u

SEVERITY=""
CONFIDENCE=""
AGENT=""
LINEAGE="none"
TEXT=""
INPR_DIFF=""
FINDING_FILE=""
CONTRACT_SCOPE=""
CONTRACT_OPEN=""
PR_FILES=""
MERGE_ISSUE=""

usage() {
  echo "ERROR: Usage: classify-finding.sh --severity <S> [--confidence <C>] [--agent <A>] [--lineage none|review-finding] [--text <T> | --text-file <F>] [--inpr-diff <F> --file <P>] [--contract-scope <F> --contract-open <F> [--pr-files <F>] [--merge-issue <N>]]" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --severity)   [ "$#" -ge 2 ] || usage; SEVERITY="$2"; shift 2 ;;
    --confidence) [ "$#" -ge 2 ] || usage; CONFIDENCE="$2"; shift 2 ;;
    --agent)      [ "$#" -ge 2 ] || usage; AGENT="$2"; shift 2 ;;
    --lineage)    [ "$#" -ge 2 ] || usage; LINEAGE="$2"; shift 2 ;;
    --text)       [ "$#" -ge 2 ] || usage; TEXT="$2"; shift 2 ;;
    --inpr-diff)  [ "$#" -ge 2 ] || usage; INPR_DIFF="$2"; shift 2 ;;
    --file)       [ "$#" -ge 2 ] || usage; FINDING_FILE="$2"; shift 2 ;;
    --contract-scope) [ "$#" -ge 2 ] || usage; CONTRACT_SCOPE="$2"; shift 2 ;;
    --contract-open)  [ "$#" -ge 2 ] || usage; CONTRACT_OPEN="$2"; shift 2 ;;
    --pr-files)       [ "$#" -ge 2 ] || usage; PR_FILES="$2"; shift 2 ;;
    --merge-issue)    [ "$#" -ge 2 ] || usage; MERGE_ISSUE="${2#\#}"; shift 2 ;;
    --text-file)
      [ "$#" -ge 2 ] || usage
      [ -r "$2" ] || { echo "ERROR: --text-file not readable: $2" >&2; exit 2; }
      TEXT=$(cat "$2"); shift 2 ;;
    *) usage ;;
  esac
done

case "$LINEAGE" in
  none|review-finding) ;;
  *) echo "ERROR: --lineage must be 'none' or 'review-finding' (got '$LINEAGE')" >&2; exit 2 ;;
esac

if [ -n "$INPR_DIFF" ] && [ ! -r "$INPR_DIFF" ]; then
  echo "ERROR: --inpr-diff not readable: $INPR_DIFF" >&2; exit 2
fi

if [ -n "$CONTRACT_SCOPE" ] && [ ! -r "$CONTRACT_SCOPE" ]; then
  echo "ERROR: --contract-scope not readable: $CONTRACT_SCOPE" >&2; exit 2
fi
if [ -n "$CONTRACT_OPEN" ] && [ ! -r "$CONTRACT_OPEN" ]; then
  echo "ERROR: --contract-open not readable: $CONTRACT_OPEN" >&2; exit 2
fi

if [ -n "$PR_FILES" ] && [ ! -r "$PR_FILES" ]; then
  echo "ERROR: --pr-files not readable: $PR_FILES" >&2; exit 2
fi

upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]'; }
SEV=$(upper "$SEVERITY")
CONF=$(upper "$CONFIDENCE")

case "$SEV" in
  CRITICAL|HIGH) echo "ISSUE severity-$SEV"; exit 0 ;;
  MEDIUM|LOW) ;;
  *) echo "ISSUE unparseable-severity"; exit 0 ;;
esac

# In-PR fix gate (#3387, narrowed). MEDIUM CONFIRMED is an ISSUE under every rule below
# (lineage included), so checking here changes only where it is handled, never whether.
if [ -n "$INPR_DIFF" ] && [ -n "$FINDING_FILE" ] && [ "$SEV" = "MEDIUM" ] && [ "$CONF" = "CONFIRMED" ]; then
  _path="${FINDING_FILE#./}"; _path="${_path%%:*}"
  if grep -Fxq -- "$_path" "$INPR_DIFF"; then
    echo "INPR_FIX medium-confirmed-in-diff"
    exit 0
  fi
fi

# Safety exemption. Keywords match whole words, where `_`, `-`, `/` and other
# punctuation separate words (so `auth_service` matches, `author` does not).
SAFETY=""
KW='security|auth|authz|authn|billing|payment|stripe|charge|invoice|injection|xss|csrf|ssrf|idor|secret|secrets|credential|credentials|permission|permissions|sql|token|password|redact'
if printf '%s' "$TEXT" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' ' ' | grep -Eqw "($KW)"; then
  SAFETY="keyword"
fi
# A dedicated domain agent rescues a finding only when it is MEDIUM+ or CONFIRMED:
# a LOW/POSSIBLE finding stays a NOTE whichever reviewer raised it.
AGENT_LC=$(printf '%s' "$AGENT" | tr '[:upper:]' '[:lower:]')
case "$AGENT_LC" in
  auth*|billing*|concurrency*|database*)
    if [ "$SEV" = "MEDIUM" ] || [ "$CONF" = "CONFIRMED" ]; then SAFETY="${SAFETY:-domain-agent}"; fi ;;
esac

# Contract-declared scope gate (#3447). Fails toward filing: any missing input, closed or unlisted
# deferred issue, a deferral to the PR's own issue, an in-PR path, or a safety-exempt finding keeps
# the classification below.
if [ -n "$CONTRACT_SCOPE" ] && [ -n "$FINDING_FILE" ]; then
  _fpath="${FINDING_FILE#./}"; _fpath="${_fpath%%:*}"
  _inpr=""
  if [ -n "$INPR_DIFF" ] && grep -Fxq -- "$_fpath" "$INPR_DIFF"; then _inpr=1; fi
  if [ -n "$PR_FILES" ] && grep -Fxq -- "$_fpath" "$PR_FILES"; then _inpr=1; fi
  if [ -z "$_inpr" ]; then
    while IFS="$(printf '\t')" read -r _disp _ipath _inum; do
      [ -n "$_ipath" ] || continue
      _ipath="${_ipath#./}"; _ipath="${_ipath%/}"
      [ "$_fpath" = "$_ipath" ] || case "$_fpath" in "$_ipath"/*) ;; *) continue ;; esac
      case "$_disp" in
        deferred)
          if [ -z "$SAFETY" ] && [ -n "$_inum" ] && [ "$_inum" != "$MERGE_ISSUE" ] \
             && [ -n "$CONTRACT_OPEN" ] && grep -Fxq -- "$_inum" "$CONTRACT_OPEN"; then
            echo "NOTE contract-deferred #$_inum"; exit 0
          fi ;;
        accepted-risk)
          if [ -z "$SAFETY" ]; then echo "NOTE contract-accepted-risk"; exit 0; fi ;;
      esac
    done < "$CONTRACT_SCOPE"
  fi
fi

if [ "$LINEAGE" = "review-finding" ]; then
  if [ "$SEV" = "MEDIUM" ] && { [ "$CONF" = "CONFIRMED" ] || { [ -n "$SAFETY" ] && [ "$CONF" = "LIKELY" ]; }; }; then
    echo "ISSUE lineage-medium-${CONF:-UNKNOWN}"
  else
    echo "NOTE lineage-${SEV}-${CONF:-UNKNOWN}"
  fi
  exit 0
fi

if [ "$SEV" = "LOW" ] || [ "$CONF" = "POSSIBLE" ]; then
  if [ -n "$SAFETY" ]; then
    echo "ISSUE safety-exemption-$SAFETY"
  else
    echo "NOTE ${SEV}-${CONF:-UNKNOWN}"
  fi
  exit 0
fi

echo "ISSUE ${SEV}-${CONF:-UNKNOWN}"
exit 0
