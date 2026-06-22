#!/usr/bin/env bash
# forge-run.sh — Universal shell-script entry point for non-Claude agents
#
# Usage: forge-run.sh <command> <issue_number> [-R <owner/repo>]
#   command:      Pipeline command to run (currently: work-on)
#   issue_number: GitHub issue number (required)
#   -R <owner/repo>: GitHub repository (optional, defaults to current repo)
#
# Description:
#   GitHub-state-aware phase router. Reads workflow:* labels and FORGE annotation
#   comments on the given issue to determine the current pipeline phase, then emits
#   structured JSON events to stdout describing phase state and transitions.
#
#   This script does NOT invoke LLM agents — it reports what phase the pipeline is
#   in and what the next action should be. It is designed to be called by any
#   agent runtime that can execute bash (Aider /run, Cursor terminal, CI runners,
#   OpenCode shell) to get deterministic routing information without re-implementing
#   the phase detection logic.
#
# JSON Event Schema:
#   Each event is a single JSON object on its own line (newline-delimited JSON):
#
#   Phase detection:
#   {"event":"phase_detected","command":"work-on","issue":N,"phase":"<phase>","ts":"<ISO8601>"}
#
#   Phase detail:
#   {"event":"phase_detail","phase":"<phase>","lane":"<lane>","branch":"<branch>","labels":["<label>",...]}
#
#   Action required:
#   {"event":"action_required","phase":"<phase>","action":"<description>","ts":"<ISO8601>"}
#
#   Terminal state:
#   {"event":"terminal","phase":"<phase>","label":"<terminal-label>","issue":N,"ts":"<ISO8601>"}
#
#   Error:
#   {"event":"error","code":"<error_code>","message":"<message>","ts":"<ISO8601>"}
#
# Phase values (work-on command):
#   no-comments          — No investigation started; next: Phase 1 (investigate)
#   investigating        — Investigation in progress (partial comment, no INVESTIGATION:COMPLETE)
#   ready-to-build       — Investigation complete; next: Phase 3 (build)
#   building             — Build in progress (no FORGE:BUILDER comment yet)
#   awaiting-pr          — Builder complete, no PR; next: Phase 4 (create PR)
#   in-review            — PR exists, review in progress; next: Phase 5 (auto-review)
#   merged               — Terminal: workflow:merged label set
#   invalid              — Terminal: workflow:invalid label set
#   decomposed           — Terminal: workflow:decomposed label set (sub-issues spawned)
#   needs-human          — Terminal: needs-human label set
#
# Exit codes: 0 = success, 1 = error (invalid args, gh auth failure, etc.)
#
# <!-- Added: forge#965 -->

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# ISO 8601 timestamp (UTC)
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Emit a JSON event to stdout (one object per line — NDJSON)
emit() {
  local json="$1"
  printf '%s\n' "$json"
}

# Emit an error event and exit 1
die() {
  local code="$1"
  local message="$2"
  local ts_val
  ts_val=$(ts)
  # Escape double quotes in message for JSON embedding
  message="${message//\"/\\\"}"
  emit "{\"event\":\"error\",\"code\":\"${code}\",\"message\":\"${message}\",\"ts\":\"${ts_val}\"}"
  exit 1
}

# JSON-escape a string (double-quote characters only — sufficient for ASCII label/branch values)
json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

COMMAND="${1:-}"
ISSUE_NUMBER="${2:-}"
GH_REPO_ARGS=()
GH_REPO_FLAG=""

if [ -z "$COMMAND" ]; then
  die "MISSING_COMMAND" "command is required. Usage: forge-run.sh <command> <issue_number> [-R <owner/repo>]"
fi

if [ -z "$ISSUE_NUMBER" ]; then
  die "MISSING_ISSUE" "issue_number is required. Usage: forge-run.sh <command> <issue_number> [-R <owner/repo>]"
fi

# Validate command
case "$COMMAND" in
  work-on) ;;
  *)
    die "UNKNOWN_COMMAND" "unknown command: ${COMMAND}. Supported: work-on"
    ;;
esac

