---
description: Recover full pipeline context after compaction — find the last active issue, reconstruct FORGE annotations, and resume work
argument-hint: [issue number (optional — auto-detects if omitted)]
install: extras
---

# /pipeline-resume — Context Recovery After Compaction

**Input**: $ARGUMENTS

You are the context-recovery agent. When a session ends or context is compressed, all working state is lost. Your job is to restore it instantly — find the most recently active issue, read all FORGE annotations, reconstruct the current pipeline phase, and re-enter the pipeline exactly where it left off.

**Agent model policy**: `model: "haiku"`, `effort: low` (mechanical tier — context recovery, annotation reading, state reconstruction). Fallback: `model: "sonnet"` if rate-limited. Feature gate: pass `effort` only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**
**NEVER use the Agent tool** — pipeline-resume re-enters the pipeline via `Skill(skill="work-on", ...)` only. Using the Agent tool would restart the pipeline in an untracked subprocess rather than resuming the existing tracked session.

<!-- FORGE:SPEC_LOADED — pipeline-resume.md loaded and active. Agent is bound by this spec. -->

---

## Phase 0: Config Resolution

Read `forge.yaml` to configure all project-specific variables before running any commands:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE")
```

If `forge.yaml` is missing: stop and tell the user to run `npx forgedock init` to generate it.

---

## Phase 1: Find Active Issue

### 1A: Parse input

Check `$ARGUMENTS`:

- **`--all-stalled`** (fleet recovery mode): shell out to `npx forgedock resume-stalled` to scan all in-flight issues for expired leases and re-dispatch them. This delegates to the durable engine's `scanStalls` for ground-truth stall detection. Add `--dry-run` if only a report is needed. Then STOP — fleet recovery is complete.

```bash
# Fleet recovery mode — delegate to the engine's resume-stalled CLI
if echo "$ARGUMENTS" | grep -q -- "--all-stalled"; then
    DRY_RUN_FLAG=""
    if echo "$ARGUMENTS" | grep -q -- "--dry-run"; then
        DRY_RUN_FLAG="--dry-run"
    fi
    echo "Fleet stall recovery: scanning all in-flight issues for expired leases…"
    npx forgedock resume-stalled $DRY_RUN_FLAG
    echo ""
    echo "Fleet recovery complete. To resume a single issue: /pipeline-resume <issue-number>"
    # STOP — fleet recovery does not fall through to single-issue resume.
fi
```

If `--all-stalled` was not specified, continue with single-issue resume:

- **Explicit issue number** (e.g., `610`, `#610`): strip `#`, set `TARGET_NUMBER={number}`, skip to Phase 2.
- **Empty**: proceed with auto-detection below.

### 1B: Query for in-progress issues

The `gh issue list --label` flag uses AND filtering when multiple labels are given. To find issues with ANY active workflow label, run one query per label and merge results:

```bash
# Find open issues with any active workflow label, sorted by most recently updated
# (gh --label uses AND, so query each label separately and merge)
ACTIVE_ISSUES=$(
  for LABEL in "workflow:investigating" "workflow:ready-to-build" "workflow:building" "workflow:in-review"; do
    gh issue list {GH_FLAG} \
      --state open \
      --label "$LABEL" \
      --limit 10 \
      --json number,title,labels,updatedAt
  done | jq -s '
    flatten |
    unique_by(.number) |
    sort_by(.updatedAt) | reverse |
    .[] | {
      number,
      title,
      phase: (.labels | map(.name | select(startswith("workflow:"))) | first // "unknown"),
      updatedAt
    }
  ')
echo "$ACTIVE_ISSUES"
```

### 1C: Select issue

**If one result**: use it — set `TARGET_NUMBER={number}`.

**If multiple results**: display a ranked list (most recently updated first), then select the top entry:

```
## Active Issues Found (most recent first)

| # | Issue | Phase | Last Updated |
|---|-------|-------|--------------|
| 1 | #{number}: {title} | {phase} | {updatedAt} |
| 2 | #{number}: {title} | {phase} | {updatedAt} |
...

Auto-selecting #1 (most recently updated). Pass an explicit issue number to override.
```

Set `TARGET_NUMBER` to the top-ranked issue number.

### 1D: Fallback — no active label found

If `ACTIVE_ISSUES` is empty, search recent issues by FORGE annotation presence:

