#!/usr/bin/env bash
# classify-grep-exit.sh <rc> <stderr> <target> — is a grep exit >= 2 a malformed check, or a real failure?
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Exit 0 + reason on stdout = malformed (a usage/regex error, a check defect, never a verdict on the code).
# Exit 1 = real verdict (exit 1 and exit 2 both fail the check). Never executes the target; it only reads its text.
# Fail closed <!-- Added: forge#3802 -->: malformed only when stderr POSITIVELY names a regex/option usage error.
# A target that suppresses stderr (`2>/dev/null`, `-s`) leaves it empty, so a missing/unreadable/looping operand
# file can never hide as malformed. Unknown or empty stderr is a real failure.
RC="${1:-0}"; ERR="${2:-}"; TARGET="${3:-}"
case "$RC" in ''|*[!0-9]*) exit 1 ;; esac
[ "$RC" -ge 2 ] || exit 1
case "$TARGET" in grep\ *|egrep\ *|fgrep\ *) ;; *) exit 1 ;; esac
if printf '%s' "$ERR" | LC_ALL=C grep -qiE 'Unmatched|Invalid (regular expression|preceding|back reference|range|character class|content of)|unrecognized option|invalid option|option requires an argument|Usage:|trailing backslash|character class syntax|conflicting matchers|error at position|mismatched|invalid escape'; then
  echo "grep usage error (exit $RC)"
  exit 0
fi
exit 1
