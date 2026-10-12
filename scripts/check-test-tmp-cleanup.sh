#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-test-tmp-cleanup.sh — fail when a test suite creates a temp dir with no cleanup.
#
# Conservative text check (no parsing):
#   - bin/**/*.test.mjs that mentions mkdtemp/mkdtempSync must import the shared
#     helper bin/tests/_tmp.mjs (tmpDir registers removal at process exit).
#   - scripts/*.test.sh that calls mktemp must register an EXIT trap.
# The helper itself (bin/tests/_tmp.mjs) is not a *.test.mjs file and is not scanned.
#
# Usage: bash scripts/check-test-tmp-cleanup.sh [ROOT]
#   ROOT defaults to the repo root; the test points it at fixture trees.
# Exit: 0 clean, 1 offenders found (printed one per line), 2 bad ROOT.
# Bash 3.2 portable: no mapfile, no associative arrays.

set -u

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"
[ -d "$ROOT" ] || { echo "check-test-tmp-cleanup: ROOT is not a directory: $ROOT" >&2; exit 2; }

BAD=0

if [ -d "$ROOT/bin" ]; then
  NODE_FILES=$(find "$ROOT/bin" -name '*.test.mjs' -not -path '*/node_modules/*' | sort)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    grep -qE 'mkdtemp(Sync)?[[:space:]]*\(|^[[:space:]]*mkdtemp(Sync)?,?[[:space:]]*$|import[^;]*mkdtemp' "$f" || continue
    if ! grep -qE "^[[:space:]]*import[^;]*from[[:space:]]+['\"][./]+(tests/)?_tmp\.mjs['\"]" "$f"; then
      echo "VIOLATION: ${f#"$ROOT"/}: uses mkdtemp without importing bin/tests/_tmp.mjs (use tmpDir)"
      BAD=1
    fi
  done <<EOF_NODE
${NODE_FILES}
EOF_NODE
fi

if [ -d "$ROOT/scripts" ]; then
  SH_FILES=$(find "$ROOT/scripts" -maxdepth 1 -name '*.test.sh' | sort)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # a mktemp call: skip comment lines and quoted mentions inside grep -F patterns
    grep -E '(^|[^[:alnum:]_.-])mktemp([[:space:]]|\)|$)' "$f" | grep -vE '^[[:space:]]*#' | grep -vE "grep[^|]*mktemp" | grep -q . || continue
    if ! grep -qE '^[^#]*\btrap\b[^#]*\bEXIT\b' "$f"; then
      echo "VIOLATION: ${f#"$ROOT"/}: uses mktemp without an EXIT trap"
      BAD=1
    fi
  done <<EOF_SH
${SH_FILES}
EOF_SH
fi

[ "$BAD" -eq 0 ] && echo "check-test-tmp-cleanup: OK"
exit "$BAD"