```bash
# Look for recently updated open issues with FORGE annotations (pipeline may have stalled pre-label)
RECENT_ISSUES=$(gh issue list {GH_FLAG} \
  --state open \
  --limit 20 \
  --json number,title,updatedAt \
  --jq 'sort_by(.updatedAt) | reverse | .[0:5] | .[] | {number, title, updatedAt}')

# For each candidate, check if it has FORGE annotations
for NUMBER in $(echo "$RECENT_ISSUES" | jq -r '.number'); do
  HAS_FORGE=$(gh api repos/{GH_REPO}/issues/$NUMBER/comments \
    --jq '[.[] | select(.body | test("<!-- FORGE:"))] | length > 0' 2>/dev/null || echo "false")
  if [ "$HAS_FORGE" = "true" ]; then
    TARGET_NUMBER=$NUMBER
    break
  fi
done
```

If still no candidate: display `No recent active issues found. To resume work on a specific issue, run: /pipeline-resume {issue-number}` and STOP.

---

## Phase 2: Reconstruct Context

### 2A: Load issue state

```bash
ISSUE=$(gh issue view {TARGET_NUMBER} {GH_FLAG} \
  --json number,title,body,labels,state,milestone,updatedAt)

ISSUE_TITLE=$(echo "$ISSUE" | jq -r '.title')
ISSUE_STATE=$(echo "$ISSUE" | jq -r '.state')
ISSUE_LABELS=$(echo "$ISSUE" | jq -r '[.labels[].name] | join(", ")')
ISSUE_MILESTONE=$(echo "$ISSUE" | jq -r '.milestone.title // "none"')

echo "Issue: #${TARGET_NUMBER} — $ISSUE_TITLE"
echo "State: $ISSUE_STATE | Labels: $ISSUE_LABELS | Milestone: $ISSUE_MILESTONE"
```

If issue is CLOSED and has `workflow:merged` or `workflow:invalid` label: display completion status and STOP — no work remaining.

### 2B: Read all FORGE annotations

Fetch all comments and extract the FORGE-annotated ones in pipeline order:

```bash
COMMENTS=$(gh api repos/{GH_REPO}/issues/{TARGET_NUMBER}/comments \
  --jq '.[] | select(.body | test("<!-- FORGE:")) | {
    id: .id,
    created_at: .created_at,
    type: (.body | capture("<!-- FORGE:(?<t>[A-Z_:]+)") | .t),
    body: .body
  }')
```

Extract specific annotations:

```bash
# Investigation report
FORGE_INVESTIGATOR=$(gh api repos/{GH_REPO}/issues/{TARGET_NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' 2>/dev/null || echo "")

# Builder contract
FORGE_CONTRACT=$(gh api repos/{GH_REPO}/issues/{TARGET_NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTRACT")) | .body' 2>/dev/null || echo "")

# Implementation context
FORGE_CONTEXT=$(gh api repos/{GH_REPO}/issues/{TARGET_NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTEXT")) | .body' 2>/dev/null || echo "")

# Architecture plan
FORGE_ARCHITECT=$(gh api repos/{GH_REPO}/issues/{TARGET_NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:ARCHITECT")) | .body' 2>/dev/null || echo "")

# Builder implementation report
FORGE_BUILDER=$(gh api repos/{GH_REPO}/issues/{TARGET_NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:BUILDER")) | .body' 2>/dev/null || echo "")
```

### 2C: Determine current pipeline phase

Read labels and annotation presence to identify where the pipeline was interrupted:

```bash
# Extract active workflow label
WORKFLOW_LABEL=$(echo "$ISSUE_LABELS" | grep -oP 'workflow:[a-z:-]+' | grep -v 'workflow:merged\|workflow:invalid\|workflow:decomposed' | head -1)

# Check annotation completion markers
HAS_INVESTIGATION=$([ -n "$FORGE_INVESTIGATOR" ] && echo "$FORGE_INVESTIGATOR" | grep -q "INVESTIGATION:COMPLETE" && echo "YES" || echo "NO")
HAS_CONTRACT=$([ -n "$FORGE_CONTRACT" ] && echo "YES" || echo "NO")
HAS_CONTEXT=$([ -n "$FORGE_CONTEXT" ] && echo "YES" || echo "NO")
HAS_ARCHITECT=$([ -n "$FORGE_ARCHITECT" ] && echo "YES" || echo "NO")
HAS_BUILDER=$([ -n "$FORGE_BUILDER" ] && echo "$FORGE_BUILDER" | grep -q "FORGE:BUILDER:COMPLETE" && echo "YES" || echo "NO")

# Check for open PR on this issue's branch
OPEN_PR=$(gh pr list {GH_FLAG} --state open --search "#{TARGET_NUMBER}" --limit 1 --json number,headRefName --jq '.[0]' 2>/dev/null || echo "")
```

