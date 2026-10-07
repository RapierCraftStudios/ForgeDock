#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# wait-ci-green.sh — CI gate every autonomous merge must pass first.
#
# Usage: wait-ci-green.sh <pr-number> -R <owner/repo> [--timeout SECONDS] [--interval SECONDS]
#
# Waits until every check on the PR has finished, then decides. Fails closed: a merge may
# proceed ONLY on exit 0. Field test: pipeline agents merged PRs to staging while checks were
# pending or red (#3165 merged with the side-effect gate failing), because neither the specs nor
# branch protection required green CI, and `gh pr merge --auto` only waits for *required* checks.
#
# Exit codes (one "CI_GATE: <RESULT>" line on stdout, details after it):
#   0  PASS     every check is pass/skipping (or the repo reports no checks after the grace period
#               and FORGE_CI_REQUIRE_CHECKS is not 1)
#   1  FAIL     at least one check failed or was cancelled (listed)
#   2  ERROR    bad usage, gh unreadable for too long, the PR head moved during the wait, or
#               FORGE_CI_REQUIRE_CHECKS=1 and no checks were reported
#   3  TIMEOUT  checks still pending when the timeout expired (listed)
#
# Every result also prints "CI_GATE_HEAD: <sha>" — the exact PR head the decision applies to. Callers
# MUST merge with `--match-head-commit <that sha>` so a push after the gate cannot land unchecked.
#
# Env: FORGE_CI_TIMEOUT (default 540 — stays under the 10-minute Bash tool limit; on TIMEOUT the
#      caller re-runs the gate, it does not raise the timeout), FORGE_CI_INTERVAL (default 20),
#      FORGE_CI_NO_CHECKS_GRACE (default 120), FORGE_CI_SETTLE (default 45 — never PASS earlier than
#      this after the wait starts, so workflows that register late are not missed),
#      FORGE_CI_REQUIRE_CHECKS (default 0).
# "No checks" passes only when GitHub Actions also reports no workflow runs for the head commit;
# if runs exist but their checks have not appeared yet, the gate keeps waiting.
set -uo pipefail

PR=""; REPO=""
TIMEOUT="${FORGE_CI_TIMEOUT:-540}"; INTERVAL="${FORGE_CI_INTERVAL:-20}"; SETTLE="${FORGE_CI_SETTLE:-45}"
GRACE="${FORGE_CI_NO_CHECKS_GRACE:-120}"; REQUIRE="${FORGE_CI_REQUIRE_CHECKS:-0}"
usage() { echo "CI_GATE: ERROR"; echo "CI_GATE_HEAD: unknown"; echo "usage: wait-ci-green.sh <pr> -R <owner/repo> [--timeout S] [--interval S]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    -R) [ $# -ge 2 ] || usage; REPO="$2"; shift 2 ;;
    -R*) REPO="${1#-R}"; REPO="${REPO# }"; shift ;;
    --timeout) [ $# -ge 2 ] || usage; TIMEOUT="$2"; shift 2 ;;
    --interval) [ $# -ge 2 ] || usage; INTERVAL="$2"; shift 2 ;;
    -h|--help) sed -n '5,25p' "$0"; exit 0 ;;
    *) [ -z "$PR" ] || usage; PR="$1"; shift ;;
  esac
done
case "$PR" in ''|*[!0-9]*) usage ;; esac
case "$REPO" in */*) ;; *) usage ;; esac
for v in "$TIMEOUT" "$INTERVAL" "$GRACE" "$SETTLE"; do case "$v" in ''|*[!0-9]*) usage ;; esac; done
[ "$INTERVAL" -ge 1 ] || INTERVAL=1

emit() { echo "CI_GATE: $1"; echo "CI_GATE_HEAD: ${START_SHA:-unknown}"; }
head_sha() { gh pr view "$PR" -R "$REPO" --json headRefOid --jq '.headRefOid' 2>/dev/null; }
START_SHA="$(head_sha)"
if [ -z "$START_SHA" ]; then START_SHA=""; emit ERROR; echo "cannot read PR #$PR head in $REPO"; exit 2; fi

start=$(date +%s); errors=0
while :; do
  now=$(date +%s); elapsed=$((now - start))
  if ! JSON="$(gh pr checks "$PR" -R "$REPO" --json name,bucket 2>/dev/null)" || ! printf '%s' "$JSON" | jq -e 'type=="array"' >/dev/null 2>&1; then
    # gh pr checks exits non-zero both on outage and on "no checks reported"; tell them apart by output.
    if printf '%s' "${JSON:-}" | jq -e 'type=="array"' >/dev/null 2>&1; then :; else
      # Capture first: under pipefail, `gh ... | grep -q` fails whenever gh exits 1, which it
      # does precisely in the "no checks reported" case this branch exists to detect.
      NC_OUT="$(gh pr checks "$PR" -R "$REPO" 2>&1 || true)"
      if printf '%s' "$NC_OUT" | grep -qi 'no checks reported'; then JSON='[]'
      else
        errors=$((errors + 1))
        if [ "$errors" -ge 5 ]; then emit ERROR; echo "gh pr checks unreadable 5 times in a row"; exit 2; fi
        sleep "$INTERVAL"; continue
      fi
    fi
  fi
  errors=0
  cur="$(head_sha)"
  if [ -n "$cur" ] && [ "$cur" != "$START_SHA" ]; then emit ERROR; echo "PR head moved during the wait ($START_SHA -> $cur); re-review the new head"; exit 2; fi
  total=$(printf '%s' "$JSON" | jq 'length')
  failed=$(printf '%s' "$JSON" | jq -r '.[] | select(.bucket=="fail" or .bucket=="cancel") | "  - \(.name) (\(.bucket))"')
  pending=$(printf '%s' "$JSON" | jq -r '.[] | select(.bucket!="pass" and .bucket!="skipping" and .bucket!="fail" and .bucket!="cancel") | "  - \(.name) (\(.bucket))"')
  if [ -n "$failed" ]; then emit FAIL; echo "PR #$PR head ${START_SHA:0:7}: failing checks:"; echo "$failed"; exit 1; fi
  if [ "$total" -eq 0 ]; then
    if [ "$elapsed" -ge "$GRACE" ]; then
      RUNS=$(gh api "repos/$REPO/actions/runs?head_sha=$START_SHA&per_page=1" --jq '.total_count' 2>/dev/null || echo "")
      if [ -n "$RUNS" ] && [ "$RUNS" != "0" ]; then
        :  # workflow runs exist for this head but no checks are reported yet — keep waiting
      elif [ "$REQUIRE" = "1" ]; then
        emit ERROR; echo "no checks reported after ${GRACE}s and FORGE_CI_REQUIRE_CHECKS=1"; exit 2
      else
        emit PASS; echo "no checks reported for PR #$PR after ${GRACE}s and no workflow runs for its head (no CI on this branch)"; exit 0
      fi
    fi
  elif [ -z "$pending" ] && [ "$elapsed" -ge "$SETTLE" ]; then
    emit PASS; echo "PR #$PR head ${START_SHA:0:7}: $total checks passed or skipped"; exit 0
  fi
  if [ "$elapsed" -ge "$TIMEOUT" ]; then emit TIMEOUT; echo "PR #$PR: still pending after ${TIMEOUT}s:"; echo "$pending"; exit 3; fi
  sleep "$INTERVAL"
done
