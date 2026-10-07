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
# Requirements by COMPLEXITY_BAND (read from the FORGE:FAST_PATH comment):
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

set -uo pipefail

ISSUE=""
REPO=""
DOCS_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    -R|--repo) REPO="${2:-}"; shift 2 ;;
    --docs-only) DOCS_ONLY=1; shift ;;
    -h|--help) sed -n '5,32p' "$0"; exit 0 ;;
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

# One line per comment, newlines folded to \x1f so a marker and its sentinel can
# be matched within the SAME comment.
COMMENTS=$(printf '%s' "$RAW" | jq -r '.[] | .body // "" | gsub("\r?\n"; "\u001f")' 2>/dev/null) || {
  echo "PHASE_TRAIL: ERROR"
  echo "could not parse comments for ${REPO}#${ISSUE}" >&2
  exit 2
}

has() { printf '%s\n' "$COMMENTS" | grep -qE "$1"; }

has_investigator() {
  printf '%s\n' "$COMMENTS" | grep -E '<!-- FORGE:INVESTIGATOR -->' | grep -qE 'INVESTIGATION:COMPLETE'
}

# Quality gate: a marker comment whose result is PASS (any later PASS wins over an earlier FAIL).
has_quality_gate_pass() {
  printf '%s\n' "$COMMENTS" | grep -E '<!-- FORGE:QUALITY_GATE -->' | grep -qE '\*\*Result\*\*: *PASS'
}

BAND=""
if has '<!-- FORGE:FAST_PATH -->'; then
  BAND=$(printf '%s\n' "$COMMENTS" | grep -E '<!-- FORGE:FAST_PATH -->' | tail -1 \
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
  exit 0
fi

echo "PHASE_TRAIL: FAIL"
echo "BAND: ${BAND:-UNKNOWN}"
for m in "${MISSING[@]}"; do echo "MISSING: $m"; done
exit 1
