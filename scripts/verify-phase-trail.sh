#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# verify-phase-trail.sh — Deterministic phase-trail gate for the /work-on pipeline.
#
# Verifies that an issue carries the FORGE artifacts that the mandatory phases
# are required to produce, so a PR is never opened or merged on a reviewer
# verdict alone after phases were silently skipped.
#
# Usage:
#   verify-phase-trail.sh <issue> -R <owner/repo> [--docs-only]
#
#   --docs-only   The diff is documentation-only; the FORGE:QUALITY_GATE marker
#                 is not required.
#
# Requirements by COMPLEXITY_BAND (read from the FORGE:FAST_PATH comment).
# The authoritative table is the `case "$EFFECTIVE"` block below; this summary must be
# updated together with it (and commands/work-on/review.md):
#   INVESTIGATION  INVESTIGATOR, FAST_PATH
#   TRIVIAL        INVESTIGATOR, CONTRACT, FAST_PATH, QUALITY_GATE*
#   STANDARD/COMPLEX (or unknown band)
#                  INVESTIGATOR, CONTRACT, FAST_PATH, CONTEXT, ARCHITECT, QUALITY_GATE*
#   (* waived with --docs-only)
#   A missing FAST_PATH is itself a failure; the remaining checks then use the
#   conservative STANDARD requirement set.
#
# Output (stdout, machine-readable):
#   PHASE_TRAIL: PASS|FAIL|ERROR
#   BAND: <band>
#   MISSING: <marker> -> <phase to re-run>      (one line per missing artifact)
#
# Exit codes: 0 pass, 1 one or more artifacts missing, 2 could not read the
# issue (fails closed — an unreadable trail is never treated as a pass).
#
# Legacy grace (#3102): an issue whose trusted FORGE:BUILDER:COMPLETE comment was created before
# FORGE_TRAIL_QG_SINCE (default: when the FORGE:QUALITY_GATE marker was introduced, #3061) could
# not have posted the marker, so QUALITY_GATE is waived for it. A missing/undated BUILDER:COMPLETE
# never earns the grace (fail closed). Set FORGE_TRAIL_QG_SINCE="" to disable the grace.
#
# Comment trust: only markers posted by a trusted author count; markers from any
# other commenter are ignored (they cannot satisfy the gate or force a band).
# Trusted = author_association in FORGE_TRAIL_TRUSTED_ASSOCIATIONS
# (default "OWNER,MEMBER,COLLABORATOR"), OR user.type == "Bot" (the pipeline's
# GitHub App identity), OR user.login in FORGE_TRAIL_TRUSTED_LOGINS
# (comma-separated, default empty).
# Identities outside that set -- e.g. a human with author_association CONTRIBUTOR/NONE/FIRST_TIME_CONTRIBUTOR
# (an external contributor running the pipeline under their own login) -- are NOT trusted, so their
# markers are ignored and the gate reports them MISSING. To accept such an identity add its login to
# FORGE_TRAIL_TRUSTED_LOGINS, or widen FORGE_TRAIL_TRUSTED_ASSOCIATIONS (e.g. add CONTRIBUTOR). On FAIL the
# script prints a NOTE when untrusted-author FORGE markers were seen, so this is diagnosable (#3123).
# Limits: "Bot" trusts any GitHub App/bot that can comment on the repo (set
# FORGE_TRAIL_TRUSTED_ASSOCIATIONS and FORGE_TRAIL_TRUSTED_LOGINS to tighten);
# COLLABORATOR includes read-level collaborators; login matching is case-sensitive.

set -uo pipefail

ISSUE=""
REPO=""
DOCS_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    -R|--repo)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then echo "PHASE_TRAIL: ERROR"; echo "usage error: $1 needs a value" >&2; exit 2; fi
      REPO="$2"; shift 2 ;;
    --docs-only) DOCS_ONLY=1; shift ;;
    -h|--help) sed -n '5,54p' "$0"; exit 0 ;;
    *)
      if [ -z "$ISSUE" ] && [[ "$1" =~ ^[0-9]+$ ]]; then ISSUE="$1"; shift
      else echo "PHASE_TRAIL: ERROR"; echo "usage error: unexpected argument '$1'" >&2; exit 2; fi
      ;;
  esac
done

