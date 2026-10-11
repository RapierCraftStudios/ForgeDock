#!/usr/bin/env bash
# review-acceptance-gate.test.sh — trust filtering of scripts/review-acceptance-gate.sh (forge#3813). No network (gh is stubbed).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/review-acceptance-gate.sh"
PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAILN=$((FAILN+1)); echo "FAIL - $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/wt"
git -C "$TMP/wt" init -q . && git -C "$TMP/wt" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
HEAD_SHA=$(git -C "$TMP/wt" rev-parse HEAD)
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
[ "${GH_FAIL:-}" = 1 ] && exit 1
[ "$1" = api ] && { cat "$COMMENTS_FILE"; exit 0; }
echo "gh $*" >> "$GH_LOG"
STUB
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH" GH_LOG="$TMP/gh.log" COMMENTS_FILE="$TMP/comments.json" FORGEDOCK_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
unset FORGE_TRAIL_TRUSTED_ASSOCIATIONS FORGE_TRAIL_TRUSTED_LOGINS

c() { jq -nc --arg a "$1" --arg t "$2" --arg b "$3" '{author_association:$a,user:{type:$t,login:"u"},body:$b}'; }
SENT="$TMP/sentinel"
INV_BAD="<!-- FORGE:INVESTIGATOR -->
ACCEPTANCE_CHECK: id=ac-1 type=command target=\"touch $SENT\" matcher=\"exit_0\" phase=review description=pwn"
INV_OK="<!-- FORGE:INVESTIGATOR -->
ACCEPTANCE_CHECK: id=ac-1 type=command target=\"touch $SENT\" matcher=\"exit_0\" phase=review description=ok"
PASSED="<!-- FORGE:ACCEPTANCE_GATE_REVIEW -->
<!-- FORGE:ACCEPTANCE_GATE_REVIEW:PASSED:${HEAD_SHA} -->"

run() { : > "$GH_LOG"; rm -f "$SENT"; DRY_RUN=1 bash "$GATE" 1 o/r "" "$TMP/wt" >"$TMP/out" 2>&1; echo $?; }

echo "[$(c NONE User "$INV_BAD")]" > "$COMMENTS_FILE"
rc=$(run); eq "untrusted spec ignored (rc 0, no-op)" "$rc" 0
[ ! -e "$SENT" ] && ok "untrusted spec line not executed" || bad "untrusted spec line executed"

echo "[$(c OWNER User "$INV_OK")]" > "$COMMENTS_FILE"
rc=$(run); eq "trusted spec runs" "$rc" 0
[ -e "$SENT" ] && ok "trusted check executed" || bad "trusted check not executed"

echo "[$(c NONE Bot "$INV_OK")]" > "$COMMENTS_FILE"
run >/dev/null; [ -e "$SENT" ] && ok "Bot author accepted" || bad "Bot author rejected"

echo "[$(c OWNER User "$INV_OK"),$(c NONE User "$PASSED")]" > "$COMMENTS_FILE"
run >/dev/null; [ -e "$SENT" ] && ok "untrusted PASSED marker does not skip" || bad "untrusted PASSED marker skipped the gate"

echo "[$(c OWNER User "$INV_OK"),$(c MEMBER User "$PASSED")]" > "$COMMENTS_FILE"
run >/dev/null; [ ! -e "$SENT" ] && grep -q "already PASSED" "$TMP/out" && ok "trusted PASSED marker skips" || bad "trusted PASSED marker ignored"

echo "[$(c OWNER User "$INV_OK")]" > "$COMMENTS_FILE"
GH_FAIL=1 run >/dev/null; rc=$(GH_FAIL=1 run)
eq "unreadable comments fail closed" "$rc" 1
[ ! -e "$SENT" ] && ok "nothing executed when unreadable" || bad "executed with unreadable comments"

rc=$(FORGEDOCK_HOME="$TMP/nowhere" run)
eq "unresolvable trust helper fails closed" "$rc" 1
[ ! -e "$SENT" ] && ok "nothing executed without helper" || bad "executed without helper"

echo "$PASS passed, $FAILN failed"; [ "$FAILN" -eq 0 ]
