<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /pipeline-health — Phase 1: Identify Context

## Phase 1: Identify Context

### 1A: Resolve the target project

```bash
# Default to current repo if no argument
if [ -z "$ARGUMENTS" ] || [ "$ARGUMENTS" = "all" ]; then
    REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null)
else
    REPO="$ARGUMENTS"
fi
echo "Target project: $REPO"
```

### 1B: Get the analysis window

```bash
# Last pipeline-health run (if any) — from Forge git log
LAST_RUN=$(cd "$FORGE_HOME" && git log --all --oneline --grep="pipeline-health: $REPO" --format="%aI" -1 2>/dev/null || echo "")
if [ -z "$LAST_RUN" ]; then
    # First run — analyze last 30 days
    SINCE=$(date -d "30 days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -v-30d +%Y-%m-%dT%H:%M:%SZ)
    echo "First health check — analyzing last 30 days"
else
    SINCE="$LAST_RUN"
    echo "Last health check: $LAST_RUN — analyzing since then"
fi
```

### 1C: Load Prior Health Report

Fetch the most recent `health-report` issue for the same repo and parse its metrics for trend computation. This must run before Phase 2 so that PRIOR_* variables are available when Phase 3A builds the trend column.

```bash
# Find the most recent health-report issue for this repo
PRIOR_REPORT=$(gh issue list -R $FORGE_REPO \
  --state all --label "health-report" --limit 10 \
  --json number,title,body \
  --jq "[.[] | select(.title | contains(\"$REPO\"))] | sort_by(.number) | last")

if [ -z "$PRIOR_REPORT" ] || [ "$PRIOR_REPORT" = "null" ]; then
    echo "No prior health report found for $REPO — this is a baseline run. All trends will show '—'."
    PRIOR_HEALTH_SCORE=""
    PRIOR_BUILD_PASS_RATE=""
    PRIOR_FINDINGS_PER_PR=""
    PRIOR_FALSE_POSITIVE_RATE=""
    PRIOR_FIXUP_RATE=""
    PRIOR_SELF_CORRECTION_RATE=""
    PRIOR_ORIGINAL_WORK_RATIO=""
    PRIOR_MILESTONE_MERGE_RATE=""
    PRIOR_POST_DEPLOY_FAILURE_RATE=""
    PRIOR_REVIEW_ESCAPE_RATE=""
    PRIOR_SEC=0; PRIOR_AUTH=0; PRIOR_BILL=0; PRIOR_DB=0; PRIOR_FE=0
    PRIOR_INFRA=0; PRIOR_API=0; PRIOR_CONC=0; PRIOR_SCRP=0; PRIOR_ISSUE_SPEC=0
    PRIOR_TRANSCRIPT_SCORE=""
    PRIOR_SESSION_COUNT=""
    PRIOR_COMPACTION_MEDIAN=""
else
    PRIOR_BODY=$(echo "$PRIOR_REPORT" | jq -r '.body')
    PRIOR_NUMBER=$(echo "$PRIOR_REPORT" | jq -r '.number')
    echo "Prior health report: #$PRIOR_NUMBER — parsing metrics for trend computation"

    # Parse health score: matches "**Health Score**: 78/100" or "Score: 78/100"
    PRIOR_HEALTH_SCORE=$(echo "$PRIOR_BODY" | grep -oP '(?<=\*\*Health Score\*\*: )\d+(?=/100)' | head -1)
    [ -z "$PRIOR_HEALTH_SCORE" ] && PRIOR_HEALTH_SCORE=$(echo "$PRIOR_BODY" | grep -oP '(?<=Score: )\d+(?=/100)' | head -1)

    # Parse metric table rows — format: "| Metric name | VALUE | target | status |"
    # Build pass rate
    PRIOR_BUILD_PASS_RATE=$(echo "$PRIOR_BODY" | grep -i "Build pass rate" | grep -oP '\d+(?=%)' | head -1)
    # Review findings per PR
    PRIOR_FINDINGS_PER_PR=$(echo "$PRIOR_BODY" | grep -i "Review findings per PR" | grep -oP '[0-9]+\.?[0-9]*' | sed -n '2p')
    # False positive rate
    PRIOR_FALSE_POSITIVE_RATE=$(echo "$PRIOR_BODY" | grep -i "False positive rate" | grep -oP '\d+(?=%)' | head -1)
    # Manual fix-up rate
    PRIOR_FIXUP_RATE=$(echo "$PRIOR_BODY" | grep -i "Manual fix-up rate" | grep -oP '\d+(?=%)' | head -1)
    # Pipeline self-correction rate
    PRIOR_SELF_CORRECTION_RATE=$(echo "$PRIOR_BODY" | grep -i "self-correction rate" | grep -oP '\d+(?=%)' | head -1)
    # Original work ratio
    PRIOR_ORIGINAL_WORK_RATIO=$(echo "$PRIOR_BODY" | grep -i "Original work ratio" | grep -oP '\d+(?=%)' | head -1)
    # Milestone merge success
    PRIOR_MILESTONE_MERGE_RATE=$(echo "$PRIOR_BODY" | grep -i "Milestone merge success" | grep -oP '\d+(?=%)' | head -1)
    # Post-deploy failure rate
    PRIOR_POST_DEPLOY_FAILURE_RATE=$(echo "$PRIOR_BODY" | grep -i "Post-deploy failure rate" | grep -oP '\d+(?=%)' | head -1)
    # Review escape rate
    PRIOR_REVIEW_ESCAPE_RATE=$(echo "$PRIOR_BODY" | grep -i "Review escape rate" | grep -oP '\d+(?=%)' | head -1)
    # Transcript health score (from Phase 3C — supplementary signal)
    PRIOR_TRANSCRIPT_SCORE=$(echo "$PRIOR_BODY" | grep -i "Transcript health score" | grep -oP '\d+(?=/100)' | head -1)
    # Pipeline sessions in window (from Transcript Flow Metrics section)
    PRIOR_SESSION_COUNT=$(echo "$PRIOR_BODY" | grep -i "Pipeline sessions parsed" | grep -oP '^\d+' | head -1)
    # Compaction events median (from Aggregated Session Metrics table)
    PRIOR_COMPACTION_MEDIAN=$(echo "$PRIOR_BODY" | grep -i "Context compaction events" | grep -oP '[0-9]+\.?[0-9]*' | head -1)

    # Parse defect category counts from the "Defect Category Breakdown" section
    # Matches table rows like "| SEC | 4 | 22% | ↑ +1 |" or "| SEC | 4 | 22% | — |"
    _parse_cat() {
        echo "$PRIOR_BODY" | grep -P "^\| $1 \|" | grep -oP '(?<=\| )\d+(?= \|)' | head -1
    }
    PRIOR_SEC=$(   _parse_cat "SEC");     [ -z "$PRIOR_SEC" ]        && PRIOR_SEC=0
    PRIOR_AUTH=$(  _parse_cat "AUTH");    [ -z "$PRIOR_AUTH" ]       && PRIOR_AUTH=0
    PRIOR_BILL=$(  _parse_cat "BILL");    [ -z "$PRIOR_BILL" ]       && PRIOR_BILL=0
    PRIOR_DB=$(    _parse_cat "DB");      [ -z "$PRIOR_DB" ]         && PRIOR_DB=0
    PRIOR_FE=$(    _parse_cat "FE");      [ -z "$PRIOR_FE" ]         && PRIOR_FE=0
    PRIOR_INFRA=$( _parse_cat "INFRA");   [ -z "$PRIOR_INFRA" ]      && PRIOR_INFRA=0
    PRIOR_API=$(   _parse_cat "API");     [ -z "$PRIOR_API" ]        && PRIOR_API=0
    PRIOR_CONC=$(  _parse_cat "CONC");    [ -z "$PRIOR_CONC" ]       && PRIOR_CONC=0
    PRIOR_SCRP=$(  _parse_cat "SCRP");    [ -z "$PRIOR_SCRP" ]       && PRIOR_SCRP=0
    PRIOR_ISSUE_SPEC=$(_parse_cat "ISSUE_SPEC"); [ -z "$PRIOR_ISSUE_SPEC" ] && PRIOR_ISSUE_SPEC=0

    echo "Prior health score: ${PRIOR_HEALTH_SCORE:-N/A}"
    echo "Prior defect counts: SEC=$PRIOR_SEC AUTH=$PRIOR_AUTH BILL=$PRIOR_BILL DB=$PRIOR_DB FE=$PRIOR_FE INFRA=$PRIOR_INFRA API=$PRIOR_API CONC=$PRIOR_CONC SCRP=$PRIOR_SCRP ISSUE_SPEC=$PRIOR_ISSUE_SPEC"
    echo "Prior transcript: score=${PRIOR_TRANSCRIPT_SCORE:-N/A} sessions=${PRIOR_SESSION_COUNT:-N/A} compaction_median=${PRIOR_COMPACTION_MEDIAN:-N/A}"
fi

# Helper function: compute trend string for a numeric category count
# Usage: _trend CURRENT PRIOR → outputs "↑ +N", "↓ -N", "=", or "—"
_trend() {
    local current="$1" prior="$2"
    if [ -z "$prior" ] || [ "$prior" = "0" ] && [ "$current" = "0" ]; then
        echo "—"
    elif [ -z "$prior" ]; then
        echo "—"
    elif [ "$current" -gt "$prior" ] 2>/dev/null; then
        echo "↑ +$(( current - prior ))"
    elif [ "$current" -lt "$prior" ] 2>/dev/null; then
        echo "↓ -$(( prior - current ))"
    else
        echo "="
    fi
}
```

