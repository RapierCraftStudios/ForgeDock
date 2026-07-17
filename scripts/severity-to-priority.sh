#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# severity-to-priority.sh — Single source of truth for the Severity → priority:*
#                            label mapping used by review-finding issue creation.
#
# Usage:
#   severity-to-priority.sh <SEVERITY>
#
#   SEVERITY  One of: CRITICAL, HIGH, MEDIUM, LOW (case-sensitive,
#             matches the exact tokens written into a finding's
#             `**Severity**:` body field by commands/review-pr-agents/*.md)
#
# Mapping (fixed — do not add a second copy of this table anywhere else;
# both commands/review-pr.md and commands/review-pr-staging.md call this
# script rather than hand-rolling their own copy, specifically so the two
# specs cannot independently drift the way they did before this fix):
#
#   CRITICAL -> priority:P0
#   HIGH     -> priority:P1
#   MEDIUM   -> priority:P2
#   LOW      -> priority:P3
#
# NOTE: an `INFO -> priority:P3` branch previously existed here (forge#2447)
# but was removed (forge#2480) — no `commands/review-pr-agents/*.md` persona
# ever documented or instructed emitting `INFO` as a `**Severity**` value, and
# neither finding-body template (`review-pr.md`/`review-pr-staging.md`) ever
# listed it as valid, making the branch permanently unreachable dead code. If
# a real producer for `INFO` is added in the future, reintroduce the mapping
# here AND update both finding-body template enums AND the relevant
# review-pr-agents persona(s) in the same change — see forge#2480.
#
# IMPORTANT: this maps SEVERITY, never Confidence (CONFIRMED/LIKELY/POSSIBLE).
# Confidence and Severity are independent axes of a finding — conflating them
# is exactly the bug this script exists to prevent (forge#2447: a LOW-severity,
# CONFIRMED-confidence finding was previously labeled priority:P1 because the
# label was derived from Confidence instead of Severity, defeating the
# orchestrator's P3 batching rule for LOW-severity nits).
#
# Output: the resolved `priority:P*` label on stdout, nothing else.
#
# Exit codes:
#   0  success — label printed to stdout
#   1  error (missing argument or unrecognized severity — fails loud rather
#      than silently guessing a default priority)
#
# Example:
#   FINDING_PRIORITY=$(scripts/severity-to-priority.sh "$FINDING_SEVERITY")
#
# <!-- Added: forge#2447 -->

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "ERROR: Usage: severity-to-priority.sh <SEVERITY>" >&2
  echo "       SEVERITY: CRITICAL | HIGH | MEDIUM | LOW" >&2
  exit 1
fi

SEVERITY="$1"

case "$SEVERITY" in
  CRITICAL)
    echo "priority:P0"
    ;;
  HIGH)
    echo "priority:P1"
    ;;
  MEDIUM)
    echo "priority:P2"
    ;;
  LOW)
    echo "priority:P3"
    ;;
  *)
    echo "ERROR: Unrecognized severity: '$SEVERITY'" >&2
    echo "       Valid severities: CRITICAL, HIGH, MEDIUM, LOW" >&2
    exit 1
    ;;
esac
