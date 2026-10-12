#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# ci-local.sh - run the repo's own pull-request checks locally, before review, without spending CI minutes.
#
# Usage:
#   ci-local.sh plan --repo <worktree> --base <ref> [--base-branch B] [--head-branch B] [--files "a b" | --files-from FILE]
#                    [--out FILE] [--json] [--no-cache]
#   ci-local.sh run  --repo <worktree> --base <ref> [same options] [--budget-minutes N] [--max-parallel N]
#                    [--iteration N] [--result-file FILE]
#
# plan  derives the check set from the repo's CI definitions (GitHub Actions, GitLab CI, CircleCI, Azure Pipelines,
#       Bitbucket Pipelines, Buildkite; task runners when no CI gates the change; forge.yaml ci_local.extra_commands),
#       reading definitions from the trusted base ref plus the PR's own edits, and scopes every check to what the
#       change can affect (per-file lint on changed files, test impact selection, fail-safe widening).
# run   executes the plan in the worktree (parallel jobs, machine-wide slot semaphore, timeouts, overall budget,
#       docker-backed services, result cache) and emits `ci_local` telemetry.
#
# Output (stdout): CI_LOCAL_JOB / CI_LOCAL_DEFERRED / CI_LOCAL_CHECK / CI_LOCAL_FAIL lines, then exactly one
#       CI_LOCAL_RESULT: PASS|FAIL|DEGRADED line.
# Exit: 0 every runnable job passed (deferred-to-ci jobs are listed), 1 a runnable job failed,
#       2 degraded (job timeout, exhausted or capped budget, gate could not run) or usage error; never a pass.
#
# This script only reads CI definitions and runs the commands they name on this machine. It never contacts GitHub
# and never starts a remote workflow. Requires: bash, node, git, and mikefarah yq v4 for YAML CI definitions.
# bash 3.2 portable.

set -u

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI="$SCRIPT_DIR/ci-local/cli.mjs"

degraded() { echo "CI_LOCAL_RESULT: DEGRADED reason=$1"; exit 2; }

SUB="${1:-}"
case "$SUB" in
  plan|run) shift ;;
  -h|--help|help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "usage: ci-local.sh plan|run --repo <worktree> --base <ref> [options]" >&2; exit 2 ;;
esac

command -v node >/dev/null 2>&1 || degraded "node not found"
[ -f "$CLI" ] || degraded "ci-local/cli.mjs not found next to ci-local.sh"

# Telemetry reuses the shared emitter (never fails the caller; FORGE_TELEMETRY=off disables it).
type forge_emit >/dev/null 2>&1 || { [ -f "$SCRIPT_DIR/lib/telemetry.sh" ] && . "$SCRIPT_DIR/lib/telemetry.sh"; }
type forge_emit >/dev/null 2>&1 || forge_emit() { :; }

if [ "$SUB" = "plan" ]; then
  node "$CLI" plan "$@"
  exit $?
fi

ITER=0
prev=""
for arg in "$@"; do
  [ "$prev" = "--iteration" ] && ITER="$arg"
  prev="$arg"
done
case "$ITER" in ''|*[!0-9]*) ITER=0 ;; esac

OUT=$(mktemp "${TMPDIR:-/tmp}/ci-local-out.XXXXXX") || degraded "could not create a temp file"
trap 'rm -f "$OUT"' EXIT
node "$CLI" run "$@" | tee "$OUT"
RC=${PIPESTATUS[0]}

RES=$(grep '^CI_LOCAL_RESULT:' "$OUT" | tail -n 1)
if [ -z "$RES" ]; then
  echo "CI_LOCAL_RESULT: DEGRADED reason=runner produced no result line (exit $RC)"
  RC=2
  RES="CI_LOCAL_RESULT: DEGRADED"
fi

field() { printf '%s\n' "$RES" | tr ' ' '\n' | sed -n "s/^$1=//p" | head -n 1; }
STATE=$(printf '%s\n' "$RES" | awk '{print $2}')
JR=$(field jobs_run); JD=$(field jobs_deferred); JF=$(field jobs_failed); DUR=$(field duration_ms)
forge_emit ci_local result="${STATE:-DEGRADED}" jobs_run="${JR:-0}" jobs_deferred="${JD:-0}" jobs_failed="${JF:-0}" \
  duration_ms="${DUR:-0}" fix_iterations="$ITER" checks="$(field checks)" cache_hits="$(field cache_hits)" \
  narrowed="$(field narrowed)" widened="$(field widened)" selected="$(field selected)" total="$(field total)" >/dev/null 2>&1 || true

# One event per scoped/widened/executed check, capped so a large plan never floods the telemetry comment.
EMITTED=0
while IFS= read -r line; do
  [ "$EMITTED" -ge 20 ] && break
  job=$(printf '%s\n' "$line" | sed -n 's/.* job=\([^ ]*\).*/\1/p')
  sel=$(printf '%s\n' "$line" | sed -n 's/.* selector=\([^ ]*\).*/\1/p')
  sc=$(printf '%s\n' "$line" | sed -n 's/.* selected=\([^ ]*\).*/\1/p')
  tt=$(printf '%s\n' "$line" | sed -n 's/.* total=\([^ ]*\).*/\1/p')
  ch=$(printf '%s\n' "$line" | sed -n 's/.* cache=\([^ ]*\).*/\1/p')
  dm=$(printf '%s\n' "$line" | sed -n 's/.* duration_ms=\([^ ]*\).*/\1/p')
  wd=$(printf '%s\n' "$line" | sed -n 's/.* widen=\([^ ]*\).*/\1/p')
  forge_emit ci_local_check job="$job" selector="$sel" selected="${sc:-0}" total="${tt:-0}" cache="$ch" duration_ms="${dm:-0}" widen="$wd" >/dev/null 2>&1 || true
  EMITTED=$((EMITTED + 1))
done < <(grep '^CI_LOCAL_CHECK:' "$OUT")

exit "$RC"
