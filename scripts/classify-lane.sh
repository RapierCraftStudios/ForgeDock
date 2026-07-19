#!/usr/bin/env bash
# classify-lane.sh — Deterministic lane routing from issue milestone
#
# Usage: classify-lane.sh <issue_number> [-R <owner/repo>] [--json]
#   issue_number: GitHub issue number (required)
#   -R <owner/repo>: GitHub repository (optional, defaults to current repo)
#   --json: emit structured JSON object instead of plain lane string (optional)
#
# Output: lane string written to stdout (default)
#   staging              — issue has no milestone (fast lane)
#   milestone/{slug}     — issue has a milestone (feature lane, slug = lowercased, spaces→hyphens, git-invalid chars stripped)
#
# Output: JSON object when --json flag is passed
#   {"lane":"staging","branch":"staging","source":"fast-lane","milestone":null}
#   {"lane":"milestone/{slug}","branch":"milestone/{slug}","source":"feature-lane","milestone":"{title}","slug":"{slug}"}
#
# Exit codes: 0 = success, 1 = error (invalid issue, gh auth failure, branch missing, etc.)
#
# Branch existence validation:
#   Both fast-lane (staging) and feature-lane (milestone/{slug}) outputs are validated
#   against the remote via `git ls-remote`. If the target branch does not exist, the
#   script exits 1 with a descriptive error. This prevents agents from creating PRs
#   targeting phantom branches and catches misconfigured branches.staging values early.
#   Fast-lane staging branch name is read from forge.yaml (branches.staging key),
#   defaulting to "staging" when forge.yaml is absent or yq is unavailable.

set -euo pipefail

ISSUE_NUMBER="${1:-}"
GH_REPO_ARGS=()
JSON_OUTPUT=false

# Parse arguments: issue number + optional -R flag + optional --json flag
if [ -z "$ISSUE_NUMBER" ]; then
  echo "ERROR: issue number is required" >&2
  echo "Usage: classify-lane.sh <issue_number> [-R <owner/repo>] [--json]" >&2
  exit 1
fi

