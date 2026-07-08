#!/usr/bin/env bash
# transition-label.sh — Workflow label state machine for ForgeDock pipeline
#
# Usage: transition-label.sh <ISSUE_NUMBER> <GH_FLAG...> <TARGET_STATE>
#   OR:  transition-label.sh --validate <VERDICT> <ISSUE_NUMBER> [GH_FLAG...]
#
#   ISSUE_NUMBER  GitHub issue number (e.g. 674)
#   GH_FLAG       Repository flag passed to gh (e.g. -R RapierCraftStudios/forgedock)
#                 May be multiple tokens — pass before TARGET_STATE
#   TARGET_STATE  One of: investigating, ready-to-build, building, in-review,
#                         merged, invalid, decomposed, awaiting-merge
#
#   --validate    Sub-command mode: translate an investigation verdict into a
#                 finding-lifecycle label (needs-validation → validated/false-positive).
#   VERDICT       One of: CONFIRMED, NOT-CONFIRMED, INVALID, PARTIAL
#                 CONFIRMED → validated; all others → false-positive
#
# Examples:
#   transition-label.sh 674 -R RapierCraftStudios/forgedock investigating
#   transition-label.sh 674 -R owner/repo ready-to-build
#   transition-label.sh --validate CONFIRMED 674 -R owner/repo
#   transition-label.sh --validate NOT-CONFIRMED 674 -R owner/repo
#
# Behavior (workflow mode):
#   1. Validates ISSUE_NUMBER and TARGET_STATE
#   2. Verifies the issue exists (exits 1 if not)
#   3. Adds workflow:{TARGET_STATE} label
#   4. Removes all other workflow:* labels atomically
#
# Behavior (--validate mode):
#   1. Validates VERDICT and ISSUE_NUMBER
#   2. Verifies issue exists and has needs-validation label (exits 0 silently if not)
#   3. Adds validated (CONFIRMED) or false-positive (all other verdicts) label
#   4. Removes needs-validation label
#   5. Idempotent: if already labeled validated/false-positive, exits 0 silently
#
# Exit codes: 0 = success, 1 = error (bad args, issue not found, gh failure)

set -euo pipefail

