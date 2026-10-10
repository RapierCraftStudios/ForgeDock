#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fixtures for scripts/check-branch-ancestry.sh. Run: bash scripts/check-branch-ancestry.test.sh (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
S="$DIR/check-branch-ancestry.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/check-branch-ancestry-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
OUT=""

g() { git -C "$T/r" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
commit() { echo "$1" > "$T/r/$1.txt"; g add -A; g commit -m "$1"; }
# run <branch> <base>: sets OUT and RC
run() { OUT=$(cd "$T/r" && bash "$S" "$@" 2>&1); RC=$?; }
expect() { # expect <want_rc> <desc> [want_substring]
  if [ "$RC" = "$1" ] && { [ -z "${3:-}" ] || case "$OUT" in *"$3"*) true ;; *) false ;; esac; }; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); echo "FAIL: $2 (rc=$RC, want $1)"; printf '%s\n' "$OUT" | sed 's/^/    /'
  fi
}

mkdir "$T/r"; git -C "$T/r" init -q -b staging >/dev/null 2>&1 || { git -C "$T/r" init -q; g checkout -b staging; }
commit base
# milestone diverges from staging after staging2
commit staging2
g checkout -b milestone/m1; commit ms1
g checkout staging
# feature branch off the original base commit
g checkout -b feat HEAD~1; commit feat1

# 1. no merges
run feat staging; expect 0 "no merges passes"

# 2. base-sync merge passes (staging advances, then is merged into feat)
g merge --no-ff -m "Merge staging into feat" staging
run feat staging; expect 0 "base-sync merge passes"
run HEAD staging; expect 0 "HEAD form passes"

# 3. staging advances further and is synced again: still passes
g checkout -q staging; commit staging3; g checkout -q feat
g merge --no-ff -m "Merge staging again" staging
run feat staging; expect 0 "repeated base-sync merges pass"

# 4. foreign merge fails, foreign parent printed
MS=$(git -C "$T/r" rev-parse milestone/m1)
g merge --no-ff -m "Merge milestone into feat" milestone/m1
run feat staging; expect 1 "foreign merge fails" "$MS"
case "$OUT" in *"Merge milestone into feat"*) pass=$((pass+1)) ;; *) fail=$((fail+1)); echo "FAIL: subject not printed"; echo "$OUT" ;; esac

# 5. octopus with one foreign parent fails
g checkout -q -b feat2 staging; commit f2
g checkout -q staging; g checkout -q -b side; commit side1
g checkout -q feat2
g merge --no-ff -m "octopus" side milestone/m1
run feat2 staging; expect 1 "octopus with foreign parent fails" "$MS"

# 5b. branch cut from a milestone line, then syncing the base: foreign first-parent history fails
MS1=$(git -C "$T/r" rev-parse milestone/m1)
g checkout -q -b feat3 milestone/m1; commit f3
g merge --no-ff -m "Merge staging into feat3" staging
run feat3 staging; expect 1 "milestone-cut branch with base sync fails" "$MS1"

# 5c. milestone-cut branch with no merge at all also fails
g checkout -q -b feat4 milestone/m1; commit f4
run feat4 staging; expect 1 "milestone-cut branch without merges fails" "$MS1"

# 6. bad refs fail closed (exit 2)
run nosuchbranch staging; expect 2 "bad branch ref exits 2"
run feat nosuchbase; expect 2 "bad base ref exits 2"
run feat; expect 2 "missing arg exits 2"

echo "check-branch-ancestry tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
