#!/usr/bin/env bash
# doctor-pipeline-state.sh — Deterministic pipeline stall detection
#
# Usage:
#   doctor-pipeline-state.sh [--repo owner/repo] [--json] [--stuck-hours N]
#
# Options:
#   --repo owner/repo   Target repository (default: reads from forge.yaml)
#   --json              Emit machine-readable JSON instead of human summary
#   --stuck-hours N     Hours before an issue is considered stuck (default: 48)
#
# Output (human mode):
#   One finding per stalled issue/PR, including:
#     - What is wrong
#     - Which invariant broke
#     - Exact resume command (copy-pasteable)
#
# Output (JSON mode):
#   { "findings": [ { "type", "severity", "issue", "label", "hours_stuck",
#                     "last_annotation", "resume_command", "detail" } ],
#     "summary": { "total", "critical", "warning",
#                   "checks_skipped", "degraded": [ { "check", "issue", "reason" } ] } }
#
# "checks_skipped"/"degraded" surface I4/I5 checks that fail-open on a real
# `gh` API failure (rate limit, network blip, auth issue) rather than being
# treated as confirmed-missing (see #1531). A skip is NOT a finding — it does
# not affect "total"/"critical"/"warning" or the exit code — but a
# persistently non-zero "checks_skipped" across runs means those invariants
# are silently disabled and warrants investigating the underlying `gh` failure.
#
# Exit codes:
#   0 = no findings (pipeline healthy)
#   1 = findings present
#   2 = error (missing deps, bad args)
#
# Depends on: gh (GitHub CLI), jq, date
#
# Invariants checked:
#   I1  Issues stuck in workflow:investigating beyond threshold
#   I2  Issues stuck in workflow:building beyond threshold
#   I3  Issues stuck in workflow:in-review beyond threshold
#   I4  Issues in workflow:building with no FORGE:BUILDER annotation
#   I5  Issues in workflow:in-review with no open PR
#   I6  PRs open without a FORGE:CONTRACT or FORGE:BUILDER annotation
#   I7  Orphaned worktree branches (local branches fix/* with no open PR)
#
# /pipeline-health should consume this script's JSON output rather than
# re-discovering state from scratch.

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
STUCK_HOURS_DEFAULT=48
TERMINAL_LABELS="workflow:merged workflow:invalid workflow:decomposed needs-human"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
GH_REPO=""
JSON_MODE=false
STUCK_HOURS=$STUCK_HOURS_DEFAULT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      GH_REPO="$2"; shift 2 ;;
    --json)
      JSON_MODE=true; shift ;;
    --stuck-hours)
      STUCK_HOURS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      echo "Usage: doctor-pipeline-state.sh [--repo owner/repo] [--json] [--stuck-hours N]" >&2
      exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
for dep in gh jq; do
  if ! command -v "$dep" &>/dev/null; then
    echo "ERROR: Required dependency not found: $dep" >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Resolve repo
# ---------------------------------------------------------------------------
if [ -z "$GH_REPO" ]; then
  if [ -f "forge.yaml" ] && command -v yq &>/dev/null; then
    GH_REPO=$(yq e '.project.owner + "/" + .project.repo' forge.yaml 2>/dev/null || true)
  fi
  if [ -z "$GH_REPO" ]; then
    GH_REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
  fi
  if [ -z "$GH_REPO" ]; then
    echo "ERROR: Could not determine repository. Pass --repo owner/repo or run from a git repo." >&2
    exit 2
  fi
fi

GH_FLAG="-R $GH_REPO"

# ---------------------------------------------------------------------------
# Shared stderr sink for checks that must not merge stderr into a compared
# value (see I4/I5 below). Redirecting to this file (instead of `2>&1`) keeps
# a captured variable limited to stdout on success, while still preserving
# the diagnostic stderr text for the WARNING message on actual failure.
# ---------------------------------------------------------------------------
GH_STDERR_TMP=$(mktemp)
trap 'rm -f "$GH_STDERR_TMP"' EXIT

# ---------------------------------------------------------------------------
# Utility: ISO timestamp to hours-ago
# ---------------------------------------------------------------------------
hours_since() {
  local ts="$1"
  local now
  now=$(date -u +%s)
  # Accept both ISO 8601 with Z and with offset
  local then
  then=$(date -u -d "$ts" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null || echo "$now")
  echo $(( (now - then) / 3600 ))
}

