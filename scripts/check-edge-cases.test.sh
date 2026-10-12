#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fixtures for scripts/check-edge-cases.sh. Run: bash scripts/check-edge-cases.test.sh (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
S="$DIR/check-edge-cases.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/check-edge-cases-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
OUT=""; RC=0

g() { git -C "$T/r" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
run() { OUT=$(bash "$S" --architect "$T/a" --builder "$T/b" --base staging --repo "$T/r" 2>&1); RC=$?; }
arch() { { echo '## Plan'; echo '<!-- FORGE:EDGE_CASES:BEGIN -->'; cat; echo '<!-- FORGE:EDGE_CASES:END -->'; echo '<!-- FORGE:ARCHITECT:COMPLETE -->'; } > "$T/a"; }
builder() { { echo '<!-- FORGE:BUILDER -->'; echo '### Edge Case Coverage'; cat; } > "$T/b"; }
expect() { # expect <want_rc> <desc> [want_substring]
  if [ "$RC" = "$1" ] && { [ -z "${3:-}" ] || case "$OUT" in *"$3"*) true ;; *) false ;; esac; }; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); echo "FAIL: $2 (rc=$RC, want $1)"; printf '%s\n' "$OUT" | sed 's/^/    /'
  fi
}
expect_absent() { case "$OUT" in *"$2"*) fail=$((fail+1)); echo "FAIL: $1 (unexpected '$2')"; printf '%s\n' "$OUT" | sed 's/^/    /' ;; *) pass=$((pass+1)) ;; esac; }
reset_branch() { g checkout -q -f staging; g branch -q -D feat; g checkout -q -b feat; }

mkdir "$T/r"; git -C "$T/r" init -q -b staging >/dev/null 2>&1 || { git -C "$T/r" init -q; g checkout -b staging; }
mkdir -p "$T/r/tests"
printf 'def test_existing_case():\n    assert True\n' > "$T/r/tests/test_a.py"
g add -A; g commit -m base
g checkout -q -b feat

E1='EDGE: id=e1 kind=edge description=empty input returns nothing'
E2='EDGE: id=e2 kind=error description=upstream times out with several classes of error'
add_test() { printf 'def %s():\n    assert True\n' "$1" >> "$T/r/tests/test_a.py"; g add -A; g commit -m "add $1"; }

# (a) empty block / absent block pass
arch </dev/null; builder </dev/null; run; expect 0 "empty block passes" "SKIP"
printf '## Plan\nno block\n' > "$T/a"; : > "$T/b"; run; expect 0 "absent block passes" "SKIP"

# (b) unmapped id fails
arch <<M
$E1
M
builder </dev/null; run; expect 1 "unmapped id fails" "UNMAPPED: e1"

# (c) untestable with a reason passes; (d) empty reason fails
builder <<M
EDGE_TEST: id=e1 untestable=pure spec change, no runtime to exercise
M
run; expect 0 "untestable with reason passes" "OK:"
builder <<M
EDGE_TEST: id=e1 untestable=
M
run; expect 1 "empty untestable reason fails" "EMPTY_REASON: e1"
builder <<M
EDGE_TEST: id=e1 untestable=   
M
run; expect 1 "whitespace-only untestable reason fails" "EMPTY_REASON: e1"

# (e) mapped test absent from the diff fails; present in added lines passes
builder <<M
EDGE_TEST: id=e1 test=tests/test_a.py::test_empty_input
M
run; expect 1 "mapped test not in diff fails" "TEST_NOT_IN_DIFF: e1"
add_test test_empty_input
run; expect 0 "mapped test in committed added lines passes" "MAPPED_TESTS: 1"

# (h) a pre-existing test name never satisfies a new edge case
builder <<M
EDGE_TEST: id=e1 test=tests/test_a.py::test_existing_case
M
run; expect 1 "pre-existing test name fails" "TEST_NOT_IN_DIFF: e1"

# the name must be in the mapped file, not just anywhere in the diff
mkdir -p "$T/r/other"; printf 'def test_elsewhere():\n    pass\n' > "$T/r/other/test_b.py"; g add -A; g commit -m other
builder <<M
EDGE_TEST: id=e1 test=tests/test_a.py::test_elsewhere
M
run; expect 1 "name added in a different file fails" "TEST_NOT_IN_DIFF: e1"

