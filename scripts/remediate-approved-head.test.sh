#!/usr/bin/env bash
# remediate-approved-head.test.sh — the M7 CI-gated merge is bound to APPROVED_HEAD on every path (forge#3686)
# Extracts the guard from commands/work-on/remediate.md and exercises it. No network. Usage: bash scripts/remediate-approved-head.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail
# Every mktemp below lands in one private dir that the EXIT trap removes (forge#4016).
_SUITE_TMP=$(mktemp -d); export TMPDIR="$_SUITE_TMP"; trap 'rm -rf "$_SUITE_TMP"' EXIT
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SPEC="$ROOT/commands/work-on/remediate.md"

PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAILN=$((FAILN+1)); echo "FAIL - $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

grep -qE 'GATED_HEAD" != "\$\{?APPROVED_HEAD' "$SPEC" && ok "spec compares GATED_HEAD to APPROVED_HEAD" || bad "spec compares GATED_HEAD to APPROVED_HEAD"
grep -qF 'if [ "${RESUME_AT_M7:-false}" = "true" ] && [ "$CI_GATE_RC" -eq 0 ]' "$SPEC" && bad "guard is no longer resume-only" || ok "guard is no longer resume-only"

# Extract the guard fence body (from the scratch reload through the closing fi) and run it per case.
GUARD=$(awk '/^_SD="\$\{FORGE_SCRATCHPAD/ && !g {g=1} g {print} g && /^fi$/ {exit}' "$SPEC")
[ -n "$GUARD" ] && ok "guard block extracted" || bad "guard block extracted"

# run_guard <persisted head or NONE> <GATED_HEAD> <CI_GATE_RC> <RESUME_AT_M7>
run_guard() {
  local d; d=$(mktemp -d)
  [ "$1" = NONE ] || printf '%s\n' "$1" > "$d/remediate_approved_head_7"
  FORGE_SCRATCHPAD="$d" GATED_HEAD="$2" CI_GATE_RC="$3" RESUME_AT_M7="$4" CI_GATE_OUT="" \
    bash -c "${GUARD//\{PR_NUMBER\}/7}"$'\nprintf %s "$CI_GATE_RC"'
  rm -rf "$d"
}
A=$(printf 'a%.0s' {1..40}); B=$(printf 'b%.0s' {1..40})
for r in true false; do
  eq "match merges (resume=$r)" "$(run_guard "$A" "$A" 0 $r)" 0
  eq "mismatch refuses (resume=$r)" "$(run_guard "$A" "$B" 0 $r)" 4
  eq "missing approved head refuses (resume=$r)" "$(run_guard NONE "$A" 0 $r)" 4
  eq "malformed approved head refuses (resume=$r)" "$(run_guard "zz" "$A" 0 $r)" 4
  eq "empty gated head refuses (resume=$r)" "$(run_guard "$A" "" 0 $r)" 4
  eq "nonzero rc is unchanged (resume=$r)" "$(run_guard "$A" "$B" 3 $r)" 3
done

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
