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
# Route by endpoint (#3152): unknown endpoints fail, so a test can never pass by accident on the wrong fixture.
for a in "$@"; do
  case "$a" in
    repos/*/issues/*/comments) cat "$MOCK_GH_JSON"; exit 0 ;;
    user) [ -n "${MOCK_SELF_LOGIN:-}" ] && { echo "$MOCK_SELF_LOGIN"; exit 0; }; exit 1 ;;
    repos/*/collaborators/*/permission)
      [ "${MOCK_PERM_FAIL:-}" = "1" ] && { echo "mock gh: permission api error" >&2; exit 1; }
      u="${a#repos/*/collaborators/}"; u="${u%/permission}"
      f="${MOCK_PERM_DIR:-/nonexistent}/$u"
      [ -f "$f" ] && { cat "$f"; exit 0; }
      echo "mock gh: 404" >&2; exit 1 ;;
  esac
done
echo "mock gh: unexpected endpoint: $*" >&2; exit 1
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
lg() { # lg <name> <builder updated_at> -> fixture without QUALITY_GATE
  local out="$TMP_FX/$1.json"
  jq -nc --arg at "$2" '[{"body":"<!-- FORGE:INVESTIGATOR -->\n<!-- INVESTIGATION:COMPLETE -->"},{"body":"<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: TRIVIAL"},{"body":"<!-- FORGE:CONTRACT -->\nc"},{"body":"<!-- FORGE:BUILDER -->\nx\n<!-- FORGE:BUILDER:COMPLETE -->","updated_at":$at}] | map(. + {author_association:"OWNER", user:{login:"owner",type:"User"}})' > "$out"; echo "$out"
}
expect_pass "legacy build (pre-cutoff) waives QUALITY_GATE" "$(lg lg1 2026-10-01T00:00:00Z)"
expect_fail "post-cutoff build still requires QUALITY_GATE" "$(lg lg2 2026-10-08T00:00:00Z)" QUALITY_GATE
OUT=$(FORGE_TRAIL_QG_SINCE="" MOCK_GH_JSON="$(lg lg4 2026-10-01T00:00:00Z)" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 1 ] && ok "grace disabled via empty FORGE_TRAIL_QG_SINCE" || bad "grace disable (rc=$RC)"

# Multi-page threads (#3121): gh --paginate emits one array per page; the LATEST build must win
mp="$TMP_FX/mp.json"
{ jq -nc '[{"body":"<!-- FORGE:INVESTIGATOR -->\n<!-- INVESTIGATION:COMPLETE -->"},{"body":"<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: TRIVIAL"},{"body":"<!-- FORGE:CONTRACT -->\nc"},{"body":"<!-- FORGE:BUILDER -->\nx\n<!-- FORGE:BUILDER:COMPLETE -->","updated_at":"2026-01-04T00:00:00Z"}] | map(. + {author_association:"OWNER", user:{login:"owner",type:"User"}})'
  jq -nc '[{"body":"<!-- FORGE:BUILDER -->\nx\n<!-- FORGE:BUILDER:COMPLETE -->","updated_at":"2026-10-06T00:00:00Z"}] | map(. + {author_association:"OWNER", user:{login:"owner",type:"User"}})'; } > "$mp"
