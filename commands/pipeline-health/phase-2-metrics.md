---
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /pipeline-health — Phase 2: Collect Pipeline Metrics

## Phase 2: Collect Pipeline Metrics

Run ALL of these in parallel (note: Phase 2I fetches trajectory comments per issue — run it concurrently with the others but expect it to take longer for large windows; Phase 2K queries persisted audit-agents summaries from Forge's tracking issue and is independent of the target project; Phase 2L queries `audit-finding` labeled issues in the Forge repo and is independent of the target project; Phase 2M scans `~/.claude/history.jsonl` and maps session IDs to JSONL files on disk — it is independent of the target project and completes in <5s for 25K entries; Phase 2N reads local JSONL transcript files using the JSONL Parser Utility and aggregates pipeline flow metrics — it requires Phase 2M to have run first and depends on `SESSION_JSONL_FILES`; Phase 2O extracts per-session structured metrics (phase detection, model distribution, tool call counts, agent spawns) from the same JSONL files — it requires Phase 2N to have run first and reads `TRANSCRIPT_DATA_AVAILABLE` set by Phase 2N; Phase 2P analyzes subagent JSONL files per session, maps each agent to its pipeline role, and computes per-role efficiency metrics — it requires Phase 2O to have run and depends on `TRANSCRIPT_DATA_AVAILABLE` and `SESSION_JSONL_FILES`; Phase 2Q aggregates per-session metrics from Phase 2O into a privacy-safe, report-ready summary — it strips session IDs and content fields, computes distributions, and emits guardrail footnotes — it requires Phase 2O to have run and reads `PER_SESSION_METRICS_RAW`):

### 2A: Forge changelog (what changed in the pipeline itself)

```bash
cd "$FORGE_HOME"
git log --oneline --since="$SINCE" -- commands/ docs/
```

Record each commit — these are the independent variables. Each prompt change is a hypothesis: "this change should improve X."

### 2B: Review finding metrics (the primary quality signal)

```bash
# Total review findings created in window
gh issue list -R $REPO --state all --label "review-finding" --json number,createdAt,labels,title,state \
  --jq "[.[] | select(.createdAt > \"$SINCE\")] | length"

# Breakdown by severity (from title/labels)
gh issue list -R $REPO --state all --label "review-finding" --limit 500 --json number,title,labels,state,createdAt \
  --jq "[.[] | select(.createdAt > \"$SINCE\")]"
```

**Categorize each finding** by its agent prefix (SEC, AUTH, BILL, CONC, SCRP, FE, API, DB, INFRA) extracted from the title or finding tags.

### 2C: Invalidation rate (false positive signal)

```bash
# Review findings that were closed as invalid
gh issue list -R $REPO --state closed --label "review-finding,workflow:invalid" --json number,createdAt \
  --jq "[.[] | select(.createdAt > \"$SINCE\")] | length"

# Total review findings closed in window
gh issue list -R $REPO --state closed --label "review-finding" --json number,createdAt \
  --jq "[.[] | select(.createdAt > \"$SINCE\")] | length"
```

**False positive rate (proxy)** = invalid / total closed. Target: < 10%.

**Note**: This proxy uses `workflow:invalid` as a stand-in for false-positive. Phase 2C.5 reports the actual false-positive rate from the `false-positive` label. Both metrics should be reported; they should converge as validation coverage increases.

### 2C.5: Validation coverage (finding lifecycle health) <!-- Added: forge#1730 -->

Measures whether the `needs-validation → validated/false-positive` lifecycle is operating. This is the primary health signal for the review system's calibration corpus.

```bash
# All finding-issue types: review-finding, staging-review, audit-finding
FINDING_LABELS="review-finding staging-review audit-finding"

TOTAL_FINDINGS=0
TOTAL_VALIDATED=0
TOTAL_FALSE_POSITIVE=0
TOTAL_NEEDS_VALIDATION=0

for LABEL in $FINDING_LABELS; do
  COUNT=$(gh issue list -R $REPO --state all --label "$LABEL" --limit 1000 --json number \
    --jq 'length' 2>/dev/null || echo 0)
  TOTAL_FINDINGS=$((TOTAL_FINDINGS + COUNT))

  VAL=$(gh issue list -R $REPO --state all --label "$LABEL,validated" --limit 1000 --json number \
    --jq 'length' 2>/dev/null || echo 0)
  TOTAL_VALIDATED=$((TOTAL_VALIDATED + VAL))

  FP=$(gh issue list -R $REPO --state all --label "$LABEL,false-positive" --limit 1000 --json number \
    --jq 'length' 2>/dev/null || echo 0)
  TOTAL_FALSE_POSITIVE=$((TOTAL_FALSE_POSITIVE + FP))

  NV=$(gh issue list -R $REPO --state all --label "$LABEL,needs-validation" --limit 1000 --json number \
    --jq 'length' 2>/dev/null || echo 0)
  TOTAL_NEEDS_VALIDATION=$((TOTAL_NEEDS_VALIDATION + NV))
done

TOTAL_RESOLVED=$((TOTAL_VALIDATED + TOTAL_FALSE_POSITIVE))
if [ "$TOTAL_FINDINGS" -gt 0 ]; then
  VALIDATION_COVERAGE_PCT=$(echo "scale=1; $TOTAL_RESOLVED * 100 / $TOTAL_FINDINGS" | bc 2>/dev/null || echo "N/A")
  if [ "$TOTAL_RESOLVED" -gt 0 ]; then
    FALSE_POSITIVE_RATE_PCT=$(echo "scale=1; $TOTAL_FALSE_POSITIVE * 100 / $TOTAL_RESOLVED" | bc 2>/dev/null || echo "N/A")
  else
    FALSE_POSITIVE_RATE_PCT="N/A (no resolved findings)"
  fi
else
  VALIDATION_COVERAGE_PCT="N/A"
  FALSE_POSITIVE_RATE_PCT="N/A"
fi

echo "=== Validation Coverage (2C.5) ==="
echo "Total finding-issues:      $TOTAL_FINDINGS (review-finding + staging-review + audit-finding)"
echo "  validated:               $TOTAL_VALIDATED"
echo "  false-positive:          $TOTAL_FALSE_POSITIVE"
echo "  resolved (total):        $TOTAL_RESOLVED"
echo "  needs-validation (open): $TOTAL_NEEDS_VALIDATION"
echo "Validation coverage:       ${VALIDATION_COVERAGE_PCT}% (target: ≥ 95% for newly closed findings)"
echo "False-positive rate:       ${FALSE_POSITIVE_RATE_PCT}% of resolved findings (actual label-based rate)"
```

**Metrics to compute**:
- **Validation coverage**: (validated + false-positive) / total finding-issues. Target: ≥ 95% for newly closed findings.
- **False-positive rate (actual)**: false-positive / (validated + false-positive). Reports true negative rate, not the `workflow:invalid` proxy from 2C.
- **Unresolved finding count**: Issues still holding `needs-validation` — actionable target for `/cleanup labels` backfill.

**Why this matters**: The `needs-validation` label was previously a dead end — applied at creation, never resolved. With the lifecycle wired (#1730), these metrics become the primary signal for review system calibration quality. Validation coverage < 95% indicates pipeline runs are not completing the verdict transition; false-positive rate is now a reportable number instead of undefined.

### 2D: Build failure rate

```bash
# staging→main PRs and their outcomes
gh pr list -R $REPO --state all --base main --json number,state,mergedAt,createdAt \
  --jq "[.[] | select(.createdAt > \"$SINCE\")] | {total: length, merged: [.[] | select(.mergedAt != null)] | length, failed: [.[] | select(.state == \"CLOSED\" and .mergedAt == null)] | length}"

# milestone→staging PRs and their outcomes
gh pr list -R $REPO --state all --limit 200 --json number,state,mergedAt,createdAt,baseRefName,headRefName \
  --jq "[.[] | select(.createdAt > \"$SINCE\" and .baseRefName == \"staging\" and (.headRefName | startswith(\"milestone/\")))] | {total: length, merged: [.[] | select(.mergedAt != null)] | length, failed: [.[] | select(.state == \"CLOSED\" and .mergedAt == null)] | length}"
```

### 2E: Review findings per PR (density metric)

```bash
# PRs merged in window
MERGED_COUNT=$(gh pr list -R $REPO --state closed --json mergedAt,createdAt \
  --jq "[.[] | select(.mergedAt != null and .createdAt > \"$SINCE\")] | length")

# Review findings created in window
FINDING_COUNT=$(gh issue list -R $REPO --state all --label "review-finding" --json createdAt \
  --jq "[.[] | select(.createdAt > \"$SINCE\")] | length")

echo "Findings per PR: $(echo "scale=2; $FINDING_COUNT / $MERGED_COUNT" | bc 2>/dev/null || echo 'N/A')"
```

Target: < 0.5 findings per PR (meaning most PRs pass clean).

### 2F: Issue lifecycle velocity

```bash
# Average time from issue creation to close (in days) for non-review-findings
gh issue list -R $REPO --state closed --json createdAt,closedAt,labels \
  --jq "[.[] | select(.createdAt > \"$SINCE\" and (.labels | map(.name) | index(\"review-finding\") | not))] | .[].createdAt" | head -20
```

### 2G: Pipeline command usage (which commands are exercised most)

```bash
# Count PR titles and issue comments that reference pipeline actions
gh pr list -R $REPO --state all --limit 200 --json title,createdAt \
  --jq "[.[] | select(.createdAt > \"$SINCE\")] | [.[].title] | group_by(. | split(\":\" )[0]) | map({prefix: .[0] | split(\":\")[0], count: length}) | sort_by(-.count)"
```

### 2H: Manual fix-up commits (builder completeness signal)

The pipeline builds a PR, but sometimes a human must intervene on the same branch to patch gaps the builder missed. These fix-up commits are a direct measure of builder completeness.

**Detection strategy**:

```bash
# For each PR merged in the window, get the full commit list with authors
MERGED_PRS=$(gh pr list -R $REPO --state closed --limit 100 --json number,headRefName,mergedAt,createdAt \
  --jq "[.[] | select(.mergedAt != null and .createdAt > \"$SINCE\")] | .[].number")

for PR in $MERGED_PRS; do
  # Get all commits on this PR
  gh api /repos/$REPO/pulls/$PR/commits \
    --jq '.[] | {sha: .sha[0:7], author: .author.login, message: .commit.message | split("\n")[0], date: .commit.author.date}'
done
```

**Classification rules** — for each PR's commit list:

1. **Pipeline commit**: author is the project bot account, or commit message matches Forge conventional-commit pattern (`Fix:`, `Feat:`, `Refactor:` with issue reference).
2. **Manual fix-up commit**: author is a human AND the commit appears AFTER the initial pipeline commits on the same PR AND the message indicates a correction (e.g., contains "fix", "patch", "missing", "forgot", "actually", "also need", "oops", or references the same component the pipeline just touched).
3. **Intentional human commit**: human commit that is clearly additive scope (new feature, unrelated change) — exclude from fix-up count.

When ambiguous, read the commit message and diff summary to determine if the human was correcting a pipeline gap or adding new scope.

**Also classify PRs by origin** — for each merged PR, determine if it is:
- **Original work**: primary feature/bug PR from an issue
- **Review-finding fix**: PR that fixes a review-finding issue (references a `review-finding` labeled issue)
- **Squash regression fix**: PR whose title/body indicates restoring code lost during a milestone squash merge

**Metrics to compute**:
- **Fix-up rate**: PRs with ≥1 manual fix-up commit / total pipeline-built PRs. Target: < 15%.
- **Fix-up density**: total manual fix-up commits / total pipeline-built PRs. Target: < 0.3.
- **Pipeline self-correction rate**: review-finding fix PRs / original work PRs. Target: < 15%.
- **Squash regression rate**: squash regression fix PRs / total PRs. Target: 0%.
- **Original work ratio**: original work PRs / total PRs. Target: > 70%.
- **Fix-up categories**: group by what was missing (config sync, edge case, test gap, incomplete refactor, wrong API usage, UI polish).

**Why this matters**: Review findings catch defects post-build. Fix-up commits reveal defects the builder produced that were caught informally (by the developer, by testing, or by deploy failure) — these are "silent" quality gaps that review findings don't capture. The PR composition breakdown shows how much pipeline capacity goes to forward progress vs self-correction.

### 2I: Trajectory analytics (pipeline completeness signal)

`FORGE:TRAJECTORY` comments are posted on every completed issue by `/work-on`. They contain the per-issue phase table, investigation verdict, task type, key decisions, and anomalies. Aggregating these reveals investigation accuracy, task type distribution, and anomaly patterns — signals invisible to the PR/issue label metrics above.

**Note**: This section makes ~1 API call per closed issue in the window (to fetch comments). For windows with 100+ issues this can take 2–3 minutes.

```bash
# Collect all issues closed in the window
CLOSED_ISSUES=$(gh issue list -R $REPO --state closed --limit 100 --json number,closedAt \
  --jq "[.[] | select(.closedAt > \"$SINCE\")] | .[].number")

# Accumulators
TRAJ_TOTAL=0
TRAJ_CONFIRMED=0
TRAJ_PARTIAL=0
TRAJ_INVALID=0
declare -A TASK_TYPE_COUNTS
ANOMALY_STRINGS=()

for NUM in $CLOSED_ISSUES; do
  TRAJ=$(gh api repos/$REPO/issues/$NUM/comments \
    --jq '.[] | select(.body | contains("FORGE:TRAJECTORY")) | .body' 2>/dev/null)

  # Skip issues with no trajectory comment (pre-pipeline or manually closed)
  [ -z "$TRAJ" ] && continue

  TRAJ_TOTAL=$((TRAJ_TOTAL + 1))

  # Parse investigation verdict from the phase table row
  # Matches: "| Phase 1: Investigation | ✅ CONFIRMED (HIGH) |" or "✅ PARTIAL (MEDIUM) |" etc.
  VERDICT=$(echo "$TRAJ" | grep -oP '(?<=Investigation \| ✅ )(CONFIRMED|PARTIAL|INVALID)' | head -1)
  case "$VERDICT" in
    CONFIRMED) TRAJ_CONFIRMED=$((TRAJ_CONFIRMED + 1)) ;;
    PARTIAL)   TRAJ_PARTIAL=$((TRAJ_PARTIAL + 1)) ;;
    INVALID)   TRAJ_INVALID=$((TRAJ_INVALID + 1)) ;;
  esac

  # Parse task type from "Task type: Feature" or "Task type: Bug Fix"
  TASK_TYPE=$(echo "$TRAJ" | grep -oP '(?<=Task type: )[^\|]+' | tr -d ' ' | head -1)
  if [ -n "$TASK_TYPE" ]; then
    TASK_TYPE_COUNTS[$TASK_TYPE]=$(( ${TASK_TYPE_COUNTS[$TASK_TYPE]:-0} + 1 ))
  fi

  # Collect non-None anomaly strings
  ANOMALY=$(echo "$TRAJ" | grep -oP '(?<=\*\*Anomalies\*\*: )(?!None)[^\n]+' | head -1)
  [ -n "$ANOMALY" ] && ANOMALY_STRINGS+=("$NUM: $ANOMALY")
done

# Compute investigation accuracy rate (CONFIRMED + PARTIAL) / total
TRAJ_ACCURATE=$((TRAJ_CONFIRMED + TRAJ_PARTIAL))
if [ "$TRAJ_TOTAL" -gt 0 ]; then
  echo "Trajectory coverage: $TRAJ_TOTAL / $(echo "$CLOSED_ISSUES" | wc -w) closed issues"
  echo "Investigation accuracy: $TRAJ_ACCURATE / $TRAJ_TOTAL ($(echo "scale=0; $TRAJ_ACCURATE * 100 / $TRAJ_TOTAL" | bc)%)"
  echo "  CONFIRMED: $TRAJ_CONFIRMED | PARTIAL: $TRAJ_PARTIAL | INVALID: $TRAJ_INVALID"
  echo ""
  echo "Task type distribution:"
  for TT in "${!TASK_TYPE_COUNTS[@]}"; do
    echo "  $TT: ${TASK_TYPE_COUNTS[$TT]}"
  done
  echo ""
  echo "Anomalies flagged: ${#ANOMALY_STRINGS[@]}"
  for A in "${ANOMALY_STRINGS[@]}"; do echo "  - Issue $A"; done
else
  echo "No FORGE:TRAJECTORY comments found in window — no trajectory data available"
fi
```

**Metrics to compute**:
- **Investigation accuracy rate**: (CONFIRMED + PARTIAL) / total issues with trajectory. Target: > 85%.
- **INVALID rate**: INVALID / total. Target: < 15% (same as Phase 2J invalidation rate — these should converge).
- **Task type distribution**: counts of Bug Fix / Feature / Refactor / Maintenance. Reveals whether the pipeline is doing forward-progress work or mostly self-correction.
- **Anomaly count**: total issues with non-None anomaly strings. Target: < 10% of window. High anomaly rates indicate pipeline instability.

**Why this matters**: Labels tell you what issues are in what state. Trajectory comments tell you *why* — what the investigator concluded, what anomalies were hit, and what decisions were made. Investigation accuracy is the deepest signal for whether the investigation phase is operating correctly. Task type distribution shows whether the pipeline is delivering forward-progress work (Feature/Bug Fix) vs. churn (Refactor/Maintenance cycles).

### 2J: Issue quality metrics (pipeline entry-point signal)

Bad issues — vague descriptions, missing files, wrong domains — cause cascading failures: wasted investigation, incomplete fixes, and audit findings classified as `ISSUE_SPEC`. This section measures how healthy the pipeline's entry point is.

```bash
# 1. Investigation invalidation rate
# Issues closed as workflow:invalid (excluding review-findings — those are tracked in 2C)
INVALID_ISSUES=$(gh issue list -R $REPO --state closed --label "workflow:invalid" --limit 500 --json number,createdAt,labels \
  --jq "[.[] | select(.createdAt > \"$SINCE\" and (.labels | map(.name) | index(\"review-finding\") | not))] | length")

TOTAL_INVESTIGATED=$(gh issue list -R $REPO --state all --limit 500 --json number,createdAt,labels \
  --jq "[.[] | select(.createdAt > \"$SINCE\" and (.labels | map(.name) | any(. == \"workflow:investigating\" or . == \"workflow:building\" or . == \"workflow:in-review\" or . == \"workflow:merged\" or . == \"workflow:invalid\")))  ] | length")

echo "Investigation invalidation rate: $INVALID_ISSUES / $TOTAL_INVESTIGATED"
# Target: < 15%

# 2. ISSUE_SPEC audit findings
# Count of /audit findings classified as ISSUE_SPEC in the window
ISSUE_SPEC_COUNT=$(gh issue list -R $FORGE_REPO --state all --label "audit-finding" --limit 200 \
  --json number,title,body,createdAt \
  --jq "[.[] | select(.createdAt > \"$SINCE\" and (.body | contains(\"ISSUE_SPEC\")))] | length")

echo "ISSUE_SPEC audit findings: $ISSUE_SPEC_COUNT"
# Target: 0. Any ISSUE_SPEC finding means /issue adoption is insufficient or issue quality is degraded.

# 3. Re-investigation rate
# Issues where FORGE:INVESTIGATOR comment was deleted and recreated (interrupted investigation → restart)
# Proxy: issues that were labeled workflow:investigating more than once (check via timeline events)
REINVESTIGATED=$(gh issue list -R $REPO --state all --limit 500 --json number,createdAt \
  --jq "[.[] | select(.createdAt > \"$SINCE\")] | .[].number" | while read NUM; do
    # Check if issue has timeline events showing workflow:investigating label added 2+ times
    INVEST_EVENTS=$(gh api repos/$REPO/issues/$NUM/timeline \
      --jq '[.[] | select(.event == "labeled" and .label.name == "workflow:investigating")] | length' 2>/dev/null || echo 0)
    if [ "$INVEST_EVENTS" -gt 1 ] 2>/dev/null; then echo "$NUM"; fi
done | wc -l)

echo "Re-investigation count: $REINVESTIGATED"
# Target: 0. Each re-investigation signals the original issue spec was unclear or wrong.

# 4. Issue structure compliance (/issue adoption proxy)
# Issues created in window that have an "Affected Files" section in their body
TOTAL_ISSUES=$(gh issue list -R $REPO --state all --limit 500 --json number,createdAt,labels \
  --jq "[.[] | select(.createdAt > \"$SINCE\" and (.labels | map(.name) | index(\"review-finding\") | not))] | length")

STRUCTURED_ISSUES=$(gh issue list -R $REPO --state all --limit 500 --json number,createdAt,body,labels \
  --jq "[.[] | select(.createdAt > \"$SINCE\" and (.labels | map(.name) | index(\"review-finding\") | not) and (.body | contains(\"Affected Files\")))] | length")

echo "Issue structure compliance: $STRUCTURED_ISSUES / $TOTAL_ISSUES"
# Target: > 80%. Issues without Affected Files are harder to investigate and more likely to produce ISSUE_SPEC failures.
```

**Issue quality score** = weighted average of sub-metrics:
- Invalidation rate: 40% weight (direct signal — these issues failed)
- ISSUE_SPEC audit findings: 30% weight (downstream cost signal)
- Re-investigation rate: 20% weight (process cost signal)
- Structure compliance: 10% weight (adoption/leading indicator)

**Why this matters**: The investigation phase can only be as good as the issue it receives. A 20% invalidation rate means 1 in 5 investigations was a complete waste. ISSUE_SPEC audit findings are the downstream cost of bad issues reaching production. Tracking these signals closes the loop between issue creation quality and pipeline output quality.

### 2K: Orchestration efficiency (agent throughput signal)

`/audit-agents` measures per-run agent efficiency (idle%, resume cycles, stall boundaries) but produces ephemeral output. This section collects persisted `<!-- FORGE:AUDIT-AGENTS -->` summary comments (posted by `audit-agents --persist`) from the Forge tracking issue and aggregates them into pipeline-wide efficiency metrics. If no persisted data exists, it falls back to mining resume-cycle anomalies from FORGE:TRAJECTORY comments collected in Phase 2I.

**Step 1 — Query persisted audit-agents summaries**:

```bash
# Persisted audit-agents summaries are posted to a designated Forge tracking issue
# tagged with label "orchestration-metrics". Find it:
TRACKING_ISSUE=$(gh issue list -R $FORGE_REPO \
  --state open --label "orchestration-metrics" --limit 1 \
  --json number --jq '.[0].number' 2>/dev/null)

if [ -n "$TRACKING_ISSUE" ]; then
  # Fetch all FORGE:AUDIT-AGENTS comments posted since $SINCE
  AUDIT_COMMENTS=$(gh api repos/$FORGE_REPO/issues/$TRACKING_ISSUE/comments \
    --jq "[.[] | select(.body | contains(\"FORGE:AUDIT-AGENTS\")) | select(.created_at > \"$SINCE\")]")
  echo "Found $(echo "$AUDIT_COMMENTS" | jq 'length') persisted audit-agents summaries in window"
else
  echo "No orchestration-metrics tracking issue found — skipping persisted data query"
  AUDIT_COMMENTS="[]"
fi
```

**Step 2 — Extract metrics from persisted summaries**:

Each `<!-- FORGE:AUDIT-AGENTS -->` comment contains a structured block (posted by `audit-agents --persist`) with these fields:

```
Session: {SESSION_ID}
Date: {ISO_TIMESTAMP}
Agents: {TOTAL_AGENT_COUNT}
Avg idle%: {VALUE}
Avg resumes: {VALUE}
Clean agents: {N}/{TOTAL}
Stall boundaries: {boundary_1}({count}), {boundary_2}({count}), ...
```

```bash
# Parse each comment and accumulate metrics
ORCH_SESSIONS=0
ORCH_TOTAL_IDLE=0
ORCH_TOTAL_RESUMES=0
ORCH_CLEAN_AGENTS=0
ORCH_TOTAL_AGENTS=0
declare -A STALL_BOUNDARY_COUNTS

echo "$AUDIT_COMMENTS" | jq -r '.[] | .body + "\u0000"' | while IFS= read -r -d $'\0' COMMENT; do
  ORCH_SESSIONS=$((ORCH_SESSIONS + 1))

  AVG_IDLE=$(echo "$COMMENT" | grep -oP '(?<=Avg idle%: )[0-9.]+' | head -1)
  AVG_RESUMES=$(echo "$COMMENT" | grep -oP '(?<=Avg resumes: )[0-9.]+' | head -1)
  CLEAN=$(echo "$COMMENT" | grep -oP '(?<=Clean agents: )\d+' | head -1)
  TOTAL=$(echo "$COMMENT" | grep -oP '(?<=Clean agents: \d{1,3}\/)\d+' | head -1)

  [ -n "$AVG_IDLE" ] && ORCH_TOTAL_IDLE=$(echo "$ORCH_TOTAL_IDLE + $AVG_IDLE" | bc)
  [ -n "$AVG_RESUMES" ] && ORCH_TOTAL_RESUMES=$(echo "$ORCH_TOTAL_RESUMES + $AVG_RESUMES" | bc)
  [ -n "$CLEAN" ] && ORCH_CLEAN_AGENTS=$((ORCH_CLEAN_AGENTS + CLEAN))
  [ -n "$TOTAL" ] && ORCH_TOTAL_AGENTS=$((ORCH_TOTAL_AGENTS + TOTAL))

  # Accumulate stall boundary counts
  BOUNDARIES=$(echo "$COMMENT" | grep -oP '(?<=Stall boundaries: )[^\n]+' | head -1)
  # Format: "investigate→build(4), context→architect(3)"
  echo "$BOUNDARIES" | grep -oP '[a-z→]+\(\d+\)' | while IFS= read -r ENTRY; do
    BOUNDARY=$(echo "$ENTRY" | grep -oP '^[a-z→]+')
    COUNT=$(echo "$ENTRY" | grep -oP '\d+')
    STALL_BOUNDARY_COUNTS[$BOUNDARY]=$(( ${STALL_BOUNDARY_COUNTS[$BOUNDARY]:-0} + COUNT ))
  done
done

# Compute aggregate metrics
if [ "$ORCH_SESSIONS" -gt 0 ]; then
  AVG_IDLE_OVERALL=$(echo "scale=1; $ORCH_TOTAL_IDLE / $ORCH_SESSIONS" | bc)
  AVG_RESUMES_OVERALL=$(echo "scale=2; $ORCH_TOTAL_RESUMES / $ORCH_SESSIONS" | bc)
  CLEAN_RATE=$(echo "scale=0; $ORCH_CLEAN_AGENTS * 100 / $ORCH_TOTAL_AGENTS" | bc 2>/dev/null || echo "N/A")
  echo "Orchestration efficiency ($ORCH_SESSIONS sessions, $ORCH_TOTAL_AGENTS agents):"
  echo "  Avg idle%: $AVG_IDLE_OVERALL% (target: < 30%)"
  echo "  Avg resumes per agent: $AVG_RESUMES_OVERALL (target: < 1)"
  echo "  Clean agent rate: $CLEAN_RATE% (target: > 60%)"
  echo "  Top stall boundaries:"
  for B in "${!STALL_BOUNDARY_COUNTS[@]}"; do
    echo "    $B: ${STALL_BOUNDARY_COUNTS[$B]} occurrences"
  done | sort -t: -k2 -rn | head -5
  ORCH_DATA_AVAILABLE=true
else
  echo "No persisted audit-agents data in window"
  ORCH_DATA_AVAILABLE=false
fi
```

**Step 3 — Fallback: mine FORGE:TRAJECTORY for resume-cycle signals**:

If `$ORCH_DATA_AVAILABLE` is false (no persisted summaries), use the trajectory data already collected in Phase 2I as a proxy. FORGE:TRAJECTORY `**Anomalies**` strings from `/work-on` often include resume cycle counts and stall descriptions.

```bash
if [ "$ORCH_DATA_AVAILABLE" = "false" ]; then
  echo "Falling back to FORGE:TRAJECTORY anomaly mining for orchestration proxy signals"
  # Count how many trajectory issues had anomalies mentioning "resume" or "stall"
  RESUME_ANOMALIES=0
  for A in "${ANOMALY_STRINGS[@]}"; do
    echo "$A" | grep -qi 'resume\|stall\|end.turn\|routing' && RESUME_ANOMALIES=$((RESUME_ANOMALIES + 1))
  done
  echo "Issues with resume/stall anomalies in trajectory: $RESUME_ANOMALIES / $TRAJ_TOTAL"
  echo "(Proxy only — run 'audit-agents --persist' after orchestration runs for full efficiency data)"
fi
```

**Metrics to compute**:
- **Avg agent idle%**: average idle time percentage across all agents in all sessions. Target: < 30%.
- **Avg resume cycles per agent**: how often orchestrator must resume stalled agents. Target: < 1.
- **Clean agent rate**: % of agents that complete without any stalls. Target: > 60%.
- **Top stall boundaries**: which phase transitions cause the most stalls (e.g., investigate→build, context→architect). No target — use for diagnosis.

**Why this matters**: Outcome metrics (findings per PR, fix-up rate) measure what the pipeline produces. Orchestration efficiency measures how much wasted motion occurs getting there. An agent that takes 40 minutes to do 8 minutes of actual work has 80% idle time — all of which is pipeline overhead. Reducing stall time directly improves throughput without changing code quality. This is the only metric that reveals whether the routing loop in `work-on.md` is functioning or causing agents to stop and wait.

**Step 4 — Batch stall rate (from FORGE:STALL_DETECTED annotations)**:

Query issues that received a `<!-- FORGE:STALL_DETECTED -->` comment within the analysis window. This measures how often the orchestrator's time-based stall detector fired — distinct from the resume-cycle count (which comes from completion-event stalls).

```bash
# Denominator: issues that entered the pipeline in the window (have any workflow:* label)
# Using pipeline-active issues avoids inflating the denominator with all 500 issues in window
BATCH_TOTAL=$(gh issue list -R $GH_REPO \
  --state all --limit 500 \
  --json number,createdAt,labels \
  --jq "[.[] | select(.createdAt > \"$SINCE\") | select(.labels | map(.name) | any(startswith(\"workflow:\")))] | length" \
  2>/dev/null || echo 0)

# Enumerate pipeline-active issue numbers for per-issue comment queries
PIPELINE_ISSUE_NUMS=$(gh issue list -R $GH_REPO \
  --state all --limit 500 \
  --json number,createdAt,labels \
  --jq "[.[] | select(.createdAt > \"$SINCE\") | select(.labels | map(.name) | any(startswith(\"workflow:\"))) | .number]" \
  2>/dev/null || echo "[]")

# Count issues with at least one FORGE:STALL_DETECTED comment
# Use wc -l pattern (not variable accumulation) to avoid bash subshell scope loss
STALL_COUNT=$(echo "$PIPELINE_ISSUE_NUMS" | jq -r '.[]' | while read -r NUM; do
  STALL_COMMENTS=$(gh api repos/$GH_REPO/issues/${NUM}/comments \
    --jq '[.[] | select(.body | contains("FORGE:STALL_DETECTED"))] | length' 2>/dev/null || echo 0)
  [ "$STALL_COMMENTS" -gt 0 ] && echo "$NUM"
done | wc -l)

# Count issues that escalated (2+ stall comments = auto-resume exhausted)
ESCALATED_COUNT=$(echo "$PIPELINE_ISSUE_NUMS" | jq -r '.[]' | while read -r NUM; do
  STALL_COMMENTS=$(gh api repos/$GH_REPO/issues/${NUM}/comments \
    --jq '[.[] | select(.body | contains("FORGE:STALL_DETECTED"))] | length' 2>/dev/null || echo 0)
  [ "$STALL_COMMENTS" -ge 2 ] && echo "$NUM"
done | wc -l)

# Compute batch stall rate
if [ "$BATCH_TOTAL" -gt 0 ]; then
  BATCH_STALL_RATE=$(echo "scale=1; $STALL_COUNT * 100 / $BATCH_TOTAL" | bc 2>/dev/null || echo "N/A")
  echo "Batch stall rate: ${BATCH_STALL_RATE}% (${STALL_COUNT}/${BATCH_TOTAL} pipeline issues stalled) — target: < 10%"
  echo "Escalated to needs-human: ${ESCALATED_COUNT} issues"
else
  BATCH_STALL_RATE="N/A"
  echo "Batch stall rate: N/A (no pipeline issues in window or FORGE:STALL_DETECTED not yet deployed)"
fi
export BATCH_STALL_RATE STALL_COUNT BATCH_TOTAL ESCALATED_COUNT
```

**Target**: `BATCH_STALL_RATE` < 10% (stalled issues / total issues in window). A rate above 10% indicates systemic pipeline unreliability — agents stopping without reaching terminal state frequently enough to require orchestrator intervention.

**Note**: `BATCH_STALL_RATE` requires `FORGE:STALL_DETECTED` comments, which are written by the stall detector in `/orchestrate` Step 4B.5. If the stall detector is not deployed, this metric returns N/A and falls back to the resume-cycle proxy from Step 3.

### 2L: Post-deploy failure metrics (pipeline escape signal)

`/audit` creates `audit-finding` labeled issues in the Forge repo whenever a defect escapes the pipeline and reaches staging or production. Each finding is tagged with a `**Failure point**:` field indicating which pipeline phase failed (INVESTIGATION, IMPLEMENTATION, REVIEW, REVIEW_FALSE_NEG, DEPLOY_GATE, etc.). Aggregating these reveals the post-deploy defect rate and review escape rate — signals invisible to the pre-merge metrics above.

**Why this matters**: Build pass rate measures whether PRs merge successfully. Post-deploy failure rate measures whether those merged PRs actually work correctly in production. The health score can read 90+ while production failures accumulate if post-deploy data is excluded. Review escape rate directly measures review agent effectiveness: a REVIEW_FALSE_NEG finding means the review agent saw the change but approved a defect — the most actionable failure mode.

```bash
# All audit-finding issues created in the window
AUDIT_FINDINGS=$(gh issue list -R $FORGE_REPO --state all --label "audit-finding" \
  --limit 200 --json number,title,body,createdAt \
  --jq "[.[] | select(.createdAt > \"$SINCE\")]")

AUDIT_TOTAL=$(echo "$AUDIT_FINDINGS" | jq 'length')
echo "Audit findings in window: $AUDIT_TOTAL"

# Post-deploy failure rate = audit findings / PRs merged in window
# (MERGED_COUNT computed in Phase 2E)
if [ "$MERGED_COUNT" -gt 0 ] && [ "$AUDIT_TOTAL" -gt 0 ]; then
  echo "Post-deploy failure rate: $(echo "scale=1; $AUDIT_TOTAL * 100 / $MERGED_COUNT" | bc)% (target: < 5%)"
else
  echo "Post-deploy failure rate: 0% (no audit findings in window)"
fi

# Review escape rate = REVIEW_FALSE_NEG findings / PRs merged in window
REVIEW_ESCAPE_COUNT=$(echo "$AUDIT_FINDINGS" | \
  jq '[.[] | select(.body | test("\\*\\*Failure point\\*\\*:.*REVIEW_FALSE_NEG"))] | length')
echo "Review escape count: $REVIEW_ESCAPE_COUNT"
if [ "$MERGED_COUNT" -gt 0 ]; then
  echo "Review escape rate: $(echo "scale=1; $REVIEW_ESCAPE_COUNT * 100 / $MERGED_COUNT" | bc)% (target: < 2%)"
fi

# Failure category distribution (by Failure point field)
echo ""
echo "Failure point distribution:"
echo "$AUDIT_FINDINGS" | jq -r \
  '.[] | .body | capture("\\*\\*Failure point\\*\\*: *(?<fp>[^\\n]+)").fp // "UNKNOWN"' \
  | sort | uniq -c | sort -rn

# Mean time to detect (days between issue createdAt and linked PR's mergedAt)
# Simplified: use audit finding createdAt as proxy for detection time relative to window start
# Full MTTD requires joining audit-finding body for the source PR number and querying its mergedAt
echo ""
echo "Mean time to detect (proxy — days from window open to finding creation):"
echo "$AUDIT_FINDINGS" | jq -r \
  --arg since "$SINCE" \
  '[.[] | {days: ((.createdAt | fromdateiso8601) - ($since | fromdateiso8601)) / 86400}] | if length > 0 then (map(.days) | add / length) else 0 end' \
  | awk '{printf "%.1f days\n", $1}'

# Severity breakdown (P1 vs P2 vs P3 from labels)
echo ""
echo "Severity breakdown:"
gh issue list -R $FORGE_REPO --state all --label "audit-finding" \
  --limit 200 --json number,createdAt,labels \
  --jq "[.[] | select(.createdAt > \"$SINCE\")] | group_by(.labels | map(.name) | map(select(startswith(\"P\"))) | .[0]) | map({severity: .[0].labels | map(.name) | map(select(startswith(\"P\"))) | .[0], count: length})"
```

**Metrics to compute**:
- **Post-deploy failure rate**: audit findings in window / PRs merged in window. Target: < 5%. Each finding represents a defect that passed the full pipeline and required post-merge remediation.
- **Review escape rate**: REVIEW_FALSE_NEG findings / PRs merged in window. Target: < 2%. This is the most direct measure of review agent effectiveness — these are defects the review agent saw but approved.
- **Failure category distribution**: breakdown by failure point (INVESTIGATION, IMPLEMENTATION, REVIEW, REVIEW_FALSE_NEG, DEPLOY_GATE, etc.). No target — use for diagnosis. High IMPLEMENTATION counts indicate builder gaps; high REVIEW_FALSE_NEG counts indicate review agent gaps.
- **Mean time to detect (MTD)**: average days from PR merge to audit-finding creation. Target: < 7 days. Long MTD means defects linger undetected in production.

### 2M.5: Review intensity distribution and escaped-defect rate by tier <!-- Added: forge#1745 -->

This metric is only meaningful once `scripts/calibration.mjs --provenance` has been publishing to the `forge-knowledge` branch for at least one 30-day shadow-mode window. Before that point, all PRs have `INTENSITY_TIER=SHADOW` in their FORGE:REVIEW annotations and both tier buckets will be empty — this is expected and correct.

**Why this matters**: Review spend should track risk. This metric verifies that the trust escalation system is working as intended: proven cells should have lower escaped-defect rates than novel cells, and overall review token cost per PR should trend down while escaped-defect rate stays flat or falls.

**Success metric**: Review token cost per PR trending down (fewer agents on proven PRs) while escaped-defect rate (14-day post-merge review-findings) stays flat or falls; zero escapes attributable to a dropped agent that the full panel would have run.

```bash
# Collect FORGE:REVIEW annotation INTENSITY_TIER fields from merged PRs in the analysis window.
# Source: the APPROVED:/CHANGES REQUESTED: PR comment from review-pr.md Phase 7B.
# Field format (set since forge#1745): "**Intensity tier**: PROVEN | **Cell**: `...` | **Shadow mode**: false"
#
# This relies on MERGED_PRS (list of PR numbers) being available from Phase 2E.
# If not available, fall back to gh pr list.
if [ -z "${MERGED_PRS:-}" ]; then
  MERGED_PRS=$(gh pr list -R "$FORGE_REPO" --state merged --limit 200 \
    --json number,mergedAt \
    --jq "[.[] | select(.mergedAt > \"$SINCE\")] | .[].number" 2>/dev/null || echo "")
fi

# Accumulators per intensity tier
TIER_NOVEL_COUNT=0
TIER_PROVEN_COUNT=0
TIER_SHADOW_COUNT=0
TIER_NOVEL_NEEDS_HUMAN_COUNT=0
TIER_NOVEL_ESCAPES=0
TIER_PROVEN_ESCAPES=0

# Also track escaped defect counts per tier using the audit-finding ledger from 2L.
# AUDIT_FINDINGS must be set from Phase 2L (contains audit-finding issues in window).
AUDIT_FINDINGS_AVAILABLE="${AUDIT_FINDINGS:+true}"

while IFS= read -r PR_NUM; do
  [ -z "$PR_NUM" ] && continue

  # Read the FORGE:REVIEW comment from this PR to extract INTENSITY_TIER
  REVIEW_COMMENT=$(gh api "repos/${FORGE_REPO}/issues/${PR_NUM}/comments" \
    --jq '[.[] | select(
      (.body | test("APPROVED:|CHANGES REQUESTED:"; "i")) and
      (.body | contains("Intensity tier"))
    )] | last | .body // ""' 2>/dev/null || echo "")

  if [ -z "$REVIEW_COMMENT" ]; then
    TIER_SHADOW_COUNT=$((TIER_SHADOW_COUNT + 1))
    continue
  fi

  PR_TIER=$(echo "$REVIEW_COMMENT" | grep -oP '(?<=\*\*Intensity tier\*\*: )[A-Z_]+' | head -1 || echo "SHADOW")
  case "$PR_TIER" in
    PROVEN)              TIER_PROVEN_COUNT=$((TIER_PROVEN_COUNT + 1)) ;;
    NOVEL_NEEDS_HUMAN)   TIER_NOVEL_NEEDS_HUMAN_COUNT=$((TIER_NOVEL_NEEDS_HUMAN_COUNT + 1))
                         TIER_NOVEL_COUNT=$((TIER_NOVEL_COUNT + 1)) ;;
    NOVEL)               TIER_NOVEL_COUNT=$((TIER_NOVEL_COUNT + 1)) ;;
    *)                   TIER_SHADOW_COUNT=$((TIER_SHADOW_COUNT + 1)) ;;
  esac

  # Cross-reference escaped defects for this PR's files (from 2L AUDIT_FINDINGS)
  # A REVIEW_FALSE_NEG audit-finding referencing PR #{PR_NUM} counts as an escape for this tier.
  if [ "$AUDIT_FINDINGS_AVAILABLE" = "true" ]; then
    ESCAPE_COUNT=$(echo "$AUDIT_FINDINGS" | \
      jq --argjson pr "$PR_NUM" '[.[] | select(
        (.body | test("\\*\\*Failure point\\*\\*:.*REVIEW_FALSE_NEG")) and
        (.body | test("#" + ($pr | tostring)))
      )] | length' 2>/dev/null || echo "0")

    if [ "${ESCAPE_COUNT:-0}" -gt 0 ]; then
      case "$PR_TIER" in
        PROVEN) TIER_PROVEN_ESCAPES=$((TIER_PROVEN_ESCAPES + ESCAPE_COUNT)) ;;
        NOVEL|NOVEL_NEEDS_HUMAN) TIER_NOVEL_ESCAPES=$((TIER_NOVEL_ESCAPES + ESCAPE_COUNT)) ;;
      esac
    fi
  fi
done <<< "$MERGED_PRS"

TIER_TOTAL=$((TIER_NOVEL_COUNT + TIER_PROVEN_COUNT + TIER_SHADOW_COUNT + TIER_NOVEL_NEEDS_HUMAN_COUNT))

echo ""
echo "=== Review Intensity Distribution (forge#1745 — provenance trust) ==="
echo "Window: ${SINCE} → now | Total PRs: ${TIER_TOTAL}"
echo ""
echo "Tier distribution:"
printf "  %-22s %4d  (%s%%)\n" "PROVEN (de-escalated):" "$TIER_PROVEN_COUNT" \
  "$([ "$TIER_TOTAL" -gt 0 ] && echo "scale=0; $TIER_PROVEN_COUNT * 100 / $TIER_TOTAL" | bc || echo "0")"
printf "  %-22s %4d  (%s%%)\n" "NOVEL (full panel):" "$TIER_NOVEL_COUNT" \
  "$([ "$TIER_TOTAL" -gt 0 ] && echo "scale=0; $TIER_NOVEL_COUNT * 100 / $TIER_TOTAL" | bc || echo "0")"
printf "  %-22s %4d  (%s%%)\n" "SHADOW (no action yet):" "$TIER_SHADOW_COUNT" \
  "$([ "$TIER_TOTAL" -gt 0 ] && echo "scale=0; $TIER_SHADOW_COUNT * 100 / $TIER_TOTAL" | bc || echo "0")"

echo ""
echo "Escaped-defect rate by tier (REVIEW_FALSE_NEG audit-findings):"
if [ "$TIER_PROVEN_COUNT" -gt 0 ]; then
  PROVEN_ESCAPE_RATE=$(echo "scale=1; $TIER_PROVEN_ESCAPES * 100 / $TIER_PROVEN_COUNT" | bc 2>/dev/null || echo "N/A")
  echo "  PROVEN: ${TIER_PROVEN_ESCAPES} escapes / ${TIER_PROVEN_COUNT} PRs = ${PROVEN_ESCAPE_RATE}% (target: ≤ review-wide escape rate)"
else
  echo "  PROVEN: no PRs in this tier yet"
fi
if [ "$TIER_NOVEL_COUNT" -gt 0 ]; then
  NOVEL_ESCAPE_RATE=$(echo "scale=1; $TIER_NOVEL_ESCAPES * 100 / $TIER_NOVEL_COUNT" | bc 2>/dev/null || echo "N/A")
  echo "  NOVEL:  ${TIER_NOVEL_ESCAPES} escapes / ${TIER_NOVEL_COUNT} PRs = ${NOVEL_ESCAPE_RATE}%"
else
  echo "  NOVEL: no PRs in this tier yet"
fi

# Health signal: if PROVEN escape rate > NOVEL escape rate, the de-escalation is leaking.
# This should never happen in steady state — flag it if it does.
if [ "$TIER_PROVEN_COUNT" -gt 0 ] && [ "$TIER_NOVEL_COUNT" -gt 0 ]; then
  PROVEN_ESC_CMP=$(echo "scale=3; $TIER_PROVEN_ESCAPES / $TIER_PROVEN_COUNT" | bc 2>/dev/null || echo "0")
  NOVEL_ESC_CMP=$(echo "scale=3; $TIER_NOVEL_ESCAPES / $TIER_NOVEL_COUNT" | bc 2>/dev/null || echo "0")
  if awk "BEGIN{exit !($PROVEN_ESC_CMP > $NOVEL_ESC_CMP)}" 2>/dev/null; then
    echo ""
    echo "⚠ WARNING: PROVEN tier escape rate (${PROVEN_ESC_CMP}) exceeds NOVEL tier (${NOVEL_ESC_CMP})."
    echo "  This indicates that de-escalation is suppressing agents that would have caught defects."
    echo "  Investigate: run /pipeline-health --detail and check which cells are PROVEN with recent escapes."
    echo "  Consider resetting affected provenance cells or raising the PROVEN threshold."
  fi
fi

# Export for downstream phases (phase-3-analyze.md health score)
export TIER_NOVEL_COUNT TIER_PROVEN_COUNT TIER_SHADOW_COUNT
export TIER_NOVEL_ESCAPES TIER_PROVEN_ESCAPES
```

**Metrics to report in Phase 5 health summary**:
- **Intensity distribution**: PROVEN / NOVEL / SHADOW counts and percentages over the analysis window
- **Escaped-defect rate by tier**: REVIEW_FALSE_NEG audit-finding rate per tier (target: PROVEN ≤ overall rate, NOVEL ≥ overall rate before de-escalation takes effect, PROVEN never exceeds NOVEL)
- **Shadow mode PRs**: count of PRs where intensity tier was computed but not acted on (should decrease after 30-day window)

**Note**: If `TRUST_SHADOW_MODE=true` is still set in forge.yaml, all PRs will appear as SHADOW tier in this metric. This is correct — shadow mode has not yet been enforced. After setting `trust_shadow_mode: false`, tiers will populate.

### 2M: Session discovery and date-gated filtering (conversation transcript analytics)

This phase locates conversation JSONL files for pipeline command sessions (work-on, orchestrate, review-pr, quality-gate, review-pr-staging) that ran within the analysis window. It produces `SESSION_JSONL_FILES` — consumed by downstream Conversation Transcript Analytics phases to extract flow metrics (phase durations, tool patterns, subagent efficiency, stalls, rate-limits).

**Why `history.jsonl` and not mtime**: `history.jsonl` timestamps record session START time (accurate to the minute). File mtime records the last WRITE — it trails session start by an average of 156 minutes. Date-gating on mtime would misclassify sessions that started before `$SINCE` but were still writing at the cutoff.

**Why XML `<command-name>` tag and not `display` field**: The `display` field records what the user TYPED, not what actually ran. A session where the user types `/work-on 350` then immediately `/clear` appears as a pipeline session in `display` but the JSONL contains only a `/clear` run. In testing, the `display`-only filter produced a 40% false positive rate. The `<command-name>` XML tag in the first few lines of the JSONL file records the actual executed command and is authoritative.

**Path construction algorithm** (empirically verified from investigation #348):

```bash
# Convert a Claude Code project path to its ~/.claude/projects/ directory name
# Rule: both '/' and '.' are replaced with '-'
# Examples:
#   /home/user/projects/myproject          ->  -home-user-projects-myproject
#   /home/user/projects/myproject/.claude/worktrees/fix-branch
#                                          ->  -home-user-projects-myproject--claude-worktrees-fix-branch
#   (note: .claude -> --claude because '.' becomes '-' and surrounding '/' also become '-')
_session_project_dir() {
    echo "$1" | sed 's|[/.]|-|g'
}
```

**Step 1 — Parse history.jsonl and filter to pipeline sessions in window**:

```bash
HISTORY_FILE="$HOME/.claude/history.jsonl"
PIPELINE_COMMANDS='work-on|orchestrate|review-pr|quality-gate|review-pr-staging'

if [ ! -f "$HISTORY_FILE" ]; then
    echo "Phase 2M: $HISTORY_FILE not found — skipping session discovery"
    SESSION_JSONL_FILES=()
    SESSION_TOTAL=0
else
    echo "Phase 2M: parsing $HISTORY_FILE for pipeline sessions since $SINCE"

    # Extract pipeline sessions: entries where display starts with a pipeline command
    # and timestamp is after $SINCE. One JSON object per line.
    # Output: tab-separated sessionId, project, timestamp, display
    SESSION_CANDIDATES=$(jq -r --arg since "$SINCE" --arg cmds "$PIPELINE_COMMANDS" '
        select(
            .timestamp != null and
            .timestamp > $since and
            .sessionId != null and
            .project != null and
            .display != null and
            (.display | test("^/(" + $cmds + ")( |$)"))
        ) |
        [.sessionId, .project, .timestamp, (.display | split(" ") | .[0])] | @tsv
    ' "$HISTORY_FILE" 2>/dev/null)

    # Deduplicate by sessionId — keep only the earliest entry per session
    # (earliest timestamp = session start time, most accurate for date filtering)
    DEDUPED_SESSIONS=$(echo "$SESSION_CANDIDATES" | sort -t$'\t' -k3,3 | sort -t$'\t' -k1,1 -u)

    SESSION_COUNT=$(echo "$DEDUPED_SESSIONS" | grep -c . 2>/dev/null || echo 0)
    echo "Phase 2M: found $SESSION_COUNT unique pipeline sessions in window (pre-disk verification)"
fi
```

**Step 2 — Map session IDs to JSONL files on disk**:

```bash
SESSION_JSONL_FILES=()
SESSION_MISSING_COUNT=0
SESSION_VERIFIED_COUNT=0
SESSION_FP_COUNT=0

CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"

while IFS=$'\t' read -r SESSION_ID PROJECT TIMESTAMP DISPLAY_CMD; do
    [ -z "$SESSION_ID" ] && continue

    # Convert project path to directory name
    PROJECT_DIR=$(_session_project_dir "$PROJECT")
    JSONL_PATH="$CLAUDE_PROJECTS_DIR/$PROJECT_DIR/$SESSION_ID.jsonl"

    # Skip if file does not exist on disk (older/pruned sessions, different machine)
    if [ ! -f "$JSONL_PATH" ]; then
        SESSION_MISSING_COUNT=$((SESSION_MISSING_COUNT + 1))
        continue
    fi

    # Verify actual command via first <command-name> XML tag in JSONL
    # Pipeline commands are stored with double-slash prefix: //work-on, //orchestrate, etc.
    # Read only the first 5 lines (enough to find the command tag — it appears in the first message)
    ACTUAL_CMD=$(head -5 "$JSONL_PATH" 2>/dev/null | \
        grep -oP '(?<=<command-name>)//[^<]+(?=</command-name>)' | head -1)

    # Strip the double-slash prefix for comparison
    ACTUAL_CMD_CLEAN="${ACTUAL_CMD#//}"

    # Verify the actual command matches a pipeline command
    if ! echo "$ACTUAL_CMD_CLEAN" | grep -qP "^($PIPELINE_COMMANDS)$"; then
        SESSION_FP_COUNT=$((SESSION_FP_COUNT + 1))
        continue  # False positive — display said pipeline command but JSONL ran something else
    fi

    # Determine subagent directory (JSONL files for agent sub-calls within this session)
    # Sub-agent JSONL files share the same project dir but have different session IDs
    # The parent session's own JSONL is the primary; subagents appear as sibling files
    SUBAGENT_DIR="$CLAUDE_PROJECTS_DIR/$PROJECT_DIR"

    SESSION_JSONL_FILES+=("$SESSION_ID	$ACTUAL_CMD_CLEAN	$TIMESTAMP	$JSONL_PATH	$SUBAGENT_DIR")
    SESSION_VERIFIED_COUNT=$((SESSION_VERIFIED_COUNT + 1))

done <<< "$DEDUPED_SESSIONS"

SESSION_TOTAL=${#SESSION_JSONL_FILES[@]}

echo "Phase 2M: session discovery complete"
echo "  Verified pipeline sessions:  $SESSION_TOTAL"
echo "  Missing on disk (pruned):    $SESSION_MISSING_COUNT"
echo "  False positives filtered:    $SESSION_FP_COUNT"
echo ""
echo "SESSION_JSONL_FILES contains $SESSION_TOTAL entries — available for transcript analytics phases"
```

**Output format** (each element in `SESSION_JSONL_FILES` is a tab-separated record):

| Field | Content | Example |
|-------|---------|---------|
| `sessionId` | Claude Code session UUID | `abc123-def456-...` |
| `command` | Actual pipeline command run | `work-on` |
| `timestamp` | Session start (from history.jsonl) | `2026-05-28T14:23:01Z` |
| `jsonlPath` | Absolute path to JSONL file | `~/.claude/projects/-home-.../abc123.jsonl` |
| `subagentDir` | Directory containing sibling JSONL files | `~/.claude/projects/-home-.../` |

**Performance characteristics** (from investigation #348 empirical measurement):
- `history.jsonl` parse + filter (25K entries): **<100ms**
- mtime scan of 900 disk files: **<2ms**
- Head-5 JSONL read for XML tag: **negligible** (<1ms per file)
- Total Phase 2M runtime: **<5s** for 25K history entries with 300 pipeline sessions

**Skip conditions**: If `~/.claude/history.jsonl` does not exist (different machine, fresh install), set `SESSION_TOTAL=0` and emit a warning. Downstream transcript analytics phases must gracefully skip when `SESSION_TOTAL == 0`.

---

### JSONL Parser Utility

<!-- FORGE:JSONL_PARSER_UTIL -->

This utility defines a reusable Python snippet for parsing Claude Code's local conversation JSONL files. It is **not a numbered phase** — it is a helper block that transcript analytics phases (added by the Conversation Transcript Analytics milestone) invoke at runtime.

**Schema source**: #346 (investigate: map Claude Code JSONL transcript schema) — 8 message types mapped across 979 records.

**Privacy contract**: Raw conversation content is NEVER emitted. Only structural metadata is extracted: tool names, skill identifiers, agent descriptions, timing data, and session metadata.

**Usage** (phases that call this parser pass a JSONL file path):
```bash
# Parse a single JSONL file and emit one structured event per line (NDJSON)
JSONL_FILE="~/.claude/projects/{project}/{sessionId}.jsonl"
python3 - "$JSONL_FILE" << 'PYEOF'
import json, sys, os

jsonl_file = sys.argv[1] if len(sys.argv) > 1 else None
if not jsonl_file:
    print(json.dumps({"error": "No JSONL file path provided"}), flush=True)
    sys.exit(1)

def parse_jsonl_file(path):
    """Parse a Claude Code JSONL session file. Emits one JSON event per line."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except (OSError, IOError) as e:
        print(json.dumps({"error": f"Cannot open {path}: {e}"}), flush=True)
        return

    for lineno, raw in enumerate(lines, 1):
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            # Malformed line — skip silently (schema resilience rule)
            continue

        msg_type = msg.get("type", "")
        timestamp = msg.get("timestamp", "")
        session_id = msg.get("sessionId", "")
        is_subagent = bool(msg.get("isSidechain", False))
        agent_id = msg.get("agentId")

        # Base event skeleton — only structural fields, no content
        base = {
            "timestamp": timestamp,
            "session_id": session_id,
            "is_subagent": is_subagent,
            "lineno": lineno,
        }
        if agent_id:
            base["agent_id"] = agent_id

        if msg_type == "assistant":
            # Extract tool_use blocks from assistant message content
            content = msg.get("message", {}).get("content", [])
            if not isinstance(content, list):
                content = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                block_type = block.get("type", "")
                if block_type == "tool_use":
                    tool_name = block.get("name", "")
                    tool_input = block.get("input", {}) or {}

                    if tool_name == "Skill":
                        # Skill invocation — extract skill name and args (structural only)
                        event = {**base,
                            "event_type": "skill",
                            "tool_name": "Skill",
                            "skill_name": tool_input.get("skill", ""),
                            "skill_args": tool_input.get("args", ""),
                        }
                    elif tool_name == "Agent":
                        # Agent spawn — extract description and model (no prompt content)
                        event = {**base,
                            "event_type": "agent_spawn",
                            "tool_name": "Agent",
                            "agent_desc": tool_input.get("description", ""),
                            "agent_model": tool_input.get("model", ""),
                        }
                    else:
                        # All other tool calls — name only, no input content
                        event = {**base,
                            "event_type": "tool_use",
                            "tool_name": tool_name,
                        }
                    print(json.dumps(event), flush=True)
                # text and thinking blocks: skip (raw content — privacy rule)

        elif msg_type == "system":
            subtype = msg.get("subtype", "")
            if subtype == "turn_duration":
                # Authoritative phase timing signal — use durationMs, NOT timestamp arithmetic
                event = {**base,
                    "event_type": "turn_duration",
                    "duration_ms": msg.get("durationMs", 0),
                    "parent_uuid": msg.get("parentUuid", ""),
                }
                print(json.dumps(event), flush=True)
            elif subtype == "compact_boundary":
                # Context compaction marker
                compact_meta = msg.get("compactMetadata", {}) or {}
                event = {**base,
                    "event_type": "compact",
                    "pre_tokens": compact_meta.get("preTokens", 0),
                    "trigger": compact_meta.get("trigger", ""),
                }
                print(json.dumps(event), flush=True)
            # local_command and other system subtypes: skip (content-bearing)

        elif msg_type == "user":
            # user messages: only emit session-start marker for first message (parentUuid=null)
            if msg.get("parentUuid") is None and not is_subagent:
                event = {**base,
                    "event_type": "session_start",
                    "is_meta": bool(msg.get("isMeta", False)),
                }
                print(json.dumps(event), flush=True)

        elif msg_type == "progress":
            # Agent progress — only structural signal (agentId, parentToolUseID)
            data = msg.get("data", {}) or {}
            if data.get("type") == "agent_progress":
                event = {**base,
                    "event_type": "agent_progress",
                    "progress_agent_id": data.get("agentId", ""),
                    "parent_tool_use_id": msg.get("parentToolUseID", ""),
                }
                print(json.dumps(event), flush=True)
            # hook_progress: skip

        elif msg_type in ("queue-operation", "pr-link", "last-prompt", "file-history-snapshot"):
            # Known non-analytics types — skip silently
            pass

        else:
            # Unknown type — emit as unknown_type for forward-compatibility diagnostics
            event = {**base,
                "event_type": "unknown_type",
                "type": msg_type,
            }
            print(json.dumps(event), flush=True)

parse_jsonl_file(jsonl_file)
PYEOF
```

**Calling convention**: Pass the JSONL file path as the first argument:
```bash
python3 -c "..." "$JSONL_FILE"          # inline version (for short scripts)
python3 - "$JSONL_FILE" << 'PYEOF'    # heredoc version — '-' reads from stdin, arg follows
```

**Output format** (NDJSON — one JSON object per line):

| `event_type` | Fields emitted | Source |
|---|---|---|
| `tool_use` | `tool_name`, `timestamp`, `session_id`, `is_subagent` | `assistant` content `tool_use` blocks |
| `skill` | `tool_name="Skill"`, `skill_name`, `skill_args`, `timestamp`, `is_subagent` | `assistant` content where `name=="Skill"` |
| `agent_spawn` | `tool_name="Agent"`, `agent_desc`, `agent_model`, `timestamp`, `is_subagent` | `assistant` content where `name=="Agent"` |
| `turn_duration` | `duration_ms`, `parent_uuid`, `timestamp` | `system {subtype: "turn_duration"}` |
| `compact` | `pre_tokens`, `trigger`, `timestamp` | `system {subtype: "compact_boundary"}` |
| `session_start` | `is_meta`, `timestamp` | first `user` message (`parentUuid=null`) |
| `agent_progress` | `progress_agent_id`, `parent_tool_use_id`, `timestamp` | `progress {data.type: "agent_progress"}` |
| `unknown_type` | `type` | any unrecognized `type` value |

**Schema resilience rules**:
1. `msg.get('field')` throughout — absent fields return `None`, never crash
2. Malformed JSON lines are silently skipped (try/except per line)
3. Unknown `type` values emit `unknown_type` event — not silently dropped
4. Both `usage` variants handled (parser doesn't touch `usage` — structural extraction only)
5. `is_subagent` populated from `isSidechain` field, not filename heuristic

**Subagent detection**:
- `isSidechain: true` → `is_subagent: true` in all events from that file
- `agentId` field present → `agent_id` field in output
- Subagent files located at: `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`

**Worktree session detection** (for session discovery phases):
```bash
# Project directory name regex to detect worktree sessions
echo "$PROJECT_DIR" | grep -qP '^-.*--claude-worktrees-.*$' && echo "worktree" || echo "main"
```

---

### 2N: Transcript flow metrics (session efficiency signal)

Parses the JSONL files discovered in Phase 2M to extract pipeline session flow metrics: per-turn durations, tool call frequency, context compaction events, stall turns (turns taking >2 min), and rate-limit indicator turns. This is the only metric that sees _inside_ a running session — all other Phase 2 metrics observe outcomes (PRs merged, findings created) not internal dynamics.

**Prerequisite**: Phase 2M must have run. If `SESSION_TOTAL == 0`, skip this phase and set `TRANSCRIPT_DATA_AVAILABLE=false`.

**This phase reads local disk only — no GitHub API calls.**

**Step 1 — Check prerequisite and select files to parse**:

```bash
if [ "${SESSION_TOTAL:-0}" -eq 0 ]; then
  echo "Phase 2N: SESSION_TOTAL=0 (Phase 2M found no sessions or history.jsonl missing) — skipping"
  TRANSCRIPT_DATA_AVAILABLE=false
else
  TRANSCRIPT_DATA_AVAILABLE=true

  # Performance guard: cap at 50 sessions to bound parse time.
  # If SESSION_TOTAL > 50: select 30 most recent + 10 largest (by JSONL file size) + 10 random from remainder.
  # Deduplication is implicit — most-recent and largest sets are drawn from the same array without replacement.
  if [ "${SESSION_TOTAL}" -gt 50 ]; then
    echo "Phase 2N: $SESSION_TOTAL sessions found — sampling 50 (30 most recent + 10 largest + 10 random) for performance"

    # SESSION_JSONL_FILES is a bash array; each element: sessionId\tcommand\ttimestamp\tjsonlPath\tsubagentDir
    # Step A: sort by timestamp (field 3) descending → pick first 30
    SORTED_BY_TIME=$(printf '%s\n' "${SESSION_JSONL_FILES[@]}" | sort -t$'\t' -k3,3 -r)
    RECENT_30=$(echo "$SORTED_BY_TIME" | head -30)
    RECENT_IDS=$(echo "$RECENT_30" | cut -f1)

    # Step B: from remaining entries (not in RECENT_IDS), sort by JSONL file size → pick 10 largest
    REMAINDER=$(printf '%s\n' "${SESSION_JSONL_FILES[@]}" | grep -vFf <(echo "$RECENT_IDS") 2>/dev/null || true)
    LARGEST_10=""
    if [ -n "$REMAINDER" ]; then
      LARGEST_10=$(echo "$REMAINDER" | while IFS=$'\t' read -r SID CMD TS JP SD; do
        SZ=$(stat -c%s "$JP" 2>/dev/null || echo 0)
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$SZ" "$SID" "$CMD" "$TS" "$JP" "$SD"
      done | sort -rn | head -10 | cut -f2-)
      LARGEST_IDS=$(echo "$LARGEST_10" | cut -f1)
    fi

    # Step C: from entries not yet selected, pick 10 at random
    EXCLUDED=$(printf '%s\n%s\n' "$RECENT_IDS" "${LARGEST_IDS:-}")
    POOL=$(printf '%s\n' "${SESSION_JSONL_FILES[@]}" | grep -vFf <(echo "$EXCLUDED") 2>/dev/null || true)
    RANDOM_10=""
    if [ -n "$POOL" ]; then
      RANDOM_10=$(echo "$POOL" | shuf | head -10)
    fi

    # Combine and rebuild SESSION_JSONL_FILES (deduplicated)
    COMBINED=$(printf '%s\n%s\n%s\n' "$RECENT_30" "${LARGEST_10:-}" "${RANDOM_10:-}" | grep -v '^$' | sort -u)
    SESSION_TOTAL_ORIGINAL=$SESSION_TOTAL
    SESSION_JSONL_FILES=()
    while IFS= read -r ENTRY; do
      [ -z "$ENTRY" ] && continue
      SESSION_JSONL_FILES+=("$ENTRY")
    done <<< "$COMBINED"
    SESSION_TOTAL=${#SESSION_JSONL_FILES[@]}
    echo "Phase 2N: sampled $SESSION_TOTAL of $SESSION_TOTAL_ORIGINAL sessions (30 most recent + 10 largest + 10 random)"
  else
    echo "Phase 2N: parsing $SESSION_TOTAL session JSONL files for flow metrics"
    SESSION_TOTAL_ORIGINAL=$SESSION_TOTAL
  fi
fi
```

**Step 2 — Parse each session and aggregate metrics (inline Python)**:

**IMPORTANT**: Run as a single Python script. JSONL files can be large (500+ lines, 100KB+). Budget: 2 minutes total.

```python
import json, sys, os
from collections import defaultdict

# Read SESSION_JSONL_FILES from Phase 2M environment
# Each entry is a tab-separated record: sessionId \t command \t timestamp \t jsonlPath \t subagentDir
session_records_raw = os.environ.get('SESSION_JSONL_FILES_RAW', '')

# Aggregate accumulators
all_durations_ms = []      # from turn_duration events
total_tool_counts = defaultdict(int)  # tool_name → call count
total_compactions = 0      # compact_boundary events
total_stall_turns = 0      # turns > 120000 ms
total_rate_limit_turns = 0  # turns 60000–120000 ms (possible rate-limit)
parent_session_count = 0
subagent_session_count = 0
parse_errors = 0

def process_jsonl_file(jsonl_path, is_subagent=False):
    """Parse one JSONL file using the JSONL Parser Utility event model."""
    global total_compactions, total_stall_turns, total_rate_limit_turns, parse_errors

    try:
        with open(jsonl_path, encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    parse_errors += 1
                    continue

                msg_type = msg.get('type', '')
                file_is_subagent = bool(msg.get('isSidechain', False)) or is_subagent

                if msg_type == 'assistant':
                    # Tool call frequency
                    content = msg.get('message', {}).get('content', [])
                    if isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict) and block.get('type') == 'tool_use':
                                total_tool_counts[block.get('name', 'unknown')] += 1

                elif msg_type == 'system':
                    subtype = msg.get('subtype', '')
                    if subtype == 'turn_duration':
                        dur = msg.get('durationMs')
                        if isinstance(dur, (int, float)) and dur > 0:
                            all_durations_ms.append(dur)
                            if dur > 120000:
                                total_stall_turns += 1
                            elif dur > 60000:
                                total_rate_limit_turns += 1
                    elif subtype == 'compact_boundary':
                        total_compactions += 1

                # Unknown types: silently skip (schema resilience)

    except (IOError, OSError):
        parse_errors += 1

# Process each session from SESSION_JSONL_FILES_RAW
for record in session_records_raw.strip().split('\n'):
    if not record.strip():
        continue
    parts = record.split('\t')
    if len(parts) < 4:
        continue
    session_id, command, timestamp, jsonl_path = parts[0], parts[1], parts[2], parts[3]
    subagent_dir = parts[4] if len(parts) > 4 else ''

    # Expand ~ in path
    jsonl_path = os.path.expanduser(jsonl_path)
    if not os.path.isfile(jsonl_path):
        continue

    parent_session_count += 1
    process_jsonl_file(jsonl_path, is_subagent=False)

    # Also parse subagent files in the same session directory
    if subagent_dir:
        sub_dir = os.path.expanduser(os.path.join(os.path.dirname(jsonl_path), session_id, 'subagents'))
        if os.path.isdir(sub_dir):
            for fname in os.listdir(sub_dir):
                if fname.startswith('agent-') and fname.endswith('.jsonl'):
                    subagent_session_count += 1
                    process_jsonl_file(os.path.join(sub_dir, fname), is_subagent=True)

# Output aggregated metrics
total_turns = len(all_durations_ms)
avg_duration_ms = sum(all_durations_ms) / len(all_durations_ms) if all_durations_ms else 0
max_duration_ms = max(all_durations_ms) if all_durations_ms else 0
stall_rate = (total_stall_turns / total_turns * 100) if total_turns > 0 else 0

print(f"\n=== Phase 2N: Transcript Flow Metrics ===")
print(f"Pipeline sessions parsed: {parent_session_count} parent, {subagent_session_count} subagent")
print(f"Total turns with timing: {total_turns}")
print(f"Avg turn duration: {avg_duration_ms/1000:.1f}s")
print(f"Max turn duration: {max_duration_ms/1000:.1f}s")
print(f"Stall turns (>120s): {total_stall_turns} ({stall_rate:.1f}% of turns) — target: < 10%")
print(f"Rate-limit indicator turns (60–120s): {total_rate_limit_turns}")
print(f"Context compaction events: {total_compactions}")
print()
print("Tool call frequency (top 10):")
for tool, count in sorted(total_tool_counts.items(), key=lambda x: -x[1])[:10]:
    print(f"  {tool}: {count}")
```

To run this step:

```bash
if [ "$TRANSCRIPT_DATA_AVAILABLE" = "true" ]; then
  # Serialize SESSION_JSONL_FILES array to newline-separated string for Python
  export SESSION_JSONL_FILES_RAW
  SESSION_JSONL_FILES_RAW=$(printf '%s\n' "${SESSION_JSONL_FILES[@]}")
  PHASE_2N_OUTPUT=$(python3 - << 'PYEOF'
# [paste the Python script above here at runtime]
PYEOF
)
  echo "$PHASE_2N_OUTPUT"

  # Extract bash variables from Phase 2N output for use in Phase 3C health score
  # "Stall turns (>120s): N (X.Y% of turns) — target: < 10%"
  STALL_TURN_RATE=$(echo "$PHASE_2N_OUTPUT" | grep -oP 'Stall turns \(>120s\): \d+ \(\K[\d.]+(?=% of turns)')
  STALL_TURN_RATE=${STALL_TURN_RATE:-0}
  # "Context compaction events: N"
  COMPACTION_TOTAL=$(echo "$PHASE_2N_OUTPUT" | grep -oP 'Context compaction events: \K\d+')
  COMPACTION_TOTAL=${COMPACTION_TOTAL:-0}
  export STALL_TURN_RATE COMPACTION_TOTAL
  echo "Phase 2N exports: STALL_TURN_RATE=$STALL_TURN_RATE COMPACTION_TOTAL=$COMPACTION_TOTAL"
fi
```

**Metrics produced**:
- **Pipeline sessions in window**: sessions confirmed in Phase 2M that actually ran a pipeline command (`work-on`, `orchestrate`, `review-pr`, etc.)
- **Avg turn duration (ms)**: mean of all `system.turn_duration.durationMs` values. Uses `durationMs` directly — NOT timestamp arithmetic (timestamps are non-monotonic).
- **Stall turns**: turns exceeding 120s. Each stall is a turn where the agent spent >2 min — often a rate-limit backoff or very large context. Target: < 10% of turns.
- **Rate-limit indicator turns**: turns 60–120s — possible but not certain rate-limit waits. Informational.
- **Context compaction events**: count of `system.compact_boundary` records. High compaction rates suggest prompts or tool outputs are too large, causing agents to lose intermediate state.
- **Tool call frequency**: which tools dominate. Reveals whether agents are read-heavy (Bash/Read/Grep) vs coordination-heavy (Skill/Agent).

**Skip condition**: If `TRANSCRIPT_DATA_AVAILABLE` is false, emit:
> `Phase 2N: Transcript flow metrics unavailable — no pipeline sessions found by Phase 2M (SESSION_TOTAL=0). Run /pipeline-health on the same machine where Claude Code sessions are stored.`

---

### 2O: Per-session metric extraction (structured session metrics)

Reads the same JSONL files discovered by Phase 2M to produce a **structured metrics dict per session**. Where Phase 2N aggregates across all sessions, Phase 2O isolates each session independently — enabling downstream phases (subagent flow #352, privacy aggregation #353, health report #354) to bucket, normalize, and compare sessions by command type, task complexity, and model distribution.

**Prerequisite**: Phase 2N must have run. If `TRANSCRIPT_DATA_AVAILABLE != true`, skip this phase.

**This phase reads local disk only — no GitHub API calls.**

**Metrics per session (HIGH and MEDIUM actionability only per #347)**:
- `total_duration_ms` — sum of all `system.turn_duration.durationMs` values (active computation time; NOT wall-clock)
- `tool_call_counts` — dict of tool_name → count for all tool_use blocks
- `skill_invocations` — list of `{phase_name, skill_name, skill_args}` in call order
- `agent_spawns` — list of `{agent_desc, model}` for each Agent tool call
- `model_distribution` — dict of model_name → count (from `message.model` on assistant messages; proxy for sonnet/opus fallback pressure)
- `compaction_count` — count of `system {subtype: compact_boundary}` events

**NOT included** (SKIP tier from #347): wall-clock duration, rate-limit event detection.

**Step 1 — Check prerequisite**:

```bash
if [ "${TRANSCRIPT_DATA_AVAILABLE:-false}" != "true" ]; then
  echo "Phase 2O: TRANSCRIPT_DATA_AVAILABLE=false (Phase 2N skipped or no sessions) — skipping"
  PER_SESSION_METRICS_RAW=""
else
  echo "Phase 2O: extracting per-session metrics from $SESSION_TOTAL sessions"
fi
```

**Step 2 — Parse each session and emit structured NDJSON (inline Python)**:

```python
import json, sys, os
from collections import defaultdict

# Skill name → pipeline phase name mapping
SKILL_PHASE_MAP = {
    'work-on':          'work-on',
    'quality-gate':     'build:validate',
    'review-pr':        'review',
    'review-pr-staging':'review',
    'cleanup':          'close',
    'orchestrate':      'orchestrate',
    'frontend-design':  'build:implement',
    'validate':         'validate',
    'audit':            'audit',
    'pipeline-health':  'pipeline-health',
}

def parse_session_jsonl(jsonl_path):
    """Parse one JSONL file and return per-session metric dict."""
    metrics = {
        'total_duration_ms': 0,
        'tool_call_counts': defaultdict(int),
        'skill_invocations': [],   # [{phase_name, skill_name, skill_args}]
        'agent_spawns': [],        # [{agent_desc, model}]
        'model_distribution': defaultdict(int),  # model_name → count
        'compaction_count': 0,
        'parse_errors': 0,
    }

    try:
        with open(jsonl_path, encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    metrics['parse_errors'] += 1
                    continue

                msg_type = msg.get('type', '')

                if msg_type == 'assistant':
                    # Track model distribution (SAFE field per #347)
                    model = msg.get('message', {}).get('model', '')
                    if model:
                        metrics['model_distribution'][model] += 1

                    # Extract tool_use blocks
                    content = msg.get('message', {}).get('content', [])
                    if not isinstance(content, list):
                        content = []
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get('type') != 'tool_use':
                            continue
                        tool_name = block.get('name', 'unknown')
                        tool_input = block.get('input', {}) or {}

                        # Count all tool calls by name
                        metrics['tool_call_counts'][tool_name] += 1

                        if tool_name == 'Skill':
                            # Map skill name to pipeline phase
                            skill_name = tool_input.get('skill', '')
                            skill_args = tool_input.get('args', '')
                            phase_name = SKILL_PHASE_MAP.get(skill_name, 'other')
                            metrics['skill_invocations'].append({
                                'phase_name': phase_name,
                                'skill_name': skill_name,
                                'skill_args': str(skill_args)[:80],  # truncate — no raw content
                            })
                        elif tool_name == 'Agent':
                            # Extract description and model only — NOT prompt content (UNSAFE per #347)
                            metrics['agent_spawns'].append({
                                'agent_desc': str(tool_input.get('description', ''))[:120],
                                'model': tool_input.get('model', ''),
                            })

                elif msg_type == 'system':
                    subtype = msg.get('subtype', '')
                    if subtype == 'turn_duration':
                        dur = msg.get('durationMs')
                        if isinstance(dur, (int, float)) and dur > 0:
                            metrics['total_duration_ms'] += dur
                    elif subtype == 'compact_boundary':
                        metrics['compaction_count'] += 1

                # All other message types: skip (content-bearing or irrelevant)

    except (IOError, OSError):
        metrics['parse_errors'] += 1

    return metrics

# Read SESSION_JSONL_FILES from Phase 2M
session_records_raw = os.environ.get('SESSION_JSONL_FILES_RAW', '')

session_results = []
total_sessions = 0
print(f"\n=== Phase 2O: Per-Session Metric Extraction ===")

for record in session_records_raw.strip().split('\n'):
    if not record.strip():
        continue
    parts = record.split('\t')
    if len(parts) < 4:
        continue
    session_id = parts[0]
    command    = parts[1]
    timestamp  = parts[2]
    jsonl_path = os.path.expanduser(parts[3])

    if not os.path.isfile(jsonl_path):
        continue

    total_sessions += 1
    m = parse_session_jsonl(jsonl_path)

    # Serialize to JSON-safe dict (convert defaultdicts)
    session_record = {
        'session_id':         session_id,
        'command':            command,
        'timestamp':          timestamp,
        'total_duration_ms':  m['total_duration_ms'],
        'tool_call_counts':   dict(m['tool_call_counts']),
        'skill_invocations':  m['skill_invocations'],
        'agent_spawns':       m['agent_spawns'],
        'model_distribution': dict(m['model_distribution']),
        'compaction_count':   m['compaction_count'],
        'parse_errors':       m['parse_errors'],
    }
    session_results.append(session_record)
    # Emit as NDJSON line (consumed by downstream phases via PER_SESSION_METRICS_RAW)
    print(json.dumps(session_record), flush=True)

# Print summary table
print(f"\nParsed {total_sessions} sessions.")
print(f"{'Session':<20} {'Command':<16} {'DurationS':>9} {'Tools':>6} {'Skills':>7} {'Agents':>7} {'Compact':>8} {'Sonnet/Opus':>12}")
print("-" * 92)
for s in session_results:
    dur_s = s['total_duration_ms'] / 1000
    tools = sum(s['tool_call_counts'].values())
    skills = len(s['skill_invocations'])
    agents = len(s['agent_spawns'])
    compact = s['compaction_count']
    sonnet = sum(v for k, v in s['model_distribution'].items() if 'sonnet' in k.lower())
    opus   = sum(v for k, v in s['model_distribution'].items() if 'opus' in k.lower())
    sid_short = s['session_id'][:18]
    cmd_short = s['command'][:14]
    print(f"{sid_short:<20} {cmd_short:<16} {dur_s:>9.1f} {tools:>6} {skills:>7} {agents:>7} {compact:>8} {sonnet:>5}/{opus:<5}")
```

To run this step:

```bash
if [ "${TRANSCRIPT_DATA_AVAILABLE:-false}" = "true" ]; then
  export SESSION_JSONL_FILES_RAW
  SESSION_JSONL_FILES_RAW=$(printf '%s\n' "${SESSION_JSONL_FILES[@]}")
  PER_SESSION_METRICS_RAW=$(python3 - << 'PYEOF'
# [paste the Python script above here at runtime]
PYEOF
)
  echo "$PER_SESSION_METRICS_RAW"
  export PER_SESSION_METRICS_RAW
fi
```

**Metrics produced per session**:
- **`total_duration_ms`**: sum of `system.turn_duration.durationMs` — active agent compute time, excludes human idle. Use this; NOT wall-clock timestamps.
- **`tool_call_counts`**: dict of every tool name called and how many times. Bash:Edit ratio reveals investigator vs builder behaviour.
- **`skill_invocations`**: ordered list of Skill calls with mapped phase names. Reveals which pipeline phases ran in this session and how many times each was invoked.
- **`agent_spawns`**: list of Agent tool calls with model used. Reveals subagent spawning patterns and model choices.
- **`model_distribution`**: sonnet vs opus request count. Proxy for API fallback pressure — a session with many opus requests may have experienced rate-limiting.
- **`compaction_count`**: per-session context compaction events. >1 = session spanned multiple context windows.

**Output variable**: `PER_SESSION_METRICS_RAW` — NDJSON string (one JSON record per line), one record per session. Consumed by Phase 2O's print output and by downstream phases (#352 subagent flow, #353 privacy aggregation, #354 health report integration). Export it with `export PER_SESSION_METRICS_RAW` so downstream phases can read it.

**Skip condition**: If `TRANSCRIPT_DATA_AVAILABLE` is false, emit:
> `Phase 2O: Per-session metrics unavailable — Phase 2N did not produce session data. SESSION_TOTAL must be > 0 for this phase to run.`

---

### 2P: Subagent flow analysis (role-mapped efficiency signal)

Parses subagent JSONL files for each pipeline session to extract per-role efficiency metrics: which pipeline role each subagent performed, how long each agent ran, how many tools it called, and whether the same role was retried multiple times within a session. This phase complements Phase 2N's aggregate-level flow metrics with role-level breakdowns — revealing which pipeline phases (investigate, build, review) are slowest, most retry-prone, or most model-diverse.

**Prerequisite**: Phase 2N must have run. If `TRANSCRIPT_DATA_AVAILABLE` is false, skip this phase.

**This phase reads local disk only — no GitHub API calls.**

**Role mapping rules** (applied to `agent_desc` from `agent_spawn` events):

| Pattern | Mapped Role |
|---------|-------------|
| `^(Investigate|investigate)\s+` | `investigate` |
| `^(Work on|work on|Resume #\d+ build|Continue #\d+ build)\s+` | `build` |
| `^(Review|review|Resume.*review|Continue.*review)\s*` | `review` |
| `^Review\+Close\s+` | `review` |
| `^(Resume #\d+ close|Continue #\d+ close)\s*` | `close` |
| `^Quality gate\s*` | `quality-gate` |
| `^(Orchestrate|orchestrate)\s+` | `orchestrate` |
| domain agent names (e.g., `API bug hunter`, `Billing.*review`, `Security.*review`, `Frontend.*quality`, `General security`, `Auth.*review`, `Infra.*review`) | `review` |
| No pattern matches | `other` |

**Retry detection**: Within a single session, if the same role is assigned to more than one subagent, subsequent agents are classified as retried (positional detection: second+ agent in same session+role = retry).

**Step 1 — Check prerequisite**:

```bash
if [ "${TRANSCRIPT_DATA_AVAILABLE:-false}" != "true" ]; then
  echo "Phase 2P: TRANSCRIPT_DATA_AVAILABLE=false — skipping subagent flow analysis"
  SUBAGENT_DATA_AVAILABLE=false
else
  echo "Phase 2P: analyzing subagent flow for $SESSION_TOTAL sessions"
  SUBAGENT_DATA_AVAILABLE=true
fi
```

**Step 2 — Parse agent_spawn events and subagent files (inline Python)**:

**IMPORTANT**: Run as a single Python script. Budget: 2 minutes total.

```python
import json, sys, os, re
from collections import defaultdict

# Role mapping: ordered list of (regex_pattern, role_name) tuples
# Evaluated in order; first match wins. Domain review agents match last (broad patterns).
ROLE_PATTERNS = [
    (re.compile(r'^(Investigate|investigate)\s+',       re.I), 'investigate'),
    (re.compile(r'^(Work on|work on)\s+',               re.I), 'build'),
    (re.compile(r'^Resume #\d+ build',                  re.I), 'build'),
    (re.compile(r'^Continue #\d+ build',                re.I), 'build'),
    (re.compile(r'^forge#\d+\b',                        re.I), 'build'),
    (re.compile(r'^Review\+Close\s+',                   re.I), 'review'),
    (re.compile(r'^Resume.*close',                      re.I), 'close'),
    (re.compile(r'^Continue.*close',                    re.I), 'close'),
    (re.compile(r'^Quality gate',                       re.I), 'quality-gate'),
    (re.compile(r'^(Orchestrate|orchestrate)\s+',       re.I), 'orchestrate'),
    (re.compile(r'^(Review|review)\s+',                 re.I), 'review'),
    (re.compile(r'^Resume.*review',                     re.I), 'review'),
    (re.compile(r'^Continue.*review',                   re.I), 'review'),
    # Domain review agent patterns (broad — must come after specific patterns)
    (re.compile(r'(bug hunter|security|quality audit|quality review|billing.*review|auth.*review|infra.*review|frontend.*review|API.*review|API.*audit|DB.*review|concurr.*review)', re.I), 'review'),
    (re.compile(r'General security',                    re.I), 'review'),
]

def map_role(agent_desc):
    """Map agent_desc string to a pipeline role name."""
    for pattern, role in ROLE_PATTERNS:
        if pattern.search(agent_desc):
            return role
    return 'other'

# Read SESSION_JSONL_FILES_RAW from Phase 2M/2N environment
session_records_raw = os.environ.get('SESSION_JSONL_FILES_RAW', '')

# Per-role accumulators
# role → list of agent records: {session_id, desc, model, duration_ms, tool_count, compact_count, is_retry}
role_agents = defaultdict(list)

def compute_subagent_metrics(subagent_path):
    """Return (duration_ms, tool_count, compact_count) for a subagent JSONL file."""
    duration_ms = 0
    tool_count = 0
    compact_count = 0
    try:
        with open(subagent_path, encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg_type = msg.get('type', '')
                if msg_type == 'assistant':
                    content = msg.get('message', {}).get('content', [])
                    if isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict) and block.get('type') == 'tool_use':
                                tool_count += 1
                elif msg_type == 'system':
                    subtype = msg.get('subtype', '')
                    if subtype == 'turn_duration':
                        dur = msg.get('durationMs')
                        if isinstance(dur, (int, float)) and dur > 0:
                            duration_ms += dur
                    elif subtype == 'compact_boundary':
                        compact_count += 1
    except (IOError, OSError):
        pass
    return duration_ms, tool_count, compact_count

# Process each parent session
for record in session_records_raw.strip().split('\n'):
    if not record.strip():
        continue
    parts = record.split('\t')
    if len(parts) < 4:
        continue
    session_id, command, timestamp, jsonl_path = parts[0], parts[1], parts[2], parts[3]
    jsonl_path = os.path.expanduser(jsonl_path)
    if not os.path.isfile(jsonl_path):
        continue

    # Collect agent_spawn events from the parent JSONL (structural only)
    spawned_agents = []   # list of {desc, model}
    try:
        with open(jsonl_path, encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get('type') != 'assistant':
                    continue
                content = msg.get('message', {}).get('content', [])
                if not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get('type') == 'tool_use' and block.get('name') == 'Agent':
                        inp = block.get('input', {}) or {}
                        agent_desc = inp.get('description', '')
                        agent_model = inp.get('model', 'unknown')
                        spawned_agents.append({'desc': agent_desc, 'model': agent_model})
    except (IOError, OSError):
        continue

    if not spawned_agents:
        continue

    # Subagent JSONL directory: dirname(jsonl_path)/{session_id}/subagents/
    sub_dir = os.path.join(os.path.dirname(jsonl_path), session_id, 'subagents')

    # Track roles seen in this session for retry detection (positional)
    session_role_counts = defaultdict(int)   # role → spawn count in this session
    spawn_counter = 0   # overall counter across all roles (positional file index)

    for spawn in spawned_agents:
        role = map_role(spawn['desc'])
        session_role_counts[role] += 1
        # Positional retry: second+ spawn of same role in same session = retry
        is_retry = (session_role_counts[role] > 1)

        # Best-effort: associate this spawn with a subagent file by position (sorted order)
        # Cannot map tool_use id to agent file hash — take file at overall spawn position
        duration_ms = 0
        tool_count = 0
        compact_count = 0

        if os.path.isdir(sub_dir):
            agent_files = sorted([
                f for f in os.listdir(sub_dir)
                if f.startswith('agent-') and f.endswith('.jsonl')
            ])
            # Use overall spawn position (across all roles) as index into sorted file list
            if spawn_counter < len(agent_files):
                fpath = os.path.join(sub_dir, agent_files[spawn_counter])
                duration_ms, tool_count, compact_count = compute_subagent_metrics(fpath)

        spawn_counter += 1
        role_agents[role].append({
            'session_id': session_id,
            'desc': spawn['desc'],
            'model': spawn['model'],
            'duration_ms': duration_ms,
            'tool_count': tool_count,
            'compact_count': compact_count,
            'is_retry': is_retry,
        })

# Aggregate metrics by role
print("\n=== Phase 2P: Subagent Flow Analysis ===")
print()

all_roles = sorted(role_agents.keys())
model_distribution = defaultdict(int)

for role in all_roles:
    agents = role_agents[role]
    total = len(agents)
    retried = sum(1 for a in agents if a.get('is_retry', False))
    retry_rate = (retried / total * 100) if total > 0 else 0

    durations = [a['duration_ms'] for a in agents if a['duration_ms'] > 0]
    avg_dur_s = (sum(durations) / len(durations) / 1000) if durations else 0
    max_dur_s = (max(durations) / 1000) if durations else 0

    tool_counts = [a['tool_count'] for a in agents]
    avg_tools = (sum(tool_counts) / len(tool_counts)) if tool_counts else 0

    compacts = sum(a['compact_count'] for a in agents)

    for a in agents:
        model_distribution[a['model']] += 1

    print(f"Role: {role} ({total} agents, {retried} retried — retry rate: {retry_rate:.0f}%)")
    print(f"  Avg duration: {avg_dur_s:.1f}s  Max: {max_dur_s:.1f}s")
    print(f"  Avg tool calls: {avg_tools:.1f}  Total compactions: {compacts}")
    print()

print("Model distribution (across all roles):")
for model, count in sorted(model_distribution.items(), key=lambda x: -x[1]):
    print(f"  {model}: {count} agents")

total_agents = sum(len(v) for v in role_agents.values())
total_retried = sum(sum(1 for a in v if a.get('is_retry', False)) for v in role_agents.values())
print()
print(f"Total subagents analyzed: {total_agents}")
print(f"Total retried agents: {total_retried} ({(total_retried/total_agents*100) if total_agents else 0:.1f}%)")
```

To run this step:

```bash
if [ "$SUBAGENT_DATA_AVAILABLE" = "true" ]; then
  export SESSION_JSONL_FILES_RAW
  python3 - << 'PYEOF'
# [paste the Python script above here at runtime]
PYEOF
fi
```

**Metrics produced**:
- **Per-role agent count**: how many subagents handled each pipeline role (investigate, build, review, quality-gate, close, orchestrate, other) in the window.
- **Retry rate by role**: % of agents for that role that were retried (same role spawned more than once per session). High retry rates indicate stall or failure patterns for that phase.
- **Avg duration by role (seconds)**: mean of all `turn_duration.durationMs` values summed per subagent. Uses `durationMs` — NOT timestamp arithmetic.
- **Avg tool calls by role**: mean tool call count per subagent in that role. High counts may indicate agents doing excessive re-reads or exploration.
- **Model distribution**: breakdown of `sonnet` vs `opus` (and other models) across all subagents. Opus appearances indicate rate-limit fallback or explicit override — they cost more and run slower.
- **Total compactions**: count of `compact_boundary` events across all subagents in the role. High compaction indicates agents hitting context limits — prompt size or tool output volume issue.

**Interpretation guide**:
- **Retry rate > 20% for a role** → that pipeline phase is fragile: agents stall, produce errors, or get externally resumed more than expected.
- **Avg duration for build > 600s** → builder agents are slow — likely doing excessive re-reads, hitting rate limits, or working on high-complexity issues that may need decomposition.
- **Opus count > 10% of total** → significant rate-limit fallback occurring — consider spreading pipeline sessions or reducing prompt sizes.
- **High compactions in review role** → review agents are loading too much context (large diffs or too many files) and compacting mid-review, which degrades finding quality.

**Skip condition**: If `SUBAGENT_DATA_AVAILABLE` is false, emit:
> `Phase 2P: Subagent flow analysis unavailable — TRANSCRIPT_DATA_AVAILABLE=false from Phase 2N. Requires Phase 2M session discovery to have found pipeline sessions on this machine.`

---

### 2Q: Privacy-safe aggregation and harmful-takeaway guardrails

Aggregates per-session metrics from Phase 2O's `PER_SESSION_METRICS_RAW` into a sanitized, report-ready summary. **No content fields pass through this phase** — only structural data (tool names, counts, durations, models). Session IDs are stripped. Output is context-framed with distribution ranges (median + P25/P75) to prevent misleading averages. Harmful-takeaway guardrail footnotes are emitted as a block for Phase 5A to embed directly in the health report.

**Prerequisite**: Phase 2O must have run. If `TRANSCRIPT_DATA_AVAILABLE` is false or `PER_SESSION_METRICS_RAW` is empty, skip and set `AGGREGATED_TRANSCRIPT_METRICS=""`.

**This phase reads only `PER_SESSION_METRICS_RAW` (in-memory) — no disk reads, no GitHub API calls.**

**Field whitelist** (deny by default — only these fields are read from each session record):
- `command` — pipeline command name (safe: structural)
- `total_duration_ms` — active compute time (safe: timing only)
- `tool_call_counts` — dict of tool_name → count (safe: tool names are structural)
- `skill_invocations[].skill_name` — skill name only (safe: structural); `skill_args` is NOT read
- `model_distribution` — model_name → count dict (safe: model names only); authoritative source for sonnet/opus split
- `compaction_count` — integer (safe: count only)

**Fields explicitly excluded** (even though present in Phase 2O output):
- `session_id` — opaque UUID; not useful for pipeline improvement; excluded from all output
- `skill_invocations[].skill_args` — may contain issue numbers (safe) but also file paths or branch names (contextual); excluded to keep the whitelist strict
- `agent_spawns[].model` — excluded from model_freq to prevent double-counting with `model_distribution`; spawn intent ≠ response actuality; Phase 2P uses this field separately for spawn pattern analysis <!-- Added: forge#369 -->
- `agent_spawns[].agent_desc` — may contain file paths or code context; excluded per #347 privacy classification

**Step 1 — Prerequisite guard**:

```bash
if [ "${TRANSCRIPT_DATA_AVAILABLE:-false}" != "true" ] || [ -z "${PER_SESSION_METRICS_RAW:-}" ]; then
  echo "Phase 2Q: skipping — TRANSCRIPT_DATA_AVAILABLE=false or PER_SESSION_METRICS_RAW empty"
  AGGREGATED_TRANSCRIPT_METRICS=""
  TRANSCRIPT_AGGREGATION_AVAILABLE=false
else
  echo "Phase 2Q: aggregating privacy-safe metrics from PER_SESSION_METRICS_RAW"
  TRANSCRIPT_AGGREGATION_AVAILABLE=true
fi
```

**Step 2 — Aggregate and sanitize (inline Python)**:

```python
import json, sys, os, statistics
from collections import defaultdict

raw = os.environ.get('PER_SESSION_METRICS_RAW', '')
if not raw.strip():
    print('Phase 2Q: PER_SESSION_METRICS_RAW is empty — nothing to aggregate')
    sys.exit(0)

# Accumulators (whitelisted fields only — no session_id, no skill_args, no agent_desc)
durations_ms = []            # total_duration_ms per session
tool_freq = defaultdict(int) # tool_name → total call count across all sessions
skill_freq = defaultdict(int) # skill_name → invocation count across all sessions
model_freq = defaultdict(int) # model_name → message count across all sessions
compaction_counts = []       # compaction_count per session
command_buckets = defaultdict(list)  # command → list of duration_ms (for task-type normalization)
sessions_parsed = 0
sessions_skipped = 0

for line in raw.strip().split('\n'):
    line = line.strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
    except json.JSONDecodeError:
        sessions_skipped += 1
        continue

    sessions_parsed += 1

    # session_id: intentionally NOT read — stripped by omission
    command = str(rec.get('command', 'unknown'))[:32]  # safe: command name only

    dur = rec.get('total_duration_ms', 0)
    if isinstance(dur, (int, float)) and dur >= 0:
        durations_ms.append(dur)
        command_buckets[command].append(dur)

    # Tool call counts: tool names only (structural)
    for tool_name, count in (rec.get('tool_call_counts') or {}).items():
        if isinstance(count, int):
            tool_freq[str(tool_name)[:64]] += count

    # Skill invocations: skill_name only — skill_args intentionally NOT read
    for inv in (rec.get('skill_invocations') or []):
        if isinstance(inv, dict):
            sk = inv.get('skill_name', '')
            if sk:
                skill_freq[str(sk)[:32]] += 1

    # Model distribution: model name → count (authoritative source for sonnet/opus split)
    # agent_spawns[].model is intentionally NOT included here — it counts spawn intent, not
    # actual response messages, and overlaps with model_distribution in all realistic sessions.
    for m, cnt in (rec.get('model_distribution') or {}).items():
        if isinstance(cnt, int):
            model_freq[str(m)[:64]] += cnt

    cc = rec.get('compaction_count', 0)
    if isinstance(cc, int):
        compaction_counts.append(cc)

# Distribution helpers (no numpy — pure stdlib)
def _median(lst):
    if not lst: return 0
    s = sorted(lst)
    n = len(s)
    return s[n // 2] if n % 2 == 1 else (s[n//2 - 1] + s[n//2]) / 2

def _p25(lst):
    if not lst: return 0
    s = sorted(lst)
    return s[max(0, len(s)//4 - 1)]

def _p75(lst):
    if not lst: return 0
    s = sorted(lst)
    return s[min(len(s)-1, (3*len(s))//4)]

n = sessions_parsed
dur_median_s = _median(durations_ms) / 1000 if durations_ms else 0
dur_p25_s    = _p25(durations_ms) / 1000 if durations_ms else 0
dur_p75_s    = _p75(durations_ms) / 1000 if durations_ms else 0
compact_median = _median(compaction_counts) if compaction_counts else 0
compact_p25    = _p25(compaction_counts) if compaction_counts else 0
compact_p75    = _p75(compaction_counts) if compaction_counts else 0

# Top tools (top 8 by frequency)
top_tools = sorted(tool_freq.items(), key=lambda x: -x[1])[:8]
# Top skills
top_skills = sorted(skill_freq.items(), key=lambda x: -x[1])[:6]
# Model split
total_model_msgs = sum(model_freq.values()) or 1
sonnet_msgs = sum(v for k, v in model_freq.items() if 'sonnet' in k.lower())
opus_msgs   = sum(v for k, v in model_freq.items() if 'opus' in k.lower())

print(f"\n=== Phase 2Q: Privacy-Safe Aggregated Transcript Metrics ===")
print(f"Sessions aggregated: {n}  (skipped/malformed: {sessions_skipped})")
print(f"Session IDs: NOT INCLUDED (stripped by whitelist)")
print()
print(f"Active compute duration (agent time, excludes human idle):")
print(f"  Median: {dur_median_s:.0f}s  [P25: {dur_p25_s:.0f}s — P75: {dur_p75_s:.0f}s]  (across {n} pipeline runs)")
print()
print(f"Context compaction events per session:")
print(f"  Median: {compact_median:.1f}  [P25: {compact_p25:.1f} — P75: {compact_p75:.1f}]")
print()
print("Tool call distribution (top 8, all sessions combined):")
for tool, cnt in top_tools:
    print(f"  {tool}: {cnt}")
print()
print("Skill invocations (top 6):")
for skill, cnt in top_skills:
    print(f"  {skill}: {cnt}")
print()
print(f"Model distribution: sonnet={sonnet_msgs} ({100*sonnet_msgs//total_model_msgs}%)  opus={opus_msgs} ({100*opus_msgs//total_model_msgs}%)")
print()
print("Command-type duration buckets (median active time per command):")
for cmd, dlist in sorted(command_buckets.items()):
    med = _median(dlist)/1000
    p25 = _p25(dlist)/1000
    p75 = _p75(dlist)/1000
    print(f"  {cmd}: {med:.0f}s median  [P25: {p25:.0f}s — P75: {p75:.0f}s]  (n={len(dlist)})")
```

To run this step:

```bash
if [ "${TRANSCRIPT_AGGREGATION_AVAILABLE:-false}" = "true" ]; then
  AGGREGATED_TRANSCRIPT_METRICS=$(python3 - << 'PYEOF'
# [paste the Python script above here at runtime]
PYEOF
)
  echo "$AGGREGATED_TRANSCRIPT_METRICS"
  export AGGREGATED_TRANSCRIPT_METRICS

  # Extract OPUS_PCT from Phase 2Q output for use in Phase 3C health score
  # "Model distribution: sonnet=N (X%)  opus=M (Y%)"
  OPUS_PCT=$(echo "$AGGREGATED_TRANSCRIPT_METRICS" | grep -oP 'opus=\d+ \(\K\d+(?=%\))')
  OPUS_PCT=${OPUS_PCT:-0}
  export OPUS_PCT
  echo "Phase 2Q exports: OPUS_PCT=$OPUS_PCT"
fi
```

**Output variable**: `AGGREGATED_TRANSCRIPT_METRICS` — plain text block (human-readable). Consumed by Phase 5A to populate the \"Aggregated Session Metrics\" section of the health report. Export with `export AGGREGATED_TRANSCRIPT_METRICS`.

**Guardrail footnotes** — embed these verbatim in the Phase 5A report section (select ≥3; all 5 apply when transcript data is available):

> ⚠️ **Harmful-takeaway guard [1/5]**: Session duration shown here is *agent compute time* (active tool-call time), not wall-clock. Wall-clock varies 2–10x due to human idle. \"Sessions are long\" does not mean prompts are bad — it means the agent was computing for a long time. Compare against the task-type median, not a global average.

> ⚠️ **Harmful-takeaway guard [2/5]**: Tool call count is normalized per task type. A 15-file feature legitimately requires 200+ tool calls; a 1-file bug fix should need 30–50. \"High tool count\" without task-type context is a false signal. Flag only if count per files-changed is ≥3× the command-type median.

> ⚠️ **Harmful-takeaway guard [3/5]**: Skill invocation count reflects *which pipeline commands ran*, not whether they ran correctly. A session that calls \`work-on\` 6 times may be a routing loop (bad) or a 6-phase investigation (expected). Do not treat high skill counts as pipeline bloat without checking the workflow:* label progression.

> ⚠️ **Harmful-takeaway guard [4/5]**: Model distribution (sonnet/opus split) is a rate-limit pressure proxy, not a quality signal. High opus% means rate limits forced fallback — it does not mean the session used better models by choice. Remedy: spread pipeline sessions across time or reduce prompt token usage.

> ⚠️ **Harmful-takeaway guard [5/5]**: Compaction events signal large context windows, not inefficiency. A review session scanning a 20-file diff legitimately compacts once. Flag only if compaction_count > 2 per session (median) and correlate with review-finding quality degradation — not with compaction count alone.

**Threshold/target values**: Use '—' on first run (no prior baseline), matching the existing Phase 1C pattern. On subsequent runs, compare median duration and compaction rate against prior report's values.

**Skip condition**: If `TRANSCRIPT_DATA_AVAILABLE` is false or `PER_SESSION_METRICS_RAW` is empty, emit:
> `Phase 2Q: Aggregated transcript metrics unavailable — Phase 2O did not produce session data. Run /pipeline-health on the machine where Claude Code sessions are stored.`

---

### 2R: Confidence Calibration Table (from run outcomes)

**Purpose**: Surfaces whether the pipeline's stated confidence levels predict actual outcomes. A HIGH-confidence issue that frequently triggers review-findings or reverts within 14 days indicates systematic overconfidence — the investigator's confidence is not tracking reality. Conversely, needs-human routing on issues that almost always survive indicates overcaution. This section reads the calibration table produced by `scripts/calibration.mjs` and published to the `forge-knowledge` branch. <!-- Added: forge#1741 -->

**Skip if**: forge-knowledge branch is absent or `calibration/table.json` does not exist on it — emit the unavailability note below and continue.

**Read calibration table**:
```bash
# Read calibration table from forge-knowledge branch (fail-safe: any error → skip)
CALIBRATION_TABLE=""
CALIBRATION_AVAILABLE=false

if git show-ref --quiet "refs/remotes/origin/${FORGE_KNOWLEDGE_BRANCH:-forge-knowledge}" 2>/dev/null || \
   git ls-remote --exit-code origin "${FORGE_KNOWLEDGE_BRANCH:-forge-knowledge}" >/dev/null 2>&1; then
  RAW_TABLE=$(git show "origin/${FORGE_KNOWLEDGE_BRANCH:-forge-knowledge}:calibration/table.json" 2>/dev/null || echo '')
  if [ -n "$RAW_TABLE" ]; then
    CALIBRATION_TABLE="$RAW_TABLE"
    CALIBRATION_AVAILABLE=true
    CALIB_COMPUTED_AT=$(echo "$CALIBRATION_TABLE" | jq -r '.computedAt // "unknown"' 2>/dev/null || echo 'unknown')
    CALIB_TOTAL_RUNS=$(echo "$CALIBRATION_TABLE" | jq -r '.totalRuns // 0' 2>/dev/null || echo '0')
    CALIB_WINDOW_DAYS=$(echo "$CALIBRATION_TABLE" | jq -r '.windowDays // 14' 2>/dev/null || echo '14')
    CALIB_MIN_SAMPLES=$(echo "$CALIBRATION_TABLE" | jq -r '.minSamples // 10' 2>/dev/null || echo '10')
    echo "Calibration table loaded: ${CALIB_TOTAL_RUNS} runs, computed ${CALIB_COMPUTED_AT}"
  fi
fi

if [ "$CALIBRATION_AVAILABLE" = false ]; then
  echo "Phase 2R: Calibration table unavailable (forge-knowledge:calibration/table.json not found)"
  echo "  To compute: node scripts/calibration.mjs --repo ${REPO} --publish"
  # Store unavailability for Phase 5A report
  CALIBRATION_AVAILABILITY_NOTE="⚠ Calibration table unavailable — run: node scripts/calibration.mjs --repo ${REPO} --publish"
fi
```

**Render calibration table** (when available):

```bash
if [ "$CALIBRATION_AVAILABLE" = true ]; then
  echo "## Confidence Calibration Table"
  echo "**Source**: forge-knowledge:calibration/table.json"
  echo "**Computed**: ${CALIB_COMPUTED_AT}"
  echo "**Outcome window**: ${CALIB_WINDOW_DAYS} days | **Min samples for trust**: ${CALIB_MIN_SAMPLES}"
  echo "**Total runs in corpus**: ${CALIB_TOTAL_RUNS}"
  echo ""

  # Extract and render per-cell rows; flag overconfidence and overcaution cells
  OVERCONFIDENCE_CELLS=""
  OVERCAUTION_CELLS=""

  echo "$CALIBRATION_TABLE" | jq -r '
    .rows[] |
    [
      .taskType,
      .confidence,
      (if .trusted then (.survivalRate * 100 | floor | tostring) + "%" else "—(N<" + (.sampleCount | tostring) + ")" end),
      (.sampleCount | tostring),
      (if .trusted then
        (if .flag == "overconfidence" then "⚠ OVERCONFIDENCE" elif .flag == "overcaution-candidate" then "ℹ OVERCAUTION?" else "✅ OK" end)
      else "ℹ untrusted" end)
    ] | @tsv
  ' 2>/dev/null | while IFS=$'\t' read -r taskType confidence survivalRate sampleCount status; do
    printf "| %-20s | %-8s | %-18s | %-7s | %s\n" \
      "$taskType" "$confidence" "$survivalRate" "$sampleCount" "$status"

    # Collect flagged cells for summary
    if [[ "$status" == *"OVERCONFIDENCE"* ]]; then
      OVERCONFIDENCE_CELLS="${OVERCONFIDENCE_CELLS}\n  - ${taskType} × ${confidence}: ${survivalRate} survival (${sampleCount} runs)"
    elif [[ "$status" == *"OVERCAUTION"* ]]; then
      OVERCAUTION_CELLS="${OVERCAUTION_CELLS}\n  - ${taskType} × ${confidence}: ${survivalRate} survival (${sampleCount} runs)"
    fi
  done

  # Emit flag summaries
  if [ -n "$OVERCONFIDENCE_CELLS" ]; then
    echo ""
    echo "### ⚠ Overconfidence Cells (HIGH confidence, survival < 80%)"
    echo "These task-type × confidence combinations claim HIGH confidence but have poor real-world outcomes."
    echo "The review threshold for these cells should be tightened (consider needs-human routing)."
    echo -e "$OVERCONFIDENCE_CELLS"
  fi

  if [ -n "$OVERCAUTION_CELLS" ]; then
    echo ""
    echo "### ℹ Overcaution Candidates (survival > 95% — needs-human may be unnecessary)"
    echo "These cells have very high survival rates. Needs-human routing on them may be unnecessary,"
    echo "but any loosening of behavior requires the eval-gate to pass on the affected task-type corpus."
    echo "Do NOT loosen automatically — flag for human review."
    echo -e "$OVERCAUTION_CELLS"
  fi

  # 30-day trend (compare against prior report's PRIOR_CALIBRATION_COMPUTED_AT if available)
  if [ -n "${PRIOR_CALIBRATION_COMPUTED_AT:-}" ]; then
    echo ""
    echo "### Calibration Trend"
    echo "Prior table computed: ${PRIOR_CALIBRATION_COMPUTED_AT}"
    echo "Current table computed: ${CALIB_COMPUTED_AT}"
    echo "(Trend comparison requires prior report data — compare manually if prior available)"
  fi
fi
```

**Metrics to surface in Phase 5A report**:
- **Calibration data coverage**: `${CALIB_TOTAL_RUNS}` runs in corpus (target: > 20 for meaningful cells)
- **Overconfidence cells**: count of cells where HIGH-confidence survival < 80%
- **Overcaution candidates**: count of cells where survival > 95% (informational — loosening requires eval-gate)
- **Table freshness**: `computedAt` timestamp — flag as stale if > 7 days old

**Why this matters**: Static confidence thresholds in review-pr.md (Phase 7B blocking criteria) are prose rules with no feedback from outcomes. The calibration table is the mechanism by which the pipeline learns whether its stated confidence is tracking reality. A task-type with persistent overconfidence should have its review intensity increased regardless of the agent's stated confidence. <!-- Added: forge#1741 -->

---