Map to current phase:

| Condition | Current Phase | Resume Action |
|-----------|---------------|---------------|
| `HAS_INVESTIGATION=NO` | Phase 1: Investigating | Reinvestigate |
| `HAS_INVESTIGATION=YES`, `WORKFLOW_LABEL=workflow:ready-to-build` | Phase 3: Build | Enter build from 3A |
| `HAS_INVESTIGATION=YES`, `HAS_BUILDER=NO`, `WORKFLOW_LABEL=workflow:building` | Phase 3: Build in progress | Enter build from 3A (will skip completed sub-phases) |
| `HAS_BUILDER=YES`, PR not found | Phase 4: PR Creation | Push branch + create PR |
| `OPEN_PR` found, `WORKFLOW_LABEL=workflow:in-review` | Phase 5: Auto-Review | Invoke review-pr |
| PR merged, issue still open | Phase 6: Close | Close issue, update board |

### 2D: Display context summary

Emit a structured context block before resuming — this is what anchors the agent's working memory:

```
## Context Recovered — Issue #${TARGET_NUMBER}

**Title**: {ISSUE_TITLE}
**Lane**: {fast-lane | feature-lane (milestone: {MILESTONE})}
**Current Phase**: {CURRENT_PHASE}
**Active Label**: {WORKFLOW_LABEL}

### Investigation Summary
{if HAS_INVESTIGATION=YES: extract "### What We Found" + "### Root Cause" + "### Affected Files" blocks from FORGE_INVESTIGATOR}
{if HAS_INVESTIGATION=NO: "Not yet investigated."}

### Contract
{if HAS_CONTRACT=YES: extract "### Proposed Approach" + "### Deliverables" table from FORGE_CONTRACT}
{if HAS_CONTRACT=NO: "Contract not yet written."}

### Architecture Plan
{if HAS_ARCHITECT=YES: extract "### Affected Paths" table + "### Implementation Order" from FORGE_ARCHITECT}
{if HAS_ARCHITECT=NO: "Architecture plan not yet written."}

### Build Status
{if HAS_BUILDER=YES: extract "### Changes" + "### Acceptance Criteria Status" from FORGE_BUILDER}
{if HAS_BUILDER=NO: "Implementation not yet started."}

### Open PR
{if OPEN_PR: "PR #{pr_number} → {headRefName} (open)"}
{if not OPEN_PR: "No PR yet."}

### Resume Entry Point
→ Will invoke /work-on {TARGET_NUMBER} — pipeline re-enters at {CURRENT_PHASE}
```

---

## Phase 3: Resume

Invoke `/work-on` to re-enter the pipeline. Work-on reads GitHub state independently and routes to the correct phase automatically.

```
Skill("work-on", args="{TARGET_NUMBER}")
```

**Why delegation works**: `/work-on` Phase 0B already implements "Determine resume point" — it reads issue labels and FORGE annotations to route to the correct phase. `/pipeline-resume` provides the human-readable context summary, then hands off to `/work-on` for execution.

**Do NOT re-implement pipeline logic here.** The context summary above is for the agent's working memory only — the actual phase routing and execution is owned by `/work-on`.

---

## Error Handling

| Condition | Response |
|-----------|----------|
| `forge.yaml` missing | Stop: "Run \`npx forgedock init\` to generate forge.yaml" |
| No active issues + no FORGE annotations found | Stop: "No recent active issues found. Run \`/pipeline-resume {number}\` with an explicit issue number, or \`/work-on next\` to start a new issue." |
| Issue is closed with `workflow:merged` | Stop: "Issue #{number} is already merged. Nothing to resume." |
| Issue is closed with `workflow:invalid` | Stop: "Issue #{number} was closed as invalid. Nothing to resume." |
| Issue has `needs-human` label | Stop: "Issue #{number} is blocked (needs-human). Review the blocking comment and resolve it manually before resuming." |
