#!/usr/bin/env bash
# check-spec-size.sh — PR spec-size budget (forge#3762).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: check-spec-size.sh [base_ref]     (default: $BASE_REF, else origin/staging)
# Env:   PR_LABELS  comma-separated PR label names (untrusted; grep-matched only)
#        PR_HEAD_REF / PR_BASE_REF  PR head and base branch names; staging -> main
#                   (a release PR) is skipped: cumulative growth is not judged here
#        PR_SAME_REPO  must be "true" for the release skip (a fork branch named
#                   staging must not bypass the budget)
#        GITHUB_STEP_SUMMARY  summary file (stdout when unset)
# Exit:  0 pass/exempt, 1 budget violation, 2 usage/base-ref error (fail closed)
#
# Rules (against the merge-base of HEAD and the PR base, compared in bytes):
#   1. Budgeted specs may not grow by more than 2% or more than 4096 bytes.
#   2. The NET count of canonical block markers across all of commands/**/*.md
#      may not rise (moving a block between files, or replacing one with a stub,
#      is allowed). Count-based until the shared helper lands (#3493).
#   Shrinking or equal size always passes.
# Exemption: the `spec-size-exempt` label only (needs triage rights; a PR-body
# marker is NOT honoured). Failures are reported, exit 0.
# Bash 3.2 portable: no assoc arrays, mapfile, grep -P.
set -uo pipefail

BASE="${1:-${BASE_REF:-origin/staging}}"
PCT_NUM=2            # 2%
ABS_MAX=4096         # bytes
BUDGETED="commands/review-pr.md commands/review-pr-staging.md commands/work-on/remediate.md commands/work-on/review.md commands/work-on.md"

SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
out() { printf '%s\n' "$*" >> "$SUMMARY"; }

if ! git rev-parse --verify -q "$BASE^{commit}" >/dev/null; then
  echo "ERROR: base ref '$BASE' cannot be resolved (shallow checkout? need fetch-depth: 0)" >&2
  exit 2
fi

# --- release PR skip (staging -> main) ---------------------------------------
if [ "${PR_HEAD_REF:-}" = "staging" ] && [ "${PR_BASE_REF:-}" = "main" ] && [ "${PR_SAME_REPO:-}" = "true" ]; then
  out "## Spec-size budget"
  out ""
  out "Result: SKIPPED (release PR staging -> main; growth was checked per PR)"
  echo "spec-size: skipped for release PR staging -> main"
  exit 0
fi

# Compare against the merge-base, not the base tip (base moves after branching).
MB=$(git merge-base HEAD "$BASE" 2>/dev/null) || MB=""
if [ -z "$MB" ]; then
  echo "ERROR: no merge-base between HEAD and '$BASE' (need fetch-depth: 0)" >&2
  exit 2
fi
BASE="$MB"

# --- exemption: label only ---------------------------------------------------
EXEMPT_REASON=""
if printf '%s' "${PR_LABELS:-}" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -qxF 'spec-size-exempt'; then
  EXEMPT_REASON="label spec-size-exempt"
fi

FAILURES=0
base_size() { git cat-file -s "$BASE:$1" 2>/dev/null || echo 0; }
MARKERS='FORGE_ROOT bootstrap \(canonical|TRUSTED_SCRIPT=""|HELPER_SCRIPT=""|mkdir -p "\$_SD".*# FENCE_BOOTSTRAP'

out "## Spec-size budget (base: \`$BASE\`)"
out ""
out "| File | Base | Head | Delta | Delta % | Status |"
out "|------|-----:|-----:|------:|--------:|--------|"
for f in $BUDGETED; do
  [ -f "$f" ] || [ "$(base_size "$f")" != 0 ] || continue
  b=$(base_size "$f")
  h=0; [ -f "$f" ] && h=$(wc -c < "$f" | tr -d ' ')
  g=$((h - b))
  status="ok"
  if [ "$g" -gt 0 ] && { [ $((g * 100)) -gt $((b * PCT_NUM)) ] || [ "$g" -gt "$ABS_MAX" ]; }; then
    status="OVER BUDGET"; FAILURES=$((FAILURES + 1))
  fi
  if [ "$b" -gt 0 ]; then
    p=$(awk -v g="$g" -v b="$b" 'BEGIN{printf "%+.2f%%", g*100/b}')
  else p="n/a"; fi
  out "| \`$f\` | $b | $h | $g | $p | $status |"
done

# Net marker total across every commands/**/*.md: head (working tree, incl. new
# files) vs base (incl. files deleted at head). Fail only when the total rises.
HEAD_TOTAL=0; BASE_TOTAL=0; MARKER_ROWS=""
HEAD_FILES=$(git ls-files 'commands/*.md' | sort -u)
BASE_FILES=$(git ls-tree -r --name-only "$BASE" -- commands | grep -E '\.md$' | sort -u)
for f in $(printf '%s\n%s\n' "$HEAD_FILES" "$BASE_FILES" | sort -u); do
  [ -n "$f" ] || continue
  hc=0; [ -f "$f" ] && hc=$(grep -cE "$MARKERS" "$f" 2>/dev/null || true); hc=${hc:-0}
  bc=$(git show "$BASE:$f" 2>/dev/null | grep -cE "$MARKERS" 2>/dev/null || true); bc=${bc:-0}
  HEAD_TOTAL=$((HEAD_TOTAL + hc)); BASE_TOTAL=$((BASE_TOTAL + bc))
  [ "$hc" -ne "$bc" ] && MARKER_ROWS="$MARKER_ROWS| \`$f\` | $bc | $hc |
"
done
if [ "$HEAD_TOTAL" -gt "$BASE_TOTAL" ]; then
  FAILURES=$((FAILURES + 1))
  out ""
  out "### NEW CANONICAL BLOCK COPY: net marker total rose $BASE_TOTAL -> $HEAD_TOTAL (source the shared helper instead)"
fi
if [ -n "$MARKER_ROWS" ]; then
  out ""
  out "| File | Base markers | Head markers |"
  out "|------|-----:|-----:|"
  printf '%s' "$MARKER_ROWS" >> "$SUMMARY"
fi

out ""
if [ "$FAILURES" -eq 0 ]; then
  out "Result: PASS"
  exit 0
fi
if [ -n "$EXEMPT_REASON" ]; then
  out "Result: EXEMPT ($FAILURES violation(s) waived: $EXEMPT_REASON)"
  echo "spec-size: $FAILURES violation(s) waived: $EXEMPT_REASON"
  exit 0
fi
out "Result: FAIL ($FAILURES violation(s)). Shrink the spec, or ask a maintainer to add the spec-size-exempt label."
echo "spec-size: FAIL ($FAILURES violation(s)); see job summary" >&2
exit 1
