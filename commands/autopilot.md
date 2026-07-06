---
description: Autonomous deploy loop — runs until zero open issues remain. Detects pipeline state and resumes from any position. Fully autonomous after invocation.
argument-hint: [--dry-run | --recon-only]
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /autopilot — Autonomous Deploy Loop

**Input**: $ARGUMENTS (default: full autonomous loop until zero open issues remain)

**Config variables used by this command** (set in `forge.yaml`):
- `{CREDENTIALS_FILE}` ← `paths.credentials.file` (optional) — path to credentials YAML for analytics APIs
- `{SERVER_SSH}` ← `services.server_ssh` (optional) — SSH target for production server health checks
- `{OPS_INBOX_PATH}` ← `services.ops_inbox_path` (optional) — path on production server to ops work-item files
- `{BILLING_ENABLED}` ← `billing.enabled` (optional, default `false`) — set to `true` to enable Stripe data in Analytics Snapshot

**NEVER use plan mode (EnterPlanMode).**
**NEVER use the Agent tool** — autopilot dispatches all work via `Skill(...)` calls only. The Agent tool bypasses the Skill pipeline's label state machine, investigation comments, and structured review — leaving no audit trail.

<!-- FORGE:SPEC_LOADED — autopilot.md loaded and active. Agent is bound by this spec. -->

You are a fully autonomous deploy loop for this project. Your job is to **detect the current pipeline state, work through all open issues from highest to lowest priority, and deploy everything — without stopping for user confirmation**. Invoking `/autopilot` is the authorization to run to completion.

**This command overrides the standard "never merge to main" rule.** `/autopilot` IS the authorized deploy system. It ships staging→main and milestone→staging→main as part of normal operation.

**This command resumes from wherever the pipeline is stuck.** It always reads current GitHub state before taking any action.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. User can override with `--model <name>`.

---

## Argument Parsing

| Flag | Effect |
|------|--------|
| (none) | Full autonomous loop — state detection → recon → fast lane → milestone → report |
| `--dry-run` | Run all phases but do NOT create issues, merge PRs, or modify state — report only |
| `--recon-only` | Phase 0 (state detection) and Phase 1 (recon) only — no loop execution |

Parse `$ARGUMENTS` and set:
```bash
DRY_RUN=false
RECON_ONLY=false

for arg in $ARGUMENTS; do
  case "$arg" in
    --dry-run)     DRY_RUN=true ;;
    --recon-only)  RECON_ONLY=true ;;
  esac
done
```

---

## Config Preamble (MANDATORY — run before any phase)

Read all `forge.yaml` config variables before any logic runs:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: forge.yaml not found. Run: npx forgedock init"
  exit 1
fi

GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE" 2>/dev/null)
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE" 2>/dev/null || git rev-parse --show-toplevel)
STAGING_BRANCH=$(yq '.branches.staging // "staging"' "$CONFIG_FILE" 2>/dev/null || echo "staging")
DEFAULT_BRANCH=$(yq '.branches.default // "main"' "$CONFIG_FILE" 2>/dev/null || echo "main")

# Optional config — gracefully absent
CREDENTIALS_FILE=$(yq '.paths.credentials.file // ""' "$CONFIG_FILE" 2>/dev/null || echo '')
SERVER_SSH=$(yq '.services.server_ssh // ""' "$CONFIG_FILE" 2>/dev/null || echo '')
OPS_INBOX_PATH=$(yq '.services.ops_inbox_path // ""' "$CONFIG_FILE" 2>/dev/null || echo '')
BILLING_ENABLED=$(yq '.billing.enabled // false' "$CONFIG_FILE" 2>/dev/null || echo 'false')

echo "Autopilot: repo=$GH_REPO staging=$STAGING_BRANCH default=$DEFAULT_BRANCH dry_run=$DRY_RUN recon_only=$RECON_ONLY"
```

---

## Phase 0: State Detection

**Goal**: Read current GitHub state and determine where the pipeline is. Always start here — never assume clean state.

### 0A: Detect open staging→main PR

```bash
STAGING_TO_MAIN_PR=$(gh pr list $GH_FLAG \
  --head "$STAGING_BRANCH" \
  --base "$DEFAULT_BRANCH" \
  --state open \
  --json number,title,headRefOid \
  --jq '.[0] // empty' 2>/dev/null)