if [ -z "$ISSUE" ] || [ -z "$REPO" ]; then
  echo "PHASE_TRAIL: ERROR"
  echo "usage: verify-phase-trail.sh <issue> -R <owner/repo> [--docs-only]" >&2
  exit 2
fi

RAW=$(gh api "repos/${REPO}/issues/${ISSUE}/comments" --paginate 2>/dev/null) || {
  echo "PHASE_TRAIL: ERROR"
  echo "could not read comments for ${REPO}#${ISSUE}" >&2
  exit 2
}

# `gh api --paginate` emits one JSON array per page; merge them into a single array so every
# later computation (notably the latest BUILDER:COMPLETE time) sees ALL pages (#3121).
RAW=$(printf '%s' "$RAW" | jq -s 'add // []' 2>/dev/null) || {
  echo "PHASE_TRAIL: ERROR"
  echo "could not parse comments for ${REPO}#${ISSUE}" >&2
  exit 2
}

# One line per comment, newlines folded to \x1f so a marker and its sentinel can
# be matched within the SAME comment.
TRUSTED_ASSOC="${FORGE_TRAIL_TRUSTED_ASSOCIATIONS-OWNER,MEMBER,COLLABORATOR}"
TRUSTED_LOGINS="${FORGE_TRAIL_TRUSTED_LOGINS-}"
COMMENTS=$(printf '%s' "$RAW" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" '
  ($assoc | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $A
  | ($logins | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $L
  | .[]
  | select(
      ((.author_association // "") as $x | $A | index($x) != null)
      or ((.user.type // "") == "Bot")
      or ((.user.login // "") as $x | $L | index($x) != null)
    )
  | .body // "" | gsub("\r?\n"; "\u001f")' 2>/dev/null) || {
  echo "PHASE_TRAIL: ERROR"
  echo "could not parse comments for ${REPO}#${ISSUE}" >&2
  exit 2
}

# Creation time of the LATEST trusted FORGE:BUILDER:COMPLETE comment (empty when absent/undated).
QG_SINCE="${FORGE_TRAIL_QG_SINCE-2026-10-07T03:40:12Z}"
# The cutoff must be ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ) and not in the future: a malformed or
# far-future value would otherwise waive QUALITY_GATE for every issue (#3121). Fails closed.
if [ -n "$QG_SINCE" ]; then
  NOW_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if ! [[ "$QG_SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || [[ "$QG_SINCE" > "$NOW_UTC" ]]; then
    echo "PHASE_TRAIL: ERROR"
    echo "invalid FORGE_TRAIL_QG_SINCE '${QG_SINCE}': must be ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ) and not in the future" >&2
    exit 2
  fi
fi
BUILD_AT=$(printf '%s' "$RAW" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" '
  ($assoc | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $A
  | ($logins | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $L
  | [ .[]
      | select(
          ((.author_association // "") as $x | $A | index($x) != null)
          or ((.user.type // "") == "Bot")
          or ((.user.login // "") as $x | $L | index($x) != null)
        )
      | select((.body // "") | startswith("<!-- FORGE:BUILDER -->") and contains("<!-- FORGE:BUILDER:COMPLETE -->"))
      | .created_at // empty ] | sort | .[-1] // empty' 2>/dev/null) || BUILD_AT=""

# NOTE: never use early-exiting `grep -q`/`head -1` after printf under pipefail: on large threads the
# writer gets SIGPIPE and the pipeline reports failure for a marker that is present (#3099).
# A marker only counts when it is the FIRST thing in a comment (comments are folded to one
# line each above), so a comment that merely quotes a marker mid-body cannot satisfy it.
has() { printf '%s\n' "$COMMENTS" | grep -E "^$1" >/dev/null; }

# INVESTIGATION:INVALID is the other terminal sentinel (issue closed invalid, no PR follows).
has_investigator() {
  printf '%s\n' "$COMMENTS" | grep -E '^<!-- FORGE:INVESTIGATOR -->' | grep -E 'INVESTIGATION:(COMPLETE|INVALID)' >/dev/null
}

# Quality gate: a marker comment whose result is PASS (any later PASS wins over an earlier FAIL).
has_quality_gate_pass() {
  printf '%s\n' "$COMMENTS" | grep -E '^<!-- FORGE:QUALITY_GATE -->' | grep -E '\*\*Result\*\*: *PASS' >/dev/null
}

BAND=""
if has '<!-- FORGE:FAST_PATH -->'; then
  # The FIRST classification wins: a later FAST_PATH comment cannot downgrade the requirement set.
  BAND=$(printf '%s\n' "$COMMENTS" | grep -E '^<!-- FORGE:FAST_PATH -->' | sed -n '1p' \
    | sed -n 's/.*\*\*COMPLEXITY_BAND\*\*: *\([A-Za-z_]*\).*/\1/p' | tr '[:lower:]' '[:upper:]')
fi

MISSING=()
add_missing() { MISSING+=("$1 -> $2"); }

has_investigator || add_missing "INVESTIGATOR" "re-run Skill work-on/investigate"

if [ -z "$BAND" ]; then
  if has '<!-- FORGE:FAST_PATH -->'; then
    add_missing "FAST_PATH (no COMPLEXITY_BAND value)" "re-run work-on Phase 3B classification"
  else
    add_missing "FAST_PATH" "re-run work-on Phase 3B classification"
  fi
  EFFECTIVE="STANDARD"
else
  EFFECTIVE="$BAND"
fi

case "$EFFECTIVE" in
  INVESTIGATION) NEED_CONTRACT=0; NEED_CTX=0; NEED_QG=0 ;;
  TRIVIAL)       NEED_CONTRACT=1; NEED_CTX=0; NEED_QG=1 ;;
  *)             NEED_CONTRACT=1; NEED_CTX=1; NEED_QG=1 ;;
esac
[ "$DOCS_ONLY" = "1" ] && NEED_QG=0
# Legacy grace: built before the quality-gate marker existed -> not required (string compare on ISO-8601 UTC).
if [ "$NEED_QG" = "1" ] && [ -n "$QG_SINCE" ] && [ -n "$BUILD_AT" ] && [[ "$BUILD_AT" < "$QG_SINCE" ]]; then
  NEED_QG=0
  LEGACY_NOTE="QUALITY_GATE waived: build completed ${BUILD_AT} before ${QG_SINCE}"
fi

if [ "$NEED_CONTRACT" = "1" ] && ! has '<!-- FORGE:CONTRACT -->'; then
  add_missing "CONTRACT" "re-run Skill work-on/build Phase B2 (builder contract)"
fi
if [ "$NEED_CTX" = "1" ]; then
  has '<!-- FORGE:CONTEXT -->' || add_missing "CONTEXT" "re-run Skill work-on/build/context"
  has '<!-- FORGE:ARCHITECT -->' || add_missing "ARCHITECT" "re-run Skill work-on/build/architect"
fi
if [ "$NEED_QG" = "1" ] && ! has_quality_gate_pass; then
  add_missing "QUALITY_GATE" "re-run Skill work-on/build/validate"
fi

if [ "${#MISSING[@]}" -eq 0 ]; then
  echo "PHASE_TRAIL: PASS"
  echo "BAND: ${BAND:-UNKNOWN}"
  [ -n "${LEGACY_NOTE:-}" ] && echo "NOTE: $LEGACY_NOTE"
  exit 0
fi

echo "PHASE_TRAIL: FAIL"
echo "BAND: ${BAND:-UNKNOWN}"
for m in "${MISSING[@]}"; do echo "MISSING: $m"; done
# Diagnose the "marker present but ignored" case: count FORGE markers posted by untrusted authors.
UNTRUSTED_FORGE=$(printf '%s' "$RAW" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" '
  ($assoc | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $A
  | ($logins | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $L
  | [ .[]
      | select(((.author_association // "") as $x | $A | index($x) == null)
               and ((.user.type // "") != "Bot")
               and ((.user.login // "") as $x | $L | index($x) == null))
      | select((.body // "") | startswith("<!-- FORGE:")) ] | length' 2>/dev/null || echo 0)
if [ "${UNTRUSTED_FORGE:-0}" -gt 0 ] 2>/dev/null; then
  echo "NOTE: ${UNTRUSTED_FORGE} FORGE marker comment(s) from untrusted authors were ignored; set FORGE_TRAIL_TRUSTED_LOGINS or FORGE_TRAIL_TRUSTED_ASSOCIATIONS to trust them"
fi
exit 1
