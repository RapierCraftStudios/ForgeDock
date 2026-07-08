#!/usr/bin/env bash
# select-fix-targets.sh — Deterministic priority-ranked issue selection for autopilot
#
# Usage:
#   select-fix-targets.sh [-R <owner/repo>] [--limit <n>] [--fixture-test]
#
#   -R <owner/repo>   : GitHub repository (optional, defaults to current repo)
#   --limit <n>       : Maximum number of issues to output (optional, default: 10)
#   --fixture-test    : Run against synthetic fixture data instead of GitHub API.
#                       Exits 0 if output matches expected ranking, 1 otherwise.
#                       Use this for wire-through proof per #1731.
#
# Output:
#   One issue number per line, in priority order (highest priority first).
#   Suitable for: for ISSUE_NUM in $(select-fix-targets.sh); do ... done
#
# Ranking algorithm (deterministic — no LLM required):
#   1. P0 issues first (priority:P0 label)
#   2. P1 issues second (priority:P1 label)
#   3. P2 issues third (priority:P2 label)
#   4. Unlabeled issues (no priority:P* label) are EXCLUDED — never selected autonomously
#
#   Tie-breaker within each priority band: oldest createdAt wins.
#   This ensures fresh self-filed findings (from /autopilot recon) never outrank
#   older human-filed issues at the same priority level. See: #1752.
#
# Exclusions (issues never selected, regardless of priority):
#   - Issues with needs-human label
#   - Issues with a milestone (feature-lane issues — autopilot handles these in Phase 3)
#   - Issues with terminal workflow labels (workflow:merged, workflow:invalid, workflow:decomposed)
#   - Issues with active workflow labels (workflow:building, workflow:in-review) — already in flight
#
# Exit codes: 0 = success (or fixture test passed), 1 = error (or fixture test failed)
#
# Added: forge#1752

set -euo pipefail

GH_REPO_ARGS=()
LIMIT=10
FIXTURE_TEST=false

