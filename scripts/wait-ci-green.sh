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
#   4  RATE_LIMITED  the window ended while GitHub only answered with rate-limit (403/429,
#               x-ratelimit-remaining: 0, secondary-limit text) or transient 5xx/network errors. Retryable,
#               never a CI verdict: callers treat it like TIMEOUT (wait and re-run), and it is never a merge.
#
# Every result also prints "CI_GATE_HEAD: <sha>" — the exact PR head the decision applies to. Callers
# MUST merge with `--match-head-commit <that sha>` so a push after the gate cannot land unchecked.
#
# Env: FORGE_CI_TIMEOUT (default 540 — stays under the 10-minute Bash tool limit; on TIMEOUT the
#      caller re-runs the gate, it does not raise the timeout), FORGE_CI_INTERVAL (default 20),
#      FORGE_CI_NO_CHECKS_GRACE (default 120), FORGE_CI_SETTLE (default 45 — never PASS earlier than
#      this after the wait starts, so workflows that register late are not missed),
#      FORGE_CI_REQUIRE_CHECKS (default 0), FORGE_CI_JITTER_PCT (default 20 — each sleep varies by +/- this
#      percent so many waiting lanes do not poll in lockstep).
# Rate-limit and transient gh failures are retried with a growing, jittered sleep and never count toward
# the 5-error ERROR limit.
# "No checks" passes only when GitHub Actions also reports no workflow runs for the head commit;
# if runs exist but their checks have not appeared yet, the gate keeps waiting.
set -uo pipefail
# Telemetry (forge#3834): best-effort decision record; never changes stdout, stderr or the exit code.
_TEL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/telemetry.sh"; [ -f "$_TEL" ] && . "$_TEL" 2>/dev/null
type forge_emit >/dev/null 2>&1 || forge_emit() { :; }

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
    -h|--help) sed -n '5,32p' "$0"; exit 0 ;;
    *) [ -z "$PR" ] || usage; PR="$1"; shift ;;
  esac