if [ -n "$STAGING_TO_MAIN_PR" ]; then
  STAGING_PR_NUMBER=$(echo "$STAGING_TO_MAIN_PR" | jq -r '.number')
  echo "STATE: Open staging→main PR #$STAGING_PR_NUMBER detected"
else
  STAGING_PR_NUMBER=""
  echo "STATE: No open staging→main PR"
fi
```

### 0B: Detect open milestone→staging PRs

```bash
MILESTONE_PRS=$(gh pr list $GH_FLAG \
  --base "$STAGING_BRANCH" \
  --state open \
  --json number,title,headRefName \
  --jq '[.[] | select(.headRefName | startswith("milestone/"))]' 2>/dev/null || echo '[]')

MILESTONE_PR_COUNT=$(echo "$MILESTONE_PRS" | jq 'length' 2>/dev/null || echo '0')
echo "STATE: $MILESTONE_PR_COUNT open milestone→staging PR(s)"
```

### 0C: Detect in-flight issues (stuck in intermediate workflow states)

```bash
INFLIGHT_ISSUES=$(gh issue list $GH_FLAG \
  --state open \
  --limit 200 \
  --json number,title,labels \
  --jq '[.[] | select(.labels | map(.name) | any(. == "workflow:building" or . == "workflow:in-review"))] | length' \
  2>/dev/null || echo '0')
echo "STATE: $INFLIGHT_ISSUES in-flight issue(s) (workflow:building or workflow:in-review)"
```

### 0D: Detect staging vs main delta

```bash
git fetch origin "$STAGING_BRANCH" "$DEFAULT_BRANCH" 2>/dev/null || true
STAGING_AHEAD=$(git rev-list --count "origin/${DEFAULT_BRANCH}..origin/${STAGING_BRANCH}" 2>/dev/null || echo '0')
echo "STATE: staging is $STAGING_AHEAD commit(s) ahead of $DEFAULT_BRANCH"
```

### 0E: Count open unmilestoned issues

```bash
OPEN_FAST_LANE=$(gh issue list $GH_FLAG \
  --state open \
  --limit 200 \
  --json number,title,milestone,labels \
  --jq '[.[] | select(
    .milestone == null and
    (.labels | map(.name) | any(. == "workflow:merged" or . == "workflow:invalid" or . == "workflow:decomposed") | not)
  )] | length' \
  2>/dev/null || echo '0')
echo "STATE: $OPEN_FAST_LANE open unmilestoned issue(s) for fast lane"
```

### 0F: Summarize detected state

```
## Current Pipeline State

| Signal | Value |
|--------|-------|
| staging→main PR open | ${STAGING_PR_NUMBER:-none} |
| milestone→staging PRs open | $MILESTONE_PR_COUNT |
| In-flight issues (stuck) | $INFLIGHT_ISSUES |
| staging commits ahead of $DEFAULT_BRANCH | $STAGING_AHEAD |
| Open fast-lane issues | $OPEN_FAST_LANE |
```

**Resume logic**:
- If `INFLIGHT_ISSUES > 0` → call `/recover-orphans` first in Phase 1A before running recon
- If `STAGING_PR_NUMBER` is set → that deploy is in progress; `/deploy-pr` will detect and resume it
- Otherwise → proceed through phases in order

---

## Phase 1: Recon

**Goal**: Surface signals that need new GitHub issues. Lightweight — CI health, issue backlog, optional analytics pulse.

If `RECON_ONLY=true`, print the recon report and **stop after this phase**.

### 1A: Recover orphaned pipeline state (MANDATORY — run before recon)

Orphaned issues (stuck in workflow:building or workflow:in-review without an active agent) cause loop contamination. Recover them first so the loop sees accurate open issue counts.

```bash
RECOVER_ORPHANS_AVAILABLE=$(ls ~/.claude/commands/recover-orphans.md 2>/dev/null && echo "true" || echo "false")

