#!/usr/bin/env bash
# classify-lane.sh — Deterministic lane routing from issue milestone
#
# Usage: classify-lane.sh <issue_number> [-R <owner/repo>]
#   issue_number: GitHub issue number (required)
#   -R <owner/repo>: GitHub repository (optional, defaults to current repo)
#
# Output: lane string written to stdout
#   staging              — issue has no milestone (fast lane)
#   milestone/{slug}     — issue has a milestone (feature lane, slug = lowercased, spaces→hyphens)
#
# Exit codes: 0 = success, 1 = error (invalid issue, gh auth failure, etc.)

set -euo pipefail

ISSUE_NUMBER="${1:-}"
GH_REPO_FLAG=""

# Parse arguments: issue number + optional -R flag
if [ -z "$ISSUE_NUMBER" ]; then
  echo "ERROR: issue number is required" >&2
  echo "Usage: classify-lane.sh <issue_number> [-R <owner/repo>]" >&2
  exit 1
fi

shift
while [ $# -gt 0 ]; do
  case "$1" in
    -R)
      GH_REPO_FLAG="-R $2"
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Validate issue number is numeric
if ! [[ "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "ERROR: issue number must be numeric, got: $ISSUE_NUMBER" >&2
  exit 1
fi

# Fetch milestone title from GitHub
# gh issue view exits non-zero if the issue does not exist or auth fails
GH_STDERR_TMP=$(mktemp)
MILESTONE_TITLE=$(gh issue view "$ISSUE_NUMBER" $GH_REPO_FLAG --json milestone --jq '.milestone.title // empty' 2>"$GH_STDERR_TMP") || {
  echo "ERROR: failed to fetch issue #$ISSUE_NUMBER — check issue number and repo flag" >&2
  cat "$GH_STDERR_TMP" >&2
  rm -f "$GH_STDERR_TMP"
  exit 1
}
rm -f "$GH_STDERR_TMP"

# Export universal script environment so per-repo scripts can call back into universal scripts.
# Per-repo scripts (.forgedock/scripts/{operation}.sh) source these to delegate to universal ones.
export FORGEDOCK_SCRIPTS
FORGEDOCK_SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
export FORGEDOCK_HOME
FORGEDOCK_HOME="$(cd "$(dirname "$0")/.." && pwd)"

# Classify lane based on milestone presence
if [ -z "$MILESTONE_TITLE" ]; then
  echo "staging"
else
  # Slugify: lowercase, spaces → hyphens, collapse multiple hyphens, strip leading/trailing hyphens
  SLUG=$(echo "$MILESTONE_TITLE" \
    | tr '[:upper:]' '[:lower:]' \
    | tr ' ' '-' \
    | sed 's/--*/-/g' \
    | sed 's/^-//;s/-$//')
  echo "milestone/$SLUG"
fi
