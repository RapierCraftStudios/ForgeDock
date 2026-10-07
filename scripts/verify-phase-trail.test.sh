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
      QUOTED) items+=('{"body":"see `<!-- FORGE:CONTRACT -->` `<!-- FORGE:CONTEXT -->` `<!-- FORGE:ARCHITECT -->` `<!-- FORGE:QUALITY_GATE -->` **Result**: PASS"}') ;;
      INV_INVALID) items+=('{"body":"<!-- FORGE:INVESTIGATOR -->\nInvalid\n<!-- INVESTIGATION:INVALID -->"}') ;;
      PROSE) items+=('{"body":"I ran the architect and context inline; FORGE:CONTEXT FORGE:ARCHITECT FORGE:QUALITY_GATE done"}') ;;
    esac
  done
  # Fixtures model a trusted (OWNER) author; trust filtering is exercised separately below (#3100).
  local IFS=,; echo "[${items[*]}]" | jq -c 'map(. + {author_association:"OWNER", user:{login:"owner",type:"User"}})' > "$out"; echo "$out"
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

expect_fail "quoted markers mid-comment do not count" "$(mk q INV FP_COMPLEX QUOTED)" CONTRACT
expect_fail "first FAST_PATH wins over a later downgrade" "$(mk r INV FP_COMPLEX FP_INVESTIGATION)" CONTRACT
expect_pass "INVESTIGATION:INVALID accepted as terminal investigator sentinel" "$(mk s INV_INVALID FP_INVESTIGATION)"

# Missing FAST_PATH uses conservative STANDARD set, so CONTEXT/ARCHITECT also named
run "$(mk l INV CONTRACT QG_PASS)"
echo "$OUT" | grep -q 'MISSING: FAST_PATH' && echo "$OUT" | grep -q 'MISSING: CONTEXT' && echo "$OUT" | grep -q 'MISSING: ARCHITECT' \
  && ok "missing FAST_PATH names every missing artifact" || bad "missing FAST_PATH names every missing artifact ($OUT)"

# Every missing line names the phase to route back to
run "$(mk m INV CONTRACT FP_COMPLEX)"
echo "$OUT" | grep -q 'MISSING: CONTEXT -> re-run Skill work-on/build/context' && ok "refusal routes to the missing phase" || bad "route text ($OUT)"

# Large thread (pipefail + early-exit grep SIGPIPE regression, #3099): a valid trail buried in filler
python3 - "$TMP_FX/big.json" <<'PY'
import json,sys
inv="<!-- FORGE:INVESTIGATOR -->\n## Investigation Report\n<!-- INVESTIGATION:COMPLETE -->"
c=[{"body":inv},{"body":"<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: COMPLEX"},
   {"body":"<!-- FORGE:CONTRACT -->\nx"},{"body":"<!-- FORGE:CONTEXT -->\nx"},
   {"body":"<!-- FORGE:ARCHITECT -->\nx"},{"body":"<!-- FORGE:QUALITY_GATE -->\n**Result**: PASS\n"}]
c+= [{"body":"filler "+("x"*2000)} for _ in range(300)]
for x in c: x.update({"author_association":"OWNER","user":{"login":"owner","type":"User"}})
json.dump(c,open(sys.argv[1],"w"))
PY
expect_pass "large thread with present markers still passes" "$TMP_FX/big.json"

# --- Comment-author trust filtering (#3100) ---
# tc <assoc> <login> <type> <body>: one comment with explicit author metadata
tc() { jq -nc --arg a "$1" --arg l "$2" --arg t "$3" --arg b "$4" '{author_association:$a,user:{login:$l,type:$t},body:$b}'; }
tj() { local out="$TMP_FX/$1.json"; shift; local IFS=,; echo "[$*]" > "$out"; echo "$out"; }
T_INV=$'<!-- FORGE:INVESTIGATOR -->\nx\n<!-- INVESTIGATION:COMPLETE -->'
T_FPI=$'<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: INVESTIGATION'
T_FPS=$'<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: STANDARD'

# Forged early INVESTIGATION band from a stranger must not downgrade requirements.
expect_fail "forged early FAST_PATH from untrusted user is ignored" \
  "$(tj t1 "$(tc NONE evil User "$T_FPI")" "$(tc OWNER own User "$T_INV")" "$(tc OWNER own User "$T_FPS")")" CONTRACT
expect_fail "untrusted-only markers satisfy nothing" \
  "$(tj t2 "$(tc NONE evil User "$T_INV")" "$(tc NONE evil User "$T_FPI")")" INVESTIGATOR
