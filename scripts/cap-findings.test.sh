#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fixtures for scripts/cap-findings.sh (review-pr §6B.5 / review-pr-staging §7B per-review cap).
# Run: bash scripts/cap-findings.test.sh   (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
S="$DIR/cap-findings.sh"
pass=0; fail=0
T=$(printf '\t')

# rows <id:sev:conf:disp[:agent]>...  -> TSV on stdout (disp may use ~ for space)
rows() {
  local spec id sev conf disp agent
  for spec in "$@"; do
    IFS=: read -r id sev conf disp agent <<EOF2
$spec
EOF2
    disp=$(printf '%s' "$disp" | tr '~' ' ')
    printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$sev" "$conf" "$disp" "$agent"
  done
}

# expect <description> <expected "id=CLASS ..."> <script args> -- <row specs>
# Compares the first word of each output row's disposition, in input order, plus the CAPPED trailer.
expect() {
  local desc="$1" want="$2"; shift 2
  local args=()
  while [ "$1" != "--" ]; do args+=("$1"); shift; done
  shift
  local got
  got=$(rows "$@" | bash "$S" ${args[@]+"${args[@]}"} 2>/dev/null | awk -F'\t' 'NF >= 2 { split($2, w, " "); printf "%s=%s%s ", $1, w[1], (w[2] == "capped" ? "(capped)" : "") } /^CAPPED=/ { printf "%s", $0 }')
  if [ "$got" = "$want" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $desc"; echo "  want: $want"; echo "  got:  $got"; fi
}
expect_exit() { # expect_exit <code> <description> -- args...
  local want="$1" desc="$2"; shift 3
  bash "$S" "$@" </dev/null >/dev/null 2>&1; local got=$?
  if [ "$got" = "$want" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $desc (want exit $want, got $got)"; fi
}

# --- Default cap is 2; ranking by severity, then confidence ---
expect "under the cap: nothing capped" "a=ISSUE b=ISSUE CAPPED=0" -- \
  a:MEDIUM:LIKELY:ISSUE~x b:MEDIUM:CONFIRMED:ISSUE~x
expect "overflow becomes NOTE capped, lowest rank loses" "a=NOTE(capped) b=ISSUE c=ISSUE CAPPED=1" -- \
  a:MEDIUM:POSSIBLE:ISSUE~x b:MEDIUM:CONFIRMED:ISSUE~x c:MEDIUM:LIKELY:ISSUE~x
expect "ranks by confidence CONFIRMED > LIKELY > POSSIBLE" "a=NOTE(capped) b=ISSUE c=ISSUE d=NOTE(capped) CAPPED=2" -- \
  a:MEDIUM:POSSIBLE:ISSUE~x b:MEDIUM:CONFIRMED:ISSUE~x c:MEDIUM:LIKELY:ISSUE~x d:MEDIUM:POSSIBLE:ISSUE~x
expect "MEDIUM outranks LOW even at lower confidence" "a=NOTE(capped) b=ISSUE c=ISSUE CAPPED=1" -- \
  a:LOW:CONFIRMED:ISSUE~x b:MEDIUM:POSSIBLE:ISSUE~x c:MEDIUM:LIKELY:ISSUE~x
expect "ties broken by safety-domain agent" "a=NOTE(capped) b=NOTE(capped) c=ISSUE d=ISSUE CAPPED=2" -- \
  a:MEDIUM:LIKELY:ISSUE~x:General b:MEDIUM:LIKELY:ISSUE~x:General c:MEDIUM:LIKELY:ISSUE~x:Auth d:MEDIUM:LIKELY:ISSUE~x:Concurrency_reviewer
expect "remaining ties broken by input order (stable)" "a=ISSUE b=ISSUE c=NOTE(capped) CAPPED=1" -- \
  a:MEDIUM:LIKELY:ISSUE~x b:MEDIUM:LIKELY:ISSUE~x c:MEDIUM:LIKELY:ISSUE~x

# --- HIGH/CRITICAL are never capped and do not consume the default budget ---
expect "HIGH and CRITICAL never capped past the cap" "a=ISSUE b=ISSUE c=ISSUE d=ISSUE e=ISSUE CAPPED=0" -- \
  a:HIGH:POSSIBLE:ISSUE~x b:CRITICAL:LIKELY:ISSUE~x c:HIGH:CONFIRMED:ISSUE~x d:MEDIUM:CONFIRMED:ISSUE~x e:MEDIUM:LIKELY:ISSUE~x
expect "HIGH does not consume the default budget" "a=ISSUE b=ISSUE c=ISSUE d=NOTE(capped) CAPPED=1" -- \
  a:HIGH:LIKELY:ISSUE~x b:MEDIUM:CONFIRMED:ISSUE~x c:MEDIUM:LIKELY:ISSUE~x d:MEDIUM:POSSIBLE:ISSUE~x
expect "lowercase high is never capped" "a=ISSUE b=NOTE(capped) CAPPED=1" --cap 0 -- \
  a:high:POSSIBLE:ISSUE~x b:medium:LIKELY:ISSUE~x

# --- Unparseable severity/confidence ranks as MEDIUM/LIKELY and IS capped ---
expect "unparseable severity is capped like MEDIUM" "a=NOTE(capped) b=ISSUE c=ISSUE CAPPED=1" -- \
  a:INFO:POSSIBLE:ISSUE~x b:MEDIUM:CONFIRMED:ISSUE~x c:MEDIUM:LIKELY:ISSUE~x
expect "missing severity and confidence rank MEDIUM/LIKELY (above POSSIBLE, below CONFIRMED)" "a=ISSUE b=NOTE(capped) c=ISSUE CAPPED=1" -- \
  a:MEDIUM:CONFIRMED:ISSUE~x b:MEDIUM:POSSIBLE:ISSUE~x c::ISSUE~x
expect "unparseable severity cannot displace a ranked MEDIUM CONFIRMED when cap is 1" "a=NOTE(capped) b=ISSUE CAPPED=1" --cap 1 -- \
  a::ISSUE~x b:MEDIUM:CONFIRMED:ISSUE~x

# --- Lineage review-finding: default 1, filed HIGH+ consumes the budget ---
expect "lineage default 1 keeps only the best" "a=NOTE(capped) b=ISSUE c=NOTE(capped) CAPPED=2" --lineage review-finding -- \
  a:MEDIUM:LIKELY:ISSUE~x b:MEDIUM:CONFIRMED:ISSUE~x c:MEDIUM:LIKELY:ISSUE~x
expect "lineage: a filed HIGH consumes the budget, all MEDIUM capped" "a=ISSUE b=NOTE(capped) c=NOTE(capped) CAPPED=2" --lineage review-finding -- \
  a:HIGH:LIKELY:ISSUE~x b:MEDIUM:CONFIRMED:ISSUE~x c:MEDIUM:LIKELY:ISSUE~x
expect "lineage: CRITICAL still never capped" "a=ISSUE b=ISSUE CAPPED=0" --lineage review-finding -- \
  a:CRITICAL:CONFIRMED:ISSUE~x b:HIGH:CONFIRMED:ISSUE~x
expect "lineage: explicit cap 3 with one HIGH keeps two MEDIUM" "a=ISSUE b=ISSUE c=ISSUE d=NOTE(capped) CAPPED=1" --lineage review-finding --cap 3 -- \
  a:HIGH:LIKELY:ISSUE~x b:MEDIUM:CONFIRMED:ISSUE~x c:MEDIUM:LIKELY:ISSUE~x d:MEDIUM:POSSIBLE:ISSUE~x

# --- Explicit cap, 0, invalid cap ---
expect "explicit cap 3 overrides default 2" "a=ISSUE b=ISSUE c=ISSUE CAPPED=0" --cap 3 -- \
  a:MEDIUM:LIKELY:ISSUE~x b:MEDIUM:LIKELY:ISSUE~x c:MEDIUM:LIKELY:ISSUE~x
expect "cap 0 caps every cappable row, never HIGH" "a=NOTE(capped) b=ISSUE c=NOTE(capped) CAPPED=2" --cap 0 -- \
  a:MEDIUM:CONFIRMED:ISSUE~x b:HIGH:LIKELY:ISSUE~x c:LOW:CONFIRMED:ISSUE~x
expect "invalid cap falls back to default 2" "a=ISSUE b=ISSUE c=NOTE(capped) CAPPED=1" --cap abc -- \
  a:MEDIUM:CONFIRMED:ISSUE~x b:MEDIUM:LIKELY:ISSUE~x c:MEDIUM:POSSIBLE:ISSUE~x
expect "negative cap falls back to default 2" "a=ISSUE b=ISSUE c=NOTE(capped) CAPPED=1" --cap -1 -- \
  a:MEDIUM:CONFIRMED:ISSUE~x b:MEDIUM:LIKELY:ISSUE~x c:MEDIUM:POSSIBLE:ISSUE~x
expect "invalid cap under lineage falls back to 1" "a=ISSUE b=NOTE(capped) CAPPED=1" --lineage review-finding --cap x -- \
  a:MEDIUM:CONFIRMED:ISSUE~x b:MEDIUM:LIKELY:ISSUE~x

# --- Pass-through rows never consume the cap ---
expect "NOTE and INPR_FIX rows pass through" "a=NOTE b=INPR_FIX c=ISSUE d=ISSUE e=NOTE(capped) CAPPED=1" -- \
  a:MEDIUM:LIKELY:NOTE~reflag-note b:MEDIUM:CONFIRMED:INPR_FIX~in-pr c:MEDIUM:CONFIRMED:ISSUE~x d:MEDIUM:LIKELY:ISSUE~x e:MEDIUM:POSSIBLE:ISSUE~x
expect "empty input prints only the trailer" "CAPPED=0" --

# --- Reason text and original rows survive ---
out=$(rows "a:MEDIUM:CONFIRMED:ISSUE~medium~confirmed" | bash "$S" 2>/dev/null | head -n 1)
if [ "$out" = "a${T}ISSUE medium confirmed" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: kept row keeps its classifier reason (got '$out')"; fi
out=$(rows "a:MEDIUM:CONFIRMED:NOTE~stale" | bash "$S" 2>/dev/null | head -n 1)
if [ "$out" = "a${T}NOTE stale" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: NOTE row passes through verbatim (got '$out')"; fi

# --- Severity text noise never demotes HIGH/CRITICAL (classifier strips whitespace and uppercases) ---
expect "whitespace/markdown HIGH still uncapped at cap 0" "a=ISSUE b=ISSUE c=ISSUE d=NOTE(capped) CAPPED=1" --cap 0 -- \
  "a:HIGH :CONFIRMED:ISSUE~severity-HIGH" 'b:**HIGH**:CONFIRMED:ISSUE~severity-HIGH' c:High:LIKELY:ISSUE~severity-HIGH d:MEDIUM:LIKELY:ISSUE~x
expect "fix-efficacy ISSUE rows are never capped (#3857 exemption survives the cap)" "a=ISSUE b=ISSUE c=NOTE(capped) CAPPED=1" --cap 1 -- \
  a:MEDIUM:LIKELY:ISSUE~fix-efficacy-fails b:MEDIUM:CONFIRMED:ISSUE~x c:MEDIUM:LIKELY:ISSUE~x
expect "lineage: fix-efficacy beats an unrelated CONFIRMED MEDIUM and consumes the budget" "a=NOTE(capped) b=ISSUE CAPPED=1" --lineage review-finding -- \
  a:MEDIUM:CONFIRMED:ISSUE~lineage-medium-CONFIRMED b:MEDIUM:LIKELY:ISSUE~fix-efficacy-regresses
expect "classifier severity-HIGH/CRITICAL reason is never capped" "a=ISSUE b=ISSUE CAPPED=0" --cap 0 -- \
  "a:weird:CONFIRMED:ISSUE~severity-HIGH" "b:weird:CONFIRMED:ISSUE~severity-CRITICAL"
expect "lineage budget counts noisy HIGH" "a=ISSUE b=NOTE(capped) CAPPED=1" --cap 1 --lineage review-finding -- \
  "a:HIGH :CONFIRMED:ISSUE~severity-HIGH" b:MEDIUM:CONFIRMED:ISSUE~x

# --- --input file and usage errors ---
tmp=$(mktemp)
rows a:MEDIUM:LIKELY:ISSUE~x b:MEDIUM:LIKELY:ISSUE~x c:MEDIUM:LIKELY:ISSUE~x > "$tmp"
got=$(bash "$S" --input "$tmp" 2>/dev/null | tail -n 1)
rm -f "$tmp"
if [ "$got" = "CAPPED=1" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: --input file (got '$got')"; fi
expect_exit 2 "unknown arg is a usage error"  -- --bogus
expect_exit 2 "bad lineage is a usage error"  -- --lineage sideways
expect_exit 2 "missing --input file is a usage error" -- --input /nonexistent/cap-findings-rows
expect_exit 0 "empty stdin exits 0"           -- 

echo "cap-findings.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
