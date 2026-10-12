#!/usr/bin/env bash
# acceptance-red-green.test.sh — tests for scripts/acceptance-red-green.sh (real temp git repos, no network)
# Usage: bash scripts/acceptance-red-green.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RG="$SCRIPT_DIR/acceptance-red-green.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export TMPDIR="$TMP/tmpdir"; mkdir -p "$TMPDIR"
PASS=0; FAILN=0
ok() { PASS=$((PASS+1)); echo "ok   - $1"; }
bad() { FAILN=$((FAILN+1)); echo "FAIL - $1"; }

# make_repo <dir>: base commit on branch main with app.sh (defect: prints bad), then a feature branch is the caller's job
make_repo() {
  git init -q -b main "$1" && git -C "$1" config user.email t@t && git -C "$1" config user.name t
  printf 'echo bad\n' > "$1/app.sh"; git -C "$1" add -A; git -C "$1" commit -qm base
  git -C "$1" update-ref refs/remotes/origin/main HEAD
}
fix_head() { printf 'echo good\n' > "$1/app.sh"; git -C "$1" add -A; git -C "$1" commit -qm fix; }
leaked() { git -C "$1" worktree list | wc -l | tr -d ' '; }
check() { # name want repo cmd [extra...]
  local name="$1" want="$2" repo="$3" cmd="$4" got
  got=$(bash "$RG" --repo-path "$repo" --base-ref origin/main --test-cmd "$cmd" 2>/dev/null)
  if [ "$got" = "$want" ]; then ok "$name"; else bad "$name: want '$want' got '$got'"; fi
  if [ "$(leaked "$repo")" = "1" ] && [ -z "$(ls "$TMPDIR")" ]; then ok "$name: base worktree and tmp dir cleaned"; else bad "$name: leaked worktree or tmp ($(leaked "$repo") worktrees)"; fi
}

# 1. real red-green proof: test greps the fixed output, new test file only exists at head (overlay)
R1="$TMP/r1"; make_repo "$R1"; fix_head "$R1"
mkdir -p "$R1/tests"; printf 'test "$(bash app.sh)" = good && echo "1 passed"\n' > "$R1/tests/t.sh"; git -C "$R1" add -A; git -C "$R1" commit -qm test
check "red on base, green on head (new test file overlaid)" "BASE=FAILED HEAD=RAN" "$R1" "bash tests/t.sh"

# 2. passes on base: test never touches the defect
R2="$TMP/r2"; make_repo "$R2"; fix_head "$R2"
mkdir -p "$R2/tests"; printf 'echo "1 passed"\n' > "$R2/tests/t.sh"; git -C "$R2" add -A; git -C "$R2" commit -qm test
check "passes on base" "BASE=RAN HEAD=RAN" "$R2" "bash tests/t.sh"

# 3. head fails: base is not run
check "head failure skips base" "BASE=SKIPPED HEAD=FAILED" "$R1" "bash app.sh; exit 1"

# 4. RAN_NOTHING on head
check "runner that exercises nothing on head" "BASE=SKIPPED HEAD=RAN_NOTHING" "$R1" "echo 'no tests ran'"

# 5. command not found (127) on head
check "rc 127 is UNRUNNABLE" "BASE=SKIPPED HEAD=UNRUNNABLE" "$R1" "definitely-not-a-command-xyz"

# 6. base cannot execute: the command only exists at head (non-test file), so base yields 127
R3="$TMP/r3"; make_repo "$R3"; fix_head "$R3"
printf 'echo "1 passed"\n' > "$R3/runner.sh"; chmod +x "$R3/runner.sh"; git -C "$R3" add -A; git -C "$R3" commit -qm runner
check "base rc 127 (runner absent at base) is UNRUNNABLE" "BASE=UNRUNNABLE HEAD=RAN" "$R3" "./runner.sh"

# 7. base ref unresolvable: worktree cannot be created
got=$(bash "$RG" --repo-path "$R1" --base-ref origin/does-not-exist --test-cmd "bash tests/t.sh" 2>/dev/null)
[ "$got" = "BASE=UNRUNNABLE HEAD=RAN" ] && ok "unresolvable base ref is UNRUNNABLE" || bad "unresolvable base ref: got '$got'"
[ "$(leaked "$R1")" = "1" ] && ok "no worktree after failed setup" || bad "worktree leaked after failed setup"

# 8. non-test files are never overlaid (a changed source file stays at base)
R4="$TMP/r4"; make_repo "$R4"; fix_head "$R4"
check "source file stays at base (no overlay of non-test files)" "BASE=FAILED HEAD=RAN" "$R4" 'test "$(bash app.sh)" = good && echo "1 passed"'

# 9. timeout is UNRUNNABLE when a timeout binary exists
if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
  got=$(bash "$RG" --repo-path "$R1" --base-ref origin/main --test-cmd "sleep 5" --timeout 1 2>/dev/null)
  [ "$got" = "BASE=SKIPPED HEAD=UNRUNNABLE" ] && ok "timeout is UNRUNNABLE" || bad "timeout: got '$got'"
fi

# 10. usage errors print nothing and exit 2
out=$(bash "$RG" --repo-path "$R1" 2>/dev/null); rc=$?
{ [ "$rc" -eq 2 ] && [ -z "$out" ]; } && ok "missing args exit 2, empty stdout" || bad "usage: rc=$rc out='$out'"

echo "$PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