### 1D: Run deterministic pipeline-state doctor

Before any LLM analysis, run the deterministic stall-detection script. This costs zero tokens and produces machine-readable findings that Phase 2 and Phase 3 consume directly.

```bash
# Resolve script path (supports repo-local overrides via FORGE_HOME/scripts/)
DOCTOR_SCRIPT="${FORGE_HOME}/scripts/doctor-pipeline-state.sh"
if [ ! -x "$DOCTOR_SCRIPT" ]; then
  DOCTOR_SCRIPT=$(command -v doctor-pipeline-state.sh 2>/dev/null || true)
fi

if [ -n "$DOCTOR_SCRIPT" ] && [ -x "$DOCTOR_SCRIPT" ]; then
  DOCTOR_OUTPUT=$("$DOCTOR_SCRIPT" --repo "$GH_REPO" --json 2>/dev/null || true)
  DOCTOR_FINDINGS=$(echo "$DOCTOR_OUTPUT" | jq '.findings // []' 2>/dev/null || echo "[]")
  DOCTOR_SUMMARY=$(echo "$DOCTOR_OUTPUT" | jq '.summary // {}' 2>/dev/null || echo "{}")
  DOCTOR_CRITICAL=$(echo "$DOCTOR_SUMMARY" | jq '.critical // 0')
  DOCTOR_WARNING=$(echo "$DOCTOR_SUMMARY"  | jq '.warning  // 0')
  echo "Pipeline-state doctor: $DOCTOR_CRITICAL critical, $DOCTOR_WARNING warning"
else
  echo "WARNING: doctor-pipeline-state.sh not found — skipping deterministic stall check"
  DOCTOR_FINDINGS="[]"
  DOCTOR_SUMMARY="{}"
  DOCTOR_CRITICAL=0
  DOCTOR_WARNING=0
fi
```

**If `DOCTOR_CRITICAL > 0`**: Surface these in the Phase 3 analysis and in the Phase 5 report as P0 items. They are invariant violations, not estimates.

**`DOCTOR_FINDINGS`** is a JSON array. Each finding has: `type`, `severity`, `issue`, `label`, `hours_stuck`, `last_annotation`, `resume_command`, `detail`. Use these fields verbatim in the health report — do not paraphrase.

---

