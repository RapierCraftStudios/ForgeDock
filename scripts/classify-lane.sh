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
# Exit codes: 0 = success, 1 = error (invalid issue, gh auth failure, branch missing, etc.)
#
# Branch existence validation:
#   For feature-lane outputs (milestone/{slug}), the script verifies the branch exists
#   on the remote via `git ls-remote`. If the branch does not exist, exits 1 with a
#   descriptive error. This prevents agents from creating PRs targeting phantom branches.
#   Fast-lane output (staging) is returned without branch validation — staging is assumed
#   to always exist as it is the primary integration branch.

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
  LANE="milestone/$SLUG"

  # Validate that the computed milestone branch exists on the remote.
  # A non-existent branch means either: (a) the milestone slug was hallucinated, or
  # (b) the milestone branch has not been created yet. Either way, targeting it would
  # strand the PR on a phantom branch — hard-fail so a human can investigate.
  if ! git ls-remote --exit-code origin "$LANE" >/dev/null 2>&1; then
    echo "ERROR: PR target branch '$LANE' does not exist on remote 'origin'." >&2
    echo "       Milestone: '$MILESTONE_TITLE' → slug: '$SLUG'" >&2
    echo "       Create the branch first, or check that the milestone title is correct." >&2
    echo "       Run: git push origin HEAD:$LANE  (from the base branch)" >&2
    exit 1
  fi

  echo "$LANE"
fi