if [ "$INFLIGHT_ISSUES" -gt 0 ]; then
  if [ "$RECOVER_ORPHANS_AVAILABLE" = "true" ] && [ "$DRY_RUN" = "false" ]; then
    echo "Recovering $INFLIGHT_ISSUES orphaned pipeline issue(s)..."
    Skill("recover-orphans", args="")
  elif [ "$DRY_RUN" = "true" ]; then
    echo "[DRY-RUN] Would invoke: Skill(recover-orphans)"
  else
    echo "WARNING: /recover-orphans not installed — cannot auto-recover orphaned issues. Install it first."
  fi
else
  echo "No in-flight issues — skipping orphan recovery"
fi
```

### 1B: CI/CD Health

```bash
DATE_1D_AGO=$(python3 -c "from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc) - timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ'))")

RECENT_FAILURES=$(gh run list $GH_FLAG --limit 30 --json conclusion,createdAt,workflowName \
  --jq "[.[] | select(.conclusion == \"failure\" and .createdAt > \"$DATE_1D_AGO\")] | length" \
  2>/dev/null || echo "0")

RECENT_RUNS=$(gh run list $GH_FLAG --limit 30 --json conclusion,createdAt \
  --jq "[.[] | select(.createdAt > \"$DATE_1D_AGO\")] | length" \
  2>/dev/null || echo "0")

echo "CI (24h): $RECENT_FAILURES/$RECENT_RUNS failures"

# Recurring failures (same workflow failing multiple times)
RECURRING=$(gh run list $GH_FLAG --limit 30 --json conclusion,workflowName \
  --jq '[.[] | select(.conclusion == "failure")] | group_by(.workflowName) | .[] | select(length > 1) | "\(length)x \(.[0].workflowName)"' \
  2>/dev/null || echo '')
[ -n "$RECURRING" ] && echo "Recurring CI failures: $RECURRING"
```

### 1C: Issue Backlog Health

```bash
DATE_14D_AGO=$(python3 -c "from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc) - timedelta(days=14)).strftime('%Y-%m-%dT%H:%M:%SZ'))")

# Count by priority
P0_COUNT=$(gh issue list $GH_FLAG --state open --limit 200 --json labels \
  --jq '[.[] | select(.labels | map(.name) | any(. == "P0"))] | length' 2>/dev/null || echo "0")
P1_COUNT=$(gh issue list $GH_FLAG --state open --limit 200 --json labels \
  --jq '[.[] | select(.labels | map(.name) | any(. == "P1"))] | length' 2>/dev/null || echo "0")
P2_COUNT=$(gh issue list $GH_FLAG --state open --limit 200 --json labels \
  --jq '[.[] | select(.labels | map(.name) | any(. == "P2"))] | length' 2>/dev/null || echo "0")

