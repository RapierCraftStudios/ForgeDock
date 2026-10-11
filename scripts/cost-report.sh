#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# cost-report.sh — pipeline token cost per ForgeDock version and repo (forge#3824).
#
# Reads the engine run logs (<runs-dir>/*.jsonl) and prints a markdown table, one row per
# (version, repo): finished-run count n, mean/median cache-read tokens per issue, mean per
# phase, remediated %, merged %, and cache-read tokens per merged issue.
#
# Rules:
#   - A run counts only when finished: the last RUN_START..end slice of a log has a
#     RUN_TERMINAL after any RUN_REOPEN / RUN_NEXT_CYCLE. A log is counted once.
#   - Runs with no usage events, or with a hydrated (reconstructed) RUN_START, are excluded:
#     they carry no usage and would drag the means down.
#   - Tokens = usage.cache_read_input_tokens summed over PHASE_COMMIT and PHASE_FAILED.
#     Per-phase means divide by n (a run that skipped a phase counts 0), so the phase
#     columns add up to the per-issue mean. "merged" is RUN_TERMINAL.reason == "merged".
#   - Version/repo come from RUN_START. Older logs lack them: repo becomes "unknown", and the
#     version is estimated from the log's mtime against release times (marked with "~").
#   - Groups with n < --min-n (default 10) are flagged low-n.
#
# Usage: bash scripts/cost-report.sh [--runs-dir DIR] [--last N] [--versions a,b] [--min-n N]
#                                    [--release-times FILE]
#   --runs-dir        default $FORGE_RUNS_DIR, else ~/.forge/runs
#   --last N          only the N highest versions (unknown excluded)
#   --versions        comma list of versions (a trailing "~" in the data is ignored)
#   --release-times   file of "<version> <epoch-seconds>" lines; default: git tags v* of this repo
# Exit: 0 report printed (also when there are no finished runs) | 2 bad usage / missing runs dir
# Portable: bash 3.2, jq, POSIX stat/git.

set -u

RUNS_DIR="${FORGE_RUNS_DIR:-$HOME/.forge/runs}"
LAST=""
VERSIONS=""
MIN_N=10
REL_FILE=""

die() { echo "cost-report: $1" >&2; exit 2; }
is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

