#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fixtures for scripts/check-blast-radius.sh. Run: bash scripts/check-blast-radius.test.sh (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
S="$DIR/check-blast-radius.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/check-blast-radius-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
OUT=""; RC=0

g() { git -C "$T/r" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
run() { OUT=$(bash "$S" --manifest "$T/m" --base staging --repo "$T/r" 2>&1); RC=$?; }
manifest() { { echo '<!-- FORGE:BLAST_RADIUS:BEGIN -->'; cat; echo '<!-- FORGE:BLAST_RADIUS:END -->'; } > "$T/m"; }
expect() { # expect <want_rc> <desc> [want_substring]
  if [ "$RC" = "$1" ] && { [ -z "${3:-}" ] || case "$OUT" in *"$3"*) true ;; *) false ;; esac; }; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); echo "FAIL: $2 (rc=$RC, want $1)"; printf '%s\n' "$OUT" | sed 's/^/    /'
  fi
}
expect_absent() { # expect_absent <desc> <substring>
  case "$OUT" in *"$2"*) fail=$((fail+1)); echo "FAIL: $1 (unexpected '$2')"; printf '%s\n' "$OUT" | sed 's/^/    /' ;; *) pass=$((pass+1)) ;; esac
}
reset_branch() { g checkout -q -f staging; g branch -q -D feat; g checkout -q -b feat; }

mkdir "$T/r"; git -C "$T/r" init -q -b staging >/dev/null 2>&1 || { git -C "$T/r" init -q; g checkout -b staging; }
mkdir -p "$T/r/routers" "$T/r/docs"
for f in a b c; do printf 'def handler():\n    use(billing_principal)\n' > "$T/r/routers/$f.py"; done
echo 'notes about nothing' > "$T/r/docs/readme.md"
g add -A; g commit -m base
g checkout -q -b feat

SYM='SYMBOL: id=s1 kind=field name=billing_principal query="billing_principal"'

# (a) 3 sibling callers, 1 changed, 2 unlisted -> FAIL naming both unlisted files
echo 'use(billing_principal, new)' >> "$T/r/routers/a.py"; g add -A; g commit -m "change a"
manifest <<M
$SYM
HIT: symbol=s1 file=routers/a.py role=consumer disposition=change
M
run; expect 1 "3 siblings, 1 changed, 2 unlisted fails" "UNLISTED: s1 routers/b.py"
case "$OUT" in *"UNLISTED: s1 routers/c.py"*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "FAIL: second unlisted sibling not named"; echo "$OUT" ;; esac
expect_absent "changed file is not unlisted" "UNLISTED: s1 routers/a.py"

# (b) all 3 changed -> PASS
echo 'use(billing_principal, new)' >> "$T/r/routers/b.py"; echo 'use(billing_principal, new)' >> "$T/r/routers/c.py"
g add -A; g commit -m "change b c"
manifest <<M
$SYM
HIT: symbol=s1 file=routers/a.py role=consumer disposition=change
M
run; expect 0 "all siblings changed passes (changed files need no row)" "OK:"

# (c) 1 changed + 2 verified-unaffected -> PASS
reset_branch; echo 'use(billing_principal, new)' >> "$T/r/routers/a.py"; g add -A; g commit -m "change a"
manifest <<M
$SYM
HIT: symbol=s1 file=routers/a.py role=consumer disposition=change
HIT: symbol=s1 file=routers/b.py role=sibling disposition=verified-unaffected reason=reads-only-never-writes
HIT: symbol=s1 file=routers/c.py role=sibling disposition=verified-unaffected reason=dead-code-path
M
run; expect 0 "verified-unaffected siblings pass" "OK:"

# (c2) staged but uncommitted and untracked changes count (validate runs before the commit)
reset_branch; echo 'use(billing_principal, new)' >> "$T/r/routers/a.py"; echo 'use(billing_principal, new)' >> "$T/r/routers/b.py"
g add routers/a.py; echo 'billing_principal = 1' > "$T/r/routers/d.py"
manifest <<M
$SYM
M
run; expect 1 "uncommitted: c.py still unlisted" "UNLISTED: s1 routers/c.py"
expect_absent "staged change counts" "UNLISTED: s1 routers/a.py"
expect_absent "unstaged tracked change counts" "UNLISTED: s1 routers/b.py"
expect_absent "untracked new file counts" "UNLISTED: s1 routers/d.py"
g checkout -q -f staging; rm -f "$T/r/routers/d.py"; g checkout -q -f feat; rm -f "$T/r/routers/d.py"; g reset -q --hard

# (d) change row whose file is not in the diff -> FAIL (planned but not done)
reset_branch; echo 'use(billing_principal, new)' >> "$T/r/routers/a.py"; g add -A; g commit -m "change a"
manifest <<M
$SYM
HIT: symbol=s1 file=routers/a.py role=consumer disposition=change
HIT: symbol=s1 file=docs/readme.md role=consumer disposition=change
HIT: symbol=s1 file=routers/b.py role=sibling disposition=verified-unaffected reason=x-reason
HIT: symbol=s1 file=routers/c.py role=sibling disposition=verified-unaffected reason=x-reason
M
run; expect 1 "planned-but-not-done change row fails" "NOT_DONE: s1 docs/readme.md"