# Validate issue number is numeric
if ! [[ "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
  die "INVALID_ISSUE" "issue_number must be numeric, got: ${ISSUE_NUMBER}"
fi

# Parse remaining flags
shift 2
while [ $# -gt 0 ]; do
  case "$1" in
    -R)
      if [ $# -lt 2 ]; then
        die "MISSING_REPO" "-R requires a value <owner/repo>. Usage: forge-run.sh <command> <issue_number> [-R <owner/repo>]"
      fi
      if ! [[ "$2" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
        die "INVALID_REPO" "-R value must be owner/repo format, got: ${2}"
      fi
      GH_REPO_ARGS=(-R "$2")
      GH_REPO_FLAG="-R $2"
      shift 2
      ;;
    *)
      die "UNKNOWN_FLAG" "unknown argument: ${1}. Usage: forge-run.sh <command> <issue_number> [-R <owner/repo>]"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Locate scripts directory (where classify-lane.sh lives alongside this script)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLASSIFY_LANE="${SCRIPT_DIR}/classify-lane.sh"

if [ ! -x "$CLASSIFY_LANE" ]; then
  die "MISSING_SCRIPT" "classify-lane.sh not found or not executable at: ${CLASSIFY_LANE}"
fi

# ---------------------------------------------------------------------------
# Phase 1: Read issue state from GitHub
# ---------------------------------------------------------------------------

# Fetch issue: state, labels
GH_STDERR_TMP=$(mktemp)
ISSUE_JSON=$(gh issue view "$ISSUE_NUMBER" "${GH_REPO_ARGS[@]}" \
  --json number,state,labels,title \
  2>"$GH_STDERR_TMP") || {
  MSG=$(cat "$GH_STDERR_TMP")
  rm -f "$GH_STDERR_TMP"
  die "GH_FETCH_FAILED" "failed to fetch issue #${ISSUE_NUMBER}: ${MSG}"
}
rm -f "$GH_STDERR_TMP"

# Extract state and labels
ISSUE_STATE=$(printf '%s' "$ISSUE_JSON" | jq -r '.state')
LABELS_JSON=$(printf '%s' "$ISSUE_JSON" | jq -c '[.labels[].name]')
ISSUE_TITLE=$(printf '%s' "$ISSUE_JSON" | jq -r '.title')

# Check if issue is closed
if [ "$ISSUE_STATE" = "CLOSED" ]; then
  ts_val=$(ts)
  emit "{\"event\":\"terminal\",\"phase\":\"closed\",\"label\":\"closed\",\"issue\":${ISSUE_NUMBER},\"ts\":\"${ts_val}\"}"
  exit 0
fi

# ---------------------------------------------------------------------------
# Phase 2: Detect terminal labels
# ---------------------------------------------------------------------------

TERMINAL_LABEL=""
for label in "workflow:merged" "workflow:invalid" "workflow:decomposed" "needs-human"; do
  if printf '%s' "$LABELS_JSON" | jq -e --arg l "$label" 'contains([$l])' > /dev/null 2>&1; then
    TERMINAL_LABEL="$label"
    break
  fi
done

if [ -n "$TERMINAL_LABEL" ]; then
  ts_val=$(ts)
  emit "{\"event\":\"terminal\",\"phase\":\"${TERMINAL_LABEL}\",\"label\":\"$(json_str "${TERMINAL_LABEL}")\",\"issue\":${ISSUE_NUMBER},\"ts\":\"${ts_val}\"}"
  exit 0
fi

# ---------------------------------------------------------------------------
# Phase 3: Read FORGE annotation comments to determine pipeline phase
# ---------------------------------------------------------------------------

# gh issue view with --json comments is the reliable approach: it accepts the -R flag
# via GH_REPO_ARGS and handles both default-repo and explicit-repo cases.
# gh api repos/{owner}/{repo}/... would need GH_REPO env var for -R override — avoided here.
GH_STDERR_TMP=$(mktemp)
COMMENTS_JSON=$(gh issue view "$ISSUE_NUMBER" "${GH_REPO_ARGS[@]}" \
  --json comments --jq '[.comments[] | {id: .id, body: .body}]' \
  2>"$GH_STDERR_TMP") || {
  MSG=$(cat "$GH_STDERR_TMP")
  rm -f "$GH_STDERR_TMP"
  die "GH_COMMENTS_FAILED" "failed to fetch comments for issue #${ISSUE_NUMBER}: ${MSG}"
}
rm -f "$GH_STDERR_TMP" 2>/dev/null || true

if [ -z "$COMMENTS_JSON" ]; then
  COMMENTS_JSON="[]"
fi

# Detect annotation presence
has_annotation() {
  local marker="$1"
  printf '%s' "$COMMENTS_JSON" | jq -e --arg m "$marker" 'any(.[]; .body | contains($m))' > /dev/null 2>&1
}

# Detect complete annotation (has both the annotation tag AND its completion sentinel)
is_annotation_complete() {
  local open_tag="$1"
  local sentinel="$2"
  printf '%s' "$COMMENTS_JSON" | jq -e \
    --arg o "$open_tag" --arg s "$sentinel" \
    'any(.[]; (.body | contains($o)) and (.body | contains($s)))' > /dev/null 2>&1
}

INVESTIGATOR_COMPLETE=false
BUILDER_COMPLETE=false
BUILDER_PRESENT=false
REVIEW_STARTED=false

if is_annotation_complete "FORGE:INVESTIGATOR" "INVESTIGATION:COMPLETE"; then
  INVESTIGATOR_COMPLETE=true
fi
if has_annotation "FORGE:BUILDER"; then
  BUILDER_PRESENT=true
fi
if is_annotation_complete "FORGE:BUILDER" "FORGE:BUILDER:COMPLETE"; then
  BUILDER_COMPLETE=true
fi
if has_annotation "FORGE:REVIEW_STARTED"; then
  REVIEW_STARTED=true
fi

# ---------------------------------------------------------------------------
# Phase 4: Determine current workflow phase from labels + annotations
# ---------------------------------------------------------------------------

# Read current workflow labels
WORKFLOW_LABEL=""
for label in "workflow:in-review" "workflow:building" "workflow:ready-to-build" "workflow:investigating"; do
  if printf '%s' "$LABELS_JSON" | jq -e --arg l "$label" 'contains([$l])' > /dev/null 2>&1; then
    WORKFLOW_LABEL="$label"
    break
  fi
done

# Phase detection logic (matches work-on.md Phase 0B: "Determine resume point")
PHASE="no-comments"
ACTION=""

if [ "$REVIEW_STARTED" = "true" ]; then
  PHASE="in-review"
  ACTION="Review in progress — /review-pr handles merge. Check PR state."
elif [ "$BUILDER_COMPLETE" = "true" ] && [ "$WORKFLOW_LABEL" != "workflow:in-review" ]; then
  PHASE="awaiting-pr"
  ACTION="Builder complete. Create PR targeting the classified lane branch."
elif [ "$BUILDER_PRESENT" = "true" ] && [ "$BUILDER_COMPLETE" = "false" ]; then
  PHASE="building"
  ACTION="Builder comment present but incomplete. Resume build from FORGE:BUILDER comment."
elif [ "$WORKFLOW_LABEL" = "workflow:building" ]; then
  PHASE="building"
  ACTION="Build phase active. No FORGE:BUILDER comment yet — build not complete."
elif [ "$INVESTIGATOR_COMPLETE" = "true" ] || [ "$WORKFLOW_LABEL" = "workflow:ready-to-build" ]; then
  PHASE="ready-to-build"
  ACTION="Investigation complete. Invoke /work-on ${ISSUE_NUMBER} to continue to build phase."
elif has_annotation "FORGE:INVESTIGATOR" && [ "$INVESTIGATOR_COMPLETE" = "false" ]; then
  PHASE="investigating"
  ACTION="Investigation comment present but incomplete (no INVESTIGATION:COMPLETE sentinel). Delete partial comment and restart investigation."
elif [ "$WORKFLOW_LABEL" = "workflow:investigating" ]; then
  PHASE="investigating"
  ACTION="Investigation in progress. No FORGE:INVESTIGATOR comment yet."
else
  PHASE="no-comments"
  ACTION="No pipeline activity detected. Invoke /work-on ${ISSUE_NUMBER} to start investigation."
fi

# ---------------------------------------------------------------------------
# Phase 5: Classify lane (for informational output in phase_detail event)
# ---------------------------------------------------------------------------

LANE=""
BRANCH=""
LANE_JSON=""
if LANE_JSON=$("$CLASSIFY_LANE" "$ISSUE_NUMBER" "${GH_REPO_ARGS[@]}" --json 2>/dev/null); then
  LANE=$(printf '%s' "$LANE_JSON" | jq -r '.lane // empty')
  BRANCH=$(printf '%s' "$LANE_JSON" | jq -r '.branch // empty')
fi

# ---------------------------------------------------------------------------
# Phase 6: Emit events
# ---------------------------------------------------------------------------

ts_val=$(ts)

# Event 1: phase_detected
emit "{\"event\":\"phase_detected\",\"command\":\"$(json_str "${COMMAND}")\",\"issue\":${ISSUE_NUMBER},\"phase\":\"$(json_str "${PHASE}")\",\"ts\":\"${ts_val}\"}"

# Event 2: phase_detail
LABELS_STR=$(printf '%s' "$LABELS_JSON")
emit "{\"event\":\"phase_detail\",\"phase\":\"$(json_str "${PHASE}")\",\"lane\":\"$(json_str "${LANE}")\",\"branch\":\"$(json_str "${BRANCH}")\",\"labels\":${LABELS_STR}}"

# Event 3: action_required (only for non-terminal active phases)
if [ -n "$ACTION" ]; then
  ts_val=$(ts)
  ACTION_ESCAPED="${ACTION//\"/\\\"}"
  emit "{\"event\":\"action_required\",\"phase\":\"$(json_str "${PHASE}")\",\"action\":\"${ACTION_ESCAPED}\",\"ts\":\"${ts_val}\"}"
fi

exit 0