# Stale issues (open >14d, no workflow label, no milestone)
STALE_COUNT=$(gh issue list $GH_FLAG --state open --limit 200 --json number,labels,createdAt,milestone \
  --jq "[.[] | select(
    (.labels | map(.name) | any(startswith(\"workflow:\")) | not) and
    (.createdAt < \"$DATE_14D_AGO\") and
    .milestone == null
  )] | length" 2>/dev/null || echo "0")

echo "Backlog: P0=$P0_COUNT P1=$P1_COUNT P2=$P2_COUNT stale=$STALE_COUNT"
```

### 1D: Analytics Pulse (optional — forge.yaml-gated)

```bash
# Only run if CREDENTIALS_FILE is configured and the file exists
if [ -n "$CREDENTIALS_FILE" ] && [ -f "$CREDENTIALS_FILE" ]; then
  echo "Analytics pulse: credentials at $CREDENTIALS_FILE — checking GSC..."
  # GSC: last 7 days via mcp__gsc__search_analytics (if MCP available)
  # If MCP unavailable, log and skip — do not block
  ANALYTICS_AVAILABLE=true
else
  echo "Analytics pulse: SKIPPED — paths.credentials.file not set in forge.yaml or file absent"
  ANALYTICS_AVAILABLE=false
fi

# Stripe balance: only if billing.enabled is true AND credentials are present
if [ "$BILLING_ENABLED" = "true" ] && [ "$ANALYTICS_AVAILABLE" = "true" ]; then
  echo "Billing analytics: checking Stripe balance..."
  # mcp__stripe__retrieve_balance — skip gracefully if MCP unavailable
else
  echo "Billing analytics: SKIPPED — billing.enabled is false (or credentials absent)"
fi
```

### 1E: Create issues from recon findings

For each finding (recurring CI failures, critical stale issue patterns):

**Deduplication check first** — search existing open issues before creating:
```bash
EXISTING_ISSUES=$(gh issue list $GH_FLAG --state open --limit 200 --json number,title \
  --jq '.[] | "\(.number) \(.title)"' 2>/dev/null)
```

For new findings that have no existing open duplicate:
```bash
if [ "$DRY_RUN" = "false" ]; then
  gh issue create $GH_FLAG \
    --title "fix: {finding_description}" \
    --label "P2,bug" \
    --body "$(cat <<'ISSUE_EOF'
## Problem

{Description of the finding with specific data points.}

## Root Cause (if known)

{Specific root cause or "Root cause unknown — investigation needed."}

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific, testable criterion}

## Context

Found by \`/autopilot\` cycle on $(date -u +%Y-%m-%dT%H:%M:%SZ).

## Evidence

{Concrete data — log lines, failure counts, metrics}
ISSUE_EOF
)"
else
  echo "[DRY-RUN] Would create issue: fix: {finding_description}"
fi
```

Store created issue numbers in `RECON_ISSUES` array for spec-edit impact analysis.

If `RECON_ONLY=true`, print recon report and **stop here**:

```
## Autopilot Recon Report — $(date -u +%Y-%m-%dT%H:%M:%SZ)

### Pipeline State
- staging→main PR: ${STAGING_PR_NUMBER:-none detected}
- In-flight issues (orphans recovered): $INFLIGHT_ISSUES
- Open fast-lane issues: $OPEN_FAST_LANE

### CI/CD (24h)
- Failure rate: $RECENT_FAILURES/$RECENT_RUNS
- Recurring: ${RECURRING:-none}

### Issue Backlog
- Open: P0=$P0_COUNT P1=$P1_COUNT P2=$P2_COUNT
- Stale (>14d, no workflow): $STALE_COUNT

### Actions Taken
- Orphans recovered: $INFLIGHT_ISSUES
- Issues created from recon: ${#RECON_ISSUES[@]}

Run without --recon-only to execute the full autonomous loop.
```

---

## Phase 2: Fast Lane Loop

**Goal**: Work through all open unmilestoned issues until zero remain. Loop until the count is 0 or a safety cap is hit.

**Overrides "never merge to main"**: This phase deploys staging→main after each iteration. `/autopilot` is the authorized deploy system.

```bash
FAST_LANE_ITERATIONS=0
MAX_FAST_LANE_ITERATIONS=20  # safety cap — prevents infinite loop on stuck state
FAST_LANE_DEPLOYS=0
FAST_LANE_FINDINGS_BOUNCED=0

echo "=== Fast Lane Loop ==="

while true; do
  FAST_LANE_ITERATIONS=$((FAST_LANE_ITERATIONS + 1))

  if [ "$FAST_LANE_ITERATIONS" -gt "$MAX_FAST_LANE_ITERATIONS" ]; then
    echo "Fast lane loop: reached max iterations ($MAX_FAST_LANE_ITERATIONS) — breaking to prevent infinite loop"
    break
  fi

  # Re-query open unmilestoned issues — always re-read, never trust a cached count
  OPEN_UNMILESTONED=$(gh issue list $GH_FLAG \
    --state open \
    --limit 200 \
    --json number,title,milestone,labels \
    --jq '[.[] | select(
      .milestone == null and
      (.labels | map(.name) | any(. == "workflow:merged" or . == "workflow:invalid" or . == "workflow:decomposed") | not)
    )] | length' \
    2>/dev/null || echo '0')

  echo "Fast lane iteration $FAST_LANE_ITERATIONS: $OPEN_UNMILESTONED open unmilestoned issue(s)"

  if [ "$OPEN_UNMILESTONED" -eq 0 ]; then
    echo "Fast lane: zero open unmilestoned issues — loop complete"
    break
  fi

  # Step 1: Orchestrate all open fast-lane issues in parallel via /orchestrate
  echo "=== Fast Lane Iteration $FAST_LANE_ITERATIONS: Orchestrating $OPEN_UNMILESTONED issues ==="
  if [ "$DRY_RUN" = "false" ]; then
    Skill("orchestrate", args="fast-lane")
  else
    echo "[DRY-RUN] Would invoke: Skill(orchestrate, fast-lane)"
  fi

  # Step 2: Deploy staging→main if staging has new commits
  git fetch origin "$STAGING_BRANCH" "$DEFAULT_BRANCH" 2>/dev/null || true
  STAGING_AHEAD_NOW=$(git rev-list --count "origin/${DEFAULT_BRANCH}..origin/${STAGING_BRANCH}" 2>/dev/null || echo '0')

  if [ "$STAGING_AHEAD_NOW" -gt 0 ]; then
    echo "staging is $STAGING_AHEAD_NOW commit(s) ahead — deploying via /deploy-pr..."
    if [ "$DRY_RUN" = "false" ]; then
      DEPLOY_RESULT=$(Skill("deploy-pr", args="staging"))
      # Parse structured JSON result from deploy-pr
      DEPLOY_STATUS=$(echo "$DEPLOY_RESULT" | jq -r '.status // empty' 2>/dev/null || echo '')
      [ -z "$DEPLOY_STATUS" ] && DEPLOY_STATUS=$(echo "$DEPLOY_RESULT" | grep -oE '"status":"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' || echo 'unknown')
      echo "Deploy status: $DEPLOY_STATUS"
      [ "$DEPLOY_STATUS" = "merged" ] && FAST_LANE_DEPLOYS=$((FAST_LANE_DEPLOYS + 1))
    else
      echo "[DRY-RUN] Would invoke: Skill(deploy-pr, staging)"
    fi
  else
    echo "staging is not ahead of $DEFAULT_BRANCH — no deploy needed this iteration"
  fi

  # Step 3: Recover any newly orphaned issues before next iteration
  if [ "$RECOVER_ORPHANS_AVAILABLE" = "true" ] && [ "$DRY_RUN" = "false" ]; then
    Skill("recover-orphans", args="--since 2")
  elif [ "$DRY_RUN" = "true" ]; then
    echo "[DRY-RUN] Would invoke: Skill(recover-orphans, --since 2)"
  fi

  # Count review findings that bounced to fast lane (unmilestoned review-finding issues)
  NEW_FINDINGS=$(gh issue list $GH_FLAG \
    --state open \
    --limit 200 \
    --json number,milestone,labels \
    --jq '[.[] | select(.milestone == null and (.labels | map(.name) | any(. == "review-finding")))] | length' \
    2>/dev/null || echo '0')
  [ "$NEW_FINDINGS" -gt 0 ] && FAST_LANE_FINDINGS_BOUNCED=$((FAST_LANE_FINDINGS_BOUNCED + NEW_FINDINGS))
  echo "End of iteration $FAST_LANE_ITERATIONS — review findings in fast lane: $NEW_FINDINGS"
done

echo "Fast lane complete: $FAST_LANE_ITERATIONS iteration(s), $FAST_LANE_DEPLOYS deploy(s)"
```

---

## Phase 3: Milestone Loop

**Goal**: Ship each milestone with open issues, in order of completion percentage (highest first). Skip milestones at 0%.

**Each milestone cycle**: orchestrate all open issues in the milestone → ship milestone branch to staging → deploy staging to main.

```bash
MILESTONE_ITERATIONS=0
MILESTONE_DEPLOYS=0

echo "=== Milestone Loop ==="

# Get all open milestones with completion percentages
MILESTONES=$(gh api "repos/$GH_REPO/milestones" \
  --jq '[.[] | {
    number: .number,
    title: .title,
    slug: (.title | ascii_downcase | gsub("[^a-z0-9]+"; "-") | ltrimstr("-") | rtrimstr("-")),
    open_issues: .open_issues,
    closed_issues: .closed_issues,
    completion_pct: (if (.open_issues + .closed_issues) > 0 then ((.closed_issues * 100) / (.open_issues + .closed_issues) | floor) else 0 end)
  }] | sort_by(-.completion_pct)' \
  2>/dev/null || echo '[]')

MILESTONE_COUNT=$(echo "$MILESTONES" | jq 'length' 2>/dev/null || echo '0')
echo "Found $MILESTONE_COUNT milestone(s)"

echo "$MILESTONES" | jq -r '.[] | "\(.completion_pct)% — \(.title) (\(.open_issues) open, \(.closed_issues) closed)"'

# Process each milestone — sorted by completion% descending, skip 0%
echo "$MILESTONES" | jq -c '.[]' | while IFS= read -r milestone; do
  MS_TITLE=$(echo "$milestone" | jq -r '.title')
  MS_SLUG=$(echo "$milestone" | jq -r '.slug')
  MS_OPEN=$(echo "$milestone" | jq -r '.open_issues')
  MS_PCT=$(echo "$milestone" | jq -r '.completion_pct')

  if [ "$MS_PCT" -eq 0 ]; then
    echo "Skipping milestone '$MS_TITLE' (0% complete — no issues closed yet)"
    continue
  fi

  echo "=== Processing milestone: '$MS_TITLE' ($MS_PCT% complete, $MS_OPEN open) ==="

  # Step 1: Orchestrate open issues in this milestone
  if [ "$MS_OPEN" -gt 0 ]; then
    if [ "$DRY_RUN" = "false" ]; then
      Skill("orchestrate", args="milestone $MS_SLUG")
    else
      echo "[DRY-RUN] Would invoke: Skill(orchestrate, milestone $MS_SLUG)"
    fi
  else
    echo "Milestone '$MS_TITLE' has no open issues — checking if branch needs deploy"
  fi

  # Step 2: Ship milestone branch → staging via /deploy-pr
  MILESTONE_BRANCH="milestone/$MS_SLUG"
  MILESTONE_BRANCH_EXISTS=$(git ls-remote --exit-code origin "$MILESTONE_BRANCH" >/dev/null 2>&1 && echo "true" || echo "false")

  if [ "$MILESTONE_BRANCH_EXISTS" = "true" ]; then
    echo "Shipping $MILESTONE_BRANCH → staging..."
    if [ "$DRY_RUN" = "false" ]; then
      MS_RESULT=$(Skill("deploy-pr", args="$MILESTONE_BRANCH"))
      MS_STATUS=$(echo "$MS_RESULT" | jq -r '.status // empty' 2>/dev/null || echo '')
      [ -z "$MS_STATUS" ] && MS_STATUS=$(echo "$MS_RESULT" | grep -oE '"status":"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' || echo 'unknown')
      echo "Milestone ship status: $MS_STATUS"

      if [ "$MS_STATUS" = "merged" ]; then
        MILESTONE_DEPLOYS=$((MILESTONE_DEPLOYS + 1))

        # Step 3: After milestone merges to staging, deploy staging → main
        git fetch origin "$STAGING_BRANCH" "$DEFAULT_BRANCH" 2>/dev/null || true
        STAGING_AHEAD_MS=$(git rev-list --count "origin/${DEFAULT_BRANCH}..origin/${STAGING_BRANCH}" 2>/dev/null || echo '0')
        if [ "$STAGING_AHEAD_MS" -gt 0 ]; then
          echo "Milestone merged to staging — deploying staging → $DEFAULT_BRANCH..."
          MAIN_RESULT=$(Skill("deploy-pr", args="staging"))
          MAIN_STATUS=$(echo "$MAIN_RESULT" | jq -r '.status // empty' 2>/dev/null || echo 'unknown')
          echo "Main deploy status: $MAIN_STATUS"
          [ "$MAIN_STATUS" = "merged" ] && FAST_LANE_DEPLOYS=$((FAST_LANE_DEPLOYS + 1))
        fi
      fi
    else
      echo "[DRY-RUN] Would invoke: Skill(deploy-pr, $MILESTONE_BRANCH)"
      echo "[DRY-RUN] If merged, would invoke: Skill(deploy-pr, staging)"
    fi
  else
    echo "Milestone branch '$MILESTONE_BRANCH' not found on remote — skipping deploy"
  fi

  MILESTONE_ITERATIONS=$((MILESTONE_ITERATIONS + 1))

  # Step 4: Review findings from milestones are unmilestoned — they loop back to fast lane automatically
  MS_FINDINGS=$(gh issue list $GH_FLAG \
    --state open \
    --limit 50 \
    --json number,milestone,labels \
    --jq '[.[] | select(.milestone == null and (.labels | map(.name) | any(. == "review-finding")))] | length' \
    2>/dev/null || echo '0')
  [ "$MS_FINDINGS" -gt 0 ] && echo "NOTE: $MS_FINDINGS review finding(s) now in fast lane — processed next cycle"
done

echo "Milestone loop complete: $MILESTONE_ITERATIONS milestone(s) processed, $MILESTONE_DEPLOYS milestone ship(s)"
```

---

## Phase 4: Final Report

Print a summary of everything done in this autopilot run:

```bash
CYCLE_END=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Re-check final open issue count
FINAL_OPEN=$(gh issue list $GH_FLAG --state open --limit 200 --json number --jq 'length' 2>/dev/null || echo '0')
FINAL_FAST_LANE=$(gh issue list $GH_FLAG --state open --limit 200 --json number,milestone \
  --jq '[.[] | select(.milestone == null)] | length' 2>/dev/null || echo '0')

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║  Autopilot Complete                               ║"
echo "╠═══════════════════════════════════════════════════╣"
echo "║                                                   ║"

cat <<REPORT
## Autopilot Cycle Report — $CYCLE_END

### Pipeline State at Start
- staging→main PR: ${STAGING_PR_NUMBER:-none}
- In-flight issues recovered: $INFLIGHT_ISSUES
- Open fast-lane issues at start: $OPEN_FAST_LANE
- Milestones found: ${MILESTONE_COUNT:-0}

### Recon
- CI failures (24h): $RECENT_FAILURES/$RECENT_RUNS
- Recurring failures: ${RECURRING:-none}
- Issues created from recon: ${#RECON_ISSUES[@]:-0}

### Fast Lane
- Iterations: $FAST_LANE_ITERATIONS
- Deploys (staging→$DEFAULT_BRANCH): $FAST_LANE_DEPLOYS
- Review findings bounced to fast lane: $FAST_LANE_FINDINGS_BOUNCED

### Milestone Loop
- Milestones processed: $MILESTONE_ITERATIONS
- Milestone ships: $MILESTONE_DEPLOYS

### Final State
- Open issues: $FINAL_OPEN total ($FINAL_FAST_LANE unmilestoned)
REPORT

if [ "$FINAL_FAST_LANE" -eq 0 ]; then
  echo ""
  echo "Zero open unmilestoned issues remain. Pipeline is clean."
else
  echo ""
  echo "$FINAL_FAST_LANE unmilestoned issue(s) remain. These may require human review (needs-human label) or have open dependencies:"
  gh issue list $GH_FLAG --state open --limit 20 --json number,title,labels,milestone \
    --jq '.[] | select(.milestone == null) | "  #\(.number) \(.title) [\(.labels | map(.name) | join(","))]"' \
    2>/dev/null || true
fi

echo ""
echo "╚═══════════════════════════════════════════════════╝"
```

---

## Spec-Edit Impact Analysis (MANDATORY before any spec-touching recon fix)

<!-- Added: forge#870 -->

Before autopilot dispatches a recon-created fix (via /orchestrate → /work-on) that edits ForgeDock's own command specs (`commands/*.md`), surface the blast radius via `graph-query.sh`. This prevents spec edits from silently breaking downstream consumers.

**When it runs**: for each issue in `RECON_ISSUES` whose affected files include any path matching `commands/*.md`.

```bash
GRAPH_QUERY="$(git rev-parse --show-toplevel)/scripts/graph-query.sh"
RECON_ISSUES=${RECON_ISSUES:-()}

for issue in "${RECON_ISSUES[@]}"; do
  AFFECTED_SPECS=$(gh issue view "$issue" $GH_FLAG --json body --jq '.body' \
    | grep -oE '`commands/[^`]+\.md`' | tr -d '`' | head -5)
  if [ -z "$AFFECTED_SPECS" ]; then continue; fi

  IMPACT_OUTPUT=""
  if [ ! -x "$GRAPH_QUERY" ]; then
    IMPACT_OUTPUT="(skipped — Spec Knowledge Graph not installed)"
    echo "skip impact analysis for #$issue — graph-query.sh not present"
  else
    for spec_file in $AFFECTED_SPECS; do
      NODE=$(basename "$spec_file" .md)
      NODE_IMPACT=$(bash "$GRAPH_QUERY" impact "$NODE" --human 2>/dev/null || echo "(no edges for $NODE)")
      IMPACT_OUTPUT="${IMPACT_OUTPUT}### Impact of $NODE:
${NODE_IMPACT}

"
    done
  fi

  if [ "$DRY_RUN" = "false" ]; then
    gh issue comment "$issue" $GH_FLAG --body "<!-- FORGE:AUTOPILOT_IMPACT -->
## Spec-Edit Impact Analysis

**Changed spec node(s)**: \`$AFFECTED_SPECS\`
**Query**: \`graph-query.sh impact <node> --human\` (Spec Knowledge Graph, read-only)

### Blast Radius (downstream consumers of this change)
\`\`\`
$IMPACT_OUTPUT
\`\`\`

Every command/spec listed above reads the changed annotation or sits in the changed sub-phase chain. The \`/work-on\` build for this fix MUST keep these consumers working.

<!-- FORGE:AUTOPILOT_IMPACT:COMPLETE -->"
  else
    echo "[DRY-RUN] Would post FORGE:AUTOPILOT_IMPACT on issue #$issue"
  fi
done
```

**`FORGE:AUTOPILOT_IMPACT`** is a leaf annotation: autopilot is its only writer and no downstream pipeline phase consumes it. It records blast radius on the issue thread for human and reviewer visibility.

---

## Safety Rules

1. **Overrides "never merge to main"** — `/autopilot` IS the authorized deploy system. staging→main is normal operation.
2. **Never skip investigation** — all issues go through full `/work-on` pipeline (via /orchestrate) before any fix lands.
3. **Never process `needs-human` issues** — /orchestrate and /work-on skip these automatically.
4. **Never create duplicate issues** — always dedup against existing open issues before creating.
5. **Loop safety cap** — max 20 fast-lane iterations prevents infinite loops on stuck state.
6. **DRY_RUN means NO side effects** — no issues created, no PRs merged, no labels changed. Report only.
7. **Graceful sub-skill degradation** — if /recover-orphans is not installed, log a warning and continue.
8. **State always re-read** — never trust a cached issue count. Re-query GitHub at each loop iteration.
9. **deploy-pr result is authoritative** — if status is not "merged", do not assume the deploy succeeded. Log and continue the loop.

---

## Operational Notes

- **Runtime**: Recon-only ~2-3 min. Full cycle time depends on open issue count — typically 20-90 min per loop.
- **Token budget**: Recon is cheap (mostly API calls). Each orchestrate+deploy cycle is expensive (full /work-on per issue via /orchestrate).
- **Idempotent**: Safe to run multiple times — /work-on resumes from pipeline checkpoints, /deploy-pr detects existing open PRs.
- **Pairs with /loop**: Run `/loop 4h /autopilot` for continuous improvement cycles.
- **Event-driven complement**: `/autopilot` is a periodic loop. For targeted signal-driven response (metric regression, incident, GEO gap), use `/signal-planner` instead — it converts a specific signal into a dependency-ordered issue DAG, executes via `/orchestrate`, and verifies the originating signal is resolved after the work merges. Use `/autopilot` for scheduled sweeps; use `/signal-planner` for targeted responses.
