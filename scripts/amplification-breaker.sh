#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# amplification-breaker.sh — Deterministic review-finding cascade breaker for /orchestrate.
#
# Measures, from GitHub state alone, how many `review-finding` issues a batch has
# spawned per merged unit, and reports whether the forge#3060 amplification breaker
# is tripped. It exists so the breaker runs on EVERY dispatch path — the engine CLI,
# the Agent-spawn fallback and a hand-driven orchestrator alike. The 2026-10-08
# audit found a batch that ran on the fallback path never evaluated the in-spec
# breaker and reached ~2 findings per merge.
#
# Usage:
#   amplification-breaker.sh --since <ISO8601> [-R owner/repo] [--threshold <ratio>] [--min-units <n>]
#
#   --since      Batch start (BATCH_T0), e.g. 2026-10-07T17:46:58Z. Required.
#   -R           Repository (default: current gh repo).
#   --threshold  Trip when findings/merged >= this ratio (default 1.0).
#   --min-units  Do not trip before this many merged units (default 3) so the
#                first merge of a batch cannot trip it on noise.
#
# Test hook: AMP_FINDINGS and AMP_MERGED, when both set, replace the GitHub queries.
#
# Output (stdout, one line):
#   AMPLIFICATION: findings=<n> merged=<m> ratio=<r> threshold=<t> tripped=<yes|no>
#
# Exit codes:
#   0  clear      — P3 findings may be admitted
#   3  tripped    — defer P3-and-below findings to bounded batches (P1/P2 unaffected)
#   2  usage error
#   4  counts unreadable — fail closed: treat as tripped for P3 admission
#
# Portable: bash 3.2, BSD/GNU awk. Requires gh + jq unless the test hook is used.

set -u

SINCE=""; REPO_FLAG=""; THRESHOLD="1.0"; MIN_UNITS=3

usage() {
  echo "ERROR: Usage: amplification-breaker.sh --since <ISO8601> [-R owner/repo] [--threshold <ratio>] [--min-units <n>]" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --since)     [ "$#" -ge 2 ] || usage; SINCE="$2"; shift 2 ;;
    -R|--repo)   [ "$#" -ge 2 ] || usage; REPO_FLAG="-R $2"; shift 2 ;;
    --threshold) [ "$#" -ge 2 ] || usage; THRESHOLD="$2"; shift 2 ;;
    --min-units) [ "$#" -ge 2 ] || usage; MIN_UNITS="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$SINCE" ] || usage
case "$SINCE" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*) ;; *) echo "ERROR: --since must be ISO8601 (got '$SINCE')" >&2; exit 2 ;; esac
case "$MIN_UNITS" in ''|*[!0-9]*) echo "ERROR: --min-units must be a non-negative integer" >&2; exit 2 ;; esac
case "$THRESHOLD" in ''|*[!0-9.]*|*.*.*) echo "ERROR: --threshold must be a positive number" >&2; exit 2 ;; esac

if [ -n "${AMP_FINDINGS:-}" ] && [ -n "${AMP_MERGED:-}" ]; then
  FINDINGS="$AMP_FINDINGS"; MERGED="$AMP_MERGED"
else
  # shellcheck disable=SC2086 # REPO_FLAG is intentionally word-split into "-R owner/repo"
  FINDINGS=$(gh issue list $REPO_FLAG --state all --label review-finding \
    --search "created:>=${SINCE}" --limit 1000 --json number --jq 'length' 2>/dev/null) || FINDINGS=""
  # shellcheck disable=SC2086
  MERGED=$(gh issue list $REPO_FLAG --state closed --label workflow:merged \
    --search "closed:>=${SINCE}" --limit 1000 --json number --jq 'length' 2>/dev/null) || MERGED=""
fi

case "$FINDINGS" in ''|*[!0-9]*) FINDINGS="" ;; esac
case "$MERGED" in ''|*[!0-9]*) MERGED="" ;; esac
if [ -z "$FINDINGS" ] || [ -z "$MERGED" ]; then
  echo "AMPLIFICATION: findings=? merged=? ratio=? threshold=${THRESHOLD} tripped=unknown"
  echo "WARNING: amplification counts unreadable — fail closed (defer P3 admission)" >&2
  exit 4
fi

RESULT=$(awk -v f="$FINDINGS" -v m="$MERGED" -v t="$THRESHOLD" -v u="$MIN_UNITS" 'BEGIN {
  r = (m > 0) ? f / m : (f > 0 ? f : 0)
  trip = (m >= u && r >= t) ? "yes" : "no"
  printf "%.2f %s\n", r, trip
}')
RATIO=${RESULT% *}
TRIPPED=${RESULT#* }

echo "AMPLIFICATION: findings=${FINDINGS} merged=${MERGED} ratio=${RATIO} threshold=${THRESHOLD} tripped=${TRIPPED}"
[ "$TRIPPED" = "yes" ] && exit 3
exit 0