while [ $# -gt 0 ]; do
  case "$1" in
    --runs-dir) [ $# -ge 2 ] || die "--runs-dir needs a value"; RUNS_DIR="$2"; shift 2 ;;
    --last) [ $# -ge 2 ] || die "--last needs a value"; LAST="$2"; shift 2 ;;
    --versions) [ $# -ge 2 ] || die "--versions needs a value"; VERSIONS="$2"; shift 2 ;;
    --min-n) [ $# -ge 2 ] || die "--min-n needs a value"; MIN_N="$2"; shift 2 ;;
    --release-times) [ $# -ge 2 ] || die "--release-times needs a value"; REL_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -d "$RUNS_DIR" ] || die "runs dir not found: $RUNS_DIR"
command -v jq >/dev/null 2>&1 || die "jq is required"
is_uint "$MIN_N" || die "--min-n must be a non-negative integer"
if [ -n "$LAST" ]; then is_uint "$LAST" || die "--last must be a non-negative integer"; fi
if [ -n "$REL_FILE" ] && [ ! -f "$REL_FILE" ]; then die "release-times file not found: $REL_FILE"; fi

# Release times: "<version> <epoch>" lines, from the file or this repo's v* tags (fail-soft: none).
if [ -n "$REL_FILE" ]; then
  REL_RAW=$(cat "$REL_FILE")
else
  ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  REL_RAW=$(git -C "$ROOT" for-each-ref refs/tags --format='%(refname:short) %(creatordate:unix)' 2>/dev/null \
    | sed -n 's/^v\([0-9][0-9.]*\) /\1 /p')
fi
REL_JSON=$(printf '%s\n' "$REL_RAW" | jq -R -s -c '
  split("\n") | map(split(" ") | select(length == 2 and (.[1] | test("^[0-9]+$"))) | {v: .[0], t: (.[1] | tonumber)})
  | sort_by(.t)')
[ -n "$REL_JSON" ] || REL_JSON='[]'

mtime_of() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

# Pass 1: one summary object per log (empty for logs that cannot be parsed or have no RUN_START).
ROWS=""
for f in "$RUNS_DIR"/*.jsonl; do
  [ -f "$f" ] || continue
  mt=$(mtime_of "$f")
  row=$(jq -c -s --argjson mt "$mt" '
    . as $all
    | ([range(0; length) | select($all[.].event == "RUN_START")] | last) as $s
    | if $s == null then empty else
      $all[$s:] as $ev
      | $ev[0] as $start
      | ([range(0; $ev | length) | select($ev[.].event == "RUN_TERMINAL")] | last) as $t
      | ([range(0; $ev | length) | select($ev[.].event == "RUN_REOPEN" or $ev[.].event == "RUN_NEXT_CYCLE")] | last) as $r
      | [$ev[] | select((.event == "PHASE_COMMIT" or .event == "PHASE_FAILED") and (.usage | type) == "object")] as $u
      | {
          version: ($start.version // null), repo: ($start.repo // null), mt: $mt,
          hydrated: ($start.hydrated == true),
          finished: ($t != null and ($r == null or $t > $r)),
          reason: (if $t == null then null else $ev[$t].reason end),
          usage_events: ($u | length),
          remediated: ([$ev[] | select(.event == "PHASE_COMMIT" and .phase == "remediate")] | length > 0),
          cr: ([$u[] | .usage.cache_read_input_tokens // 0] | add // 0),
          out: ([$u[] | .usage.output_tokens // 0] | add // 0),
          phase: ($u | group_by(.phase) | map({key: (.[0].phase // "other"), value: ([.[] | .usage.cache_read_input_tokens // 0] | add)}) | from_entries)
        }
      end' "$f" 2>/dev/null) || row=""
  [ -n "$row" ] && ROWS="$ROWS$row
"
done

printf '%s' "$ROWS" | jq -s -r \
  --argjson rel "$REL_JSON" --argjson minn "$MIN_N" \
  --arg last "$LAST" --arg versions "$VERSIONS" '
  def vkey: (sub("~$"; "") | split(".") | map(tonumber? // 0));
  def mean: if length == 0 then 0 else add / length end;
  def median: sort | if length == 0 then 0 elif length % 2 == 1 then .[length / 2 | floor] else (.[length / 2 - 1] + .[length / 2]) / 2 end;
  def k: ((. / 1000) | round | tostring) + "k";
  def pct: ((. * 100) | round | tostring) + "%";
  def ver($mt): if .version != null then .version
           else ([$rel[] | select(.t <= $mt)] | last | if . == null then "unknown" else .v + "~" end) end;

  . as $rows
  | ($rows | map(select(.finished | not)) | length) as $unfinished
  | ($rows | map(select(.finished and (.hydrated or .usage_events == 0))) | length) as $nousage
  | [ $rows[] | select(.finished and (.hydrated | not) and .usage_events > 0)
      | . as $r | $r + {ver: ($r | ver($r.mt)), repo: ($r.repo // "unknown")} ] as $runs
  | ($versions | split(",") | map(select(length > 0))) as $vf
  | ($runs | map(.ver | select(. != "unknown")) | unique | sort_by(vkey)) as $vers
  | (if $last == "" then $vers else ($vers | .[(length - ($last | tonumber) | if . < 0 then 0 else . end):]) end) as $keep
  | [ $runs[] | select((.ver | IN($keep[])) or ($last == "" and .ver == "unknown"))
      | select($vf == [] or ((.ver | sub("~$"; "")) | IN($vf[]))) ]
  | group_by([.ver, .repo]) | sort_by(.[0].ver | vkey) as $groups
  | "| Version | Repo | n | Cache-read/issue mean | median | investigate | build | review | remediate | close | Remediated | Merged | Per merged issue | Confidence |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ( $groups[] | . as $g | length as $n
      | ([.[] | select(.reason == "merged")] | length) as $m
      | (map(.cr) | add) as $tot
      | def pm($p): (map(.phase[$p] // 0) | add) / $n;
        "| \($g[0].ver) | \($g[0].repo) | \($n) | \((map(.cr) | mean) | k) | \((map(.cr) | median) | k)"
        + " | \(pm("investigate") | k) | \(pm("build") | k) | \(pm("review") | k) | \(pm("remediate") | k) | \(pm("close") | k)"
        + " | \(([.[] | select(.remediated)] | length) / $n | pct) | \($m / $n | pct)"
        + " | \(if $m == 0 then "n/a" else ($tot / $m | k) end)"
        + " | \(if $n < $minn then "low-n (<\($minn))" else "ok" end) |" ),
    "",
    "Finished runs only; tokens are cache-read per issue. Excluded: \($unfinished) unfinished, \($nousage) without usage data (hydrated or empty). \"~\" = version estimated from log mtime; \"unknown\" = no version available."
  '