# staged-but-uncommitted and untracked tests count (validate runs before the commit)
printf 'def test_staged_case():\n    pass\n' >> "$T/r/tests/test_a.py"; g add -A
printf 'def test_untracked_case():\n    pass\n' > "$T/r/tests/test_new.py"
arch <<M
$E1
$E2
M
builder <<M
EDGE_TEST: id=e1 test=tests/test_a.py::test_staged_case
EDGE_TEST: id=e2 test=tests/test_new.py::test_untracked_case
M
run; expect 0 "staged and untracked tests count" "MAPPED_TESTS: 2"
reset_branch

# (g) duplicate ids fail (architect side and builder side)
arch <<M
$E1
EDGE: id=e1 kind=error description=same id twice
M
builder <<M
EDGE_TEST: id=e1 untestable=reason one
M
run; expect 1 "duplicate architect id fails" "DUPLICATE_ID: e1"
arch <<M
$E1
M
builder <<M
EDGE_TEST: id=e1 untestable=reason one
EDGE_TEST: id=e1 untestable=reason two
M
run; expect 1 "duplicate EDGE_TEST id fails" "DUPLICATE_ID: e1"

# mixed: one covered, one unmapped -> only the unmapped id is named
arch <<M
$E1
$E2
M
builder <<M
- EDGE_TEST: id=e1 untestable=reason given
M
run; expect 1 "bulleted EDGE_TEST line parses; other id unmapped" "UNMAPPED: e2"
expect_absent "covered id is not reported" "UNMAPPED: e1"

# prose mentioning EDGE_TEST mid-line is not a record
builder <<M
Note: each id needs an EDGE_TEST: line later.
EDGE_TEST: id=e1 untestable=reason given
EDGE_TEST: id=e2 untestable=another reason
M
run; expect 0 "mid-line EDGE_TEST mention ignored" "OK:"

# (f) bad input is rc 2, never a pass
builder <<M
EDGE_TEST: id=e1 untestable=r
EDGE_TEST: id=e2 test=no-separator
M
run; expect 2 "test= without ::name is rc 2" "must be <path>::<name>"
builder <<M
EDGE_TEST: id=e1 bogus=1
M
run; expect 2 "malformed EDGE_TEST is rc 2" "malformed EDGE_TEST"
builder <<M
EDGE_TEST: id=e1 test=--evil::x
M
run; expect 2 "test path starting with - is rc 2"
printf '<!-- FORGE:EDGE_CASES:BEGIN -->\nEDGE: id=bad kind=edge description=x\n<!-- FORGE:EDGE_CASES:END -->\n' > "$T/a"; : > "$T/b"
run; expect 2 "malformed EDGE id is rc 2" "malformed EDGE record"
printf '<!-- FORGE:EDGE_CASES:BEGIN -->\nEDGE: id=e1 kind=edge description=x\n' > "$T/a"
run; expect 2 "unbalanced markers are rc 2" "unbalanced"
arch <<M
$E1
M
builder <<M
EDGE_TEST: id=e1 untestable=r
M
OUT=$(bash "$S" --architect "$T/a" --builder "$T/b" --base nonexistent --repo "$T/r" 2>&1); RC=$?; expect 2 "unresolvable base is rc 2" "cannot resolve base"
mkdir -p "$T/notgit"
OUT=$(bash "$S" --architect "$T/a" --builder "$T/b" --base staging --repo "$T/notgit" 2>&1); RC=$?; expect 2 "non-git repo is rc 2"
OUT=$(bash "$S" --architect "$T/missing" --builder "$T/b" --base staging --repo "$T/r" 2>&1); RC=$?; expect 2 "missing architect file is rc 2"
OUT=$(bash "$S" --base staging 2>&1); RC=$?; expect 2 "missing args is rc 2"

# description with spaces and punctuation is data, never parsed or executed
arch <<'M'
EDGE: id=e1 kind=concurrency description=two writers $(touch /tmp/pwned) `x` "quoted" a=b
M
builder <<M
EDGE_TEST: id=e1 untestable=reason given
M
run; expect 0 "free-text description is inert" "OK:"

echo "check-edge-cases.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