# Parse arguments
while [ $# -gt 0 ]; do
  case "$1" in
    -R)
      if [ $# -lt 2 ]; then
        echo "ERROR: -R requires a value <owner/repo>" >&2
        echo "Usage: select-fix-targets.sh [-R <owner/repo>] [--limit <n>] [--fixture-test]" >&2
        exit 1
      fi
      if ! [[ "$2" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
        echo "ERROR: -R value must be owner/repo format, got: $2" >&2
        exit 1
      fi
      GH_REPO_ARGS=(-R "$2")
      shift 2
      ;;
    --limit)
      if [ $# -lt 2 ] || ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "ERROR: --limit requires a positive integer" >&2
        exit 1
      fi
      LIMIT="$2"
      shift 2
      ;;
    --fixture-test)
      FIXTURE_TEST=true
      shift
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      echo "Usage: select-fix-targets.sh [-R <owner/repo>] [--limit <n>] [--fixture-test]" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Fixture test mode (wire-through proof per #1731)
# ---------------------------------------------------------------------------
# Runs the ranking logic against synthetic JSON that exercises every edge case:
#   - P0 issue (should be first)
#   - P1 issue (should be second)
#   - Unlabeled issue (should be excluded)
#   - Fresh P2 self-filed finding (should be last among selected, after P0 and P1)
#   - Older P2 issue (should appear before fresh P2 within the P2 band)
# Expected output order: 100 (P0), 101 (P1, older), 103 (P2, older), 104 (P2, newer)
# Issues 102 (unlabeled) and 105 (needs-human) must be absent from output.
#
# This test does NOT make GitHub API calls — it validates the jq pipeline directly.
# ---------------------------------------------------------------------------
if [ "$FIXTURE_TEST" = "true" ]; then
  FIXTURE_JSON='[
    {
      "number": 100,
      "createdAt": "2026-01-01T00:00:00Z",
      "milestone": null,
      "labels": [{"name": "priority:P0"}, {"name": "bug"}]
    },
    {
      "number": 101,
      "createdAt": "2026-01-02T00:00:00Z",
      "milestone": null,
      "labels": [{"name": "priority:P1"}]
    },
    {
      "number": 102,
      "createdAt": "2026-01-03T00:00:00Z",
      "milestone": null,
      "labels": [{"name": "bug"}]
    },
    {
      "number": 103,
      "createdAt": "2026-03-01T00:00:00Z",
      "milestone": null,
      "labels": [{"name": "priority:P2"}]
    },
    {
      "number": 104,
      "createdAt": "2026-07-08T01:30:00Z",
      "milestone": null,
      "labels": [{"name": "priority:P2"}, {"name": "bug"}]
    },
    {
      "number": 105,
      "createdAt": "2026-01-01T00:00:00Z",
      "milestone": null,
      "labels": [{"name": "priority:P0"}, {"name": "needs-human"}]
    },
    {
      "number": 106,
      "createdAt": "2026-01-01T00:00:00Z",
      "milestone": {"title": "v2.0"},
      "labels": [{"name": "priority:P0"}]
    }
  ]'

  # Expected order: 100, 101, 103, 104
  # Excluded: 102 (no priority label), 105 (needs-human), 106 (has milestone)
  EXPECTED="100
101
103
104"

  ACTUAL=$(echo "$FIXTURE_JSON" | jq -r '
    # Step 1: Filter out exclusions
    [.[] | select(
      .milestone == null and
      (.labels | map(.name) | any(. == "needs-human" or
        . == "workflow:merged" or . == "workflow:invalid" or
        . == "workflow:decomposed" or . == "workflow:building" or
        . == "workflow:in-review") | not) and
      # Only include issues with an explicit priority:P* label (unlabeled = excluded)
      (.labels | map(.name) | any(startswith("priority:P")))
    )] |
    # Step 2: Assign numeric priority rank (lower = higher priority)
    # P0 → 0, P1 → 1, P2 → 2, any other priority:P* → 9 (future-proof)
    map(. + {
      "_rank": (
        .labels | map(.name) |
        if any(. == "priority:P0") then 0
        elif any(. == "priority:P1") then 1
        elif any(. == "priority:P2") then 2
        else 9
        end
      )
    }) |
    # Step 3: Sort by rank ASC, then by createdAt ASC (oldest wins within same band)
    sort_by([._rank, .createdAt]) |
    # Step 4: Output issue numbers
    .[].number
  ')

  if [ "$ACTUAL" = "$EXPECTED" ]; then
    echo "FIXTURE TEST PASSED — ranking: $(echo "$ACTUAL" | tr '\n' ' ')"
    echo "Excluded correctly: 102 (unlabeled), 105 (needs-human), 106 (has milestone)"
    exit 0
  else
    echo "FIXTURE TEST FAILED" >&2
    echo "Expected order: $(echo "$EXPECTED" | tr '\n' ' ')" >&2
    echo "Actual order:   $(echo "$ACTUAL" | tr '\n' ' ')" >&2
    echo "" >&2
    echo "Diff:" >&2
    diff <(echo "$EXPECTED") <(echo "$ACTUAL") >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Live mode: query GitHub and apply ranking
# ---------------------------------------------------------------------------

# Fetch open issues — get all candidates in one API call.
# JSON fields: number, createdAt, milestone (null or object), labels (array of name objects).
# Limit to 200 issues to match the rest of autopilot's queries; ranking is applied in jq.
ISSUES_JSON=$(gh issue list "${GH_REPO_ARGS[@]}" \
  --state open \
  --limit 200 \
  --json number,createdAt,milestone,labels \
  2>/dev/null || echo '[]')

if [ "$ISSUES_JSON" = "[]" ] || [ -z "$ISSUES_JSON" ]; then
  echo "" # No issues — empty output is valid (caller loops over nothing)
  exit 0
fi

echo "$ISSUES_JSON" | jq -r --argjson limit "$LIMIT" '
  # Step 1: Filter out exclusions (same logic as fixture test)
  [.[] | select(
    .milestone == null and
    (.labels | map(.name) | any(. == "needs-human" or
      . == "workflow:merged" or . == "workflow:invalid" or
      . == "workflow:decomposed" or . == "workflow:building" or
      . == "workflow:in-review") | not) and
    # Only include issues with an explicit priority:P* label (unlabeled = excluded)
    (.labels | map(.name) | any(startswith("priority:P")))
  )] |
  # Step 2: Assign numeric priority rank
  map(. + {
    "_rank": (
      .labels | map(.name) |
      if any(. == "priority:P0") then 0
      elif any(. == "priority:P1") then 1
      elif any(. == "priority:P2") then 2
      else 9
      end
    )
  }) |
  # Step 3: Sort by rank ASC, then by createdAt ASC (oldest wins within same priority band)
  sort_by([._rank, .createdAt]) |
  # Step 4: Apply limit and output issue numbers
  .[:$limit] | .[].number
'
