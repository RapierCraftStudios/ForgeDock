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
reset; git checkout -q staging; gen 3000 > base-only.txt; git add base-only.txt; git commit -qm "base moves"
git push -q origin staging 2>/dev/null; git checkout -q feat; gen 10 > a.txt; git add a.txt
OUT="$(run --threshold 100)"
check "moving base lines" "$OUT" diff_lines 10; check "moving base over" "$OUT" over false

echo "diff-size.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" = 0 ]