done
case "$PR" in ''|*[!0-9]*) usage ;; esac
case "$REPO" in */*) ;; *) usage ;; esac
for v in "$TIMEOUT" "$INTERVAL" "$GRACE" "$SETTLE"; do case "$v" in ''|*[!0-9]*) usage ;; esac; done
[ "$INTERVAL" -ge 1 ] || INTERVAL=1
JITTER_PCT="${FORGE_CI_JITTER_PCT:-20}"; case "$JITTER_PCT" in ''|*[!0-9]*) JITTER_PCT=20 ;; esac
[ "$JITTER_PCT" -le 90 ] || JITTER_PCT=90
# jitter <seconds> -> seconds varied by +/- JITTER_PCT percent (never below 1).
jitter() { awk -v s="$1" -v p="$JITTER_PCT" -v r="$RANDOM" 'BEGIN{ v=s*(1-p/100+2*(p/100)*(r/32767)); if (v<1) v=1; printf "%.2f", v }'; }

# classify_gh <text> -> prints one class, or nothing when the text is unrecognised:
#   limited    real rate-limit evidence (x-ratelimit-remaining: 0, HTTP 429, "API rate limit exceeded", secondary rate limit,
#              abuse detection, too many requests): a wait, bounded by the whole window
#   auth       a bare 401/403 (bad credentials, missing scope): permanent, never waited on
#   transient  5xx / gateway / network failures: a small bounded retry (FORGE_CI_TRANSIENT_RETRIES), never the long wait
classify_gh() {
  if printf '%s' "$1" | grep -Eqi 'api rate limit exceeded|secondary (rate )?limit|abuse detection|x-ratelimit-remaining: *0|HTTP 429|status 429|too many requests'; then echo limited
  elif printf '%s' "$1" | grep -Eqi 'HTTP (401|403)|status (401|403)|bad credentials|requires authentication'; then echo auth
  elif printf '%s' "$1" | grep -Eqi 'HTTP 5[0-9][0-9]|status 5[0-9][0-9]|bad gateway|service unavailable|gateway time-?out|timed? ?out|i/o timeout|connection (reset|refused)|could not resolve host|unexpected EOF|network is unreachable|TLS handshake'; then echo transient
  fi
}

emit() {
  case "$1" in PASS) _rc=0 ;; FAIL) _rc=1 ;; TIMEOUT) _rc=3 ;; RATE_LIMITED) _rc=4 ;; *) _rc=2 ;; esac
  FORGE_REPO="${FORGE_REPO:-$REPO}" FORGE_PR="${FORGE_PR:-$PR}" forge_emit ci_gate result="$1" rc="$_rc" checks="${total:-0}"
  echo "CI_GATE: $1"; echo "CI_GATE_HEAD: ${START_SHA:-unknown}"
}
head_sha() { gh pr view "$PR" -R "$REPO" --json headRefOid --jq '.headRefOid' 2>/dev/null; }
# forge#4037: the initial head read goes through the same classification as the checks poll: a rate limit is a wait
# (rc 4 once the window is spent), a bare 401/403 is a fast permanent error, anything else a small bounded retry.
START_SHA=""; _hstart=$(date +%s); _hlim=0; _hfail=0; _herr="$(mktemp)"; trap 'rm -f "$_herr"' EXIT
while :; do
  START_SHA="$(gh pr view "$PR" -R "$REPO" --json headRefOid --jq '.headRefOid' 2>"$_herr")" && [ -n "$START_SHA" ] && break
  START_SHA=""; _hc="$(classify_gh "$(cat "$_herr" 2>/dev/null)")"
  case "$_hc" in
    auth) emit ERROR; echo "cannot read PR #$PR head in $REPO (HTTP 401/403 without rate-limit evidence)"; exit 2 ;;
    limited)
      _hlim=$((_hlim + 1))
      if [ $(( $(date +%s) - _hstart )) -ge "$TIMEOUT" ]; then emit RATE_LIMITED; echo "PR #$PR: GitHub rate-limited for the whole ${TIMEOUT}s window reading the PR head; retry later"; exit 4; fi
      _m=$((_hlim > 4 ? 4 : _hlim)); sleep "$(jitter $((INTERVAL * (1 << (_m - 1)))))" ;;
    *)
      _hfail=$((_hfail + 1))
      if [ "$_hfail" -gt 2 ]; then emit ERROR; echo "cannot read PR #$PR head in $REPO"; exit 2; fi
      sleep "$(jitter "$INTERVAL")" ;;
  esac
done

start=$(date +%s); errors=0; limited=0; transient=0
TRANSIENT_MAX="${FORGE_CI_TRANSIENT_RETRIES:-4}"; case "$TRANSIENT_MAX" in ''|*[!0-9]*) TRANSIENT_MAX=4 ;; esac
while :; do
  now=$(date +%s); elapsed=$((now - start))
  if ! JSON="$(gh pr checks "$PR" -R "$REPO" --json name,bucket 2>/dev/null)" || ! printf '%s' "$JSON" | jq -e 'type=="array"' >/dev/null 2>&1; then
    # gh pr checks exits non-zero both on outage and on "no checks reported"; tell them apart by output.
    if printf '%s' "${JSON:-}" | jq -e 'type=="array"' >/dev/null 2>&1; then :; else
      # Capture first: under pipefail, `gh ... | grep -q` fails whenever gh exits 1, which it
      # does precisely in the "no checks reported" case this branch exists to detect.
      NC_OUT="$(gh pr checks "$PR" -R "$REPO" 2>&1 || true)"
      if printf '%s' "$NC_OUT" | grep -qi 'no checks reported'; then JSON='[]'
      elif GH_CLASS="$(classify_gh "$NC_OUT")"; [ "$GH_CLASS" = auth ]; then
        # A bare 401/403 is an auth fault that never clears: fail fast instead of waiting out the window (forge#4037).
        emit ERROR; echo "gh pr checks refused (HTTP 401/403 without rate-limit evidence); fix the token or its scopes"; exit 2
      elif [ "$GH_CLASS" = transient ]; then
        # Network timeout / 5xx: a small bounded retry, never the long rate-limit wait.
        transient=$((transient + 1))
        if [ "$transient" -gt "$TRANSIENT_MAX" ]; then emit ERROR; echo "gh pr checks unavailable (transient error) ${transient} times in a row"; exit 2; fi
        sleep "$(jitter "$INTERVAL")"; continue
      elif [ "$GH_CLASS" = limited ]; then
        # Real rate limit: a wait, not a verdict. Retry with a growing jittered sleep; never counts toward ERROR.
        limited=$((limited + 1)); now=$(date +%s)
        if [ $((now - start)) -ge "$TIMEOUT" ]; then emit RATE_LIMITED; echo "PR #$PR: GitHub rate-limited for the whole ${TIMEOUT}s window (${limited} retries); retry later"; exit 4; fi
        _m=$((limited > 4 ? 4 : limited)); sleep "$(jitter $((INTERVAL * (1 << (_m - 1)))))"; continue
      else
        errors=$((errors + 1))
        if [ "$errors" -ge 5 ]; then emit ERROR; echo "gh pr checks unreadable 5 times in a row"; exit 2; fi
        sleep "$(jitter "$INTERVAL")"; continue
      fi
    fi
  fi
  errors=0; limited=0; transient=0
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
  sleep "$(jitter "$INTERVAL")"
done