OUT=$(FORGE_TRAIL_QG_SINCE=2026-10-05T00:00:00Z MOCK_GH_JSON="$mp" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'MISSING: QUALITY_GATE' && ok "multi-page: latest build on page 2 is not waived" || bad "multi-page (rc=$RC out=$OUT)"

# Cutoff validation (#3121): malformed or future cutoff fails closed
for bad_since in "garbage" "2999-01-01T00:00:00Z" "2020-13-45T99:99:99Z" "2026-02-30T00:00:00Z" "2026-10-01T24:00:00Z"; do
  OUT=$(FORGE_TRAIL_QG_SINCE="$bad_since" MOCK_GH_JSON="$(lg lgv 2026-10-01T00:00:00Z)" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
  [ $RC -eq 2 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: ERROR' && ok "invalid cutoff '$bad_since' rejected" || bad "cutoff '$bad_since' (rc=$RC out=$OUT)"
done

# Runner clock behind the default cutoff: cutoff looks future-dated -> exit 2 (fails closed)
CLK="$TMP_FX/clock"; mkdir -p "$CLK"
REAL_DATE=$(command -v date)
cat > "$CLK/date" <<MOCKDATE
#!/usr/bin/env bash
# Intercept the "now" probe by scanning every arg (not one exact arg form): a bare +FORMAT call with no -d/-j parse flags.
mode=now; fmt=""
for a in "\$@"; do case "\$a" in -d|-j|-f) mode=parse ;; +%Y-%m-%dT%H:%M:%SZ) fmt=1 ;; esac; done
if [ "\$mode" = now ] && [ -n "\$fmt" ]; then echo 2020-01-01T00:00:00Z; else exec "$REAL_DATE" "\$@"; fi
MOCKDATE
chmod +x "$CLK/date"
OUT=$(PATH="$CLK:$PATH" MOCK_GH_JSON="$(lg lgc 2026-10-01T00:00:00Z)" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 2 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: ERROR' && ok "clock behind default cutoff fails closed (exit 2)" || bad "clock behind cutoff (rc=$RC out=$OUT)"

# BSD/macOS date fallback (#3139): GNU `date -d` unavailable, `date -j -f` available -> valid cutoff still honoured;
# neither parser available -> fails closed (exit 2).
BSD="$TMP_FX/bsd"; mkdir -p "$BSD"
cat > "$BSD/date" <<BSDDATE
#!/usr/bin/env bash
for a in "\$@"; do [ "\$a" = "-d" ] && exit 1; done
if [ "\$2" = "-j" ] && [ "\$3" = "-f" ]; then
  [ -n "\${BSD_NO_PARSE:-}" ] && exit 1
  # Emulate BSD parse-and-reformat without GNU/BSD-specific flags: the value is already in the output format.
  echo "\${5}"; exit 0
fi
exec "$REAL_DATE" "\$@"
BSDDATE
chmod +x "$BSD/date"
OUT=$(PATH="$BSD:$PATH" FORGE_TRAIL_QG_SINCE=2026-10-05T00:00:00Z MOCK_GH_JSON="$(lg lgbsd 2026-10-01T00:00:00Z)" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 0 ] && ok "BSD date -j -f fallback validates a real cutoff" || bad "BSD fallback (rc=$RC out=$OUT)"
OUT=$(PATH="$BSD:$PATH" BSD_NO_PARSE=1 FORGE_TRAIL_QG_SINCE=2026-10-05T00:00:00Z MOCK_GH_JSON="$(lg lgbsd2 2026-10-01T00:00:00Z)" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 2 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: ERROR' && ok "no usable date parser fails closed (exit 2)" || bad "no date parser (rc=$RC out=$OUT)"

# Boundary: cutoff exactly equal to BUILDER:COMPLETE time is NOT waived (strictly-before only)
OUT=$(FORGE_TRAIL_QG_SINCE=2026-10-01T00:00:00Z MOCK_GH_JSON="$(lg lgb 2026-10-01T00:00:00Z)" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'MISSING: QUALITY_GATE' && ok "boundary: build at exactly the cutoff is not waived" || bad "boundary equal (rc=$RC out=$OUT)"
OUT=$(FORGE_TRAIL_QG_SINCE=2026-10-01T00:00:01Z MOCK_GH_JSON="$(lg lgb2 2026-10-01T00:00:00Z)" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 0 ] && ok "boundary: build one second before the cutoff is waived" || bad "boundary minus 1s (rc=$RC out=$OUT)"

# Page-shape edge cases (#3130)
BLD='{"body":"<!-- FORGE:BUILDER -->\nx\n<!-- FORGE:BUILDER:COMPLETE -->","updated_at":"2026-10-06T00:00:00Z"}'
pg() { jq -nc --argjson c "$1" '$c | map(. + {author_association:"OWNER", user:{login:"owner",type:"User"}})'; }
BASE='[{"body":"<!-- FORGE:INVESTIGATOR -->\n<!-- INVESTIGATION:COMPLETE -->"},{"body":"<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: TRIVIAL"},{"body":"<!-- FORGE:CONTRACT -->\nc"}]'
# empty pages around a populated one
{ echo '[]'; pg "$BASE"; echo '[]'; pg "[$BLD]"; echo '[]'; } > "$TMP_FX/empty.json"
OUT=$(FORGE_TRAIL_QG_SINCE=2026-10-05T00:00:00Z MOCK_GH_JSON="$TMP_FX/empty.json" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'MISSING: QUALITY_GATE' && ok "empty pages interleaved are tolerated" || bad "empty pages (rc=$RC out=$OUT)"
OUT=$(MOCK_GH_JSON=<(echo '[]') bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'MISSING: INVESTIGATOR' && ok "all-empty thread fails (not error)" || bad "all-empty (rc=$RC out=$OUT)"
# 3+ pages: latest build on the LAST page wins
{ pg "$BASE"; pg '[{"body":"<!-- FORGE:BUILDER -->\nx\n<!-- FORGE:BUILDER:COMPLETE -->","updated_at":"2026-01-01T00:00:00Z"}]'; pg "[$BLD]"; } > "$TMP_FX/p3.json"
OUT=$(FORGE_TRAIL_QG_SINCE=2026-10-05T00:00:00Z MOCK_GH_JSON="$TMP_FX/p3.json" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'MISSING: QUALITY_GATE' && ok "3 pages: latest build on page 3 is not waived" || bad "3 pages (rc=$RC out=$OUT)"
# Malformed / mixed pages fail closed with exit 2
{ pg "$BASE"; echo '{"message":"Server Error"}'; } > "$TMP_FX/mixed.json"
OUT=$(MOCK_GH_JSON="$TMP_FX/mixed.json" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 2 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: ERROR' && ok "mixed array/object pages fail closed (exit 2)" || bad "mixed pages (rc=$RC out=$OUT)"
{ pg "$BASE"; echo '[1,"x"]'; } > "$TMP_FX/nonobj.json"
OUT=$(MOCK_GH_JSON="$TMP_FX/nonobj.json" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 2 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: ERROR' && ok "page with non-object elements fails closed (exit 2)" || bad "non-object elements (rc=$RC out=$OUT)"
{ pg "$BASE"; echo '[{"body":'; } > "$TMP_FX/malformed.json"
OUT=$(MOCK_GH_JSON="$TMP_FX/malformed.json" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 2 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: ERROR' && ok "malformed page fails closed (exit 2)" || bad "malformed page (rc=$RC out=$OUT)"

# SEC-4 (#3149): the grace keys on updated_at -- BUILDER:COMPLETE is PATCHed in later than the comment was created
jq -nc '[{"body":"<!-- FORGE:INVESTIGATOR -->\n<!-- INVESTIGATION:COMPLETE -->"},{"body":"<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: TRIVIAL"},{"body":"<!-- FORGE:CONTRACT -->\nc"},{"body":"<!-- FORGE:BUILDER -->\nx\n<!-- FORGE:BUILDER:COMPLETE -->","created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-08T00:00:00Z"}] | map(. + {author_association:"OWNER", user:{login:"owner",type:"User"}})' > "$TMP_FX/patched.json"
expect_fail "old created_at but post-cutoff updated_at is not waived" "$TMP_FX/patched.json" QUALITY_GATE
jq -c 'map(del(.updated_at))' "$TMP_FX/patched.json" > "$TMP_FX/noupd.json"
expect_fail "BUILDER:COMPLETE without updated_at never earns the grace" "$TMP_FX/noupd.json" QUALITY_GATE

# SEC-3 (#3149): --code-diff makes an INVESTIGATION band unusable for waiving requirements
expect_fail "INVESTIGATION band + code diff requires CONTRACT" "$(mk cd1 INV FP_INVESTIGATION)" CONTRACT --code-diff
expect_fail "INVESTIGATION band + code diff requires QUALITY_GATE" "$(mk cd2 INV CONTRACT CONTEXT ARCH FP_INVESTIGATION)" QUALITY_GATE --code-diff
expect_pass "INVESTIGATION band + code diff passes with a full trail" "$(mk cd3 INV CONTRACT CONTEXT ARCH QG_PASS FP_INVESTIGATION)" --code-diff
run "$(mk cd4 INV FP_INVESTIGATION)" --code-diff
echo "$OUT" | grep -q 'NOTE: INVESTIGATION band ignored' && ok "ignored band is reported" || bad "band note ($OUT)"
expect_pass "INVESTIGATION band + docs-only (no code diff) still passes" "$(mk cd5 INV FP_INVESTIGATION)" --docs-only
expect_pass "TRIVIAL band is unaffected by --code-diff" "$(mk cd6 INV CONTRACT FP_TRIVIAL QG_PASS)" --code-diff

# SEC-5 (#3149): --head-tree binds the QUALITY_GATE PASS to the built tree
T1=1111111111111111111111111111111111111111; T2=2222222222222222222222222222222222222222
qgt() { jq -nc --arg b "$1" '{body:$b}' ; }
ht() { # ht <name> <qg body...> -> full STANDARD trail whose only QUALITY_GATE comments are the given bodies
  local out="$TMP_FX/$1.json"; shift
  { echo '{"body":"<!-- FORGE:INVESTIGATOR -->\n<!-- INVESTIGATION:COMPLETE -->"}'; echo '{"body":"<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: STANDARD"}'
    echo '{"body":"<!-- FORGE:CONTRACT -->\nc"}'; echo '{"body":"<!-- FORGE:CONTEXT -->\nc"}'; echo '{"body":"<!-- FORGE:ARCHITECT -->\nc"}'
    local b; for b in "$@"; do qgt "$b"; done; } | jq -sc 'map(. + {author_association:"OWNER", user:{login:"owner",type:"User"}})' > "$out"; echo "$out"
}
QG_T1=$'<!-- FORGE:QUALITY_GATE -->\n**Result**: PASS\n**Tree**: '"$T1"$'\n**Iterations**: 1'
QG_T2=$'<!-- FORGE:QUALITY_GATE -->\n**Result**: PASS\n**Tree**: '"$T2"
QG_NOTREE=$'<!-- FORGE:QUALITY_GATE -->\n**Result**: PASS'
expect_pass "head-tree matches the PASS marker's Tree" "$(ht h1 "$QG_T1")" --head-tree "$T1"
expect_fail "PASS recorded for an earlier tree does not satisfy the gate" "$(ht h2 "$QG_T2")" QUALITY_GATE --head-tree "$T1"
expect_fail "PASS without a Tree line does not satisfy a bound gate" "$(ht h3 "$QG_NOTREE")" QUALITY_GATE --head-tree "$T1"
expect_pass "a later PASS for the head tree wins over an earlier-tree PASS" "$(ht h4 "$QG_T2" "$QG_T1")" --head-tree "$T1"
expect_pass "no --head-tree keeps the unbound behaviour" "$(ht h5 "$QG_NOTREE")"
expect_pass "uppercase head-tree is normalised" "$(ht h6 "$QG_T1")" --head-tree "$(echo "$T1" | tr a-f A-F)"
expect_pass "docs-only still waives the bound gate" "$(ht h7)" --docs-only --head-tree "$T1"
for bt in "" "xyz" "${T1}0" "abc123"; do
  OUT=$(MOCK_GH_JSON="$(ht h8 "$QG_T1")" bash "$VERIFY" 3061 -R o/r --head-tree "$bt" 2>/dev/null); RC=$?
  [ $RC -eq 2 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: ERROR' && ok "invalid --head-tree '$bt' fails closed (exit 2)" || bad "head-tree '$bt' (rc=$RC out=$OUT)"
done
# A 64-hex marker tree that merely starts with the 40-hex head tree must not match
QG_LONG=$'<!-- FORGE:QUALITY_GATE -->\n**Result**: PASS\n**Tree**: '"${T1}1111111111111111111111"
expect_fail "marker tree longer than (but prefixed by) the head tree is rejected" "$(ht h10 "$QG_LONG")" QUALITY_GATE --head-tree "$T1"
OUT=$(MOCK_GH_JSON="$(ht h9 "$QG_T1")" bash "$VERIFY" 3061 -R o/r --head-tree 2>/dev/null); RC=$?
[ $RC -eq 2 ] && ok "--head-tree without a value exits 2" || bad "head-tree no value (rc=$RC)"

# -h prints the full header
HOUT=$(bash "$VERIFY" -h)
echo "$HOUT" | grep -q 'TRUSTED ENVIRONMENT ONLY' && echo "$HOUT" | grep -q 'COLLABORATOR includes read-level' && echo "$HOUT" | grep -q '^# Usage:' && ok "-h prints the full multi-line header" || bad "-h truncated"

# Untrusted-author FORGE markers are ignored AND diagnosed with a NOTE (#3123)
UT="$TMP_FX/untrusted.json"
jq -c 'map(. + {author_association:"CONTRIBUTOR", user:{login:"ext",type:"User"}})' "$(mk ut_src INV CONTRACT FP_TRIVIAL QG_PASS)" > "$UT"
OUT=$(MOCK_GH_JSON="$UT" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 1 ] && echo "$OUT" | grep -q 'MISSING: INVESTIGATOR' && echo "$OUT" | grep -q 'NOTE: .*untrusted authors were ignored' && ok "CONTRIBUTOR markers ignored with NOTE" || bad "contributor note (rc=$RC out=$OUT)"
OUT=$(FORGE_TRAIL_TRUSTED_LOGINS=ext MOCK_GH_JSON="$UT" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 0 ] && ok "FORGE_TRAIL_TRUSTED_LOGINS accepts a CONTRIBUTOR login" || bad "trusted login override (rc=$RC out=$OUT)"
expect_pass "marker-only CONTEXT satisfies STANDARD" "$(mk minctx INV FP_STANDARD CONTRACT CONTEXT ARCH QG_PASS)"

# -h is bounded by the END-HELP sentinel, not a hardcoded line range (#3147)
echo "$HOUT" | grep -q 'Callers route on the exit code' && ! echo "$HOUT" | grep -q 'END-HELP' && ! echo "$HOUT" | grep -q 'set -uo pipefail' && ok "-h stops at the END-HELP sentinel" || bad "-h sentinel"

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

# --- Break-glass override (#3152) ---
HS=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; HS2=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PERM="$TMP_FX/perm"; mkdir -p "$PERM"
echo '{"permission":"write"}' > "$PERM/alice"; echo '{"permission":"admin"}' > "$PERM/carol"
echo '{"permission":"read"}' > "$PERM/reader"; echo '{"permission":"write"}' > "$PERM/pipeuser"
echo '{"permission":"write"}' > "$PERM/builduser"
export MOCK_PERM_DIR="$PERM"
BT=2026-10-08T01:00:00Z; AFTER=2026-10-08T02:00:00Z; BEFORE=2026-10-08T00:30:00Z
# Base trail: everything but CONTEXT/ARCHITECT/QUALITY_GATE on a STANDARD band, built (BUILDER:COMPLETE) at $BT by `builduser`.
ov_base() {
  jq -nc --arg bt "$BT" '[
    {body:"<!-- FORGE:INVESTIGATOR -->\n<!-- INVESTIGATION:COMPLETE -->",user:{login:"builduser",type:"User"},author_association:"OWNER"},
    {body:"<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: STANDARD",user:{login:"builduser",type:"User"},author_association:"OWNER"},
    {body:"<!-- FORGE:CONTRACT -->\nc",user:{login:"builduser",type:"User"},author_association:"OWNER"},
    {body:"<!-- FORGE:BUILDER -->\nx\n<!-- FORGE:BUILDER:COMPLETE -->",created_at:$bt,updated_at:$bt,user:{login:"builduser",type:"User"},author_association:"OWNER"}]'
}
CUR_MISSING='ARCHITECT,CONTEXT,QUALITY_GATE'
# ovc <login> <type> <created> <updated> <head> <missing> <reason> -> one override comment (JSON)
ovc() {
  jq -nc --arg l "$1" --arg t "$2" --arg c "$3" --arg u "$4" --arg h "$5" --arg m "$6" --arg r "$7" \
    '{body:("<!-- FORGE:PHASE_TRAIL_OVERRIDE -->\n**Head**: "+$h+"\n**Missing**: "+$m+"\n**Reason**: "+$r),created_at:$c,updated_at:$u,author_association:"OWNER",user:{login:$l,type:$t}}'
}
ovf() { # ovf <name> <override comment json...> -> fixture = base trail + comments
  local out="$TMP_FX/$1.json"; shift
  { ov_base | jq -c '.[]'; for c in "$@"; do echo "$c"; done; } | jq -sc '.' > "$out"; echo "$out"
}
GOODC() { ovc alice User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "gate misfire, verified by hand"; }
orun() { OUT=$(MOCK_GH_JSON="$1" bash "$VERIFY" 3061 -R o/r --head-sha "$HS" "${@:2}" 2>/dev/null); RC=$?; }
expect_override() { orun "$2" "${@:3}"; [ $RC -eq 0 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: OVERRIDDEN' && echo "$OUT" | grep -q '^OVERRIDE: approver=' && ok "$1" || bad "$1 (rc=$RC out=$OUT)"; }
expect_blocked() { orun "$2" "${@:3}"; [ $RC -eq 1 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: FAIL' && ! echo "$OUT" | grep -q 'OVERRIDDEN' && ok "$1" || bad "$1 (rc=$RC out=$OUT)"; }

expect_blocked "no override comment stays blocked" "$(ovf o0)"
expect_override "valid human override is accepted" "$(ovf o1 "$(GOODC)")"
orun "$(ovf o1b "$(GOODC)")"
echo "$OUT" | grep -q "^OVERRIDE: approver=alice head=$HS missing=$CUR_MISSING reason=gate misfire, verified by hand$" && ok "OVERRIDE line carries approver, head, missing set and reason" || bad "OVERRIDE line ($OUT)"
echo "$OUT" | grep -q '^MISSING:' && bad "accepted override must not emit MISSING lines" || ok "accepted override emits no MISSING lines"
expect_override "admin permission is accepted" "$(ovf o2 "$(ovc carol User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "ok")")"
expect_override "uppercase head and shuffled/spaced missing list still bind to the same set" \
  "$(ovf o3 "$(ovc alice User "$AFTER" "$AFTER" "$(echo $HS | tr a-f A-F)" "QUALITY_GATE , ARCHITECT,CONTEXT -> x" "ok")")"
expect_override "a later valid override wins over an earlier rejected one" \
  "$(ovf o4 "$(ovc reader User "$BEFORE" "$BEFORE" "$HS" "$CUR_MISSING" "old")" "$(GOODC)")"

# One test per rejection rule
expect_blocked "rejects: Bot author" "$(ovf r1 "$(ovc alice Bot "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "r")")"
expect_blocked "rejects: null user" "$(ovf r2 "$(GOODC | jq -c '.user=null')")"
expect_blocked "rejects: missing user.type" "$(ovf r3 "$(GOODC | jq -c 'del(.user.type)')")"
expect_blocked "rejects: edited comment (updated_at != created_at)" "$(ovf r4 "$(ovc alice User "$AFTER" "2026-10-08T03:00:00Z" "$HS" "$CUR_MISSING" "r")")"
expect_blocked "rejects: missing timestamps" "$(ovf r5 "$(GOODC | jq -c 'del(.updated_at)')")"
expect_blocked "rejects: read-only collaborator" "$(ovf r6 "$(ovc reader User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "r")")"
expect_blocked "rejects: author with no permission record" "$(ovf r7 "$(ovc stranger User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "r")")"
orun "$(ovf r8 "$(GOODC)")"; OUT=$(MOCK_PERM_FAIL=1 MOCK_GH_JSON="$TMP_FX/r8.json" bash "$VERIFY" 3061 -R o/r --head-sha "$HS" 2>/dev/null); RC=$?
[ $RC -eq 1 ] && ! echo "$OUT" | grep -q OVERRIDDEN && ok "rejects: permission API error fails closed (exit 1)" || bad "permission api error (rc=$RC out=$OUT)"
expect_blocked "rejects: wrong head sha" "$(ovf r9 "$(ovc alice User "$AFTER" "$AFTER" "$HS2" "$CUR_MISSING" "r")")"
expect_blocked "rejects: truncated head sha" "$(ovf r10 "$(ovc alice User "$AFTER" "$AFTER" "${HS:0:12}" "$CUR_MISSING" "r")")"
expect_blocked "rejects: override for a different MISSING set" "$(ovf r11 "$(ovc alice User "$AFTER" "$AFTER" "$HS" "ARCHITECT,CONTEXT" "r")")"
expect_blocked "rejects: override for a superset of MISSING" "$(ovf r12 "$(ovc alice User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING,CONTRACT" "r")")"
expect_blocked "rejects: posted before BUILDER:COMPLETE" "$(ovf r13 "$(ovc alice User "$BEFORE" "$BEFORE" "$HS" "$CUR_MISSING" "r")")"
expect_blocked "rejects: posted exactly at BUILDER:COMPLETE time" "$(ovf r14 "$(ovc alice User "$BT" "$BT" "$HS" "$CUR_MISSING" "r")")"
expect_blocked "rejects: empty reason" "$(ovf r15 "$(ovc alice User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "   ")")"
expect_blocked "rejects: reason that is only control characters" "$(ovf r16 "$(ovc alice User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" $'\x1b\x07')")"
expect_blocked "rejects: login with path characters (no API path injection)" "$(ovf r17 "$(ovc 'alice/../x' User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "r")")"
# Pipeline identity: configured login, and derived (author of the pipeline's own FORGE markers)
FORGE_TRAIL_PIPELINE_LOGINS="Alice" expect_blocked "rejects: configured pipeline login (case-insensitive)" "$(ovf p1 "$(GOODC)")"
FORGE_TRAIL_PIPELINE_LOGINS="x, alice ,y" expect_blocked "rejects: configured pipeline login in a list" "$(ovf p2 "$(GOODC)")"
expect_blocked "rejects: derived pipeline identity (author of FORGE:BUILDER/INVESTIGATOR/CONTRACT)" "$(ovf p3 "$(ovc builduser User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "self approve")")"
expect_blocked "rejects: derived pipeline identity matches case-insensitively" "$(ovf p4 "$(ovc BuildUser User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "self approve")")"
# A pipeline App identity that posts markers is also excluded even if typed User in the override
PIPE_C=$(jq -nc '{body:"<!-- FORGE:QUALITY_GATE -->\n**Result**: FAIL",user:{login:"pipeuser",type:"User"},author_association:"OWNER"}')
expect_blocked "rejects: author of any trusted FORGE marker (QUALITY_GATE) is pipeline" "$(ovf p5 "$PIPE_C" "$(ovc pipeuser User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "r")")"
# Override cannot be evaluated without --head-sha
OUT=$(MOCK_GH_JSON="$(ovf n1 "$(GOODC)")" bash "$VERIFY" 3061 -R o/r 2>/dev/null); RC=$?
[ $RC -eq 1 ] && ! echo "$OUT" | grep -q OVERRIDDEN && ok "rejects: no --head-sha means the override is never evaluated" || bad "no head-sha (rc=$RC out=$OUT)"
for bs in "" "xyz" "${HS}0"; do
  OUT=$(MOCK_GH_JSON="$(ovf n2 "$(GOODC)")" bash "$VERIFY" 3061 -R o/r --head-sha "$bs" 2>/dev/null); RC=$?
  [ $RC -eq 2 ] && echo "$OUT" | grep -q 'PHASE_TRAIL: ERROR' && ok "invalid --head-sha '$bs' fails closed (exit 2)" || bad "head-sha '$bs' (rc=$RC out=$OUT)"
done
OUT=$(MOCK_GH_JSON="$TMP_FX/n2.json" bash "$VERIFY" 3061 -R o/r --head-sha 2>/dev/null); RC=$?
[ $RC -eq 2 ] && ok "--head-sha without a value exits 2" || bad "head-sha no value (rc=$RC)"
# Exit 2 is never overridable
OUT=$(MOCK_GH_FAIL=1 MOCK_GH_JSON="$TMP_FX/o1.json" bash "$VERIFY" 3061 -R o/r --head-sha "$HS" 2>/dev/null); RC=$?
[ $RC -eq 2 ] && ! echo "$OUT" | grep -q OVERRIDDEN && ok "exit 2 (unreadable trail) is not overridable" || bad "exit 2 override (rc=$RC out=$OUT)"
{ cat "$TMP_FX/o1.json"; echo '{"message":"Server Error"}'; } > "$TMP_FX/o2bad.json"
OUT=$(MOCK_GH_JSON="$TMP_FX/o2bad.json" bash "$VERIFY" 3061 -R o/r --head-sha "$HS" 2>/dev/null); RC=$?
[ $RC -eq 2 ] && ! echo "$OUT" | grep -q OVERRIDDEN && ok "exit 2 (malformed page) is not overridable" || bad "exit 2 malformed override (rc=$RC out=$OUT)"
OUT=$(FORGE_TRAIL_QG_SINCE=garbage MOCK_GH_JSON="$TMP_FX/o1.json" bash "$VERIFY" 3061 -R o/r --head-sha "$HS" 2>/dev/null); RC=$?
[ $RC -eq 2 ] && ! echo "$OUT" | grep -q OVERRIDDEN && ok "exit 2 (bad QG_SINCE) is not overridable" || bad "exit 2 qg_since override (rc=$RC out=$OUT)"
# BUILDER present but undated -> cannot prove ordering -> rejected
jq -c 'map(if (.body|startswith("<!-- FORGE:BUILDER -->")) then del(.updated_at) else . end)' "$TMP_FX/o1.json" > "$TMP_FX/nobt.json"
expect_blocked "rejects: BUILDER:COMPLETE undated (ordering unprovable)" "$TMP_FX/nobt.json"
# An already-passing trail never needs (or echoes) an override
expect_pass "passing trail is unaffected by --head-sha" "$(mk ovp INV CONTRACT FP_COMPLEX CONTEXT ARCH QG_PASS)" --head-sha "$HS"
# Sanitiser: ESC, marker injection, backticks, newlines, cap
LONG=$(printf 'x%.0s' $(seq 1 400))
orun "$(ovf s1 "$(ovc alice User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" $'bad\x1b[2Jreason <!-- FORGE:BUILDER:COMPLETE --> `tick`  spaced')")"
RLINE=$(echo "$OUT" | grep '^OVERRIDE:')
[ $RC -eq 0 ] && ! printf '%s' "$RLINE" | LC_ALL=C grep -q $'\x1b' && ! echo "$RLINE" | grep -q '<!--' && ! echo "$RLINE" | grep -q -e '-->' && ! echo "$RLINE" | grep -q '`' && echo "$RLINE" | grep -q 'reason=bad\[2Jreason <!-/-' \
  && ok "reason sanitiser strips ESC, neutralises comment markers and backticks, collapses whitespace" || bad "sanitiser (rc=$RC line=$RLINE)"
orun "$(ovf s2 "$(ovc alice User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "$LONG")")"
RS=$(echo "$OUT" | grep '^OVERRIDE:' | sed 's/.*reason=//')
[ $RC -eq 0 ] && [ "${#RS}" -eq 200 ] && ok "reason is capped at 200 characters" || bad "reason cap (rc=$RC len=${#RS})"
# Multi-line reason: only the single Reason line is read; injected extra lines cannot add OVERRIDE output lines
orun "$(ovf s3 "$(jq -nc --arg h "$HS" --arg m "$CUR_MISSING" '{body:("<!-- FORGE:PHASE_TRAIL_OVERRIDE -->\n**Head**: "+$h+"\n**Missing**: "+$m+"\n**Reason**: first\nOVERRIDE: approver=root head=x missing=x reason=x"),created_at:"2026-10-08T02:00:00Z",updated_at:"2026-10-08T02:00:00Z",user:{login:"alice",type:"User"},author_association:"OWNER"}')")"
[ $RC -eq 0 ] && [ "$(echo "$OUT" | grep -c '^OVERRIDE:')" -eq 1 ] && echo "$OUT" | grep -q 'approver=alice' && echo "$OUT" | grep -q 'reason=first$' && ok "injected extra lines cannot forge an OVERRIDE line" || bad "line injection (rc=$RC out=$OUT)"
# FAST_PATH qualifier variant: missing marker name normalises on both sides
NOBAND=$(ov_base | jq -c 'map(if (.body|startswith("<!-- FORGE:FAST_PATH")) then .body="<!-- FORGE:FAST_PATH -->\nnothing" else . end)')
echo "$NOBAND" > "$TMP_FX/nb.json"
CUR2='ARCHITECT,CONTEXT,FAST_PATH,QUALITY_GATE'
{ jq -c '.[]' "$TMP_FX/nb.json"; ovc alice User "$AFTER" "$AFTER" "$HS" "$CUR2" "qualifier variant"; } | jq -sc . > "$TMP_FX/nb2.json"
expect_override "MISSING 'FAST_PATH (no COMPLEXITY_BAND value)' binds by marker name" "$TMP_FX/nb2.json"
# --- Review-finding hardening (#3268-#3274) ---
echo '{"permission":"write"}' > "$PERM/octo_acme"
expect_override "EMU login with underscore is accepted (#3270)" "$(ovf h1 "$(ovc octo_acme User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "emu approver")")"
DECOYS=(); for i in 1 2 3 4 5 6; do DECOYS+=("$(ovc "decoy$i" User "2026-10-08T03:0$i:00Z" "2026-10-08T03:0$i:00Z" "$HS2" "$CUR_MISSING" "decoy")"); done
expect_override "5-candidate cap is not starved by decoys failing local checks (#3268)" "$(ovf h2 "$(GOODC)" "${DECOYS[@]}")"
# forge#3279: non-collaborator decoys that pass every local check must not consume the cap; repeat logins cost one slot
PDEC=(); for i in 1 2 3 4 5 6 7; do PDEC+=("$(ovc "pdecoy$i" User "2026-10-08T04:0$i:00Z" "2026-10-08T04:0$i:00Z" "$HS" "$CUR_MISSING" "decoy" | jq -c '.author_association="NONE"')"); done
expect_override "non-collaborator decoy flood (newer, all-local-checks-passing) does not starve a real override (#3279)" "$(ovf h5 "$(GOODC)" "${PDEC[@]}")"
echo '{"permission":"read"}' > "$PERM/rdr1"
RDEC=(); for i in 1 2 3 4 5 6; do RDEC+=("$(ovc rdr1 User "2026-10-08T05:0$i:00Z" "2026-10-08T05:0$i:00Z" "$HS" "$CUR_MISSING" "same login repeated")"); done
expect_override "one login repeated many times costs a single cap slot (#3279)" "$(ovf h6 "$(GOODC)" "${RDEC[@]}")"
MOCK_SELF_LOGIN=alice orun "$(ovf h3 "$(GOODC)")"
[ $RC -eq 1 ] && ! echo "$OUT" | grep -q OVERRIDDEN && ok "verifier's own login cannot approve an override (#3269)" || bad "self-login exclusion (rc=$RC out=$OUT)"
MOCK_SELF_LOGIN=someoneelse orun "$(ovf h3b "$(GOODC)")"
[ $RC -eq 0 ] && echo "$OUT" | grep -q OVERRIDDEN && ok "an unrelated self-login does not block a valid override (#3269)" || bad "self-login unrelated (rc=$RC out=$OUT)"
orun "$(ovf h4 "$(ovc alice User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" $'ping @octocat\u2028next\u2029line')")"
RS=$(echo "$OUT" | grep '^OVERRIDE:' | sed 's/.*reason=//')
[ $RC -eq 0 ] && ! printf '%s' "$RS" | grep -q '@' && ! printf '%s' "$RS" | grep -q $'\xe2\x80\xa8' && ok "reason sanitiser neutralises @mentions and U+2028/2029 (#3274)" || bad "sanitiser unicode (rc=$RC rs=$RS)"
# No BUILDER at all: floor falls back to the newest trusted FORGE marker (#3271)
ov_base | jq -c '[.[] | select((.body|startswith("<!-- FORGE:BUILDER -->"))|not)] | map(if (.body|startswith("<!-- FORGE:CONTRACT -->")) then .created_at="2026-10-08T01:30:00Z" else . end)' > "$TMP_FX/nobuilder.json"
orun "$TMP_FX/nobuilder.json"; NB_OUT="$OUT"
NB_MISS=$(echo "$NB_OUT" | sed -n 's/^MISSING: //p' | sed -e 's/ -> .*$//' | paste -sd, -)
if [ -n "$NB_MISS" ]; then
  { jq -c '.[]' "$TMP_FX/nobuilder.json"; ovc alice User "2026-10-08T01:10:00Z" "2026-10-08T01:10:00Z" "$HS" "$NB_MISS" "older than marker"; } | jq -sc . > "$TMP_FX/nbo1.json"
  expect_blocked "override older than newest trusted marker is rejected when BUILDER is absent (#3271)" "$TMP_FX/nbo1.json"
  { jq -c '.[]' "$TMP_FX/nobuilder.json"; ovc alice User "$AFTER" "$AFTER" "$HS" "$NB_MISS" "newer than marker"; } | jq -sc . > "$TMP_FX/nbo2.json"
  expect_override "override newer than newest trusted marker is accepted when BUILDER is absent (#3271)" "$TMP_FX/nbo2.json"
else bad "no-BUILDER fixture produced no MISSING set ($NB_OUT)"; fi
# Rejected permission is explained on stderr (#3272)
ERRTXT=$(MOCK_GH_JSON="$(ovf h5 "$(ovc reader User "$AFTER" "$AFTER" "$HS" "$CUR_MISSING" "no perm")")" bash "$VERIFY" 3061 -R o/r --head-sha "$HS" 2>&1 >/dev/null)
echo "$ERRTXT" | grep -q "rejected: permission='read'" && ok "rejected permission prints a diagnostic to stderr (#3272)" || bad "permission diagnostic ($ERRTXT)"

# -h documents the override
HOUT2=$(bash "$VERIFY" -h)
echo "$HOUT2" | grep -q 'FORGE_TRAIL_PIPELINE_LOGINS' && echo "$HOUT2" | grep -q -- '--head-sha' && ok "-h documents the override and --head-sha" || bad "-h override docs"

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