# (e) rc 2 cases
manifest <<M
SYMBOL: id=s1 kind=field name=x query="-rf"
M
run; expect 2 "leading dash query rejected"
manifest <<M
SYMBOL: id=s1 kind=field name=x query=""
M
run; expect 2 "empty query rejected"
manifest <<M
SYMBOL: id=s1 kind=field name=x query="ab"
M
run; expect 2 "too-short query rejected"
manifest <<M
SYMBOL: id=s1 kind=field name=x query="foo bar baz"
M
run; expect 2 "query with spaces rejected"
manifest <<M
SYMBOL: id=s1 kind=field name=x query="a;rm -rf"
M
run; expect 2 "query with shell metacharacters rejected"
manifest <<M
$SYM
this is not a record
M
run; expect 2 "malformed line rejected"
manifest <<M
$SYM
HIT: symbol=s1 file=routers/b.py role=sibling disposition=verified-unaffected
M
run; expect 2 "verified-unaffected without reason rejected"
manifest <<M
$SYM
HIT: symbol=s9 file=routers/b.py role=sibling disposition=change
M
run; expect 2 "HIT with unknown symbol rejected"
manifest <<M
$SYM
HIT: symbol=s1 file=routers/b.py role=sibling disposition=maybe
M
run; expect 2 "invalid disposition rejected"
manifest <<M
$SYM
$SYM
M
run; expect 2 "duplicate symbol id rejected"
printf '<!-- FORGE:BLAST_RADIUS:BEGIN -->\n%s\n' "$SYM" > "$T/m"
run; expect 2 "unterminated BEGIN rejected"
manifest <<M
$SYM
M
OUT=$(bash "$S" --manifest "$T/m" --base no-such-ref --repo "$T/r" 2>&1); RC=$?; expect 2 "bad base ref is rc 2, not a pass"
mkdir "$T/notgit"
OUT=$(bash "$S" --manifest "$T/m" --base staging --repo "$T/notgit" 2>&1); RC=$?; expect 2 "non-git repo is rc 2, not a pass"
OUT=$(bash "$S" --manifest "$T/missing" --base staging --repo "$T/r" 2>&1); RC=$?; expect 2 "missing manifest file is rc 2"
OUT=$(bash "$S" --base staging 2>&1); RC=$?; expect 2 "missing --manifest is rc 2"

# (f) absent / empty manifest -> SKIP rc 0
: > "$T/m"; run; expect 0 "empty manifest skips" "SKIP: no manifest"
printf '## Implementation Plan\nno block here\n' > "$T/m"; run; expect 0 "no BEGIN/END block skips" "SKIP: no manifest"
printf '## Plan\nprose\n<!-- FORGE:BLAST_RADIUS:BEGIN -->\n%s\nHIT: symbol=s1 file=routers/a.py role=consumer disposition=change\n<!-- FORGE:BLAST_RADIUS:END -->\ntrailing prose\n<!-- FORGE:ARCHITECT:COMPLETE -->\n' "$SYM" > "$T/m"
run; expect 1 "whole comment body is accepted, prose outside the block ignored" "UNLISTED: s1 routers/b.py"

# fixed-string, not regex: a query with metacharacter-like text must match literally
g checkout -q -f staging; echo 'a.b(c)' > "$T/r/docs/regex.txt"; echo 'aXb(c)' > "$T/r/docs/other.txt"; g add -A; g commit -m regex
g branch -q -D feat; g checkout -q -b feat
manifest <<M
SYMBOL: id=s1 kind=function name=dot query="a.b"
M
run; expect 1 "fixed-string match lists the literal hit" "UNLISTED"
expect_absent "regex-style wildcard does not match aXb" "other.txt"
HIT_OK='HIT: symbol=s1 file=docs/regex.txt role=producer disposition=verified-unaffected reason=literal-only'
manifest <<M
SYMBOL: id=s1 kind=function name=dot query="a.b"
$HIT_OK
M
run; expect 0 "literal hit covered by verified-unaffected" "OK:"

# zero-hit symbol passes
manifest <<M
SYMBOL: id=s1 kind=flag name=nothing query="zz_never_present_zz"
M
run; expect 0 "zero-hit symbol passes" "OK:"

# query too broad -> rc 2
reset_branch; mkdir -p "$T/r/many"; i=0; while [ "$i" -lt 205 ]; do echo broadtoken > "$T/r/many/f$i.txt"; i=$((i+1)); done; g add -A; g commit -m many
manifest <<M
SYMBOL: id=s1 kind=flag name=broad query="broadtoken"
M
run; expect 2 "over-broad query is rc 2" "too broad"

echo "check-blast-radius.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
