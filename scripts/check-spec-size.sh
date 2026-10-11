#!/usr/bin/env bash
# check-spec-size.sh — PR spec-size budget (forge#3762).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: check-spec-size.sh [base_ref]     (default: $BASE_REF, else origin/staging)
# Env:   PR_LABELS  comma-separated PR label names (untrusted; grep-matched only)
#        PR_BODY    PR body text (untrusted; grep-matched only)
#        GITHUB_STEP_SUMMARY  summary file (stdout when unset)
# Exit:  0 pass/exempt, 1 budget violation, 2 usage/base-ref error (fail closed)
#
# Rules (against the PR base, compared in bytes):
#   1. Budgeted specs may not grow by more than 2% or more than 4096 bytes.
#   2. No commands/**/*.md file may gain a canonical block copy (per-file marker
#      count may not rise). Count-based until the shared helper lands (#3493).
#   Shrinking or equal size always passes.
# Exemption: `spec-size-exempt` label, or a `<!-- spec-size-exempt: <reason> -->`
# line with a non-empty reason in the PR body. Failures are reported, exit 0.
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

# --- exemption -------------------------------------------------------------
EXEMPT_REASON=""
if printf '%s' "${PR_LABELS:-}" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -qxF 'spec-size-exempt'; then
  EXEMPT_REASON="label spec-size-exempt"
else
  R=$(printf '%s\n' "${PR_BODY:-}" | tr -d '\r' \
    | sed -n 's/^[[:space:]]*<!--[[:space:]]*spec-size-exempt:[[:space:]]*\(.*\)-->[[:space:]]*$/\1/p' \
    | head -n 1 | sed 's/[[:space:]]*$//')
  [ -n "$R" ] && EXEMPT_REASON="PR body marker: $R"
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

DUP_ROWS=""
# Every commands/**/*.md present at head (new files have base count 0).
for f in $(git ls-files 'commands/*.md' 'commands/**/*.md' | sort -u); do
  [ -f "$f" ] || continue
  hc=$(grep -cE "$MARKERS" "$f" 2>/dev/null || true); hc=${hc:-0}
  bc=$(git show "$BASE:$f" 2>/dev/null | grep -cE "$MARKERS" 2>/dev/null || true); bc=${bc:-0}
  if [ "$hc" -gt "$bc" ]; then
    DUP_ROWS="$DUP_ROWS| \`$f\` | $bc | $hc | NEW CANONICAL BLOCK COPY |
"
    FAILURES=$((FAILURES + 1))
  fi
done
if [ -n "$DUP_ROWS" ]; then
  out ""
  out "### Canonical block copies added (source the shared helper instead)"
  out ""
  out "| File | Base markers | Head markers | Status |"
  out "|------|-----:|-----:|--------|"
  printf '%s' "$DUP_ROWS" >> "$SUMMARY"
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
out "Result: FAIL ($FAILURES violation(s)). Shrink the spec, or add the spec-size-exempt label / a \`<!-- spec-size-exempt: <reason> -->\` line to the PR body."
echo "spec-size: FAIL ($FAILURES violation(s)); see job summary" >&2
exit 1
