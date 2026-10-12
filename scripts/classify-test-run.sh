#!/usr/bin/env bash
# classify-test-run.sh — classify a finished test-command run as RAN, RAN_NOTHING or FAILED.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: classify-test-run.sh <exit_code> <output_file>
# Prints exactly one word on stdout:
#   FAILED       non-zero exit that is not a "ran nothing" signal (a real failure)
#   RAN_NOTHING  the runner exited without exercising anything: pytest exit 5, "no tests ran/collected" output,
#                every collected test skipped, or a connection/service-unavailable error that caused the skips
#   RAN          anything else (including exit 0 with no recognizable runner output; the caller only classifies test commands)
# Conservative by design: RAN_NOTHING needs positive evidence, and any "N passed" count means something ran.
# The script only reads the exit code and the output file; it never executes their contents.
# Exit: 0 classified | 2 usage error (bad exit code or unreadable file; stdout empty so callers fail closed)
# Bash 3.2 portable (no mapfile, associative arrays, grep -P).
set -uo pipefail

CODE="${1-}"; FILE="${2-}"
case "$CODE" in ''|*[!0-9]*) echo "usage: classify-test-run.sh <exit_code> <output_file>" >&2; exit 2 ;; esac
[ -n "$FILE" ] && [ -r "$FILE" ] && [ -f "$FILE" ] || { echo "classify-test-run.sh: output file unreadable: ${FILE}" >&2; exit 2; }

has() { grep -qiE -e "$1" "$FILE"; }

# pytest exit 5 is "no tests were collected"; it is never a verified run.
if [ "$CODE" -eq 5 ]; then echo RAN_NOTHING; exit 0; fi

# Any other non-zero exit is a real failure; the existing blocking rules apply.
if [ "$CODE" -ne 0 ]; then echo FAILED; exit 0; fi

# Positive evidence that something executed and passed: a "N passed" / "# pass N" / "ok N" count with N >= 1.
PASSED=false
if grep -qE '(^|[^0-9A-Za-z])[1-9][0-9]* passed' "$FILE" || grep -qE '^# pass [1-9][0-9]*' "$FILE" \
   || grep -qE '^Ran [1-9][0-9]* tests?' "$FILE" \
   || grep -qE '^ok [0-9]+' "$FILE"; then
  PASSED=true
fi

# Explicit "nothing ran" output.
if has 'no tests ran' || has 'no tests collected' || has 'collected 0 items' || has '^Ran 0 tests' \
   || has '^# tests 0$' || has 'no test files found' || has 'No tests found'; then
  [ "$PASSED" = "true" ] || { echo RAN_NOTHING; exit 0; }
fi

# Every collected test skipped: a pytest-style summary with a skipped count and no passed count.
if [ "$PASSED" = "false" ] && grep -qE '(^|[^0-9A-Za-z])[1-9][0-9]* skipped' "$FILE" \
   && ! grep -qE '(^|[^0-9A-Za-z])[1-9][0-9]* (failed|error)' "$FILE"; then
  echo RAN_NOTHING; exit 0
fi
# node:test / TAP all-skipped: "# skipped N" with "# pass 0".
if has '^# skipped [1-9]' && has '^# pass 0$'; then echo RAN_NOTHING; exit 0; fi

# Unreachable DB or service that turned tests into skips (or an exit-0 runner that swallowed the error).
if [ "$PASSED" = "false" ] \
   && has 'connection refused|ECONNREFUSED|could not connect to server|service unavailable|database (is )?(unavailable|not available)|connection to .* failed' \
   && has 'skip'; then
  echo RAN_NOTHING; exit 0
fi

echo RAN
