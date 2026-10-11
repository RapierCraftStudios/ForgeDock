#!/usr/bin/env bash
# orchestrate-soft-edge.test.sh — cases for verify_soft_edge_early (forge#3697).
# Extracts the helper's fenced bash block from commands/orchestrate/phase-4-execution.md and runs it
# against a stubbed `gh`, so the spec and the test cannot drift.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
P4="$ROOT/commands/orchestrate/phase-4-execution.md"
P3="$ROOT/commands/orchestrate/phase-3-dependency.md"
PASS=0; FAILN=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }

if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then echo "orchestrate-soft-edge.test.sh: bash 4+ required (associative arrays), skipped"; exit 0; fi

awk '/^```bash$/{b="";in_b=1;next} /^```$/{if(in_b&&b~/^verify_soft_edge_early\(\)/)printf "%s",b; in_b=0;next} in_b{b=b $0 "\n"}' "$P4" \
  | sed 's/{GH_REPO}/o\/r/g' > "$TMP/helper.sh"
if [ -s "$TMP/helper.sh" ]; then ok; else bad "verify_soft_edge_early block not found"; echo "failed=$FAILN"; exit 1; fi

mkdir "$TMP/bin"
cat > "$TMP/bin/gh" <<'STUB'
#!/bin/sh
case "$1 $2" in
  "pr list") [ "${STUB_LIST_FAIL:-0}" = 1 ] && exit 1; [ "${STUB_NO_PR:-0}" = 1 ] || echo 42; exit 0 ;;
  "pr diff") [ "${STUB_DIFF_FAIL:-0}" = 1 ] && exit 1; printf '%s\n' $STUB_DIFF; exit 0 ;;
esac
exit 1
STUB
chmod +x "$TMP/bin/gh"

# run NAME WANT SOFT(1|0) EDGE_FILES DIFF [ENV=VAL...]
run() {
  local name="$1" want="$2" soft="$3" files="$4" diff="$5"; shift 5
  local got
  got="$(env PATH="$TMP/bin:$PATH" STUB_DIFF="$diff" "$@" bash -c '
    declare -A EDGE_SOFT EDGE_KIND EDGE_FILES
    EDGE_KIND["1:2"]=same-file; EDGE_FILES["1:2"]="'"$files"'"
    [ "'"$soft"'" = 1 ] && EDGE_SOFT["1:2"]=true
    . "'"$TMP"'/helper.sh"
    verify_soft_edge_early 1 2' 2>&1 | tail -n1)"
  if [ "$got" = "$want" ]; then ok; else bad "$name (got '$got' want '$want')"; fi
}
run "soft edge, diff excludes shared file -> RELEASE" RELEASE 1 "commands/review-pr.md" "commands/review-pr-staging.md"
run "soft edge, diff has shared file -> HOLD"          HOLD    1 "commands/review-pr.md" "commands/review-pr.md other.md"
run "soft edge, no PR -> HOLD"                         HOLD    1 "commands/review-pr.md" "" STUB_NO_PR=1
run "hard edge, no overlap -> HOLD"                    HOLD    0 "commands/review-pr.md" "commands/review-pr-staging.md"
run "soft edge, gh pr diff fails -> HOLD"              HOLD    1 "commands/review-pr.md" "" STUB_DIFF_FAIL=1
run "soft edge, PR lookup fails -> HOLD"               HOLD    1 "commands/review-pr.md" "x" STUB_LIST_FAIL=1
run "path boundary: utils vs some_utils_helper.py"     RELEASE 1 "utils" "src/some_utils_helper.py"
run "directory edge overlap -> HOLD"                   HOLD    1 "src/utils/" "src/utils/a.py"

grep -q 'EDGE_SOFT' "$P3" && grep -qi 'soft' "$P3" && ok || bad "phase-3 does not declare/tag EDGE_SOFT"
grep -q 'verify_soft_edge_early "\$PRED"' "$P4" && ok || bad "phase-4 IN_PROGRESS arm does not call verify_soft_edge_early"

echo "orchestrate-soft-edge.test.sh: passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
