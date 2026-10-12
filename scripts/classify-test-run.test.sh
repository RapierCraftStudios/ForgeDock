#!/usr/bin/env bash
# classify-test-run.test.sh — tests for scripts/classify-test-run.sh
# One case per class plus a positive control (normal pass) and a real failure. No network.
# Usage: bash scripts/classify-test-run.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLS="$SCRIPT_DIR/classify-test-run.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
PASS=0; FAILN=0
check() { # name expected exit_code output
  local name="$1" want="$2" code="$3" out="$4" got
  printf '%s\n' "$out" > "$TMP/out.txt"
  got=$(bash "$CLS" "$code" "$TMP/out.txt" 2>/dev/null)
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "ok   - $name"; else FAILN=$((FAILN+1)); echo "FAIL - $name: want $want got '$got'"; fi
}

check "positive control: normal pass is RAN" RAN 0 "collected 12 items
============ 12 passed in 0.31s ============"
check "pytest passed with some skipped is RAN" RAN 0 "=== 10 passed, 2 skipped in 1.2s ==="
check "pytest exit 5 is RAN_NOTHING" RAN_NOTHING 5 "collected 0 items
no tests ran in 0.01s"
check "exit 0 with 'no tests ran' is RAN_NOTHING" RAN_NOTHING 0 "============ no tests ran in 0.02s ============"
check "collected 0 items is RAN_NOTHING" RAN_NOTHING 0 "collected 0 items"
check "all tests skipped is RAN_NOTHING" RAN_NOTHING 0 "collected 8 items
=========== 8 skipped in 0.12s ==========="
check "connection refused causing skips is RAN_NOTHING" RAN_NOTHING 0 "SKIPPED [3] tests/test_db.py: could not connect to server: Connection refused
=========== 3 skipped in 0.5s ==========="
check "connection refused without a skip summary but with skip text is RAN_NOTHING" RAN_NOTHING 0 "ECONNREFUSED 127.0.0.1:5432 - skipping DB tests"
check "real failure is FAILED" FAILED 1 "=========== 1 failed, 4 passed in 0.9s ==========="
check "failure that mentions connection refused is still FAILED" FAILED 1 "ConnectionRefusedError: connection refused
1 failed in 0.2s"
check "exit 0 with no runner output is RAN" RAN 0 "done"
check "node:test TAP all skipped is RAN_NOTHING" RAN_NOTHING 0 "# tests 3
# pass 0
# skipped 3"
check "node:test TAP pass is RAN" RAN 0 "# tests 3
# pass 3
# skipped 0"

: > "$TMP/empty.txt"
[ "$(bash "$CLS" 0 "$TMP/empty.txt" 2>/dev/null)" = "RAN" ] && { PASS=$((PASS+1)); echo "ok   - empty output exit 0 is RAN"; } || { FAILN=$((FAILN+1)); echo "FAIL - empty output exit 0"; }
bash "$CLS" abc "$TMP/empty.txt" >/dev/null 2>&1; [ $? -eq 2 ] && { PASS=$((PASS+1)); echo "ok   - bad exit code is a usage error"; } || { FAILN=$((FAILN+1)); echo "FAIL - bad exit code"; }
bash "$CLS" 0 "$TMP/nope.txt" >/dev/null 2>&1; [ $? -eq 2 ] && { PASS=$((PASS+1)); echo "ok   - missing file is a usage error"; } || { FAILN=$((FAILN+1)); echo "FAIL - missing file"; }

echo "$PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