# ---------------------------------------------------------------------------
# --validate sub-command: finding lifecycle label transition
# Signature: --validate <VERDICT> <ISSUE_NUMBER> [GH_FLAG...]
# Separate from the workflow state machine — operates on needs-validation,
# validated, false-positive labels only; never touches workflow:* labels.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--validate" ]; then
  shift

  if [ "$#" -lt 2 ]; then
    echo "ERROR: Usage: transition-label.sh --validate <VERDICT> <ISSUE_NUMBER> [GH_FLAG...]" >&2
    echo "       VERDICT: CONFIRMED | NOT-CONFIRMED | INVALID | PARTIAL" >&2
    echo "       Example: transition-label.sh --validate CONFIRMED 674 -R owner/repo" >&2
    exit 1
  fi

  VERDICT="$1"
  shift
  ISSUE_NUMBER="$1"
  shift
  GH_ARGS=("$@")

  # Validate verdict
  case "$VERDICT" in
    CONFIRMED|NOT-CONFIRMED|INVALID|PARTIAL) ;;
    *)
      echo "ERROR: Unknown verdict: '$VERDICT'" >&2
      echo "       Valid verdicts: CONFIRMED, NOT-CONFIRMED, INVALID, PARTIAL" >&2
      exit 1
      ;;
  esac

  # Validate issue number
  if ! [[ "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "ERROR: ISSUE_NUMBER must be a positive integer, got: '$ISSUE_NUMBER'" >&2
    exit 1
  fi

  # Verify issue exists
  if ! gh issue view "$ISSUE_NUMBER" "${GH_ARGS[@]}" --json number >/dev/null 2>&1; then
    echo "ERROR: Issue #$ISSUE_NUMBER not found (GH_FLAG: ${GH_ARGS[*]:-<none>})" >&2
    exit 1
  fi

  # Check if issue carries needs-validation (idempotent gate)
  CURRENT_LABELS=$(gh issue view "$ISSUE_NUMBER" "${GH_ARGS[@]}" --json labels \
    --jq '[.labels[].name] | join(",")' 2>/dev/null || echo "")

  if ! echo "$CURRENT_LABELS" | grep -q "needs-validation"; then
    echo "OK: Issue #$ISSUE_NUMBER does not have needs-validation — no action taken (idempotent)"
    exit 0
  fi

  # Check if already resolved (idempotent)
  if echo "$CURRENT_LABELS" | grep -qE "validated|false-positive"; then
    echo "OK: Issue #$ISSUE_NUMBER already has a resolved verdict label — no action taken (idempotent)"
    exit 0
  fi

  # Map verdict to label
  if [ "$VERDICT" = "CONFIRMED" ]; then
    TARGET_VERDICT_LABEL="validated"
    echo "Verdict CONFIRMED → adding 'validated' to issue #$ISSUE_NUMBER..."
  else
    TARGET_VERDICT_LABEL="false-positive"
    echo "Verdict $VERDICT → adding 'false-positive' to issue #$ISSUE_NUMBER..."
  fi

  # Add verdict label
  gh issue edit "$ISSUE_NUMBER" "${GH_ARGS[@]}" --add-label "$TARGET_VERDICT_LABEL"

  # Remove needs-validation
  gh issue edit "$ISSUE_NUMBER" "${GH_ARGS[@]}" --remove-label "needs-validation" 2>/dev/null || true

  echo "OK: needs-validation → $TARGET_VERDICT_LABEL on issue #$ISSUE_NUMBER"
  exit 0
fi

# ---------------------------------------------------------------------------
# Argument parsing (workflow state machine mode)
# Signature: <ISSUE_NUMBER> [GH_FLAG...] <TARGET_STATE>
# We consume ISSUE_NUMBER as $1, TARGET_STATE as the last arg, everything
# in between is GH_FLAG (e.g. -R RapierCraftStudios/forgedock).
# ---------------------------------------------------------------------------

if [ "$#" -lt 2 ]; then
  echo "ERROR: Usage: transition-label.sh <ISSUE_NUMBER> [GH_FLAG...] <TARGET_STATE>" >&2
  echo "       Example: transition-label.sh 674 -R RapierCraftStudios/forgedock investigating" >&2
  echo "       OR:      transition-label.sh --validate CONFIRMED 674 -R owner/repo" >&2
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
  "awaiting-merge"
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

# Export universal script environment so per-repo scripts can call back into universal scripts.
# Per-repo scripts (.forgedock/scripts/{operation}.sh) source these to delegate to universal ones.
export FORGEDOCK_SCRIPTS
FORGEDOCK_SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
export FORGEDOCK_HOME
FORGEDOCK_HOME="$(cd "$(dirname "$0")/.." && pwd)"

# ---------------------------------------------------------------------------
# FORGE_LABEL_MAP — optional env var (JSON object) from forge.yaml → learned.label_map
#
# If set and non-empty (not '{}'), look up "workflow:$TARGET_STATE" in the map.
# If a mapping exists, use the mapped label name instead of the canonical one.
# This allows repos with non-standard label naming to use ForgeDock without
# renaming their labels to match the canonical workflow:* format.
#
# Set by work-on.md Phase 0B.1: export FORGE_LABEL_MAP="$LEARNED_LABEL_MAP"
# Falls back to canonical label if: FORGE_LABEL_MAP is unset/empty/{}, jq
# is not available, or no mapping exists for the target state.
#
# Note: --remove-label always uses canonical workflow:* format — it clears all
# canonical labels regardless of mapping, which is correct cleanup behavior.
# ---------------------------------------------------------------------------
CANONICAL_LABEL="workflow:$TARGET_STATE"
EFFECTIVE_LABEL="$CANONICAL_LABEL"

if [ -n "${FORGE_LABEL_MAP:-}" ] && [ "${FORGE_LABEL_MAP:-}" != "{}" ]; then
  if command -v jq >/dev/null 2>&1; then
    MAPPED=$(echo "$FORGE_LABEL_MAP" | jq -r --arg key "$CANONICAL_LABEL" '.[$key] // empty' 2>/dev/null || true)
    if [ -n "$MAPPED" ]; then
      # Validate: reject any mapped value starting with '-' to prevent CLI flag injection.
      # A forge.yaml learned.label_map entry like "workflow:investigating": "--json" would
      # otherwise be passed directly to gh issue edit --add-label, interpreted as a flag.
      if [[ "$MAPPED" == -* ]]; then
        echo "ERROR: FORGE_LABEL_MAP value for '$CANONICAL_LABEL' is not a valid label name: '$MAPPED'" >&2
        echo "       Label names must not start with '-'. Using canonical label fallback: $CANONICAL_LABEL" >&2
      else
        EFFECTIVE_LABEL="$MAPPED"
        echo "Label map override: $CANONICAL_LABEL → $EFFECTIVE_LABEL"
      fi
    fi
  else
    echo "WARNING: FORGE_LABEL_MAP is set but jq is not available — using canonical label ($CANONICAL_LABEL)" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Add target label
# ---------------------------------------------------------------------------
echo "Adding $EFFECTIVE_LABEL to issue #$ISSUE_NUMBER..."
gh issue edit "$ISSUE_NUMBER" "${GH_ARGS[@]}" --add-label "$EFFECTIVE_LABEL"

# ---------------------------------------------------------------------------
# Remove all other workflow:* labels currently on the issue (best-effort)
#
# IMPORTANT: `gh issue edit --remove-label` is atomic across its whole
# comma-separated argument — if ANY label in the list is not a valid label
# on the repo (e.g. a newly added VALID_STATES entry like awaiting-merge
# whose repo-side `gh label create` / bootstrap hasn't run yet), the ENTIRE
# call fails with "not found" and — under `set -euo pipefail` without the
# `|| true` this used to silently swallow — no labels are removed at all,
# including ones that DO exist and SHOULD have been cleared (forge#1810
# follow-up: this exact bug was caught by dogfooding this script against
# the live repo before `workflow:awaiting-merge` had been bootstrapped).
#
# Fix: only ask to remove labels that are BOTH (a) in REMOVE_LABELS (valid
# states other than the target) AND (b) actually present on the issue right
# now. A label that was never applied to this issue can't be "not found" on
# the repo without failing the whole call, and a label the issue doesn't
# have doesn't need removing anyway — so intersecting against the issue's
# current labels sidesteps the all-or-nothing failure mode entirely instead
# of relying on `|| true` to mask it.
# ---------------------------------------------------------------------------
CURRENT_ISSUE_LABELS=$(gh issue view "$ISSUE_NUMBER" "${GH_ARGS[@]}" --json labels \
  --jq '[.labels[].name] | join(",")' 2>/dev/null || echo "")

TO_REMOVE=""
IFS=',' read -ra REMOVE_CANDIDATES <<< "$REMOVE_LABELS"
for candidate in "${REMOVE_CANDIDATES[@]}"; do
  case ",$CURRENT_ISSUE_LABELS," in
    *",$candidate,"*)
      TO_REMOVE="${TO_REMOVE:+$TO_REMOVE,}$candidate"
      ;;
  esac
done

if [ -n "$TO_REMOVE" ]; then
  echo "Removing stale workflow:* labels present on the issue ($TO_REMOVE)..."
  gh issue edit "$ISSUE_NUMBER" "${GH_ARGS[@]}" --remove-label "$TO_REMOVE" 2>/dev/null || true
else
  echo "No stale workflow:* labels present on the issue — nothing to remove."
fi

# ---------------------------------------------------------------------------
# Clear needs-human (best-effort)
#
# needs-human is NOT a workflow:* label, so it is never included in
# VALID_STATES/REMOVE_LABELS above. Historically no code path ever cleared it
# (forge#1809/#1810) — it was a write-only, sticky, terminal label even after
# the pipeline made forward progress past the condition that set it.
#
# This script only runs at explicit forward-progress transition points (the
# dispatcher STOPs on needs-human before ever reaching a transition-label.sh
# call in normal operation — see commands/work-on.md's terminal-state checks),
# so clearing needs-human here is safe: it only fires when something has
# deliberately decided to move the issue/PR to a new state, most notably
# workflow:awaiting-merge (a remediated + re-reviewed PR moving off
# needs-human without yet meeting the auto-land bar — see #1809 Q1).
# Best-effort: `|| true` so a missing label never fails the script under
# `set -euo pipefail`.
# ---------------------------------------------------------------------------
echo "Clearing needs-human (best-effort)..."
gh issue edit "$ISSUE_NUMBER" "${GH_ARGS[@]}" --remove-label "needs-human" 2>/dev/null || true

echo "OK: $EFFECTIVE_LABEL set on issue #$ISSUE_NUMBER"
