#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fixtures for scripts/amplification-breaker.sh. No network: uses the
# AMP_FINDINGS/AMP_MERGED test hook. Run: bash scripts/amplification-breaker.test.sh

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
S="$DIR/amplification-breaker.sh"
T0="2026-10-07T17:46:58Z"
pass=0; fail=0

check() { # check <want_exit> <want_substring> <desc> -- env... -- args...
  want_rc="$1"; want_out="$2"; desc="$3"; shift 4
  envs=""
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs="$envs $1"; shift; done
  [ "$#" -gt 0 ] && shift
  out=$(env $envs bash "$S" "$@" 2>/dev/null); rc=$?
  case "$out" in *"$want_out"*) ok=1 ;; *) ok=0 ;; esac
  if [ "$rc" = "$want_rc" ] && [ "$ok" = 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $desc (rc=$rc out='$out')"; fi
}

check 3 "ratio=2.02 threshold=1.0 tripped=yes" "audited batch (93/46) trips" -- AMP_FINDINGS=93 AMP_MERGED=46 -- --since "$T0"
check 0 "ratio=0.89 threshold=1.0 tripped=no"  "post-fix projection (41/46) clear" -- AMP_FINDINGS=41 AMP_MERGED=46 -- --since "$T0"
check 3 "ratio=1.00"                           "exactly at threshold trips" -- AMP_FINDINGS=5 AMP_MERGED=5 -- --since "$T0"
check 0 "tripped=no"                           "below min-units never trips" -- AMP_FINDINGS=8 AMP_MERGED=2 -- --since "$T0"
check 3 "tripped=yes"                          "min-units 1 trips early" -- AMP_FINDINGS=8 AMP_MERGED=2 -- --since "$T0" --min-units 1
check 0 "ratio=0.00"                           "empty batch clear" -- AMP_FINDINGS=0 AMP_MERGED=0 -- --since "$T0"
check 0 "threshold=1.5 tripped=no"             "custom threshold respected" -- AMP_FINDINGS=6 AMP_MERGED=5 -- --since "$T0" --threshold 1.5
check 4 "tripped=unknown"                      "unreadable counts fail closed" -- AMP_FINDINGS=x AMP_MERGED=3 -- --since "$T0"
check 2 ""                                     "missing --since" -- AMP_FINDINGS=1 AMP_MERGED=1 --
check 2 ""                                     "bad --since" -- AMP_FINDINGS=1 AMP_MERGED=1 -- --since yesterday
check 2 ""                                     "bad --min-units" -- AMP_FINDINGS=1 AMP_MERGED=1 -- --since "$T0" --min-units -1
check 2 ""                                     "bad --threshold" -- AMP_FINDINGS=1 AMP_MERGED=1 -- --since "$T0" --threshold 1.2.3
check 2 ""                                     "unknown flag" -- AMP_FINDINGS=1 AMP_MERGED=1 -- --since "$T0" --bogus

echo "amplification-breaker.test.sh: passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