expect_fail "untrusted user mixed into a complete trail cannot supply the missing CONTRACT" \
  "$(tj t3 "$(tc OWNER own User "$T_INV")" "$(tc OWNER own User "$T_FPS")" "$(tc NONE evil User '<!-- FORGE:CONTRACT -->')" "$(tc OWNER own User '<!-- FORGE:CONTEXT -->')" "$(tc OWNER own User '<!-- FORGE:ARCHITECT -->')" "$(tc OWNER own User $'<!-- FORGE:QUALITY_GATE -->\n**Result**: PASS')")" CONTRACT
expect_fail "comment with no author metadata is untrusted" \
  "$(tj t4 '{"body":"<!-- FORGE:INVESTIGATOR -->\n<!-- INVESTIGATION:COMPLETE -->"}')" INVESTIGATOR
expect_pass "Bot identity is trusted" "$(tj t5 "$(tc NONE app Bot "$T_INV")" "$(tc NONE app Bot "$T_FPI")")"
expect_pass "MEMBER and COLLABORATOR are trusted by default" "$(tj t6 "$(tc MEMBER m User "$T_INV")" "$(tc COLLABORATOR c User "$T_FPI")")"
FORGE_TRAIL_TRUSTED_LOGINS="svc-user, other" expect_pass "allowlisted login is trusted" \
  "$(tj t7 "$(tc NONE svc-user User "$T_INV")" "$(tc NONE svc-user User "$T_FPI")")"
FORGE_TRAIL_TRUSTED_ASSOCIATIONS="OWNER" expect_fail "narrowed associations reject COLLABORATOR" \
  "$(tj t8 "$(tc COLLABORATOR c User "$T_INV")" "$(tc COLLABORATOR c User "$T_FPI")")" INVESTIGATOR
FORGE_TRAIL_TRUSTED_ASSOCIATIONS="" expect_fail "empty associations trust no one but Bots/allowlist" \
  "$(tj t9 "$(tc OWNER own User "$T_INV")" "$(tc OWNER own User "$T_FPI")")" INVESTIGATOR

# Legacy grace (#3102): BUILDER:COMPLETE predating the quality-gate marker waives QUALITY_GATE only
lg() { # lg <name> <builder created_at> -> fixture without QUALITY_GATE
  local out="$TMP_FX/$1.json"
  jq -nc --arg at "$2" '[{"body":"<!-- FORGE:INVESTIGATOR -->\n<!-- INVESTIGATION:COMPLETE -->"},{"body":"<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: TRIVIAL"},{"body":"<!-- FORGE:CONTRACT -->\nc"},{"body":"<!-- FORGE:BUILDER -->\nx\n<!-- FORGE:BUILDER:COMPLETE -->","created_at":$at}] | map(. + {author_association:"OWNER", user:{login:"owner",type:"User"}})' > "$out"; echo "$out"
}
expect_pass "legacy build (pre-cutoff) waives QUALITY_GATE" "$(lg lg1 2026-10-01T00:00:00Z)"
expect_fail "post-cutoff build still requires QUALITY_GATE" "$(lg lg2 2026-10-08T00:00:00Z)" QUALITY_GATE
OUT=$(FORGE_TRAIL_QG_SINCE="" MOCK_GH_JSON="$(lg lg4 2026-10-01T00:00:00Z)" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 1 ] && ok "grace disabled via empty FORGE_TRAIL_QG_SINCE" || bad "grace disable (rc=$RC)"

# Outage fails closed (exit 2, never PASS)
OUT=$(MOCK_GH_FAIL=1 MOCK_GH_JSON=/dev/null bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 2 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: ERROR' && ok "gh outage fails closed" || bad "gh outage (rc=$RC out=$OUT)"

# -R with no value must error out, not hang
# macOS has no `timeout`; fall back to gtimeout, then perl alarm.
if command -v timeout >/dev/null 2>&1; then TMO=(timeout 5)
elif command -v gtimeout >/dev/null 2>&1; then TMO=(gtimeout 5)
else TMO=(perl -e 'alarm shift; exec @ARGV' 5); fi
OUT=$("${TMO[@]}" bash "$VERIFY" 5 -R 2>/dev/null); RC=$?
[ $RC -eq 2 ] && ok "-R without value exits 2 (no hang)" || bad "-R without value (rc=$RC)"

# Usage errors
OUT=$(bash "$VERIFY" 2>/dev/null); RC=$?
[ $RC -eq 2 ] && ok "no args is a usage error" || bad "usage error (rc=$RC)"

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
