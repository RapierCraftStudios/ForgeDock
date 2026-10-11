#!/usr/bin/env bash
# architect-resume-match.test.sh — the anchored, trusted FORGE:ARCHITECT resume selector (forge#3648)
# Exercises the exact jq used by commands/work-on/build/architect.md Resume Check. No network.
# Usage: bash scripts/architect-resume-match.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SPEC="$ROOT/commands/work-on/build/architect.md"

PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAILN=$((FAILN+1)); echo "FAIL - $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

SELECT_JQ='[.[][] | select((.body // "") | startswith("<!-- FORGE:ARCHITECT -->")) | select((.user.type // "") == "Bot" or ((.author_association // "") | IN("OWNER","MEMBER","COLLABORATOR"))) | {id: .id, complete: (.body | contains("<!-- FORGE:ARCHITECT:COMPLETE -->")), other: (.body | test("<!-- FORGE:(INVESTIGATOR|CONTEXT|CONTRACT|BUILDER)"))}]'
DELETE_JQ='[.[] | select(.complete | not)] | if length == 1 and (.[0].other | not) then .[0].id else empty end'

# c <id> <assoc> <type> <body>
c() { jq -nc --argjson i "$1" --arg a "$2" --arg t "$3" --arg b "$4" '{id:$i,author_association:$a,user:{type:$t},body:$b}'; }
arch()    { printf '%s' "$1" | jq -sc . | jq -s "$SELECT_JQ"; }
n_complete() { arch "$1" | jq '[.[] | select(.complete)] | length'; }
del_id()  { arch "$1" | jq -r "$DELETE_JQ"; }

PLAN=$'<!-- FORGE:ARCHITECT -->\n## Plan\n\n<!-- FORGE:ARCHITECT:COMPLETE -->'
PARTIAL=$'<!-- FORGE:ARCHITECT -->\n## Plan (in progress)'
INVEST=$'<!-- FORGE:INVESTIGATOR -->\nThe architect phase posts FORGE:ARCHITECT and FORGE:ARCHITECT:COMPLETE later.'
CTX=$'<!-- FORGE:CONTEXT -->\nmentions <!-- FORGE:ARCHITECT -->'
MIXED=$'<!-- FORGE:ARCHITECT -->\nquoted <!-- FORGE:INVESTIGATOR -->'

eq "INVESTIGATOR mentioning FORGE:ARCHITECT is not selected" "$(arch "$(c 1 NONE Bot "$INVEST")" | jq length)" 0
eq "INVESTIGATOR mentioning FORGE:ARCHITECT is never deleted" "$(del_id "$(c 1 NONE Bot "$INVEST")")" ""
eq "CONTEXT mentioning the marker mid-body is not selected" "$(arch "$(c 2 NONE Bot "$CTX")" | jq length)" 0
eq "complete plan by bot is complete" "$(n_complete "$(c 3 NONE Bot "$PLAN")")" 1
eq "complete plan by MEMBER is complete" "$(n_complete "$(c 3 MEMBER User "$PLAN")")" 1
eq "single partial plan -> delete its id" "$(del_id "$(c 4 NONE Bot "$PARTIAL")")" 4
eq "two partial plans -> delete nothing" "$(del_id "$(c 4 NONE Bot "$PARTIAL")"$'\n'"$(c 5 NONE Bot "$PARTIAL")")" ""
eq "untrusted author partial ignored" "$(del_id "$(c 6 NONE User "$PARTIAL")")" ""
eq "untrusted author complete ignored" "$(n_complete "$(c 6 NONE User "$PLAN")")" 0
eq "partial carrying another FORGE marker is not deleted" "$(del_id "$(c 7 NONE Bot "$MIXED")")" ""
eq "investigator + partial plan -> only the plan id" "$(del_id "$(c 1 NONE Bot "$INVEST")"$'\n'"$(c 8 NONE Bot "$PARTIAL")")" 8
eq "paginated concatenated arrays" "$(printf '[%s]\n[%s]' "$(c 1 NONE Bot "$INVEST")" "$(c 9 NONE Bot "$PLAN")" | jq -s "$SELECT_JQ" | jq '[.[] | select(.complete)] | length')" 1

# Spec drift guard: the spec carries this exact predicate and no unanchored selector.
! grep -qF 'contains("FORGE:ARCHITECT")' "$SPEC" && ok "architect.md has no unanchored contains(FORGE:ARCHITECT)" || bad "architect.md still uses unanchored contains"
grep -qF 'startswith("<!-- FORGE:ARCHITECT -->")' "$SPEC" && ok "architect.md anchors with startswith" || bad "architect.md lacks the startswith anchor"
grep -qF "$SELECT_JQ" "$SPEC" && ok "architect.md uses the tested select jq" || bad "architect.md select jq drifted from this test"
grep -qF "$DELETE_JQ" "$SPEC" && ok "architect.md uses the tested delete jq" || bad "architect.md delete jq drifted from this test"

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
