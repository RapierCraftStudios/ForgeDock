#!/usr/bin/env bash
# builder-resume-match.test.sh — the anchored, trusted FORGE:BUILDER resume selector (forge#3668, mirrors forge#3648)
# Exercises the exact jq used by commands/work-on/build/implement.md Resume Check. No network.
# Usage: bash scripts/builder-resume-match.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAILN=$((FAILN+1)); echo "FAIL - $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

SELECT_JQ='[.[][] | select((.body // "") | startswith("<!-- FORGE:BUILDER -->")) | select((.user.type // "") == "Bot" or ((.author_association // "") | IN("OWNER","MEMBER","COLLABORATOR"))) | {id: .id, complete: (.body | contains("<!-- FORGE:BUILDER:COMPLETE -->")), other: (.body | test("<!-- FORGE:(INVESTIGATOR|CONTEXT|CONTRACT|ARCHITECT)"))}]'
DELETE_JQ='[.[] | select(.complete | not)] | if length == 1 and (.[0].other | not) then .[0].id else empty end'

# c <id> <assoc> <type> <body>
c() { jq -nc --argjson i "$1" --arg a "$2" --arg t "$3" --arg b "$4" '{id:$i,author_association:$a,user:{type:$t},body:$b}'; }
arch()    { printf '%s' "$1" | jq -sc . | jq -s "$SELECT_JQ"; }
n_complete() { arch "$1" | jq '[.[] | select(.complete)] | length'; }
del_id()  { arch "$1" | jq -r "$DELETE_JQ"; }

PLAN=$'<!-- FORGE:BUILDER -->\n## Implementation\n\n<!-- FORGE:BUILDER:COMPLETE -->'
PARTIAL=$'<!-- FORGE:BUILDER -->\n## Implementation (in progress)'
INVEST=$'<!-- FORGE:INVESTIGATOR -->\nThe build phase later posts FORGE:BUILDER and FORGE:BUILDER:COMPLETE.'
CTX=$'<!-- FORGE:CONTEXT -->\nmentions <!-- FORGE:BUILDER -->'
MIXED=$'<!-- FORGE:BUILDER -->\nquoted <!-- FORGE:INVESTIGATOR -->'

eq "INVESTIGATOR mentioning FORGE:BUILDER is not selected" "$(arch "$(c 1 NONE Bot "$INVEST")" | jq length)" 0
eq "INVESTIGATOR mentioning FORGE:BUILDER is never deleted" "$(del_id "$(c 1 NONE Bot "$INVEST")")" ""
eq "CONTEXT mentioning the marker mid-body is not selected" "$(arch "$(c 2 NONE Bot "$CTX")" | jq length)" 0
eq "complete comment by bot is complete" "$(n_complete "$(c 3 NONE Bot "$PLAN")")" 1
eq "complete comment by MEMBER is complete" "$(n_complete "$(c 3 MEMBER User "$PLAN")")" 1
eq "single partial comment -> delete its id" "$(del_id "$(c 4 NONE Bot "$PARTIAL")")" 4
eq "two partial comments -> delete nothing" "$(del_id "$(c 4 NONE Bot "$PARTIAL")"$'\n'"$(c 5 NONE Bot "$PARTIAL")")" ""
eq "untrusted author partial ignored" "$(del_id "$(c 6 NONE User "$PARTIAL")")" ""
eq "untrusted author complete ignored" "$(n_complete "$(c 6 NONE User "$PLAN")")" 0
eq "partial carrying another FORGE marker is not deleted" "$(del_id "$(c 7 NONE Bot "$MIXED")")" ""
eq "investigator + partial comment -> only the comment id" "$(del_id "$(c 1 NONE Bot "$INVEST")"$'\n'"$(c 8 NONE Bot "$PARTIAL")")" 8
eq "paginated concatenated arrays" "$(printf '[%s]\n[%s]' "$(c 1 NONE Bot "$INVEST")" "$(c 9 NONE Bot "$PLAN")" | jq -s "$SELECT_JQ" | jq '[.[] | select(.complete)] | length')" 1

ARCHC=$'<!-- FORGE:ARCHITECT -->\nplan; the builder will post <!-- FORGE:BUILDER -->'
eq "ARCHITECT mentioning the marker is not selected" "$(arch "$(c 10 NONE Bot "$ARCHC")" | jq length)" 0
eq "unparsable input fails closed" "$(printf 'not json' | jq -s "$SELECT_JQ" 2>/dev/null | jq -r "$DELETE_JQ" 2>/dev/null)" ""

# Spec drift guard: every mutating site carries this exact predicate and no unanchored selector.
for f in commands/work-on/build/implement.md commands/work-on/build.md commands/work-on/build/validate.md; do
  SPEC="$ROOT/$f"
  ! grep -qE 'contains\(.FORGE:BUILDER.\) and' "$SPEC" && ok "$f has no unanchored selector" || bad "$f still uses unanchored selector"
  grep -qF "$SELECT_JQ" "$SPEC" && ok "$f uses the tested select jq" || bad "$f select jq drifted from this test"
  grep -qF "$DELETE_JQ" "$SPEC" && ok "$f uses the tested pick jq" || bad "$f pick jq drifted from this test"
done

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