shift
while [ $# -gt 0 ]; do
  case "$1" in
    -R)
      if [ $# -lt 2 ]; then
        echo "ERROR: -R requires a value <owner/repo>" >&2
        echo "Usage: classify-lane.sh <issue_number> [-R <owner/repo>] [--json]" >&2
        exit 1
      fi
      if ! [[ "$2" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
        echo "ERROR: -R value must be owner/repo format, got: $2" >&2
        exit 1
      fi
      GH_REPO_ARGS=(-R "$2")
      shift 2
      ;;
    --json)
      JSON_OUTPUT=true
      shift
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

# Fetch milestone title (and labels, for the review-finding staging-default
# note below) from GitHub in a single call — gh issue view exits non-zero if
# the issue does not exist or auth fails. Labels are fetched here rather
# than via a second `gh issue view` call so this stays one round trip, same
# failure surface as before this field was added. <!-- Added: forge#2443 -->
GH_STDERR_TMP=$(mktemp)
chmod 600 "$GH_STDERR_TMP"
trap 'rm -f "$GH_STDERR_TMP"' EXIT
ISSUE_JSON=$(gh issue view "$ISSUE_NUMBER" "${GH_REPO_ARGS[@]}" --json milestone,labels 2>"$GH_STDERR_TMP") || {
  echo "ERROR: failed to fetch issue #$ISSUE_NUMBER — check issue number and repo flag" >&2
  cat "$GH_STDERR_TMP" >&2
  rm -f "$GH_STDERR_TMP"
  exit 1
}
rm -f "$GH_STDERR_TMP"

MILESTONE_TITLE=$(echo "$ISSUE_JSON" | jq -r '.milestone.title // empty')
HAS_REVIEW_FINDING_LABEL=$(echo "$ISSUE_JSON" | jq -r '[.labels[]?.name] | any(. == "review-finding")')

# Resolve staging branch name from forge.yaml (branches.staging), defaulting to "staging".
# Uses yq if available; falls back gracefully when forge.yaml is absent or yq is not installed.
STAGING_BRANCH=$(yq '.branches.staging // "staging"' forge.yaml 2>/dev/null || echo 'staging')
# yq returns literal "null" when the key exists but is null-valued — treat as default
[ "$STAGING_BRANCH" = "null" ] && STAGING_BRANCH="staging"
# Trim any surrounding whitespace or quotes that yq might emit
STAGING_BRANCH=$(echo "$STAGING_BRANCH" | tr -d '"' | xargs)
# Final safety net: if somehow empty, use default
[ -z "$STAGING_BRANCH" ] && STAGING_BRANCH="staging"

# Classify lane based on milestone presence
if [ -z "$MILESTONE_TITLE" ]; then
  # Fast lane: validate staging branch exists on remote before returning it.
  # This mirrors the feature-lane validation below and catches misconfigured
  # branches.staging values early, with a descriptive error instead of an
  # opaque failure in the subsequent git worktree add or gh pr create call.
  if ! git ls-remote --exit-code origin "$STAGING_BRANCH" >/dev/null 2>&1; then
    echo "ERROR: Fast-lane PR target branch '$STAGING_BRANCH' does not exist on remote 'origin'." >&2
    echo "       This branch is configured via forge.yaml → branches.staging (default: staging)." >&2
    echo "       Create the branch first, or update forge.yaml to point to an existing branch." >&2
    echo "       Run: git push origin HEAD:$STAGING_BRANCH  (from the default branch)" >&2
    exit 1
  fi
  # Defense-in-depth visibility (forge#2443): a review-finding issue with no
  # milestone defaults to the staging fast lane here — which is correct ONLY
  # when the finding's subject code actually lives on staging. For a finding
  # spawned from a milestone-lane PR whose body is missing **Code branch**
  # and whose milestone wasn't propagated, this default silently routes the
  # fix to the one branch where the code is guaranteed absent, causing
  # /work-on's investigation phase to close it as invalid. This script has
  # no way to know whether that mismatch applies to THIS issue (it only
  # knows the issue has no milestone) — the note below is diagnostic only,
  # non-fatal, so callers relying on stdout are unaffected.
  # WIRE:PROVEN — manual: ran classify-lane.sh against a fake `gh issue view`
  # returning labels:[{"name":"review-finding"}] and milestone:null; confirmed
  # the NOTE lines below print to stderr while stdout stays unaffected.
  if [ "$HAS_REVIEW_FINDING_LABEL" = "true" ]; then
    echo "NOTE: issue #$ISSUE_NUMBER is a review-finding with no milestone — defaulting to staging fast lane ('$STAGING_BRANCH')." >&2
    echo "      If this finding's subject code only exists on a milestone branch, this default is WRONG." >&2
    echo "      See commands/orchestrate/phase-4-execution.md Step 4C for the repair/loud-failure guard." >&2
  fi
  if [ "$JSON_OUTPUT" = "true" ]; then
    printf '{"lane":"%s","branch":"%s","source":"fast-lane","milestone":null}\n' \
      "$STAGING_BRANCH" "$STAGING_BRANCH"
  else
    echo "$STAGING_BRANCH"
  fi
else
  # Slugify: lowercase, spaces → hyphens, strip git-invalid chars, collapse multiple hyphens,
  # strip leading/trailing hyphens.
  # `tr -cd 'a-z0-9-'` removes every character that is not a lowercase letter, digit, or hyphen —
  # this covers all chars forbidden by git-check-ref-format (colons, brackets, parens, etc.).
  # It runs after space→hyphen so that word boundaries become hyphens before the strip pass,
  # and before the hyphen-collapse step so consecutive hyphens (produced by stripping special
  # chars between words) are collapsed into a single hyphen.
  SLUG=$(echo "$MILESTONE_TITLE" \
    | tr '[:upper:]' '[:lower:]' \
    | tr ' ' '-' \
    | tr -cd 'a-z0-9-' \
    | sed 's/--*/-/g' \
    | sed 's/^-//;s/-$//')

  # Guard: empty slug means the milestone title contained no ASCII letters, digits, or hyphens
  # (e.g. purely Unicode/emoji titles like "🚀✨"). An empty slug would produce LANE="milestone/"
  # which is an invalid branch reference — catch this early with an actionable error.
  if [ -z "$SLUG" ]; then
    echo "ERROR: Milestone title '$MILESTONE_TITLE' produced an empty slug after slugification." >&2
    echo "       Milestone titles must contain at least one ASCII letter, digit, or hyphen." >&2
    echo "       Rename the milestone to include an ASCII-safe name (e.g. add a short English suffix)." >&2
    exit 1
  fi

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

  if [ "$JSON_OUTPUT" = "true" ]; then
    # Escape double quotes in milestone title for safe JSON embedding.
    MILESTONE_ESCAPED="${MILESTONE_TITLE//\"/\\\"}"
    printf '{"lane":"%s","branch":"%s","source":"feature-lane","milestone":"%s","slug":"%s"}\n' \
      "$LANE" "$LANE" "$MILESTONE_ESCAPED" "$SLUG"
  else
    echo "$LANE"
  fi
fi
