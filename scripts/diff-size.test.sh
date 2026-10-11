#!/usr/bin/env bash
# diff-size.test.sh — cases for scripts/diff-size.sh (forge#3450).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/diff-size.sh"
PASS=0; FAILN=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }

# Fixture: a bare "origin" plus a clone on a feature branch.
git init -q --bare "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/w" 2>/dev/null
cd "$TMP/w" || exit 1
git config user.email t@example.com; git config user.name t
echo base > README.md
git add README.md; git commit -qm base; git branch -M staging; git push -q origin staging 2>/dev/null
git checkout -q -b feat

gen() { awk -v n="$1" 'BEGIN{for(i=0;i<n;i++) print "line " i}'; }
reset() { git reset -q --hard origin/staging; git clean -qfd; }
run() { bash "$S" --repo-path "$TMP/w" --base staging "$@"; }
val() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -n1; }
check() { # name out key want
  local got; got="$(val "$2" "$3")"
  if [ "$got" = "$4" ]; then ok; else bad "$1 ($3=$got want $4)"; fi
}

# empty diff
OUT="$(run)"; check "empty diff lines" "$OUT" diff_lines 0; check "empty diff over" "$OUT" over false

# under threshold
reset; gen 10 > a.txt; git add a.txt
OUT="$(run --threshold 100)"; check "under lines" "$OUT" diff_lines 10; check "under over" "$OUT" over false

# over threshold, exit 0 even when over
reset; gen 150 > a.txt; git add a.txt
OUT="$(run --threshold 100)"; rc=$?
[ "$rc" = 0 ] && ok || bad "over exits 0 (rc=$rc)"
check "over lines" "$OUT" diff_lines 150; check "over flag" "$OUT" over true

# exactly at threshold is not over
OUT="$(run --threshold 150)"; check "at threshold" "$OUT" over false

# threshold 0 disables
OUT="$(run --threshold 0)"; check "threshold 0 disables" "$OUT" over false

# default exclusions: lockfile, min, snap, root dist/, any-depth __snapshots__/
reset; gen 5 > a.txt
gen 500 > package-lock.json; gen 500 > app.min.js; gen 500 > x.snap
mkdir -p dist pkg/__snapshots__/deep; gen 500 > dist/out.js; gen 500 > pkg/__snapshots__/deep/f.json
git add -A
OUT="$(run --threshold 100)"
check "defaults diff_lines" "$OUT" diff_lines 5; check "defaults excluded" "$OUT" excluded_lines 2500; check "defaults over" "$OUT" over false

# SEC-2: built-in directory defaults are root-anchored; first-party nested dirs are counted
reset; mkdir -p commands/work-on/build pkg/vendor pkg/fixtures; gen 300 > commands/work-on/build/a.md
gen 200 > pkg/vendor/v.js; gen 100 > pkg/fixtures/f.json; mkdir -p build; gen 50 > build/root.js; git add -A
OUT="$(run --threshold 100)"
check "nested defaults counted" "$OUT" diff_lines 600; check "root build excluded" "$OUT" excluded_lines 50; check "nested defaults over" "$OUT" over true


# a directory glob is not a substring match (distribution/ is not dist/)
reset; mkdir -p distribution; gen 30 > distribution/a.txt; git add -A
OUT="$(run --threshold 100)"; check "dist is not substring" "$OUT" diff_lines 30

# extra glob is additive
reset; gen 40 > keep.txt; mkdir -p docs/gen; gen 400 > docs/gen/big.md; git add -A
OUT="$(run --threshold 100 --exclude-glob 'docs/gen/*')"
check "extra glob lines" "$OUT" diff_lines 40; check "extra glob excluded" "$OUT" excluded_lines 400
OUT="$(run --threshold 100 --exclude-glob 'docs/gen/*' --exclude-glob '*.txt')"
check "two extra globs" "$OUT" diff_lines 0

# glob is data, not evaluated
reset; gen 10 > a.txt; git add -A
OUT="$(run --exclude-glob '$(touch '"$TMP"'/pwned)' 2>/dev/null)"
[ ! -e "$TMP/pwned" ] && ok || bad "glob evaluated as code"

# binary file counts 0
reset; head -c 2000 /dev/urandom > b.bin; gen 7 > a.txt; git add -A
OUT="$(run)"; check "binary counts 0" "$OUT" diff_lines 7

# deletions and renames count both sides (--no-renames)
reset; gen 20 > r.txt; git add -A; git commit -qm r; git push -q origin feat:staging 2>/dev/null
git mv r.txt r2.txt; OUT="$(run)"; check "rename counts add+delete" "$OUT" diff_lines 40
git reset -q --hard origin/staging

# committed + staged are both measured
reset; gen 10 > c1.txt; git add -A; git commit -qm c1; gen 5 > c2.txt; git add -A
OUT="$(run)"; check "committed + staged" "$OUT" diff_lines 15

# top files, largest first
reset; gen 3 > s.txt; gen 9 > l.txt; git add -A
OUT="$(run)"; FIRST="$(printf '%s\n' "$OUT" | sed -n 's/^top=//p' | head -n1)"
[ "$FIRST" = "9 l.txt" ] && ok || bad "top ordering (got '$FIRST')"

