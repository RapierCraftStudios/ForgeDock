#!/usr/bin/env bash
# validate-pr-target.sh — Hard-fail if PR base branch doesn't match classified lane
#
# Usage: validate-pr-target.sh <actual_base> <classified_lane>
#   actual_base:      the branch the PR will target (e.g. staging, milestone/deterministic-pipeline-v2)
#   classified_lane:  the lane produced by classify-lane.sh (e.g. staging, milestone/deterministic-pipeline-v2)
#
# Output: Structured finding (prefixed with severity)
#   BLOCKING: <message>  — mismatch detected; pipeline must not continue
#   OK:       <message>  — base matches classified lane
#
# Exit codes: 0 = match (PR target is correct), 1 = mismatch (hard-fail)

set -euo pipefail

if [ $# -ne 2 ]; then
    echo "BLOCKING: validate-pr-target.sh requires exactly 2 arguments: <actual_base> <classified_lane>" >&2
    exit 1
fi

ACTUAL_BASE="$1"
CLASSIFIED_LANE="$2"

if [ "$ACTUAL_BASE" = "$CLASSIFIED_LANE" ]; then
    echo "OK: PR target '${ACTUAL_BASE}' matches classified lane"
    exit 0
else
    echo "BLOCKING: PR target '${ACTUAL_BASE}' does not match classified lane '${CLASSIFIED_LANE}'"
    exit 1
fi
