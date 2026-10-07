#!/usr/bin/env bash
# verify-phase-trail.test.sh — tests for scripts/verify-phase-trail.sh
# No network: `gh` is mocked on PATH; MOCK_GH_JSON names a fixture file holding the
# raw JSON array `gh api .../comments` would return. MOCK_GH_FAIL=1 simulates an outage.
#
# Usage: bash scripts/verify-phase-trail.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="$SCRIPT_DIR/verify-phase-trail.sh"
TMP_BIN=$(mktemp -d); TMP_FX=$(mktemp -d)
trap 'rm -rf "$TMP_BIN" "$TMP_FX"' EXIT

cat > "$TMP_BIN/gh" <<'MOCK'
#!/usr/bin/env bash
if [ "${MOCK_GH_FAIL:-}" = "1" ]; then echo "mock gh: outage" >&2; exit 1; fi
cat "$MOCK_GH_JSON"
MOCK
chmod +x "$TMP_BIN/gh"
export PATH="$TMP_BIN:$PATH"

PASS=0; FAILN=0
ok()   { PASS=$((PASS+1)); echo "ok   - $1"; }
bad()  { FAILN=$((FAILN+1)); echo "FAIL - $1"; }

# fixture <name> <marker...>: builds a comments JSON array from marker keys
INV='<!-- FORGE:INVESTIGATOR -->\n## Investigation Report\n<!-- INVESTIGATION:COMPLETE -->'
mk() {
  local out="$TMP_FX/$1.json"; shift
  local items=()
  for k in "$@"; do
    case "$k" in
      INV) items+=("{\"body\":\"$INV\"}") ;;
      INV_PARTIAL) items+=("{\"body\":\"<!-- FORGE:INVESTIGATOR -->\\n## partial\"}") ;;
      CONTRACT) items+=('{"body":"<!-- FORGE:CONTRACT -->\n## Builder Contract"}') ;;
      CONTEXT) items+=('{"body":"<!-- FORGE:CONTEXT -->\n## Context"}') ;;
      ARCH) items+=('{"body":"<!-- FORGE:ARCHITECT -->\n## Plan"}') ;;
      QG_PASS) items+=('{"body":"<!-- FORGE:QUALITY_GATE -->\n**Result**: PASS\n"}') ;;
      QG_FAIL) items+=('{"body":"<!-- FORGE:QUALITY_GATE -->\n**Result**: FAIL\n"}') ;;
      FP_NOBAND) items+=('{"body":"<!-- FORGE:FAST_PATH -->\nnothing"}') ;;
      FP_*) items+=("{\"body\":\"<!-- FORGE:FAST_PATH -->\\n**COMPLEXITY_BAND**: ${k#FP_}\"}") ;;
      PROSE) items+=('{"body":"I ran the architect and context inline; FORGE:CONTEXT FORGE:ARCHITECT FORGE:QUALITY_GATE done"}') ;;
    esac
  done
  local IFS=,; echo "[${items[*]}]" > "$out"; echo "$out"
}

run() { # run <fixture> [args...] -> sets OUT, RC
  local fx="$1"; shift
  OUT=$(MOCK_GH_JSON="$fx" bash "$VERIFY" 3061 -R o/r "$@" 2>/dev/null); RC=$?
}
expect_pass() { run "$2" "${@:3}"; [ $RC -eq 0 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: PASS' && ok "$1" || bad "$1 (rc=$RC out=$OUT)"; }
expect_fail() { # name fixture needle [args]
  run "$2" "${@:4}"
  [ $RC -eq 1 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: FAIL' && echo "$OUT" | grep -q "MISSING: $3" && ok "$1" || bad "$1 (rc=$RC out=$OUT)"
}

expect_pass "full COMPLEX trail passes" "$(mk full INV CONTRACT FP_COMPLEX CONTEXT ARCH QG_PASS)"
expect_pass "full STANDARD trail passes" "$(mk std INV CONTRACT FP_STANDARD CONTEXT ARCH QG_PASS)"
expect_pass "TRIVIAL passes without CONTEXT/ARCHITECT" "$(mk triv INV CONTRACT FP_TRIVIAL QG_PASS)"
expect_pass "lowercase band is accepted" "$(mk lower INV CONTRACT FP_trivial QG_PASS)"
expect_pass "Investigation band passes with only INVESTIGATOR+FAST_PATH" "$(mk invest INV FP_INVESTIGATION)"
expect_pass "docs-only waives QUALITY_GATE" "$(mk docs INV CONTRACT FP_TRIVIAL)" --docs-only

expect_fail "missing INVESTIGATOR" "$(mk a CONTRACT FP_COMPLEX CONTEXT ARCH QG_PASS)" INVESTIGATOR
expect_fail "partial investigation (no COMPLETE) fails" "$(mk b INV_PARTIAL CONTRACT FP_COMPLEX CONTEXT ARCH QG_PASS)" INVESTIGATOR
expect_fail "missing CONTRACT" "$(mk c INV FP_COMPLEX CONTEXT ARCH QG_PASS)" CONTRACT
expect_fail "missing CONTEXT on STANDARD" "$(mk d INV CONTRACT FP_STANDARD ARCH QG_PASS)" CONTEXT
expect_fail "missing ARCHITECT on STANDARD" "$(mk e INV CONTRACT FP_STANDARD CONTEXT QG_PASS)" ARCHITECT
expect_fail "missing FAST_PATH" "$(mk f INV CONTRACT CONTEXT ARCH QG_PASS)" FAST_PATH
expect_fail "FAST_PATH without band value fails" "$(mk g INV CONTRACT FP_NOBAND CONTEXT ARCH QG_PASS)" FAST_PATH
expect_fail "missing QUALITY_GATE" "$(mk h INV CONTRACT FP_COMPLEX CONTEXT ARCH)" QUALITY_GATE
expect_fail "QUALITY_GATE FAIL result does not count" "$(mk i INV CONTRACT FP_COMPLEX CONTEXT ARCH QG_FAIL)" QUALITY_GATE
expect_fail "TRIVIAL still needs CONTRACT" "$(mk j INV FP_TRIVIAL QG_PASS)" CONTRACT
expect_fail "prose mentions do not satisfy markers" "$(mk k INV CONTRACT FP_COMPLEX PROSE)" CONTEXT

# Missing FAST_PATH uses conservative STANDARD set, so CONTEXT/ARCHITECT also named
run "$(mk l INV CONTRACT QG_PASS)"
echo "$OUT" | grep -q 'MISSING: FAST_PATH' && echo "$OUT" | grep -q 'MISSING: CONTEXT' && echo "$OUT" | grep -q 'MISSING: ARCHITECT' \
  && ok "missing FAST_PATH names every missing artifact" || bad "missing FAST_PATH names every missing artifact ($OUT)"

# Every missing line names the phase to route back to
run "$(mk m INV CONTRACT FP_COMPLEX)"
echo "$OUT" | grep -q 'MISSING: CONTEXT -> re-run Skill work-on/build/context' && ok "refusal routes to the missing phase" || bad "route text ($OUT)"

# Outage fails closed (exit 2, never PASS)
OUT=$(MOCK_GH_FAIL=1 MOCK_GH_JSON=/dev/null bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 2 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: ERROR' && ok "gh outage fails closed" || bad "gh outage (rc=$RC out=$OUT)"

# Usage errors
OUT=$(bash "$VERIFY" 2>/dev/null); RC=$?
[ $RC -eq 2 ] && ok "no args is a usage error" || bad "usage error (rc=$RC)"

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
