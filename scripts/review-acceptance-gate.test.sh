#!/usr/bin/env bash
# review-acceptance-gate.test.sh — trust filtering (forge#3813) and behavior (pass / fail / malformed-skip, forge#3814) of scripts/review-acceptance-gate.sh. No network (gh is stubbed, DRY_RUN=1).
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

# Behavioral cases (forge#3814). DRY_RUN=1 echoes gh writes as `DRY_RUN:` lines into $TMP/out.
printf 'x\n' > "$TMP/wt/f.txt"
inv() { local b="<!-- FORGE:INVESTIGATOR -->"; local l; for l in "$@"; do b="$b
$l"; done; echo "[$(c OWNER User "$b")]" > "$COMMENTS_FILE"; }
chk() { printf 'ACCEPTANCE_CHECK: id=%s type=command target="%s" matcher="exit_0" phase=review description=d' "$1" "$2"; }
nolabel() { ! grep -q 'needs-human' "$TMP/out"; }

inv "$(chk ac-1 true)"; rc=$(run); eq "pass: rc 0" "$rc" 0
grep -q ':PASSED:' "$TMP/out" && ok "pass: PASSED sentinel posted" || bad "pass: no PASSED sentinel"

inv "$(chk ac-1 false)"; rc=$(run); eq "real fail: rc 1" "$rc" 1
grep -q 'needs-human' "$TMP/out" && ok "real fail: needs-human added" || bad "real fail: no needs-human"
inv "$(chk ac-1 'grep -q nomatch f.txt')"; rc=$(run); eq "grep exit 1 is a real fail" "$rc" 1
inv "$(chk ac-1 'grep -q x nofile.txt')"; rc=$(run); eq "grep missing operand file stays a real fail" "$rc" 1
inv "$(chk ac-1 'grep -q x nofile.txt 2>/dev/null')"; rc=$(run); eq "stderr-suppressed missing operand is a real fail (forge#3802)" "$rc" 1
grep -q ':PASSED:' "$TMP/out" && bad "stderr-suppressed missing operand wrote PASSED" || ok "stderr-suppressed missing operand: no PASSED marker"
inv "$(chk ac-1 'grep -sq x nofile.txt')"; rc=$(run); eq "grep -s missing operand is a real fail (forge#3802)" "$rc" 1

for t in "echo 'unbalanced" 'echo a\\\\\\\\b' "grep -E '[' f.txt"; do
  inv "$(chk ac-7 "$t")"; rc=$(run); eq "malformed skipped, rc 0: $t" "$rc" 0
  nolabel && ok "malformed: no needs-human" || bad "malformed: needs-human added: $t"
  grep -qi 'malformed' "$TMP/out" && ok "malformed reported" || bad "malformed not reported: $t"
  grep -q ':PASSED:' "$TMP/out" && bad "all-malformed wrote PASSED marker: $t" || ok "all-malformed: no PASSED marker"
done

inv "$(chk ac-1 true)" "$(chk ac-7 "echo 'unbalanced")"; rc=$(run); eq "mixed pass+malformed: rc 0" "$rc" 0
grep -q ':PASSED:' "$TMP/out" && grep -qi 'malformed' "$TMP/out" && ok "mixed: PASSED with malformed listed" || bad "mixed: wrong output"
inv "$(chk ac-1 false)" "$(chk ac-7 "echo 'unbalanced")"; rc=$(run); eq "mixed fail+malformed: fails closed" "$rc" 1

# rc 127 downgrade only when the target's own first word is the missing command (forge#3842).
printf '#!/bin/bash\nno-such-tool-xyzzy\n' > "$TMP/wt/inner.sh"
inv "$(chk ac-8 'no-such-cmd-xyzzy --help')"; rc=$(run); eq "first word missing: malformed, rc 0" "$rc" 0
grep -qi 'malformed' "$TMP/out" && ok "first word missing reported malformed" || bad "first word missing not reported"
inv "$(chk ac-8 'bash inner.sh')"; rc=$(run); eq "script with missing inner tool is a real fail" "$rc" 1
inv "$(chk ac-8 'true && no-such-cmd-xyzzy')"; rc=$(run); eq "missing command not first word is a real fail" "$rc" 1
export LANG=de_DE.UTF-8 LC_MESSAGES=de_DE.UTF-8
inv "$(chk ac-8 'no-such-cmd-xyzzy --help')"; rc=$(run); eq "non-English locale: first word missing still malformed" "$rc" 0
grep -qi 'malformed' "$TMP/out" && ok "locale: reported malformed" || bad "locale: not reported malformed"
unset LANG LC_MESSAGES
# target runs in its native locale: a locale-dependent verdict (wc -m on multibyte) must not be forced to C
export LC_ALL=C.UTF-8
inv "$(chk ac-8 'printf "\303\251" | wc -m | grep -qx 1')"; rc=$(run); eq "target keeps native locale (wc -m multibyte)" "$rc" 0
unset LC_ALL
inv 'ACCEPTANCE_CHECK: id=ac-9 type=command target="no-such-cmd-xyzzy" matcher="QQQ" phase=review description=d'; rc=$(run); eq "matcher branch: first word missing malformed" "$rc" 0
inv 'ACCEPTANCE_CHECK: id=ac-9 type=command target="bash inner.sh" matcher="QQQ" phase=review description=d'; rc=$(run); eq "matcher branch: inner missing tool is a real fail" "$rc" 1

# Selection parity with B6.5 (forge#3809): non-review checks are selected by the `gh pr` target only, never by a phase= text match.
bt() { printf 'ACCEPTANCE_CHECK: id=%s type=command target="%s" matcher="exit_0" phase=%s description=%s' "$1" "$2" "$3" "$4"; }
inv "$(bt ac-1 'gh pr view 1 && false' build d)"; rc=$(run); eq "phase=build gh pr check is evaluated (fails)" "$rc" 1
inv "$(bt ac-1 'gh pr view 1 && true' build d)"; rc=$(run)
grep -q ':PASSED:' "$TMP/out" && ok "phase=build gh pr check counted and passes" || bad "phase=build gh pr check not counted"
inv "$(bt ac-1 'false' build d)"; rc=$(run); eq "phase=build non-gh-pr check is not selected" "$rc" 0
inv "$(bt ac-1 'gh pr view 1 && false' build 'x phase=review y')"; rc=$(run); eq "phase=review in description does not change selection" "$rc" 1
inv "$(bt ac-1 'false' build 'x phase=review y')"; rc=$(run); eq "phase=review in description does not select a non-gh-pr check" "$rc" 0
inv 'ACCEPTANCE_CHECK: id=ac-1 type=command target="gh pr view 1 && false" matcher="exit_0" description=untagged'; rc=$(run); eq "untagged gh pr check is evaluated" "$rc" 1
# test= tolerance (forge#3630): a test="..." token between phase= and description= does not change phase handling or selection.
inv 'ACCEPTANCE_CHECK: id=ac-1 type=command target="gh pr view 1 && false" matcher="exit_0" phase=review test="node --test x.mjs" description=d'; rc=$(run); eq "test= token on a phase=review check is tolerated (evaluated, fails)" "$rc" 1
inv 'ACCEPTANCE_CHECK: id=ac-1 type=command target="false" matcher="exit_0" phase=build test="node --test x.mjs" description=d'; rc=$(run); eq "test= token on a phase=build non-gh-pr check is not selected" "$rc" 0

echo "$PASS passed, $FAILN failed"; [ "$FAILN" -eq 0 ]
