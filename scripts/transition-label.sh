#!/usr/bin/env bash
# transition-label.sh — Workflow label state machine for ForgeDock pipeline
#
# Usage: transition-label.sh <ISSUE_NUMBER> <GH_FLAG...> <TARGET_STATE>
#
#   ISSUE_NUMBER  GitHub issue number (e.g. 674)
#   GH_FLAG       Repository flag passed to gh (e.g. -R RapierCraftStudios/forgedock)
#                 May be multiple tokens — pass before TARGET_STATE
#   TARGET_STATE  One of: investigating, ready-to-build, building, in-review,
#                         merged, invalid, decomposed
#
# Examples:
#   transition-label.sh 674 -R RapierCraftStudios/forgedock investigating
#   transition-label.sh 674 -R owner/repo ready-to-build
#
# Behavior:
#   1. Validates ISSUE_NUMBER and TARGET_STATE
#   2. Verifies the issue exists (exits 1 if not)
#   3. Adds workflow:{TARGET_STATE} label
#   4. Removes all other workflow:* labels atomically
#
# Exit codes: 0 = success, 1 = error (bad args, issue not found, gh failure)

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# Signature: <ISSUE_NUMBER> [GH_FLAG...] <TARGET_STATE>
# We consume ISSUE_NUMBER as $1, TARGET_STATE as the last arg, everything
# in between is GH_FLAG (e.g. -R RapierCraftStudios/forgedock).
# ---------------------------------------------------------------------------

if [ "$#" -lt 2 ]; then
  echo "ERROR: Usage: transition-label.sh <ISSUE_NUMBER> [GH_FLAG...] <TARGET_STATE>" >&2
  echo "       Example: transition-label.sh 674 -R RapierCraftStudios/forgedock investigating" >&2
  exit 1
fi

ISSUE_NUMBER="$1"
shift

# Last arg is TARGET_STATE; everything remaining before it is GH_FLAG
# Build an array of all remaining args, then split off the last one.
ALL_REMAINING=("$@")
LAST_INDEX=$(( ${#ALL_REMAINING[@]} - 1 ))
TARGET_STATE="${ALL_REMAINING[$LAST_INDEX]}"
GH_ARGS=("${ALL_REMAINING[@]:0:$LAST_INDEX}")

# ---------------------------------------------------------------------------
# Validate ISSUE_NUMBER
# ---------------------------------------------------------------------------
if ! [[ "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "ERROR: ISSUE_NUMBER must be a positive integer, got: '$ISSUE_NUMBER'" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Valid workflow states (complete list — all workflow:* labels)
# ---------------------------------------------------------------------------
VALID_STATES=(
  "investigating"
  "ready-to-build"
  "building"
  "in-review"
  "merged"
  "invalid"
  "decomposed"
)

# ---------------------------------------------------------------------------
# Validate TARGET_STATE
# ---------------------------------------------------------------------------
VALID=0
for state in "${VALID_STATES[@]}"; do
  if [ "$state" = "$TARGET_STATE" ]; then
    VALID=1
    break
  fi
done

if [ "$VALID" -eq 0 ]; then
  echo "ERROR: Unknown target state: '$TARGET_STATE'" >&2
  echo "Valid states:" >&2
  for state in "${VALID_STATES[@]}"; do
    echo "  $state" >&2
  done
  exit 1
fi

# ---------------------------------------------------------------------------
# Verify issue exists before mutating labels
# ---------------------------------------------------------------------------
if ! gh issue view "$ISSUE_NUMBER" "${GH_ARGS[@]}" --json number >/dev/null 2>&1; then
  echo "ERROR: Issue #$ISSUE_NUMBER not found (GH_FLAG: ${GH_ARGS[*]:-<none>})" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Build remove list: all valid states except the target
# ---------------------------------------------------------------------------
REMOVE_LABELS=""
for state in "${VALID_STATES[@]}"; do
  if [ "$state" != "$TARGET_STATE" ]; then
    if [ -n "$REMOVE_LABELS" ]; then
      REMOVE_LABELS="$REMOVE_LABELS,workflow:$state"
    else
      REMOVE_LABELS="workflow:$state"
    fi
  fi
done

# ---------------------------------------------------------------------------
# Add target label
# ---------------------------------------------------------------------------
echo "Adding workflow:$TARGET_STATE to issue #$ISSUE_NUMBER..."
gh issue edit "$ISSUE_NUMBER" "${GH_ARGS[@]}" --add-label "workflow:$TARGET_STATE"

# ---------------------------------------------------------------------------
# Remove all other workflow:* labels (best-effort — labels may not all exist)
# ---------------------------------------------------------------------------
echo "Removing stale workflow:* labels ($REMOVE_LABELS)..."
gh issue edit "$ISSUE_NUMBER" "${GH_ARGS[@]}" --remove-label "$REMOVE_LABELS" 2>/dev/null || true

echo "OK: workflow:$TARGET_STATE set on issue #$ISSUE_NUMBER"
