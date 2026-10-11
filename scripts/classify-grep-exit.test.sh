#!/usr/bin/env bash
# classify-grep-exit.test.sh — verdicts of scripts/classify-grep-exit.sh (forge#3802). Runs real grep, no network.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLS="$SCRIPT_DIR/classify-grep-exit.sh"
PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAILN=$((FAILN+1)); echo "FAIL - $1"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cd "$TMP" || exit 1
echo hello > present.txt
ln -s loop1 loop2; ln -s loop2 loop1

# run_target <target>: execute like B6.5 does, then classify. Prints "malformed" or "real".
verdict() {
  local t="$1" err rc
  err=$(eval "$t" 2>&1 >/dev/null); rc=$?
  if bash "$CLS" "$rc" "$err" "$t" >/dev/null; then echo malformed; else echo real; fi
}
expect() { local got; got=$(verdict "$2"); if [ "$got" = "$3" ]; then ok "$1"; else bad "$1 (got $got, want $3)"; fi; }

expect "missing file, plain" "grep -qF -e x nofile.md" real
expect "missing file, 2>/dev/null" "grep -qF -e x nofile.md 2>/dev/null" real
expect "missing file, -s" "grep -sqF -e x nofile.md" real
expect "missing file, --no-messages" "grep --no-messages -qF -e x nofile.md" real
expect "symlink loop, stderr suppressed" "grep -qF -e x loop1 2>/dev/null" real
expect "directory operand, stderr suppressed" "grep -qF -e x . 2>/dev/null" real
expect "unmatched bracket regex" "grep -qE '[abc' present.txt" malformed
expect "unmatched paren regex" "grep -qE '(abc' present.txt" malformed
expect "pattern read as option" "grep -qE '--no-such-flag' present.txt" malformed
expect "option-looking pattern" "grep -qE '-z foo' present.txt" malformed
expect "non-grep target" "bash -c 'exit 2'" real
for _w in "grep: brackets ([ ]) not balanced" "grep: parentheses not balanced" "grep: braces not balanced" "grep: repetition-operator operand invalid" "grep: empty (sub)expression" "grep: invalid repetition count(s)"; do
  bash "$CLS" 2 "$_w" "grep -E x f" >/dev/null && ok "BSD wording malformed: $_w" || bad "BSD wording malformed: $_w"
done
[ "$(bash "$CLS" 2 "grep: Unmatched [" "grep -q x f")" = "grep usage error (exit 2)" ] && ok "reason text" || bad "reason text"
bash "$CLS" 2 "grep: Unmatched [" "ls -l" >/dev/null && bad "non-grep with usage stderr is not malformed" || ok "non-grep with usage stderr is not malformed"
bash "$CLS" 1 "grep: Unmatched [" "grep -q x f" >/dev/null && bad "rc 1 is not malformed" || ok "rc 1 is not malformed"
bash "$CLS" 0 "" "grep -q x f" >/dev/null && bad "rc 0 is not malformed" || ok "rc 0 is not malformed"
bash "$CLS" 2 "" "grep -q x f" >/dev/null && bad "rc 2 empty stderr is a real failure" || ok "rc 2 empty stderr is a real failure"
bash "$CLS" 2 "" >/dev/null && bad "missing args fail closed" || ok "missing args fail closed"

echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
