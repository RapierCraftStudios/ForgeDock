#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Fixtures for lint-build-validate-files.sh (forge#3254). Run: bash scripts/lint-build-validate-files.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LINT="$HERE/lint-build-validate-files.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAILN=0
check() { # name want_rc file
  bash "$LINT" "$3" >"$T/out" 2>&1; rc=$?
  if [ "$rc" -eq "$2" ]; then PASS=$((PASS+1)); else FAILN=$((FAILN+1)); echo "FAIL: $1 (rc=$rc want $2)"; cat "$T/out"; fi
}
V='Skill(skill="{FORGE_SKILL_PREFIX}work-on:build:validate", args="{NUMBER} --worktree {W}'
printf '## Phase B6\n%s --files \\"{CHANGED_FILES}\\"")\n## Phase B6.5\n%s --files \\"{CHANGED_FILES}\\"")\n' "$V" "$V" > "$T/ok.md"
check "all carry --files" 0 "$T/ok.md"
printf '## Phase B6\n%s --files \\"x\\"")\n## Phase B6.5\n%s")\n' "$V" "$V" > "$T/bad1.md"
check "one invocation lacks --files" 1 "$T/bad1.md"
printf '## Phase B6\n%s --files \\"x\\"")\n## Phase B6.5\nfollowed by work-on:build:validate with the same args\n' "$V" > "$T/bad2.md"
check "B6.5 has no explicit invocation" 1 "$T/bad2.md"
printf 'nothing here\n' > "$T/bad3.md"
check "no invocations at all" 1 "$T/bad3.md"
check "real build.md" 0 "$HERE/../commands/work-on/build.md"
echo "passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
