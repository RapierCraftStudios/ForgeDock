#!/usr/bin/env bash
# trusted-comments.test.sh — tests for scripts/trusted-comments.sh (shared FORGE marker trust predicate)
# No network. Usage: bash scripts/trusted-comments.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TC="$SCRIPT_DIR/trusted-comments.sh"
VERIFY="$SCRIPT_DIR/verify-phase-trail.sh"
unset FORGE_TRAIL_TRUSTED_ASSOCIATIONS FORGE_TRAIL_TRUSTED_LOGINS

PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAILN=$((FAILN+1)); echo "FAIL - $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

# c <assoc> <type> <login> <body>
c() { jq -nc --arg a "$1" --arg t "$2" --arg l "$3" --arg b "$4" '{author_association:$a,user:{type:$t,login:$l},body:$b}'; }
M='<!-- FORGE:NOTE_DISPOSITION notes_fixed=0 -->'
RE='^<!-- FORGE:NOTE_DISPOSITION'
cnt() { printf '%s' "$1" | bash "$TC" count "$RE"; }

eq "bot (type=Bot, assoc NONE) accepted" "$(cnt "[$(c NONE Bot 'app[bot]' "$M")]")" 1
for a in OWNER MEMBER COLLABORATOR; do
  eq "$a accepted" "$(cnt "[$(c $a User u "$M")]")" 1
done
for a in NONE CONTRIBUTOR FIRST_TIME_CONTRIBUTOR; do
  eq "human $a rejected" "$(cnt "[$(c $a User u "$M")]")" 0
done
eq "trusted login honoured (assoc NONE)" "$(FORGE_TRAIL_TRUSTED_LOGINS="x, alice" cnt "[$(c NONE User alice "$M")]")" 1
eq "other login still rejected" "$(FORGE_TRAIL_TRUSTED_LOGINS="alice" cnt "[$(c NONE User mallory "$M")]")" 0
eq "narrowed associations reject MEMBER" "$(FORGE_TRAIL_TRUSTED_ASSOCIATIONS=OWNER cnt "[$(c MEMBER User u "$M")]")" 0
eq "widened associations accept CONTRIBUTOR" "$(FORGE_TRAIL_TRUSTED_ASSOCIATIONS=OWNER,CONTRIBUTOR cnt "[$(c CONTRIBUTOR User u "$M")]")" 1
eq "explicit empty associations reject non-bot" "$(FORGE_TRAIL_TRUSTED_ASSOCIATIONS= cnt "[$(c OWNER User u "$M")]")" 0
eq "explicit empty associations still accept bot" "$(FORGE_TRAIL_TRUSTED_ASSOCIATIONS= cnt "[$(c NONE Bot b "$M")]")" 1
eq "marker mid-body not counted (^ anchoring)" "$(cnt "[$(c OWNER User u "see $M")]")" 0
eq "paginated concatenated arrays" "$(cnt "[$(c OWNER User u "$M")] [$(c NONE Bot b "$M")] [$(c NONE User h "$M")]")" 2
eq "empty array counts 0" "$(cnt '[]')" 0

# bodies mode
B=$(printf '%s' "[$(c NONE Bot b '<!-- FORGE:INPR_FIX: head=abc1234 -->'),$(c NONE User h '<!-- FORGE:INPR_FIX: head=dead999 -->')]" | bash "$TC" bodies '^<!-- FORGE:INPR_FIX: ')
eq "bodies emits only trusted bodies" "$B" '"<!-- FORGE:INPR_FIX: head=abc1234 -->"'
eq "bodies with no match prints nothing" "$(printf '[]' | bash "$TC" bodies x)" ""

# fail closed
printf 'not json' | bash "$TC" count "$RE" >/dev/null 2>&1; eq "invalid JSON exits non-zero" "$?" 2
printf '[{"body":"x","user":{"type":"Bot"}}]' | bash "$TC" count '(' >/dev/null 2>&1; eq "invalid regex exits non-zero" "$?" 2
printf '[]' | bash "$TC" frobnicate x >/dev/null 2>&1; eq "bad mode exits non-zero" "$?" 2
printf '[]' | bash "$TC" count >/dev/null 2>&1; eq "missing regex exits non-zero" "$?" 2

# drift guard: the predicate lines must match verify-phase-trail.sh verbatim
for line in \
  '((.author_association // "") as $x | $A | index($x) != null)' \
  '((.user.type // "") == "Bot")' \
  '((.user.login // "") as $x | $L | index($x) != null)' \
  'TRUSTED_ASSOC="${FORGE_TRAIL_TRUSTED_ASSOCIATIONS-OWNER,MEMBER,COLLABORATOR}"' \
  'TRUSTED_LOGINS="${FORGE_TRAIL_TRUSTED_LOGINS-}"'; do
  if grep -qF -- "$line" "$TC" && grep -qF -- "$line" "$VERIFY"; then ok "predicate in sync: $line"; else bad "predicate drift vs verify-phase-trail.sh: $line"; fi
done

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
