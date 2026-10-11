#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# run-shell-tests.sh — glob runner for every scripts/*.test.sh suite.
#
# Usage: bash scripts/run-shell-tests.sh [suite-file ...]
#   No args: runs every scripts/*.test.sh (sorted). New suites need no workflow edit.
#   Args:    runs only the given suite files (used to point at fixtures).
#
# Env:
#   SHELL_TEST_TIMEOUT  per-suite timeout in seconds (default 300)
#
# Exit: 0 when every suite passes; 1 on any FAIL/TIMEOUT or when no suite is found.
# Bash 3.2 portable: no mapfile, no associative arrays.

set -u

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT" || exit 1

TIMEOUT_SECS="${SHELL_TEST_TIMEOUT:-300}"
# WIRE:PROVEN — manual: SHELL_TEST_TIMEOUT=abc and SHELL_TEST_TIMEOUT=0 both print the error and exit 2
case "$TIMEOUT_SECS" in
  ''|*[!0-9]*) echo "run-shell-tests: SHELL_TEST_TIMEOUT must be a positive integer, got '$TIMEOUT_SECS'" >&2; exit 2 ;;
esac
if [ "$TIMEOUT_SECS" -eq 0 ]; then
  echo "run-shell-tests: SHELL_TEST_TIMEOUT must be a positive integer, got '$TIMEOUT_SECS'" >&2
  exit 2
fi

TIMEOUT_BIN=""
# WIRE:PROVEN — manual: timeout branch runs on Linux; gtimeout branch is the macOS fallback (same invocation shape); neither-found branch only warns and runs suites unbounded
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
else
  echo "run-shell-tests: no timeout/gtimeout found; suites run without a per-suite timeout" >&2
fi

SUITES=""
if [ "$#" -gt 0 ]; then
  for f in "$@"; do
    SUITES="${SUITES}${f}
"
  done
else
  for f in scripts/*.test.sh; do
    [ -e "$f" ] || continue
    SUITES="${SUITES}${f}
"
  done
fi

if [ -z "$SUITES" ]; then
  echo "run-shell-tests: no suites found (scripts/*.test.sh)" >&2
  exit 1
fi

# WIRE:PROVEN — manual: GITHUB_ACTIONS=true emits ::group::/::endgroup:: lines, unset prints "=== suite"
GROUPING=false
[ "${GITHUB_ACTIONS:-}" = "true" ] && GROUPING=true

TOTAL=0
FAILED=0
SUMMARY=""

while IFS= read -r suite; do
  [ -n "$suite" ] || continue
  TOTAL=$((TOTAL + 1))
  # WIRE:PROVEN — manual: passing a nonexistent suite path prints FAIL (missing file) and exits 1
  if [ ! -f "$suite" ]; then
    SUMMARY="${SUMMARY}FAIL     ${suite} (missing file)
"
    FAILED=$((FAILED + 1))
    continue
  fi

  if $GROUPING; then echo "::group::${suite}"; else echo "=== ${suite}"; fi
  start=$(date +%s)
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "$TIMEOUT_SECS" bash "$suite"
  else
    bash "$suite"
  fi
  rc=$?
  elapsed=$(( $(date +%s) - start ))
  if $GROUPING; then echo "::endgroup::"; fi

  if [ "$rc" -eq 0 ]; then
    status="PASS"
  # WIRE:PROVEN — manual: SHELL_TEST_TIMEOUT=1 against a `sleep 5` fixture suite yields rc 124 -> TIMEOUT
  elif [ "$rc" -eq 124 ] && [ -n "$TIMEOUT_BIN" ]; then
    status="TIMEOUT"
    FAILED=$((FAILED + 1))
  else
    status="FAIL"
    FAILED=$((FAILED + 1))
  fi
  [ "$status" = "PASS" ] || echo "${status}: ${suite} (exit ${rc})"
  SUMMARY="${SUMMARY}$(printf '%-8s %s (%ss)' "$status" "$suite" "$elapsed")
"
done <<EOF_SUITES
${SUITES}
EOF_SUITES

echo
echo "=== Shell test summary ==="
printf '%s' "$SUMMARY"
echo "Total: ${TOTAL}  Failed: ${FAILED}"

[ "$FAILED" -eq 0 ] || exit 1
exit 0