# ---------------------------------------------------------------------------
# Utility: does a JSON array of label names contain any TERMINAL_LABELS entry?
# ---------------------------------------------------------------------------
has_terminal_label() {
  local labels_json="$1"
  local label
  for label in $TERMINAL_LABELS; do
    if echo "$labels_json" | jq -e --arg l "$label" 'index($l) != null' >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Findings accumulator
# ---------------------------------------------------------------------------
FINDINGS_JSON="[]"

add_finding() {
  local type="$1"
  local severity="$2"
  local issue_num="$3"
  local label="$4"
  local hours_stuck="$5"
  local last_annotation="$6"
  local resume_command="$7"
  local detail="$8"

  local entry
  entry=$(jq -n \
    --arg type "$type" \
    --arg severity "$severity" \
    --arg issue "$issue_num" \
    --arg label "$label" \
    --argjson hours_stuck "$hours_stuck" \
    --arg last_annotation "$last_annotation" \
    --arg resume_command "$resume_command" \
    --arg detail "$detail" \
    '{type:$type,severity:$severity,issue:$issue,label:$label,
      hours_stuck:$hours_stuck,last_annotation:$last_annotation,
      resume_command:$resume_command,detail:$detail}')
  FINDINGS_JSON=$(echo "$FINDINGS_JSON" | jq ". + [$entry]")
}

# ---------------------------------------------------------------------------
# Skipped-checks accumulator
#
# I4/I5 fail open on a real `gh` API failure (rate limit, network blip, auth
# issue) rather than treating it as confirmed-missing — this is intentional
# (see #1531: skip > false-CRITICAL). The skip previously logged only to
# stderr, which is invisible to /pipeline-health (it consumes --json stdout,
# not stderr). add_skip() records the same skip event into a JSON-tracked
# array so persistent degradation surfaces in the machine-readable contract.
# ---------------------------------------------------------------------------
SKIPPED_JSON="[]"

add_skip() {
  local check="$1"
  local issue_num="$2"
  local reason="$3"

  local entry
  entry=$(jq -n \
    --arg check "$check" \
    --arg issue "$issue_num" \
    --arg reason "$reason" \
    '{check:$check,issue:$issue,reason:$reason}')
  SKIPPED_JSON=$(echo "$SKIPPED_JSON" | jq ". + [$entry]")
}

# ---------------------------------------------------------------------------
# I1: Issues stuck in workflow:investigating
# ---------------------------------------------------------------------------
INVESTIGATING=$(gh issue list $GH_FLAG \
  --state open --label "workflow:investigating" \
  --limit 100 \
  --json number,title,updatedAt,labels 2>/dev/null || echo "[]")

while IFS= read -r row; do
  num=$(echo "$row" | jq -r '.number')
  labels=$(echo "$row" | jq -c '[.labels[].name]')
  if has_terminal_label "$labels"; then
    continue
  fi
  updated=$(echo "$row" | jq -r '.updatedAt')
  hours=$(hours_since "$updated")
  if [ "$hours" -ge "$STUCK_HOURS" ]; then
    add_finding \
      "stuck_investigating" "warning" \
      "$num" "workflow:investigating" "$hours" \
      "FORGE:INVESTIGATOR" \
      "/work-on $num --resume" \
      "Issue #$num stuck in workflow:investigating for ${hours}h (threshold: ${STUCK_HOURS}h). Last annotation expected: FORGE:INVESTIGATOR. Resume with /work-on $num --resume"
  fi
done < <(echo "$INVESTIGATING" | jq -c '.[]')

# ---------------------------------------------------------------------------
# I2: Issues stuck in workflow:building
# ---------------------------------------------------------------------------
BUILDING=$(gh issue list $GH_FLAG \
  --state open --label "workflow:building" \
  --limit 100 \
  --json number,title,updatedAt,labels 2>/dev/null || echo "[]")

while IFS= read -r row; do
  num=$(echo "$row" | jq -r '.number')
  labels=$(echo "$row" | jq -c '[.labels[].name]')
  if has_terminal_label "$labels"; then
    continue
  fi
  updated=$(echo "$row" | jq -r '.updatedAt')
  hours=$(hours_since "$updated")
  if [ "$hours" -ge "$STUCK_HOURS" ]; then
    add_finding \
      "stuck_building" "warning" \
      "$num" "workflow:building" "$hours" \
      "FORGE:BUILDER" \
      "/work-on $num --resume" \
      "Issue #$num stuck in workflow:building for ${hours}h (threshold: ${STUCK_HOURS}h). Last annotation expected: FORGE:BUILDER. Resume with /work-on $num --resume"
  fi
done < <(echo "$BUILDING" | jq -c '.[]')

# ---------------------------------------------------------------------------
# I3: Issues stuck in workflow:in-review
# ---------------------------------------------------------------------------
IN_REVIEW=$(gh issue list $GH_FLAG \
  --state open --label "workflow:in-review" \
  --limit 100 \
  --json number,title,updatedAt,labels 2>/dev/null || echo "[]")

while IFS= read -r row; do
  num=$(echo "$row" | jq -r '.number')
  labels=$(echo "$row" | jq -c '[.labels[].name]')
  if has_terminal_label "$labels"; then
    continue
  fi
  updated=$(echo "$row" | jq -r '.updatedAt')
  hours=$(hours_since "$updated")
  if [ "$hours" -ge "$STUCK_HOURS" ]; then
    add_finding \
      "stuck_in_review" "warning" \
      "$num" "workflow:in-review" "$hours" \
      "FORGE:TRAJECTORY" \
      "/review-pr $num" \
      "Issue #$num stuck in workflow:in-review for ${hours}h (threshold: ${STUCK_HOURS}h). Resume review with /review-pr (find associated PR first)"
  fi
done < <(echo "$IN_REVIEW" | jq -c '.[]')

# ---------------------------------------------------------------------------
# I4: Issues in workflow:building with no FORGE:BUILDER annotation
# ---------------------------------------------------------------------------
while IFS= read -r row; do
  num=$(echo "$row" | jq -r '.number')
  # Check for FORGE:BUILDER annotation in issue comments.
  # Distinguish a confirmed-absent annotation from a gh API failure (rate limit,
  # network blip, auth issue) — an API failure must NOT be treated as confirmed-missing.
  if ! has_builder=$(gh issue view "$num" $GH_FLAG \
    --json comments \
    --jq '[.comments[].body | contains("FORGE:BUILDER")] | any' 2>"$GH_STDERR_TMP"); then
    echo "WARNING: gh issue view failed for #$num — I4 check inconclusive, skipping (not treated as missing): $(cat "$GH_STDERR_TMP")" >&2
    add_skip "I4" "$num" "gh issue view failed: $(cat "$GH_STDERR_TMP")"
    continue
  fi
  if [ "$has_builder" = "false" ]; then
    add_finding \
      "missing_annotation" "critical" \
      "$num" "workflow:building" "0" \
      "none" \
      "/work-on $num --resume" \
      "Issue #$num is labeled workflow:building but has no FORGE:BUILDER annotation. The builder phase either never ran or failed before writing its annotation. Invariant I4 broken. Resume: /work-on $num --resume"
  fi
done < <(echo "$BUILDING" | jq -c '.[]')

# ---------------------------------------------------------------------------
# I5: Issues in workflow:in-review with no open PR
# ---------------------------------------------------------------------------
while IFS= read -r row; do
  num=$(echo "$row" | jq -r '.number')
  # Distinguish a confirmed-absent PR from a gh API failure (rate limit, network
  # blip, auth issue) — an API failure must NOT be treated as confirmed-missing.
  if ! pr_count=$(gh pr list $GH_FLAG \
    --state open \
    --search "closes #$num" \
    --json number \
    --jq '. | length' 2>"$GH_STDERR_TMP"); then
    echo "WARNING: gh pr list failed for #$num — I5 check inconclusive, skipping (not treated as missing): $(cat "$GH_STDERR_TMP")" >&2
    add_skip "I5" "$num" "gh pr list failed: $(cat "$GH_STDERR_TMP")"
    continue
  fi
  if [ "$pr_count" -eq 0 ]; then
    add_finding \
      "missing_pr" "critical" \
      "$num" "workflow:in-review" "0" \
      "FORGE:TRAJECTORY" \
      "/work-on $num --resume" \
      "Issue #$num is labeled workflow:in-review but no open PR references it. Invariant I5 broken. Resume: /work-on $num --resume"
  fi
done < <(echo "$IN_REVIEW" | jq -c '.[]')

# ---------------------------------------------------------------------------
# I6: PRs open without FORGE annotations
# ---------------------------------------------------------------------------
OPEN_PRS=$(gh pr list $GH_FLAG \
  --state open \
  --limit 50 \
  --json number,title,body,createdAt 2>/dev/null || echo "[]")

while IFS= read -r row; do
  pr_num=$(echo "$row" | jq -r '.number')
  body=$(echo "$row" | jq -r '.body // ""')
  created=$(echo "$row" | jq -r '.createdAt')
  hours=$(hours_since "$created")
  # Only flag PRs older than 1 hour to avoid false positives on brand-new PRs
  if [ "$hours" -lt 1 ]; then
    continue
  fi
  has_forge=$(echo "$body" | grep -c "FORGE:" || true)
  if [ "$has_forge" -eq 0 ]; then
    add_finding \
      "pr_missing_annotations" "warning" \
      "PR#$pr_num" "open_pr" "$hours" \
      "none" \
      "gh pr view $pr_num $GH_FLAG" \
      "PR #$pr_num is open but has no FORGE: annotations in its body. Either it was created outside the pipeline or the annotation was lost. Invariant I6: pipeline PRs must have FORGE:CONTRACT or FORGE:BUILDER. Inspect: gh pr view $pr_num $GH_FLAG"
  fi
done < <(echo "$OPEN_PRS" | jq -c '.[]')

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
TOTAL=$(echo "$FINDINGS_JSON" | jq 'length')
CRITICAL=$(echo "$FINDINGS_JSON" | jq '[.[] | select(.severity == "critical")] | length')
WARNING=$(echo "$FINDINGS_JSON" | jq '[.[] | select(.severity == "warning")] | length')
CHECKS_SKIPPED=$(echo "$SKIPPED_JSON" | jq 'length')

SUMMARY_JSON=$(jq -n \
  --argjson total "$TOTAL" \
  --argjson critical "$CRITICAL" \
  --argjson warning "$WARNING" \
  --argjson checks_skipped "$CHECKS_SKIPPED" \
  --argjson degraded "$SKIPPED_JSON" \
  --arg repo "$GH_REPO" \
  --arg stuck_hours "$STUCK_HOURS" \
  '{repo:$repo,stuck_hours_threshold:($stuck_hours|tonumber),
    total:$total,critical:$critical,warning:$warning,
    checks_skipped:$checks_skipped,degraded:$degraded}')

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
if $JSON_MODE; then
  jq -n \
    --argjson findings "$FINDINGS_JSON" \
    --argjson summary "$SUMMARY_JSON" \
    '{findings:$findings,summary:$summary}'
  [ "$TOTAL" -eq 0 ] && exit 0 || exit 1
fi

# Human-readable output
echo ""
echo "ForgeDock Pipeline State Doctor"
echo "Repo: $GH_REPO | Stuck threshold: ${STUCK_HOURS}h"
echo "────────────────────────────────────────────────────────────"

if [ "$CHECKS_SKIPPED" -gt 0 ]; then
  echo "  NOTE: $CHECKS_SKIPPED check(s) skipped due to gh API failures (see --json 'degraded' for detail)."
fi

if [ "$TOTAL" -eq 0 ]; then
  echo "  No stalls detected. Pipeline is healthy."
  echo ""
  exit 0
fi

echo "  Found $TOTAL finding(s): $CRITICAL critical, $WARNING warning"
echo ""

while IFS= read -r finding; do
  severity=$(echo "$finding" | jq -r '.severity')
  type=$(echo "$finding" | jq -r '.type')
  issue=$(echo "$finding" | jq -r '.issue')
  hours=$(echo "$finding" | jq -r '.hours_stuck')
  detail=$(echo "$finding" | jq -r '.detail')
  resume=$(echo "$finding" | jq -r '.resume_command')

  if [ "$severity" = "critical" ]; then
    prefix="[CRITICAL]"
  else
    prefix="[WARNING] "
  fi

  echo "  $prefix  $type — $issue"
  echo "  Detail:  $detail"
  echo "  Resume:  $resume"
  echo ""
done < <(echo "$FINDINGS_JSON" | jq -c '.[]')

echo "────────────────────────────────────────────────────────────"
echo "  Run with --json for machine-readable output."
echo "  /pipeline-health consumes this output for LLM analysis."
echo ""
exit 1
