#!/usr/bin/env bash
# cost-report.test.sh — cases for scripts/cost-report.sh (forge#3824).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/cost-report.sh"
FIX="$HERE/fixtures/cost-report"
PASS=0; FAILN=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
has() { # name text needle
  case "$2" in *"$3"*) ok ;; *) bad "$1 (missing: $3)"; printf '%s\n' "$2" | sed 's/^/    /' ;; esac
}
hasnt() { # name text needle
  case "$2" in *"$3"*) bad "$1 (unexpected: $3)" ;; *) ok ;; esac
}

RUNS="$TMP/runs"; mkdir -p "$RUNS"
cp "$FIX"/*.jsonl "$RUNS"/
# Old logs carry no version: their mtime (UTC) is mapped to the release active at that time.
TZ=UTC touch -t 200201010000 "$RUNS/old-log-no-version.jsonl"
printf '1.0.0 1000000000\n2.0.0 1100000000\n' > "$TMP/releases.txt"

OUT=$(bash "$S" --runs-dir "$RUNS" --release-times "$TMP/releases.txt"); rc=$?
[ "$rc" -eq 0 ] && ok || bad "exit 0 on a valid runs dir (rc=$rc)"

# Repo split: o/a (3 finished runs) and o/b (1) are separate rows.
ROW_A=$(printf '%s\n' "$OUT" | grep '^| 2\.0\.0 | o/a |')
ROW_B=$(printf '%s\n' "$OUT" | grep '^| 2\.0\.0 | o/b |')
[ -n "$ROW_A" ] && ok || bad "row for 2.0.0 o/a"
[ -n "$ROW_B" ] && ok || bad "row for 2.0.0 o/b"

# o/a: unfinished (no terminal, reopened) and hydrated runs are excluded, so n=3.
has "o/a n=3 (unfinished and hydrated excluded)" "$ROW_A" "| 2.0.0 | o/a | 3 |"
# totals 330k, 560k, 100k: mean 330k, median 330k
has "o/a mean and median" "$ROW_A" "| 330k | 330k |"
# per-phase means divide by n: investigate 30k/3, build 390k/3, review 500k/3, remediate 40k/3, close 30k/3
has "o/a per-phase means" "$ROW_A" "| 10k | 130k | 167k | 13k | 10k |"
# 1 of 3 remediated, 2 of 3 merged (needs-human is not merged)
has "o/a remediated and merged rates" "$ROW_A" "| 33% | 67% |"
# per merged issue: 990k total over 2 merged runs
has "o/a tokens per merged issue" "$ROW_A" "| 495k |"
has "o/a low-n flag" "$ROW_A" "low-n (<10)"
has "o/b single run per-merged math" "$ROW_B" "| 2.0.0 | o/b | 1 | 1000k | 1000k |"
has "o/b per merged" "$ROW_B" "| 100% | 1000k |"
hasnt "unfinished usage never counted" "$OUT" "9999k"

# Old log: version estimated from mtime (marked ~), repo unknown.
has "old-log fallback" "$OUT" "| 1.0.0~ | unknown | 1 | 70k |"
has "excluded footer" "$OUT" "Excluded: 2 unfinished, 1 without usage data"

# --min-n lowers the flag threshold.
OUT2=$(bash "$S" --runs-dir "$RUNS" --release-times "$TMP/releases.txt" --min-n 3)
has "min-n 3 marks o/a ok" "$(printf '%s\n' "$OUT2" | grep '^| 2\.0\.0 | o/a |')" "| ok |"

# --last / --versions filtering.
OUT3=$(bash "$S" --runs-dir "$RUNS" --release-times "$TMP/releases.txt" --last 1)
hasnt "--last 1 drops the older estimated version" "$OUT3" "1.0.0~"
has "--last 1 keeps the newest" "$OUT3" "| 2.0.0 | o/a |"
OUT4=$(bash "$S" --runs-dir "$RUNS" --release-times "$TMP/releases.txt" --versions 1.0.0)
has "--versions matches an estimated version" "$OUT4" "| 1.0.0~ |"
hasnt "--versions excludes others" "$OUT4" "| 2.0.0 |"

# Fail closed: missing runs dir exits 2; empty dir still reports (header only).
bash "$S" --runs-dir "$TMP/nope" >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "missing runs dir exits 2"
bash "$S" --bogus >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "unknown flag exits 2"
mkdir "$TMP/empty"
OUT5=$(bash "$S" --runs-dir "$TMP/empty" --release-times "$TMP/releases.txt"); rc=$?
[ "$rc" -eq 0 ] && ok || bad "empty runs dir exits 0"
has "empty dir footer" "$OUT5" "Excluded: 0 unfinished"

echo "cost-report.test: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