# cohesion (forge#3790): new files + test files >= 70% of diff_lines and diff_lines <= threshold*3/2
shape() { # all-new fixture: $1=new module lines, $2=new test file lines
  reset; mkdir -p src tests; gen "$1" > src/newmod.py; gen "$2" > tests/test_newmod.py; git add -A
}
shape 685 458; OUT="$(run --threshold 1000)"
check "34844 shape cohesive" "$OUT" cohesive true; check "34844 shape new (test file is also new)" "$OUT" new_lines 1143
check "34844 shape test" "$OUT" test_lines 458; check "34844 shape cohesive_lines" "$OUT" cohesive_lines 1143
shape 471 593; OUT="$(run --threshold 1000)"; check "35124 shape cohesive" "$OUT" cohesive true
shape 516 697; OUT="$(run --threshold 1000)"; check "35143 shape cohesive" "$OUT" cohesive true
shape 1478 0; OUT="$(run --threshold 1000)"; check "35100 all-new at 1.5x cohesive" "$OUT" cohesive true
shape 1500 1; OUT="$(run --threshold 1000)"; check "over 1.5x not cohesive" "$OUT" cohesive false
shape 1000 0; OUT="$(run --threshold 0)"; check "threshold 0 not cohesive" "$OUT" cohesive false

# new test file counts once (union), under the threshold still reports cohesive
reset; mkdir -p tests; gen 50 > tests/test_x.py; git add -A
OUT="$(run --threshold 1000)"; check "new test file new" "$OUT" new_lines 50; check "new test file test" "$OUT" test_lines 50
check "new test file union once" "$OUT" cohesive_lines 50

# a modified (not added) test file counts as test, not new
reset; mkdir -p tests; gen 40 > tests/test_old.py
git add -A; git commit -qm t; git push -q origin feat:staging 2>/dev/null
gen 10 | sed 's/line/chg/' > tests/test_old.py; gen 30 > src_new.py; git add -A
OUT="$(run)"; check "modified test new_lines" "$OUT" new_lines 30; check "modified test test_lines" "$OUT" test_lines 50
check "modified test union" "$OUT" cohesive_lines 80
git reset -q --hard origin/staging

# sprawl: 1300 lines across 15 modified files is not cohesive
reset; for i in $(seq 1 15); do gen 50 > "m$i.txt"; done; git add -A; git commit -qm m; git push -q origin feat:staging 2>/dev/null
for i in $(seq 1 15); do gen 43 | sed 's/line/edit/' > "m$i.txt"; done; git add -A
OUT="$(run --threshold 1000)"
check "sprawl lines" "$OUT" diff_lines 1395; check "sprawl cohesive_lines" "$OUT" cohesive_lines 0; check "sprawl not cohesive" "$OUT" cohesive false
git reset -q --hard origin/staging

# modified (not added) test file is test-classified; modified non-test stays out; basename patterns, no substring match
reset; mkdir -p t; gen 10 > latest.sh; gen 10 > contest.txt; gen 10 > a.spec.ts; gen 10 > b_test.go; gen 10 > test_c.py; git add -A
OUT="$(run)"; check "latest.sh and contest.txt are new, all counted" "$OUT" new_lines 50
check "test name patterns" "$OUT" test_lines 30

# excluded files are not counted by cohesion
reset; gen 20 > keep.py; gen 900 > package-lock.json; git add -A
OUT="$(run --threshold 1000)"; check "excluded not in new_lines" "$OUT" new_lines 20

# existing key order is unchanged: cohesion keys sit between over= and top=
reset; gen 3 > s.txt; git add -A
KEYS="$(run | sed -n 's/^\([a-z_]*\)=.*/\1/p' | tr '\n' ' ')"
[ "$KEYS" = "diff_lines excluded_lines threshold over new_lines test_lines cohesive_lines cohesive top " ] && ok || bad "key order ($KEYS)"

# fail closed: bad repo path, bad base, bad threshold, unknown arg, missing base
OUT="$(bash "$S" --repo-path "$TMP/nope" --base staging 2>/dev/null)"; rc=$?
{ [ "$rc" = 2 ] && [ -z "$OUT" ]; } && ok || bad "bad repo path (rc=$rc out='$OUT')"
OUT="$(run2() { bash "$S" --repo-path "$TMP/w" --base nonexistent 2>/dev/null; }; run2)"; rc=$?
{ [ "$rc" = 2 ] && [ -z "$OUT" ]; } && ok || bad "bad base (rc=$rc out='$OUT')"
OUT="$(bash "$S" --repo-path "$TMP/w" --base staging --threshold abc 2>/dev/null)"; rc=$?
{ [ "$rc" = 2 ] && [ -z "$OUT" ]; } && ok || bad "bad threshold (rc=$rc)"
OUT="$(bash "$S" --repo-path "$TMP/w" --bogus 2>/dev/null)"; rc=$?
{ [ "$rc" = 2 ] && [ -z "$OUT" ]; } && ok || bad "unknown arg (rc=$rc)"
OUT="$(bash "$S" --repo-path "$TMP/w" 2>/dev/null)"; rc=$?
{ [ "$rc" = 2 ] && [ -z "$OUT" ]; } && ok || bad "missing base (rc=$rc)"

# SEC-1: commits landing on the base after the branch point are not counted
reset; git checkout -q staging; git reset -q --hard origin/staging; gen 3000 > base-only.txt; git add base-only.txt; git commit -qm "base moves"
git push -q origin staging 2>/dev/null && ok || bad "base-moves push rejected"
git checkout -q feat; gen 10 > a.txt; git add a.txt
OUT="$(run --threshold 100)"
check "moving base lines" "$OUT" diff_lines 10; check "moving base over" "$OUT" over false

echo "diff-size.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" = 0 ]
