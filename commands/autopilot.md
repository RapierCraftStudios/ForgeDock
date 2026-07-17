---
description: Autonomous deploy loop — runs until zero open issues remain. Detects pipeline state and resumes from any position. Fully autonomous after invocation.
argument-hint: "[--dry-run | --recon-only]"
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
- `{RECON_SOURCES}` ← `autopilot.recon_sources` (optional, default `["ci","backlog"]`) — list of collectors to run in Phase 1. Built-in tags: `ci` (Phase 1B), `backlog` (Phase 1C), `analytics` (Phase 1D). Omit the key to run `ci` and `backlog` only.

**NEVER use plan mode (EnterPlanMode).**
**NEVER use the Agent tool** — autopilot dispatches all work via `Skill(...)` calls only. The Agent tool bypasses the Skill pipeline's label state machine, investigation comments, and structured review — leaving no audit trail.

<!-- FORGE:SPEC_LOADED — autopilot.md loaded and active. Agent is bound by this spec. -->

You are a fully autonomous deploy loop for this project. Your job is to **detect the current pipeline state, work through all open issues, and deploy everything — without stopping for user confirmation**. Invoking `/autopilot` is the authorization to run to completion.

**Issue selection and priority**: Phase 2 (Fast Lane Loop) dispatches all eligible open issues **concurrently** via the durable engine — ordering is irrelevant at dispatch time because all issues start simultaneously. For scenarios requiring sequential, priority-ordered dispatch (P0 before P1 before P2, unlabeled excluded), use `scripts/select-fix-targets.sh` as the entry point. This script will be the substitution point when #1743 (economic scheduling) implements value/cost-based ordering. <!-- Added: forge#1752 -->

**This command overrides the standard "never merge to main" rule.** `/autopilot` IS the authorized deploy system. It ships staging→main and milestone→staging→main as part of normal operation.

**This command resumes from wherever the pipeline is stuck.** It always reads current GitHub state before taking any action.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. User can override with `--model <name>`.

---

## Argument Parsing

| Flag | Effect |
|------|--------|
| (none) | Full autonomous loop — state detection → recon → fast lane → milestone → report |
| `--dry-run` | Run all phases but do NOT create issues, merge PRs, or modify state — report only |
| `--recon-only` | Phase 0 (state detection) and Phase 1 (recon) only — no loop execution |
| `--fix` | Enable autonomous fix dispatch for this run (requires `autopilot.headless: true` in forge.yaml; refused otherwise) |

Parse `$ARGUMENTS` and set:
```bash
DRY_RUN=false
RECON_ONLY=false
AUTOPILOT_FIX=false

for arg in $ARGUMENTS; do
  case "$arg" in
    --dry-run)     DRY_RUN=true ;;
    --recon-only)  RECON_ONLY=true ;;
    --fix)         AUTOPILOT_FIX=true ;;
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

# Hygiene counters — populated by Phase 1B.5 (/cleanup) and Phase 1A (/recover-orphans)
CLEANUP_LABELS_FIXED=0

# Autopilot ops issue — rolling issue where FORGE:AUTOPILOT_CYCLE annotations accumulate.
# Created automatically on first run if absent. Label is configurable; defaults to autopilot-ops.
AUTOPILOT_OPS_LABEL=$(yq '.autopilot.ops_issue_label // "autopilot-ops"' "$CONFIG_FILE" 2>/dev/null || echo 'autopilot-ops')

# Declared autonomy policy (forge.yaml → autopilot.*).
# All fields default to the conservative/safe value when absent so existing configs are unaffected.
AUTOPILOT_HEADLESS=$(yq '.autopilot.headless // false' "$CONFIG_FILE" 2>/dev/null || echo 'false')
AUTOPILOT_APPROVE_P0=$(yq '.autopilot.approve.p0 // "needs-human"' "$CONFIG_FILE" 2>/dev/null || echo 'needs-human')
AUTOPILOT_APPROVE_P1=$(yq '.autopilot.approve.p1 // "needs-human"' "$CONFIG_FILE" 2>/dev/null || echo 'needs-human')
AUTOPILOT_APPROVE_P2=$(yq '.autopilot.approve.p2 // "needs-human"' "$CONFIG_FILE" 2>/dev/null || echo 'needs-human')
AUTOPILOT_APPROVE_P3=$(yq '.autopilot.approve.p3 // "needs-human"' "$CONFIG_FILE" 2>/dev/null || echo 'needs-human')
BUDGET_PER_CYCLE_FIXES=$(yq '.autopilot.budget.per_cycle_fixes // "null"' "$CONFIG_FILE" 2>/dev/null || echo 'null')
# yq may emit a float (e.g. "5.0"); truncate to an integer so `[ "$FIX_COUNT" -ge ... ]`
# does not error. Leaves the "null"/empty guard value untouched. Single assignment, so
# both budget-ceiling checks (fast lane + milestone lane) read the truncated value.
case "$BUDGET_PER_CYCLE_FIXES" in
  ''|null) : ;;
  *) BUDGET_PER_CYCLE_FIXES=$(echo "$BUDGET_PER_CYCLE_FIXES" | cut -d. -f1) ;;
esac
RECON_SOURCES=$(yq '.autopilot.recon_sources // ["ci","backlog"] | join(",")' "$CONFIG_FILE" 2>/dev/null || echo 'ci,backlog')

# FIX_COUNT tracks how many issues have been dispatched as autonomous fixes this cycle.
# Declared here (outside all loops) so it persists across Phase 2 and Phase 3 iterations.
FIX_COUNT=0

# Policy decision accumulators — populated during dispatch; written to FORGE:AUTOPILOT_CYCLE.
POLICY_APPROVED_ISSUES=()   # issue numbers dispatched automatically by policy
POLICY_GATED_ISSUES=()      # issue numbers whose plan was posted for async approval
POLICY_DEFERRED_ISSUES=()   # issue numbers deferred due to budget ceiling

# Headless guard: if --fix requested but headless: false (default), refuse and exit.
# This guard runs after all config is read so the refusal message can include the fix target.
if [ "$AUTOPILOT_FIX" = "true" ] && [ "$AUTOPILOT_HEADLESS" != "true" ]; then
  echo ""
  echo "ERROR: --fix requested but autopilot.headless is not set to true in forge.yaml."
  echo ""
  echo "Autonomous fix dispatch requires an explicit opt-in:"
  echo "  autopilot:"
  echo "    headless: true"
  echo "    approve:"
  echo "      p2: auto   # or whichever priorities you trust for autonomous fixing"
  echo ""
  echo "Without this declaration, /autopilot performs recon and reporting only — no fixes."
  echo "Add the autopilot.headless: true block to forge.yaml to enable unattended fixing."
  exit 1
fi

# Resolve or create the ops issue (idempotent — checks before creating)
OPS_ISSUE_NUMBER=$(gh issue list $GH_FLAG \
  --state open \
  --label "$AUTOPILOT_OPS_LABEL" \
  --limit 1 \
  --json number \
  --jq '.[0].number // empty' 2>/dev/null || echo '')

if [ -z "$OPS_ISSUE_NUMBER" ]; then
  echo "Autopilot: ops issue not found — creating one with label '$AUTOPILOT_OPS_LABEL'"
  if [ "$DRY_RUN" = "false" ]; then
    # Ensure the label exists before creating the issue
    gh label create "$AUTOPILOT_OPS_LABEL" \
      --description "Autopilot ops issue — rolling FORGE:AUTOPILOT_CYCLE annotations. Managed by /autopilot." \
      --color "0075CA" \
      $GH_FLAG 2>/dev/null || true
    OPS_BODY_TMPFILE=$(mktemp)
    trap 'rm -f "$OPS_BODY_TMPFILE"' EXIT
    cat > "$OPS_BODY_TMPFILE" <<'OPS_EOF'
## Autopilot Ops Issue

This issue is the rolling log for `/autopilot` cycle annotations. Each cycle appends a `<!-- FORGE:AUTOPILOT_CYCLE -->` comment with its metrics and phase-completion markers. Cycle N+1 reads the latest comment for baseline deltas and resume state.

**Do not close this issue manually.** It is managed by `/autopilot`.
OPS_EOF
    # Route through the /issue create-hook (canonical dedup + body validation) instead of
    # a raw `gh issue create`. See commands/issue.md Programmatic Invocation Contract.
    Skill(skill="issue", args="--title \"ops: autopilot cycle log\" --body-file \"$OPS_BODY_TMPFILE\" --label \"$AUTOPILOT_OPS_LABEL\"")
    rm -f "$OPS_BODY_TMPFILE"
    trap - EXIT
    OPS_ISSUE_NUMBER=$(gh issue list $GH_FLAG \
      --state open \
      --search "ops: autopilot cycle log" \
      --json number,title \
      --jq '.[] | select(.title == "ops: autopilot cycle log") | .number' 2>/dev/null | head -1)
    echo "Autopilot: ops issue created: #$OPS_ISSUE_NUMBER"
  else
    echo "[DRY-RUN] Would create ops issue with label '$AUTOPILOT_OPS_LABEL'"
    OPS_ISSUE_NUMBER="0"
  fi
else
  echo "Autopilot: ops issue found: #$OPS_ISSUE_NUMBER"
fi

echo "Autopilot: repo=$GH_REPO staging=$STAGING_BRANCH default=$DEFAULT_BRANCH dry_run=$DRY_RUN recon_only=$RECON_ONLY fix=$AUTOPILOT_FIX ops_issue=#$OPS_ISSUE_NUMBER"
echo "Autonomy policy: headless=$AUTOPILOT_HEADLESS approve={p0:$AUTOPILOT_APPROVE_P0,p1:$AUTOPILOT_APPROVE_P1,p2:$AUTOPILOT_APPROVE_P2,p3:$AUTOPILOT_APPROVE_P3} budget.per_cycle_fixes=$BUDGET_PER_CYCLE_FIXES"
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

### 0G: Read prior cycle baseline (for delta computation)

Read the latest `FORGE:AUTOPILOT_CYCLE` annotation from the ops issue. Extract baseline metrics so Phase 4 can compute deltas showing what changed since the last cycle.

```bash
# Read the latest AUTOPILOT_CYCLE annotation from the ops issue
PREV_CYCLE_COMMENT=""
PREV_CYCLE_ID=""
PREV_CYCLE_BASELINE=""
PREV_CYCLE_OPEN_ISSUES=""
PREV_CYCLE_CI_FAILURES=""
PREV_CYCLE_PENDING_FINDINGS=""

if [ -n "$OPS_ISSUE_NUMBER" ] && [ "$OPS_ISSUE_NUMBER" != "0" ]; then
  PREV_CYCLE_COMMENT=$(gh api repos/${GH_REPO}/issues/${OPS_ISSUE_NUMBER}/comments \
    --jq '[.[] | select(.body | contains("FORGE:AUTOPILOT_CYCLE"))] | last | .body // ""' \
    2>/dev/null || echo '')

  if [ -n "$PREV_CYCLE_COMMENT" ]; then
    # Check it's a complete (not interrupted) cycle
    PREV_COMPLETE=$(echo "$PREV_CYCLE_COMMENT" | grep -c "FORGE:AUTOPILOT_CYCLE:COMPLETE" || echo "0")

    if [ "${PREV_COMPLETE:-0}" -gt 0 ]; then
      PREV_CYCLE_ID=$(echo "$PREV_CYCLE_COMMENT" \
        | grep -oP '(?<=\*\*cycle_id\*\*: )[^\n]+' | head -1 | tr -d '[:space:]' || echo '')
      PREV_CYCLE_BASELINE=$(echo "$PREV_CYCLE_COMMENT" \
        | grep -oP '(?<=\*\*baseline\*\*: ).+' | head -1 || echo '{}')
      # Extract numeric metrics from the baseline JSON string
      PREV_CYCLE_OPEN_ISSUES=$(echo "$PREV_CYCLE_BASELINE" \
        | jq -r '.open_issues // empty' 2>/dev/null || echo '')
      PREV_CYCLE_CI_FAILURES=$(echo "$PREV_CYCLE_BASELINE" \
        | jq -r '.ci_failures // empty' 2>/dev/null || echo '')
      PREV_CYCLE_PENDING_FINDINGS=$(echo "$PREV_CYCLE_BASELINE" \
        | jq -r '.pending_findings // empty' 2>/dev/null || echo '')
      echo "Prior cycle: $PREV_CYCLE_ID — open_issues=$PREV_CYCLE_OPEN_ISSUES ci_failures=$PREV_CYCLE_CI_FAILURES findings=$PREV_CYCLE_PENDING_FINDINGS"
    else
      echo "Prior cycle annotation found but not complete — will check for resume in Phase 0H"
    fi
  else
    echo "No prior FORGE:AUTOPILOT_CYCLE annotation found — this is the first cycle"
  fi
fi
```

### 0H: Resume detection (skip committed phases on restart)

If the latest cycle annotation on the ops issue is **incomplete** (lacks `FORGE:AUTOPILOT_CYCLE:COMPLETE`), this cycle was interrupted. Read `phase_markers` to determine which phases already committed and skip them — avoiding duplicate issue creation, duplicate deploys, and redundant work.

```bash
RESUME_FROM_PHASE=""
SKIP_RECON=false
SKIP_FAST_LANE=false
SKIP_MILESTONE=false

if [ -n "$PREV_CYCLE_COMMENT" ]; then
  PREV_COMPLETE=$(echo "$PREV_CYCLE_COMMENT" | grep -c "FORGE:AUTOPILOT_CYCLE:COMPLETE" || echo "0")

  if [ "${PREV_COMPLETE:-0}" -eq 0 ]; then
    # Incomplete cycle — extract committed phase_markers
    PREV_PHASE_MARKERS=$(echo "$PREV_CYCLE_COMMENT" \
      | grep -oP '(?<=\*\*phase_markers\*\*: )[^\n]+' | head -1 | tr -d '[:space:]' || echo '')

    echo "RESUME: Incomplete prior cycle detected. Committed phases: ${PREV_PHASE_MARKERS:-none}"

    # Set skip flags for phases already committed
    echo "$PREV_PHASE_MARKERS" | grep -q "recon"      && SKIP_RECON=true      && echo "RESUME: Skipping Phase 1 (recon already committed)"
    echo "$PREV_PHASE_MARKERS" | grep -q "fast-lane"  && SKIP_FAST_LANE=true  && echo "RESUME: Skipping Phase 2 (fast-lane already committed)"
    echo "$PREV_PHASE_MARKERS" | grep -q "milestone"  && SKIP_MILESTONE=true  && echo "RESUME: Skipping Phase 3 (milestone already committed)"

    # Inherit the cycle_id from the interrupted cycle so the resume writes to the same annotation
    RESUME_CYCLE_ID=$(echo "$PREV_CYCLE_COMMENT" \
      | grep -oP '(?<=\*\*cycle_id\*\*: )[^\n]+' | head -1 | tr -d '[:space:]' || echo '')
    [ -n "$RESUME_CYCLE_ID" ] && echo "RESUME: Continuing as cycle $RESUME_CYCLE_ID"
  fi
fi

# Generate a new cycle_id if not resuming an interrupted cycle
if [ -z "$RESUME_CYCLE_ID" ]; then
  # Count completed cycles today to produce a unique counter
  TODAY=$(date -u +%Y%m%d)
  if [ -n "$OPS_ISSUE_NUMBER" ] && [ "$OPS_ISSUE_NUMBER" != "0" ]; then
    TODAY_CYCLE_COUNT=$(gh api repos/${GH_REPO}/issues/${OPS_ISSUE_NUMBER}/comments \
      --jq "[.[] | select(.body | contains(\"FORGE:AUTOPILOT_CYCLE\") and contains(\"FORGE:AUTOPILOT_CYCLE:COMPLETE\") and contains(\"$TODAY\"))] | length" \
      2>/dev/null || echo '0')
  else
    TODAY_CYCLE_COUNT=0
  fi
  CYCLE_COUNTER=$((TODAY_CYCLE_COUNT + 1))
  CYCLE_ID="${TODAY}-${CYCLE_COUNTER}"
  echo "New cycle: $CYCLE_ID"
else
  CYCLE_ID="$RESUME_CYCLE_ID"
fi

# Initialize phase_markers (will be extended as phases complete)
PHASE_MARKERS_COMMITTED="${PREV_PHASE_MARKERS:-}"
```

---

## Phase 1: Recon

**Goal**: Surface signals that need new GitHub issues. Lightweight — CI health, issue backlog, optional analytics pulse.

If `RECON_ONLY=true`, print the recon report and **stop after this phase**.

**Resume guard**: If `SKIP_RECON=true` (set in Phase 0H — recon was already committed in the interrupted cycle), skip Phase 1 entirely and proceed to Phase 2.

```bash
if [ "$SKIP_RECON" = "true" ]; then
  echo "RESUME: Phase 1 (recon) already committed in cycle $CYCLE_ID — skipping"
  RECON_ISSUES=()
  RECENT_FAILURES=0
  RECENT_RUNS=0
  RECURRING=""
else
```

*(Close the skip block at the end of Phase 1, after the RECON_ONLY stop point.)*

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

Runs when `ci` is in `RECON_SOURCES` (default: always). Skip with `autopilot.recon_sources: ["backlog"]` in forge.yaml.

```bash
# Collector gate — skip if 'ci' not declared in RECON_SOURCES.
# Exact comma-delimited match so 'ci' does not false-match 'ci-extended' (grep -qw
# treats '-' as a word boundary and would match the hyphenated tag).
if echo "$RECON_SOURCES" | grep -qE '(^|,)ci(,|$)'; then
  # Node.js is guaranteed by the npm installer; python3 is not (Windows alias issue)
  DATE_1D_AGO=$(node -e "console.log(new Date(Date.now()-86400000).toISOString())")

  # 3-minute timeout per collector — a hung gh call costs one report line, not the cycle
  TIMEOUT_CMD=$(command -v timeout >/dev/null 2>&1 && echo "timeout 180" || echo "")

  RECENT_FAILURES=$(${TIMEOUT_CMD} gh run list $GH_FLAG --limit 30 --json conclusion,createdAt,workflowName \
    --jq "[.[] | select(.conclusion == \"failure\" and .createdAt > \"$DATE_1D_AGO\")] | length" \
    2>/dev/null || echo "0")

  RECENT_RUNS=$(${TIMEOUT_CMD} gh run list $GH_FLAG --limit 30 --json conclusion,createdAt \
    --jq "[.[] | select(.createdAt > \"$DATE_1D_AGO\")] | length" \
    2>/dev/null || echo "0")

  echo "CI (24h): $RECENT_FAILURES/$RECENT_RUNS failures"

  # Recurring failures (same workflow failing multiple times)
  RECURRING=$(${TIMEOUT_CMD} gh run list $GH_FLAG --limit 30 --json conclusion,workflowName \
    --jq '[.[] | select(.conclusion == "failure")] | group_by(.workflowName) | .[] | select(length > 1) | "\(length)x \(.[0].workflowName)"' \
    2>/dev/null || echo '')
  [ -n "$RECURRING" ] && echo "Recurring CI failures: $RECURRING"
else
  echo "CI collector (1B): SKIPPED — 'ci' not in autopilot.recon_sources"
  RECENT_FAILURES=0
  RECENT_RUNS=0
  RECURRING=""
fi
```

### 1B.5: Label Hygiene Delegation

Sweep stale workflow labels from closed issues. Delegates to `/cleanup labels` — the command that verifies state before acting and maintains an audit trail. Autopilot never performs label mutations directly.

```bash
CLEANUP_AVAILABLE=$(ls ~/.claude/commands/cleanup.md 2>/dev/null && echo "true" || echo "false")

if [ "$DRY_RUN" = "false" ]; then
  if [ "$CLEANUP_AVAILABLE" = "true" ]; then
    echo "Running label hygiene sweep via /cleanup..."
    Skill("cleanup", args="labels")
    CLEANUP_LABELS_FIXED=1  # /cleanup ran; detailed counts are in its own output
  else
    echo "INFO: /cleanup not installed (extras tier) — skipping label hygiene sweep. Install with: npx forgedock install --extras"
  fi
else
  echo "[DRY-RUN] Would invoke: Skill(cleanup, labels)"
fi
```

### 1C: Issue Backlog Health

Runs when `backlog` is in `RECON_SOURCES` (default: always). Skip with `autopilot.recon_sources: ["ci"]` in forge.yaml.

```bash
# Collector gate — skip if 'backlog' not declared in RECON_SOURCES.
# Exact comma-delimited match (see 1B) — avoids false-matching hyphenated tags.
if echo "$RECON_SOURCES" | grep -qE '(^|,)backlog(,|$)'; then
  # Node.js is guaranteed by the npm installer; python3 is not (Windows alias issue)
  DATE_14D_AGO=$(node -e "console.log(new Date(Date.now()-14*86400000).toISOString())")

  # Reuse TIMEOUT_CMD from 1B if set; detect if this is the first collector run
  TIMEOUT_CMD=${TIMEOUT_CMD:-$(command -v timeout >/dev/null 2>&1 && echo "timeout 180" || echo "")}

  # Count by priority
  P0_COUNT=$(${TIMEOUT_CMD} gh issue list $GH_FLAG --state open --limit 200 --json labels \
    --jq '[.[] | select(.labels | map(.name) | any(. == "P0"))] | length' 2>/dev/null || echo "0")
  P1_COUNT=$(${TIMEOUT_CMD} gh issue list $GH_FLAG --state open --limit 200 --json labels \
    --jq '[.[] | select(.labels | map(.name) | any(. == "P1"))] | length' 2>/dev/null || echo "0")
  P2_COUNT=$(${TIMEOUT_CMD} gh issue list $GH_FLAG --state open --limit 200 --json labels \
    --jq '[.[] | select(.labels | map(.name) | any(. == "P2"))] | length' 2>/dev/null || echo "0")

  # Stale issues (open >14d, no workflow label, no milestone)
  STALE_COUNT=$(${TIMEOUT_CMD} gh issue list $GH_FLAG --state open --limit 200 --json number,labels,createdAt,milestone \
    --jq "[.[] | select(
      (.labels | map(.name) | any(startswith(\"workflow:\")) | not) and
      (.createdAt < \"$DATE_14D_AGO\") and
      .milestone == null
    )] | length" 2>/dev/null || echo "0")

  echo "Backlog: P0=$P0_COUNT P1=$P1_COUNT P2=$P2_COUNT stale=$STALE_COUNT"
else
  echo "Backlog collector (1C): SKIPPED — 'backlog' not in autopilot.recon_sources"
  P0_COUNT=0; P1_COUNT=0; P2_COUNT=0; STALE_COUNT=0
fi
```

### 1D: Analytics Pulse (optional — forge.yaml-gated, recon_sources-gated)

Runs only when ALL of: (a) `analytics` is in `RECON_SOURCES`, (b) `CREDENTIALS_FILE` is set and exists, (c) the relevant MCP server is reachable. Enable with `autopilot.recon_sources: ["ci","backlog","analytics"]` in forge.yaml.

```bash
ANALYTICS_AVAILABLE=false

# Collector gate — skip if 'analytics' not declared in RECON_SOURCES.
# Exact comma-delimited match (see 1B) — avoids false-matching hyphenated tags.
if ! echo "$RECON_SOURCES" | grep -qE '(^|,)analytics(,|$)'; then
  echo "Analytics collector (1D): SKIPPED — 'analytics' not in autopilot.recon_sources"
elif [ -z "$CREDENTIALS_FILE" ] || [ ! -f "$CREDENTIALS_FILE" ]; then
  echo "Analytics collector (1D): SKIPPED — paths.credentials.file not set in forge.yaml or file absent"
else
  echo "Analytics pulse: credentials at $CREDENTIALS_FILE — checking MCP availability..."
  # MCP capability detection: verify the GSC MCP server is reachable before invoking.
  # If the server is absent, the tool call would produce an agent error rather than a graceful skip.
  # Detection strategy: attempt a lightweight probe (list tools or a no-op call) and gate on exit code.
  # When the MCP server is present, proceed; when absent, log and skip without blocking the cycle.
  # Dual-mode by design: an LLM agent interprets `mcp__gsc__search_analytics` as an MCP tool call
  # (exit code = availability); a POSIX shell interprets it as an unknown command → 'command not
  # found' → exit 1 → the else branch. Either interpretation yields a graceful skip when GSC is absent.
  if mcp__gsc__search_analytics --list-only 2>/dev/null; then
    ANALYTICS_AVAILABLE=true
    echo "Analytics pulse: GSC MCP available — proceeding with 7-day search analytics query"
    # Full GSC analytics query runs here when MCP is present
  else
    echo "Analytics pulse: SKIPPED — GSC MCP server not reachable (mcp__gsc__search_analytics unavailable)"
  fi
fi

# Stripe balance: only if billing.enabled is true AND analytics collector ran successfully
if [ "$BILLING_ENABLED" = "true" ] && [ "$ANALYTICS_AVAILABLE" = "true" ]; then
  echo "Billing analytics: checking Stripe balance..."
  # mcp__stripe__retrieve_balance — skip gracefully if MCP unavailable
else
  echo "Billing analytics: SKIPPED — billing.enabled is false, credentials absent, or analytics collector skipped"
fi
```

### 1E: Create issues from recon findings

For each finding (recurring CI failures, critical stale issue patterns), route creation through the `/issue` create-hook — its Phase 2D runs the same deterministic `scripts/issue-dedup.sh` + LLM-fallback dedup this step used to run inline, and its Phase 3F runs the same mandatory-section repair this step used to run inline post-creation. Do not duplicate either check here.

```bash
if [ "$DRY_RUN" = "false" ]; then
  # Write body to a temp file to avoid heredoc shell-expansion and injection issues
  BODY_TMPFILE=$(mktemp /tmp/autopilot-issue-body-XXXXXX.md)
  trap 'rm -f "$BODY_TMPFILE"' EXIT

  cat > "$BODY_TMPFILE" <<'ISSUE_BODY_EOF'
## Problem

{Description of the finding with specific data points.}

## Root Cause (if known)

{Specific root cause or "Root cause unknown — investigation needed."}

## Affected Files

Files that need changes (ordered by dependency):
1. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific, testable criterion}

## Context

Found by `/autopilot` cycle on {CYCLE_TIMESTAMP}.

## Evidence

{Concrete data — log lines, failure counts, metrics}
ISSUE_BODY_EOF

  # Substitute the cycle timestamp (not inside heredoc to avoid expansion-in-template issues)
  sed -i "s|{CYCLE_TIMESTAMP}|$(date -u +%Y-%m-%dT%H:%M:%SZ)|g" "$BODY_TMPFILE"

  FINDING_TITLE="fix: {finding_description}"

  # Route through the /issue create-hook (canonical dedup + body validation) instead of
  # a raw `gh issue create`. If /issue finds a near-duplicate, it reports it and does not
  # create — NEW_NUMBER will come back empty from the lookup below.
  Skill(skill="issue", args="--title \"$FINDING_TITLE\" --body-file \"$BODY_TMPFILE\" --label P2 --label bug")

  rm -f "$BODY_TMPFILE"
  trap - EXIT

  NEW_NUMBER=$(gh issue list $GH_FLAG \
    --state open \
    --search "$FINDING_TITLE" \
    --json number,title \
    --jq --arg t "$FINDING_TITLE" '.[] | select(.title == $t) | .number' 2>/dev/null | head -1)

  if [ -n "$NEW_NUMBER" ]; then
    echo "Created: #$NEW_NUMBER"
  else
    echo "No new issue created for finding (likely deduped by /issue) — skipping"
  fi
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
- Orphans recovered (/recover-orphans): $INFLIGHT_ISSUES
- Label hygiene (/cleanup labels): $([ "${CLEANUP_LABELS_FIXED:-0}" -eq 1 ] && echo "ran" || echo "skipped (not installed or dry-run)")
- Issues created from recon: ${#RECON_ISSUES[@]}

Run without --recon-only to execute the full autonomous loop.
```

```bash
fi  # end SKIP_RECON guard

# Phase 1 complete — record phase marker
PHASE_MARKERS_COMMITTED="${PHASE_MARKERS_COMMITTED:+$PHASE_MARKERS_COMMITTED,}recon"
echo "Phase 1 complete. Committed phases: $PHASE_MARKERS_COMMITTED"
```

---

## Phase 2: Fast Lane Loop

**Goal**: Work through all open unmilestoned issues until zero remain. Loop until the count is 0 or a safety cap is hit.

**Overrides "never merge to main"**: This phase deploys staging→main after each iteration. `/autopilot` is the authorized deploy system.

**Resume guard**: If `SKIP_FAST_LANE=true` (set in Phase 0H — fast lane was already committed in the interrupted cycle), skip Phase 2 entirely and proceed to Phase 3.

```bash
FAST_LANE_ITERATIONS=0
MAX_FAST_LANE_ITERATIONS=20  # safety cap — prevents infinite loop on stuck state
FAST_LANE_DEPLOYS=0
FAST_LANE_FINDINGS_BOUNCED=0
DISPATCHED_ISSUES=()        # accumulates every issue number dispatched this cycle (for Phase 4 report)
STALLED_ISSUES=()           # issues that did not reach a terminal state after dispatch

if [ "$SKIP_FAST_LANE" = "true" ]; then
  echo "RESUME: Phase 2 (fast-lane) already committed in cycle $CYCLE_ID — skipping"
else

echo "=== Fast Lane Loop ==="

while true; do
  FAST_LANE_ITERATIONS=$((FAST_LANE_ITERATIONS + 1))

  if [ "$FAST_LANE_ITERATIONS" -gt "$MAX_FAST_LANE_ITERATIONS" ]; then
    echo "Fast lane loop: reached max iterations ($MAX_FAST_LANE_ITERATIONS) — breaking to prevent infinite loop"
    break
  fi

  # Fast preliminary fleet-health check (forge#2393): `forgedock query fleet`'s exit
  # code (0 healthy / 2 stalls present / 3 blocked present) is a single-call signal
  # for whether any in-flight fast-lane agent needs recovery attention this iteration
  # — read ahead of the detailed per-issue `gh issue list` enumeration below (which
  # still runs regardless, since dispatch/recovery need full issue objects, not just
  # counts). A non-zero exit is not itself a reason to break the loop — it flags that
  # this iteration's terminal-state verification sweep (below) is likely to find
  # stalled/blocked issues worth routing through recover-orphans.
  FLEET_JSON=$(npx forgedock query fleet $GH_FLAG 2>/dev/null)
  FLEET_EXIT=$?
  case "$FLEET_EXIT" in
    0) echo "Fleet health: healthy (query fleet exit 0)" ;;
    2) echo "Fleet health: stalls present (query fleet exit 2) — expect recover-orphans activity this iteration" ;;
    3) echo "Fleet health: blocked issues present (query fleet exit 3, needs-human) — expect recover-orphans activity this iteration" ;;
    *) echo "Fleet health: query fleet unavailable or errored (exit $FLEET_EXIT) — proceeding on label counts alone" ;;
  esac

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

  if [ "$OPEN_UNMILESTONED" -eq 0 ] && [ "$FLEET_EXIT" -ne 2 ] && [ "$FLEET_EXIT" -ne 3 ]; then
    echo "Fast lane: zero open unmilestoned issues and no stalled/blocked in-flight agents — loop complete"
    break
  elif [ "$OPEN_UNMILESTONED" -eq 0 ]; then
    # Note: this extra pass re-runs the SAME dispatch/recovery sweep as every other
    # iteration, which is scoped to unmilestoned issues only (FAST_LANE_ISSUE_NUMS /
    # PRE_DISPATCH_ISSUES below both filter on `.milestone == null`). It does not
    # itself recover a milestoned stalled/blocked agent — that's handled separately
    # by /orchestrate's own stall detector. This is just a bounded extra fast-lane
    # iteration before declaring the loop complete, not a milestone-aware recovery step.
    echo "Fast lane: zero open unmilestoned issues, but query fleet reports stalled/blocked agents (exit $FLEET_EXIT) — running one more fast-lane iteration before declaring complete (unmilestoned-scope recovery sweep only; milestoned stalls are recovered separately by /orchestrate)"
  fi

  # Step 1: Drive all open fast-lane issues through the durable engine.
  # Each issue is dispatched individually via `forgedock run-issue` so the engine's
  # phase table (fail-closed review gate, deterministic resume, lease-based concurrency)
  # enforces every transition — not the LLM interpreting work-on.md.
  # Fallback: if forgedock CLI is unavailable, delegate to /orchestrate (markdown-spec path).
  echo "=== Fast Lane Iteration $FAST_LANE_ITERATIONS: Dispatching $OPEN_UNMILESTONED issues via engine ==="

  FORGEDOCK_AVAILABLE=$(command -v forgedock >/dev/null 2>&1 && echo "true" || echo "false")

  if [ "$DRY_RUN" = "false" ]; then
    if [ "$FORGEDOCK_AVAILABLE" = "true" ]; then
      # Engine-first dispatch: enumerate ALL eligible fast-lane issues and run each
      # through the durable engine concurrently (background workers + wait).
      # Dispatch order is irrelevant here — all issues start simultaneously and the
      # engine's per-issue leases prevent conflicts. For sequential priority-ordered
      # dispatch, use scripts/select-fix-targets.sh instead. <!-- forge#1752 -->
      FAST_LANE_ISSUE_NUMS=$(gh issue list $GH_FLAG \
        --state open \
        --limit 200 \
        --json number,milestone,labels \
        --jq '[.[] | select(
          .milestone == null and
          (.labels | map(.name) | any(. == "workflow:merged" or . == "workflow:invalid" or . == "workflow:decomposed" or . == "needs-human") | not)
        )] | .[].number' \
        2>/dev/null || echo '')

      for ISSUE_NUM in $FAST_LANE_ISSUE_NUMS; do
        # Autonomy policy gate — evaluate approve map by issue priority.
        # Only applies when --fix is set; without --fix all issues flow normally.
        if [ "$AUTOPILOT_FIX" = "true" ]; then
          # Read the priority label for this issue (format: priority:P0, priority:P1, etc.)
          ISSUE_PRIORITY_LABEL=$(gh issue view "$ISSUE_NUM" $GH_FLAG \
            --json labels --jq '.labels | map(.name) | map(select(startswith("priority:"))) | .[0] // ""' \
            2>/dev/null || echo '')
          # Normalize: "priority:P2" → "p2"; unlabeled → "p2" (treat as P2 for policy default)
          PRIORITY_KEY=$(echo "$ISSUE_PRIORITY_LABEL" | sed 's/priority://;s/P/p/' | tr '[:upper:]' '[:lower:]')
          [ -z "$PRIORITY_KEY" ] && PRIORITY_KEY="p2"

          # Resolve approval action from the map
          case "$PRIORITY_KEY" in
            p0) APPROVE_ACTION="$AUTOPILOT_APPROVE_P0" ;;
            p1) APPROVE_ACTION="$AUTOPILOT_APPROVE_P1" ;;
            p2) APPROVE_ACTION="$AUTOPILOT_APPROVE_P2" ;;
            p3) APPROVE_ACTION="$AUTOPILOT_APPROVE_P3" ;;
            *)  APPROVE_ACTION="needs-human" ;;  # unknown priority → gate
          esac

          # Budget ceiling check (only for auto-approved issues)
          if [ "$APPROVE_ACTION" = "auto" ]; then
            if [ "$BUDGET_PER_CYCLE_FIXES" != "null" ] && [ -n "$BUDGET_PER_CYCLE_FIXES" ]; then
              if [ "$FIX_COUNT" -ge "$BUDGET_PER_CYCLE_FIXES" ]; then
                echo "  #$ISSUE_NUM deferred (budget ceiling: $FIX_COUNT/$BUDGET_PER_CYCLE_FIXES fixes dispatched)"
                POLICY_DEFERRED_ISSUES+=("$ISSUE_NUM")
                continue
              fi
            fi
          fi

          if [ "$APPROVE_ACTION" = "auto" ]; then
            echo "  #$ISSUE_NUM approved-by-policy ($PRIORITY_KEY → auto) — dispatching"
            POLICY_APPROVED_ISSUES+=("$ISSUE_NUM")
            FIX_COUNT=$((FIX_COUNT + 1))
          else
            # needs-human: post the fix plan on the ops issue for async approval; never dispatch
            echo "  #$ISSUE_NUM gated-by-policy ($PRIORITY_KEY → needs-human) — posting plan to ops issue #$OPS_ISSUE_NUMBER"
            POLICY_GATED_ISSUES+=("$ISSUE_NUM")
            ISSUE_TITLE=$(gh issue view "$ISSUE_NUM" $GH_FLAG --json title --jq '.title' 2>/dev/null || echo "#$ISSUE_NUM")
            if [ -n "$OPS_ISSUE_NUMBER" ] && [ "$OPS_ISSUE_NUMBER" != "0" ]; then
              gh issue comment "$OPS_ISSUE_NUMBER" $GH_FLAG --body "<!-- FORGE:AUTOPILOT_GATE -->
## Gated Fix — Requires Human Approval

**Issue**: #${ISSUE_NUM} — ${ISSUE_TITLE}
**Priority**: \`${ISSUE_PRIORITY_LABEL:-unlabeled}\`
**Policy**: \`autopilot.approve.${PRIORITY_KEY} = needs-human\`
**Action needed**: Review #${ISSUE_NUM} and either approve for autonomous dispatch or resolve manually.

To approve: remove \`needs-human\` label from #${ISSUE_NUM} and re-run \`/autopilot --fix\`, OR change \`autopilot.approve.${PRIORITY_KEY}\` to \`auto\` in forge.yaml.

<!-- FORGE:AUTOPILOT_GATE:COMPLETE -->" 2>/dev/null || true
            fi
            continue  # skip dispatch for gated issues
          fi
        fi

        echo "Dispatching #$ISSUE_NUM via forgedock run-issue --lane staging"
        DISPATCHED_ISSUES+=("$ISSUE_NUM")
        forgedock run-issue "$ISSUE_NUM" --lane staging &
      done

      # Wait for all engine workers to complete before proceeding to deploy step.
      wait
      echo "Engine dispatch complete for fast-lane iteration $FAST_LANE_ITERATIONS"

      # Terminal-state verification sweep (MANDATORY after every dispatch batch).
      # Query actual GitHub label state for each dispatched issue — the engine's
      # exit code only reflects process completion, not pipeline terminal state.
      # An issue whose PR merged but whose close phase was interrupted will show
      # workflow:in-review (non-terminal) here and be flagged for targeted recovery.
      echo "Verifying terminal state for $( echo "$FAST_LANE_ISSUE_NUMS" | wc -w | tr -d ' ') dispatched issue(s)..."
      for ISSUE_NUM in $FAST_LANE_ISSUE_NUMS; do
        ISSUE_LABELS=$(gh issue view "$ISSUE_NUM" $GH_FLAG \
          --json labels,state \
          --jq '(.labels | map(.name) | join(",")) + "|" + .state' \
          2>/dev/null || echo "unknown|unknown")
        ISSUE_LABEL_STR="${ISSUE_LABELS%%|*}"
        ISSUE_STATE="${ISSUE_LABELS##*|}"

        if echo "$ISSUE_LABEL_STR" | grep -qE 'workflow:merged|workflow:invalid|needs-human' || [ "$ISSUE_STATE" = "CLOSED" ]; then
          echo "  #$ISSUE_NUM ✓ terminal ($ISSUE_LABEL_STR)"
        elif echo "$ISSUE_LABEL_STR" | grep -q 'workflow:in-review'; then
          # Known recoverable stall class: PR merged but close phase did not run.
          # Verify PR state before invoking recover-orphans.
          # Search by issue number — ForgeDock branch slugs include the issue number,
          # so a title-only --head slug lookup never matches (returned dead-empty).
          MERGED_PR=$(gh pr list $GH_FLAG --search "closes #$ISSUE_NUM" \
            --state merged --limit 1 --json number --jq '.[0].number' 2>/dev/null || echo '')
          if [ -n "$MERGED_PR" ] || gh api repos/$GH_REPO/issues/$ISSUE_NUM/events \
              --jq '[.[] | select(.event == "labeled" and .label.name == "workflow:merged")] | length > 0' \
              2>/dev/null | grep -q true; then
            echo "  #$ISSUE_NUM ⟳ stalled at workflow:in-review (PR merged) — resuming via recover-orphans"
            if [ "$RECOVER_ORPHANS_AVAILABLE" = "true" ]; then
              Skill("recover-orphans", args="--issue $ISSUE_NUM")
            else
              echo "  WARNING: recover-orphans not installed — cannot auto-resume #$ISSUE_NUM"
              STALLED_ISSUES+=("$ISSUE_NUM")
            fi
          else
            echo "  #$ISSUE_NUM ⚠ non-terminal ($ISSUE_LABEL_STR) — will retry next iteration"
            STALLED_ISSUES+=("$ISSUE_NUM")
          fi
        else
          echo "  #$ISSUE_NUM ⚠ non-terminal ($ISSUE_LABEL_STR) — will retry next iteration"
          STALLED_ISSUES+=("$ISSUE_NUM")
        fi
      done
    else
      echo "INFO: Using agent dispatch mode (forgedock CLI not in PATH — run \`npm install -g forgedock\` for engine-mode dispatch)"
      # Safety Rule 2 (needs-human guarantee): The engine-first path above filters
      # needs-human issues via an explicit jq selector. On this fallback path,
      # /orchestrate enforces the same guarantee at its own phase entry — it skips
      # any issue labeled needs-human before dispatching /work-on. Both paths
      # implement Rule 2; the mechanism differs (jq filter vs. downstream check).

      # Snapshot the fast-lane issue list before orchestrate runs so we can verify
      # terminal state afterward. orchestrate enumerates internally, so we cannot
      # rely on FAST_LANE_ISSUE_NUMS (which was not set on this path).
      PRE_DISPATCH_ISSUES=$(gh issue list $GH_FLAG \
        --state open \
        --limit 200 \
        --json number,milestone,labels \
        --jq '[.[] | select(
          .milestone == null and
          (.labels | map(.name) | any(. == "workflow:merged" or . == "workflow:invalid" or . == "workflow:decomposed" or . == "needs-human") | not)
        )] | .[].number' \
        2>/dev/null || echo '')
      for N in $PRE_DISPATCH_ISSUES; do DISPATCHED_ISSUES+=("$N"); done

      Skill("orchestrate", args="fast-lane")

      # Terminal-state verification after orchestrate (fallback path).
      # Re-query GitHub state for each pre-dispatch issue.
      echo "Verifying terminal state for $( echo "$PRE_DISPATCH_ISSUES" | wc -w | tr -d ' ') dispatched issue(s) (orchestrate path)..."
      for ISSUE_NUM in $PRE_DISPATCH_ISSUES; do
        ISSUE_LABELS=$(gh issue view "$ISSUE_NUM" $GH_FLAG \
          --json labels,state \
          --jq '(.labels | map(.name) | join(",")) + "|" + .state' \
          2>/dev/null || echo "unknown|unknown")
        ISSUE_LABEL_STR="${ISSUE_LABELS%%|*}"
        ISSUE_STATE="${ISSUE_LABELS##*|}"

        if echo "$ISSUE_LABEL_STR" | grep -qE 'workflow:merged|workflow:invalid|needs-human' || [ "$ISSUE_STATE" = "CLOSED" ]; then
          echo "  #$ISSUE_NUM ✓ terminal ($ISSUE_LABEL_STR)"
        else
          echo "  #$ISSUE_NUM ⚠ non-terminal ($ISSUE_LABEL_STR)"
          STALLED_ISSUES+=("$ISSUE_NUM")
        fi
      done
    fi
  else
    if [ "$FORGEDOCK_AVAILABLE" = "true" ]; then
      echo "[DRY-RUN] Would dispatch each fast-lane issue via: forgedock run-issue <issue> --lane staging"
    else
      echo "[DRY-RUN] Would invoke: Skill(orchestrate, fast-lane)"
    fi
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

fi  # end SKIP_FAST_LANE guard

# Phase 2 complete — record phase marker
PHASE_MARKERS_COMMITTED="${PHASE_MARKERS_COMMITTED:+$PHASE_MARKERS_COMMITTED,}fast-lane"
echo "Phase 2 complete. Committed phases: $PHASE_MARKERS_COMMITTED"
```

---

## Phase 3: Milestone Loop

**Goal**: Ship each milestone with open issues, in order of completion percentage (highest first). Skip milestones at 0%.

**Each milestone cycle**: orchestrate all open issues in the milestone → ship milestone branch to staging → deploy staging to main.

**Resume guard**: If `SKIP_MILESTONE=true` (set in Phase 0H — milestone loop was already committed in the interrupted cycle), skip Phase 3 entirely and proceed to Phase 4.

```bash
MILESTONE_ITERATIONS=0
MILESTONE_DEPLOYS=0

if [ "$SKIP_MILESTONE" = "true" ]; then
  echo "RESUME: Phase 3 (milestone) already committed in cycle $CYCLE_ID — skipping"
else

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
# Process substitution (not a pipe) so DISPATCHED_ISSUES+=() appends in the loop
# body run in THIS shell, not a subshell, and survive for the Phase 4 report.
while IFS= read -r milestone; do
  MS_TITLE=$(echo "$milestone" | jq -r '.title')
  MS_SLUG=$(echo "$milestone" | jq -r '.slug')
  MS_OPEN=$(echo "$milestone" | jq -r '.open_issues')
  MS_PCT=$(echo "$milestone" | jq -r '.completion_pct')

  if [ "$MS_PCT" -eq 0 ]; then
    echo "Skipping milestone '$MS_TITLE' (0% complete — no issues closed yet)"
    continue
  fi

  echo "=== Processing milestone: '$MS_TITLE' ($MS_PCT% complete, $MS_OPEN open) ==="

  # Step 1: Drive open issues in this milestone through the durable engine.
  # Same engine-first dispatch as Phase 2 — fail-closed gates apply to milestone issues too.
  # Fallback: if forgedock CLI is unavailable, delegate to /orchestrate.
  if [ "$MS_OPEN" -gt 0 ]; then
    FORGEDOCK_AVAILABLE=$(command -v forgedock >/dev/null 2>&1 && echo "true" || echo "false")

    if [ "$DRY_RUN" = "false" ]; then
      if [ "$FORGEDOCK_AVAILABLE" = "true" ]; then
        MS_ISSUE_NUMS=$(gh issue list $GH_FLAG \
          --state open \
          --limit 200 \
          --json number,milestone,labels \
          --jq --arg slug "$MS_SLUG" \
          '[.[] | select(
            .milestone != null and
            (.milestone.title | ascii_downcase | gsub("[^a-z0-9]+"; "-") | ltrimstr("-") | rtrimstr("-")) == $slug and
            (.labels | map(.name) | any(. == "workflow:merged" or . == "workflow:invalid" or . == "workflow:decomposed" or . == "needs-human") | not)
          )] | .[].number' \
          2>/dev/null || echo '')

        for ISSUE_NUM in $MS_ISSUE_NUMS; do
          # Autonomy policy gate — same approve map as Phase 2 fast lane.
          # Only applies when --fix is set; without --fix all issues flow normally.
          if [ "$AUTOPILOT_FIX" = "true" ]; then
            ISSUE_PRIORITY_LABEL=$(gh issue view "$ISSUE_NUM" $GH_FLAG \
              --json labels --jq '.labels | map(.name) | map(select(startswith("priority:"))) | .[0] // ""' \
              2>/dev/null || echo '')
            PRIORITY_KEY=$(echo "$ISSUE_PRIORITY_LABEL" | sed 's/priority://;s/P/p/' | tr '[:upper:]' '[:lower:]')
            [ -z "$PRIORITY_KEY" ] && PRIORITY_KEY="p2"

            case "$PRIORITY_KEY" in
              p0) APPROVE_ACTION="$AUTOPILOT_APPROVE_P0" ;;
              p1) APPROVE_ACTION="$AUTOPILOT_APPROVE_P1" ;;
              p2) APPROVE_ACTION="$AUTOPILOT_APPROVE_P2" ;;
              p3) APPROVE_ACTION="$AUTOPILOT_APPROVE_P3" ;;
              *)  APPROVE_ACTION="needs-human" ;;
            esac

            if [ "$APPROVE_ACTION" = "auto" ]; then
              if [ "$BUDGET_PER_CYCLE_FIXES" != "null" ] && [ -n "$BUDGET_PER_CYCLE_FIXES" ]; then
                if [ "$FIX_COUNT" -ge "$BUDGET_PER_CYCLE_FIXES" ]; then
                  echo "  #$ISSUE_NUM deferred (budget ceiling: $FIX_COUNT/$BUDGET_PER_CYCLE_FIXES fixes dispatched)"
                  POLICY_DEFERRED_ISSUES+=("$ISSUE_NUM")
                  continue
                fi
              fi
            fi

            if [ "$APPROVE_ACTION" = "auto" ]; then
              echo "  #$ISSUE_NUM approved-by-policy ($PRIORITY_KEY → auto) — dispatching"
              POLICY_APPROVED_ISSUES+=("$ISSUE_NUM")
              FIX_COUNT=$((FIX_COUNT + 1))
            else
              echo "  #$ISSUE_NUM gated-by-policy ($PRIORITY_KEY → needs-human) — posting plan to ops issue #$OPS_ISSUE_NUMBER"
              POLICY_GATED_ISSUES+=("$ISSUE_NUM")
              ISSUE_TITLE=$(gh issue view "$ISSUE_NUM" $GH_FLAG --json title --jq '.title' 2>/dev/null || echo "#$ISSUE_NUM")
              if [ -n "$OPS_ISSUE_NUMBER" ] && [ "$OPS_ISSUE_NUMBER" != "0" ]; then
                gh issue comment "$OPS_ISSUE_NUMBER" $GH_FLAG --body "<!-- FORGE:AUTOPILOT_GATE -->
## Gated Fix — Requires Human Approval

**Issue**: #${ISSUE_NUM} — ${ISSUE_TITLE}
**Priority**: \`${ISSUE_PRIORITY_LABEL:-unlabeled}\`
**Policy**: \`autopilot.approve.${PRIORITY_KEY} = needs-human\`
**Action needed**: Review #${ISSUE_NUM} and either approve for autonomous dispatch or resolve manually.

To approve: remove \`needs-human\` label from #${ISSUE_NUM} and re-run \`/autopilot --fix\`, OR change \`autopilot.approve.${PRIORITY_KEY}\` to \`auto\` in forge.yaml.

<!-- FORGE:AUTOPILOT_GATE:COMPLETE -->" 2>/dev/null || true
              fi
              continue  # skip dispatch for gated issues
            fi
          fi

          echo "Dispatching #$ISSUE_NUM via forgedock run-issue --lane milestone/$MS_SLUG"
          DISPATCHED_ISSUES+=("$ISSUE_NUM")
          forgedock run-issue "$ISSUE_NUM" --lane "milestone/$MS_SLUG" &
        done

        wait
        echo "Engine dispatch complete for milestone '$MS_TITLE'"

        # Terminal-state verification sweep for milestone batch.
        echo "Verifying terminal state for $( echo "$MS_ISSUE_NUMS" | wc -w | tr -d ' ') dispatched milestone issue(s)..."
        for ISSUE_NUM in $MS_ISSUE_NUMS; do
          ISSUE_LABELS=$(gh issue view "$ISSUE_NUM" $GH_FLAG \
            --json labels,state \
            --jq '(.labels | map(.name) | join(",")) + "|" + .state' \
            2>/dev/null || echo "unknown|unknown")
          ISSUE_LABEL_STR="${ISSUE_LABELS%%|*}"
          ISSUE_STATE="${ISSUE_LABELS##*|}"

          if echo "$ISSUE_LABEL_STR" | grep -qE 'workflow:merged|workflow:invalid|needs-human' || [ "$ISSUE_STATE" = "CLOSED" ]; then
            echo "  #$ISSUE_NUM ✓ terminal ($ISSUE_LABEL_STR)"
          elif echo "$ISSUE_LABEL_STR" | grep -q 'workflow:in-review'; then
            echo "  #$ISSUE_NUM ⟳ stalled at workflow:in-review — resuming via recover-orphans"
            if [ "$RECOVER_ORPHANS_AVAILABLE" = "true" ]; then
              Skill("recover-orphans", args="--issue $ISSUE_NUM")
            else
              echo "  WARNING: recover-orphans not installed — cannot auto-resume #$ISSUE_NUM"
              STALLED_ISSUES+=("$ISSUE_NUM")
            fi
          else
            echo "  #$ISSUE_NUM ⚠ non-terminal ($ISSUE_LABEL_STR) — will surface in Phase 4 report"
            STALLED_ISSUES+=("$ISSUE_NUM")
          fi
        done
      else
        echo "INFO: Using agent dispatch mode (forgedock CLI not in PATH — run \`npm install -g forgedock\` for engine-mode dispatch)"
        # Safety Rule 2 (needs-human guarantee): See fast-lane fallback comment above.
        # /orchestrate enforces the needs-human exclusion at its own phase entry.

        # Snapshot milestone issue list before orchestrate so we can verify afterward.
        MS_PRE_DISPATCH=$(gh issue list $GH_FLAG \
          --state open \
          --limit 200 \
          --json number,milestone,labels \
          --jq --arg slug "$MS_SLUG" \
          '[.[] | select(
            .milestone != null and
            (.milestone.title | ascii_downcase | gsub("[^a-z0-9]+"; "-") | ltrimstr("-") | rtrimstr("-")) == $slug and
            (.labels | map(.name) | any(. == "workflow:merged" or . == "workflow:invalid" or . == "workflow:decomposed" or . == "needs-human") | not)
          )] | .[].number' \
          2>/dev/null || echo '')
        for N in $MS_PRE_DISPATCH; do DISPATCHED_ISSUES+=("$N"); done

        Skill("orchestrate", args="milestone $MS_SLUG")

        # Terminal-state verification after orchestrate fallback.
        echo "Verifying terminal state for $( echo "$MS_PRE_DISPATCH" | wc -w | tr -d ' ') dispatched milestone issue(s) (orchestrate path)..."
        for ISSUE_NUM in $MS_PRE_DISPATCH; do
          ISSUE_LABELS=$(gh issue view "$ISSUE_NUM" $GH_FLAG \
            --json labels,state \
            --jq '(.labels | map(.name) | join(",")) + "|" + .state' \
            2>/dev/null || echo "unknown|unknown")
          ISSUE_LABEL_STR="${ISSUE_LABELS%%|*}"
          ISSUE_STATE="${ISSUE_LABELS##*|}"

          if echo "$ISSUE_LABEL_STR" | grep -qE 'workflow:merged|workflow:invalid|needs-human' || [ "$ISSUE_STATE" = "CLOSED" ]; then
            echo "  #$ISSUE_NUM ✓ terminal ($ISSUE_LABEL_STR)"
          else
            echo "  #$ISSUE_NUM ⚠ non-terminal ($ISSUE_LABEL_STR)"
            STALLED_ISSUES+=("$ISSUE_NUM")
          fi
        done
      fi
    else
      if [ "$FORGEDOCK_AVAILABLE" = "true" ]; then
        echo "[DRY-RUN] Would dispatch each milestone issue via: forgedock run-issue <issue> --lane milestone/$MS_SLUG"
      else
        echo "[DRY-RUN] Would invoke: Skill(orchestrate, milestone $MS_SLUG)"
      fi
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
done < <(echo "$MILESTONES" | jq -c '.[]')

echo "Milestone loop complete: $MILESTONE_ITERATIONS milestone(s) processed, $MILESTONE_DEPLOYS milestone ship(s)"

fi  # end SKIP_MILESTONE guard

# Phase 3 complete — record phase marker
PHASE_MARKERS_COMMITTED="${PHASE_MARKERS_COMMITTED:+$PHASE_MARKERS_COMMITTED,}milestone"
echo "Phase 3 complete. Committed phases: $PHASE_MARKERS_COMMITTED"
```

---

## Phase 4: Final Report and Durable Cycle Annotation

Write the machine-readable `FORGE:AUTOPILOT_CYCLE` annotation to the ops issue, then print the human-readable terminal summary. The annotation is written FIRST so that partial-report crashes do not leave a terminal-appearing state without the durable record.

### 4A: Collect final metrics and write FORGE:AUTOPILOT_CYCLE annotation

```bash
CYCLE_END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
CYCLE_START_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)  # best-effort — pipeline start is earlier

# Re-check final open issue count
FINAL_OPEN=$(gh issue list $GH_FLAG --state open --limit 200 --json number --jq 'length' 2>/dev/null || echo '0')
FINAL_FAST_LANE=$(gh issue list $GH_FLAG --state open --limit 200 --json number,milestone \
  --jq '[.[] | select(.milestone == null)] | length' 2>/dev/null || echo '0')
FINAL_CI_FAILURES="${RECENT_FAILURES:-0}"
FINAL_PENDING_FINDINGS=$(gh issue list $GH_FLAG --state open --label "review-finding" --limit 200 --json number --jq 'length' 2>/dev/null || echo '0')

# Phase 4 complete — record phase marker (before annotation write so it's in the sentinel block)
PHASE_MARKERS_COMMITTED="${PHASE_MARKERS_COMMITTED:+$PHASE_MARKERS_COMMITTED,}report"

# Build baseline JSON for this cycle (consumed by cycle N+1's Phase 0G)
BASELINE_JSON="{\"open_issues\":${FINAL_OPEN},\"ci_failures\":${FINAL_CI_FAILURES},\"pending_findings\":${FINAL_PENDING_FINDINGS}}"

# Build findings summary (recon-created issue numbers)
FINDINGS_SUMMARY="${#RECON_ISSUES[@]:-0} recon issue(s) created"
if [ "${#RECON_ISSUES[@]}" -gt 0 ]; then
  FINDINGS_SUMMARY="$FINDINGS_SUMMARY: ${RECON_ISSUES[*]}"
fi

# Build delta section vs prior cycle
DELTA_LINES=""
if [ -n "$PREV_CYCLE_ID" ]; then
  if [ -n "$PREV_CYCLE_OPEN_ISSUES" ]; then
    DELTA_OPEN=$((FINAL_OPEN - PREV_CYCLE_OPEN_ISSUES))
    DELTA_SIGN=$( [ "$DELTA_OPEN" -lt 0 ] && echo "" || echo "+")
    DELTA_LINES="${DELTA_LINES}- Open issues: $PREV_CYCLE_OPEN_ISSUES → $FINAL_OPEN (${DELTA_SIGN}${DELTA_OPEN})\n"
  fi
  if [ -n "$PREV_CYCLE_CI_FAILURES" ]; then
    DELTA_CI=$((FINAL_CI_FAILURES - PREV_CYCLE_CI_FAILURES))
    DELTA_CI_SIGN=$( [ "$DELTA_CI" -lt 0 ] && echo "" || echo "+")
    DELTA_LINES="${DELTA_LINES}- CI failures: $PREV_CYCLE_CI_FAILURES → $FINAL_CI_FAILURES (${DELTA_CI_SIGN}${DELTA_CI})\n"
  fi
  if [ -n "$PREV_CYCLE_PENDING_FINDINGS" ]; then
    DELTA_PF=$((FINAL_PENDING_FINDINGS - PREV_CYCLE_PENDING_FINDINGS))
    DELTA_PF_SIGN=$( [ "$DELTA_PF" -lt 0 ] && echo "" || echo "+")
    DELTA_LINES="${DELTA_LINES}- Pending findings: $PREV_CYCLE_PENDING_FINDINGS → $FINAL_PENDING_FINDINGS (${DELTA_PF_SIGN}${DELTA_PF})\n"
  fi
  DELTA_SECTION="### Deltas vs Cycle ${PREV_CYCLE_ID}\n$(printf '%b' "$DELTA_LINES")"
else
  DELTA_SECTION="### Deltas vs Prior Cycle\nNo prior complete cycle found — this is the baseline cycle."
fi

# Write FORGE:AUTOPILOT_CYCLE annotation to the ops issue (machine-readable durable record)
if [ -n "$OPS_ISSUE_NUMBER" ] && [ "$OPS_ISSUE_NUMBER" != "0" ] && [ "$DRY_RUN" = "false" ]; then
  gh issue comment "$OPS_ISSUE_NUMBER" $GH_FLAG --body "<!-- FORGE:AUTOPILOT_CYCLE -->
## Autopilot Cycle — ${CYCLE_ID}

**cycle_id**: ${CYCLE_ID}
**timestamp**: ${CYCLE_END}
**baseline**: ${BASELINE_JSON}
**phase_markers**: ${PHASE_MARKERS_COMMITTED}

$(printf '%b' "$DELTA_SECTION")

### Findings Created This Cycle
${FINDINGS_SUMMARY}

### Fast Lane
- Iterations: ${FAST_LANE_ITERATIONS:-0}
- Deploys (staging→${DEFAULT_BRANCH}): ${FAST_LANE_DEPLOYS:-0}
- Issues dispatched: ${#DISPATCHED_ISSUES[@]:-0}

### Milestone Loop
- Milestones processed: ${MILESTONE_ITERATIONS:-0}
- Milestone ships: ${MILESTONE_DEPLOYS:-0}

### Autonomy Policy Decisions
- Fix mode: ${AUTOPILOT_FIX} (headless: ${AUTOPILOT_HEADLESS})
- Approved by policy: ${#POLICY_APPROVED_ISSUES[@]:-0} issue(s)$([ "${#POLICY_APPROVED_ISSUES[@]:-0}" -gt 0 ] && echo " — ${POLICY_APPROVED_ISSUES[*]}" || echo "")
- Gated (needs-human): ${#POLICY_GATED_ISSUES[@]:-0} issue(s)$([ "${#POLICY_GATED_ISSUES[@]:-0}" -gt 0 ] && echo " — ${POLICY_GATED_ISSUES[*]}" || echo "")
- Deferred (budget ceiling): ${#POLICY_DEFERRED_ISSUES[@]:-0} issue(s)$([ "${#POLICY_DEFERRED_ISSUES[@]:-0}" -gt 0 ] && echo " — ${POLICY_DEFERRED_ISSUES[*]}" || echo "")
- Budget used: ${FIX_COUNT:-0} / ${BUDGET_PER_CYCLE_FIXES:-unlimited}
- Approve map: {p0:${AUTOPILOT_APPROVE_P0},p1:${AUTOPILOT_APPROVE_P1},p2:${AUTOPILOT_APPROVE_P2},p3:${AUTOPILOT_APPROVE_P3}}

### Final State
- Open issues: ${FINAL_OPEN} total (${FINAL_FAST_LANE} unmilestoned)
- CI failures (24h): ${FINAL_CI_FAILURES}
- Pending review findings: ${FINAL_PENDING_FINDINGS}

<!-- FORGE:AUTOPILOT_CYCLE:COMPLETE -->" 2>/dev/null \
    && echo "FORGE:AUTOPILOT_CYCLE annotation written to ops issue #$OPS_ISSUE_NUMBER" \
    || echo "WARNING: Failed to write FORGE:AUTOPILOT_CYCLE annotation — ops issue #$OPS_ISSUE_NUMBER may be inaccessible"
elif [ "$DRY_RUN" = "true" ]; then
  echo "[DRY-RUN] Would write FORGE:AUTOPILOT_CYCLE annotation to ops issue #$OPS_ISSUE_NUMBER"
  echo "[DRY-RUN] cycle_id=$CYCLE_ID baseline=$BASELINE_JSON phase_markers=$PHASE_MARKERS_COMMITTED"
  echo "[DRY-RUN] policy: fix=$AUTOPILOT_FIX headless=$AUTOPILOT_HEADLESS approved=${#POLICY_APPROVED_ISSUES[@]:-0} gated=${#POLICY_GATED_ISSUES[@]:-0} deferred=${#POLICY_DEFERRED_ISSUES[@]:-0} budget_used=$FIX_COUNT/$BUDGET_PER_CYCLE_FIXES"
fi
```

### 4B: Recurrence detection

After writing the current cycle annotation, fetch the last 3 COMPLETE cycle annotations from the ops issue. If the same recon-created issue title prefix appears in ALL 3, create a meta-issue citing the cycle annotations — implementing the recurrence detection claim.

```bash
# Recurrence detection — only run if there are recon findings this cycle and ops issue exists
if [ "${#RECON_ISSUES[@]:-0}" -gt 0 ] && [ -n "$OPS_ISSUE_NUMBER" ] && [ "$OPS_ISSUE_NUMBER" != "0" ]; then
  # Fetch last 3 complete AUTOPILOT_CYCLE annotations (now includes the one we just wrote)
  LAST_3_CYCLES=$(gh api repos/${GH_REPO}/issues/${OPS_ISSUE_NUMBER}/comments \
    --jq '[.[] | select(.body | contains("FORGE:AUTOPILOT_CYCLE:COMPLETE"))] | .[-3:] | .[].body' \
    2>/dev/null || echo '')

  CYCLE_COUNT=$(echo "$LAST_3_CYCLES" | grep -c "FORGE:AUTOPILOT_CYCLE:COMPLETE" || echo '0')

  if [ "${CYCLE_COUNT:-0}" -ge 3 ]; then
    # Check each recon finding title prefix against all 3 cycle annotations
    for ISSUE_NUM in "${RECON_ISSUES[@]}"; do
      FINDING_TITLE=$(gh issue view "$ISSUE_NUM" $GH_FLAG --json title --jq '.title' 2>/dev/null | cut -c1-60 || echo '')
      [ -z "$FINDING_TITLE" ] && continue

      # Extract the first 30 chars as a pattern (enough to distinguish issues without being too strict)
      FINDING_PATTERN=$(echo "$FINDING_TITLE" | cut -c1-30)

      # Count how many of the 3 cycles contain this pattern in their findings section
      MATCH_COUNT=$(echo "$LAST_3_CYCLES" | grep -cF "$FINDING_PATTERN" || echo '0')

      if [ "${MATCH_COUNT:-0}" -ge 3 ]; then
        echo "RECURRENCE DETECTED: '$FINDING_PATTERN' appeared in all 3 recent cycles — creating meta-issue"

        # Extract cycle IDs from the last 3 annotations for citation
        CITING_CYCLES=$(echo "$LAST_3_CYCLES" \
          | grep -oP '(?<=\*\*cycle_id\*\*: )[^\n]+' | tr -d '[:space:]' | tr '\n' ', ' | sed 's/,$//')

        # Dedup check — avoid creating a duplicate meta-issue for the same pattern
        EXISTING_META=$(gh issue list $GH_FLAG --state open \
          --search "meta: recurring autopilot finding $FINDING_PATTERN" \
          --limit 1 --json number --jq '.[0].number // empty' 2>/dev/null || echo '')

        if [ -z "$EXISTING_META" ] && [ "$DRY_RUN" = "false" ]; then
          META_TITLE="meta: recurring autopilot finding — $FINDING_PATTERN"
          META_BODY_TMPFILE=$(mktemp /tmp/autopilot-meta-body-XXXXXX.md)
          trap 'rm -f "$META_BODY_TMPFILE"' EXIT
          cat > "$META_BODY_TMPFILE" <<META_EOF
## Problem

The following finding pattern has appeared in **3 or more consecutive /autopilot cycles**, indicating a systemic issue rather than a one-off occurrence.

**Pattern**: \`${FINDING_PATTERN}\`
**Detected in cycles**: ${CITING_CYCLES}

This meta-issue is created by /autopilot recurrence detection (Phase 4B) when the same finding pattern appears in 3 consecutive complete cycle annotations on the ops issue (#${OPS_ISSUE_NUMBER}).

## Root Cause (if known)

Root cause unknown — the recurrent nature suggests either:
1. The underlying issue is not being fixed by the regular work-on pipeline (check if prior issues for this pattern were closed with workflow:invalid or blocked)
2. A systemic condition keeps re-triggering the finding (e.g., a flaky CI step, a recurring deployment error)
3. The issue is being created and merged but the fix does not hold (regression)

## Affected Files

Files to be identified during investigation.

## Acceptance Criteria

- [ ] Root cause of recurrence identified
- [ ] Fix confirmed: pattern does not appear in 3 subsequent /autopilot cycles after merge
- [ ] Prior per-cycle issues for this pattern are closed with explanation

## Context

**Ops issue (cycle annotations)**: #${OPS_ISSUE_NUMBER}
**Citing cycles**: ${CITING_CYCLES}
**Detected by**: /autopilot Phase 4B recurrence detection
META_EOF
          # Route through the /issue create-hook (canonical dedup + body validation) instead
          # of a raw `gh issue create`. The EXISTING_META search above already guards against
          # re-creating for the same pattern; /issue's own dedup is an additional safety net.
          Skill(skill="issue", args="--title \"$META_TITLE\" --body-file \"$META_BODY_TMPFILE\" --label priority:P2")
          rm -f "$META_BODY_TMPFILE"
          trap - EXIT
          META_NEW_NUMBER=$(gh issue list $GH_FLAG \
            --state open \
            --search "$META_TITLE" \
            --json number,title \
            --jq --arg t "$META_TITLE" '.[] | select(.title == $t) | .number' 2>/dev/null | head -1)
          if [ -n "$META_NEW_NUMBER" ]; then
            echo "Created meta-issue #$META_NEW_NUMBER for recurrent pattern: $FINDING_PATTERN"
          else
            echo "WARNING: Could not confirm meta-issue creation for recurrence pattern: $FINDING_PATTERN"
          fi
        elif [ -n "$EXISTING_META" ]; then
          echo "Recurrence meta-issue already exists (#$EXISTING_META) for pattern '$FINDING_PATTERN' — skipping"
        elif [ "$DRY_RUN" = "true" ]; then
          echo "[DRY-RUN] Would create meta-issue for recurrent pattern: $FINDING_PATTERN (cycles: $CITING_CYCLES)"
        fi
      fi
    done
  else
    echo "Recurrence check: only $CYCLE_COUNT complete cycle(s) on record — need 3 for detection (will activate after more cycles)"
  fi
fi
```

### 4C: Human-readable terminal summary

```bash
echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║  Autopilot Complete                               ║"
echo "╠═══════════════════════════════════════════════════╣"
echo "║                                                   ║"

cat <<REPORT
## Autopilot Cycle Report — $CYCLE_END

**Cycle ID**: ${CYCLE_ID}
**Ops Issue**: #${OPS_ISSUE_NUMBER} (FORGE:AUTOPILOT_CYCLE annotation written)

### Pipeline State at Start
- staging→main PR: ${STAGING_PR_NUMBER:-none}
- In-flight issues recovered: $INFLIGHT_ISSUES
- Open fast-lane issues at start: $OPEN_FAST_LANE
- Milestones found: ${MILESTONE_COUNT:-0}

### Recon
- CI failures (24h): $RECENT_FAILURES/$RECENT_RUNS
- Recurring failures: ${RECURRING:-none}
- Issues created from recon: ${#RECON_ISSUES[@]:-0}

### Hygiene
- Orphaned issues recovered (/recover-orphans): $INFLIGHT_ISSUES
- Label hygiene sweep (/cleanup labels): $([ "${CLEANUP_LABELS_FIXED:-0}" -eq 1 ] && echo "ran — see /cleanup output for counts" || echo "skipped (not installed or dry-run)")

### Fast Lane
- Iterations: $FAST_LANE_ITERATIONS
- Deploys (staging→$DEFAULT_BRANCH): $FAST_LANE_DEPLOYS
- Review findings bounced to fast lane: $FAST_LANE_FINDINGS_BOUNCED

### Milestone Loop
- Milestones processed: $MILESTONE_ITERATIONS
- Milestone ships: $MILESTONE_DEPLOYS

### Autonomy Policy
- Fix mode: $AUTOPILOT_FIX (headless: $AUTOPILOT_HEADLESS)
- Approved by policy: ${#POLICY_APPROVED_ISSUES[@]:-0} issue(s)
- Gated (needs-human, posted to ops issue): ${#POLICY_GATED_ISSUES[@]:-0} issue(s)
- Deferred (budget ceiling hit): ${#POLICY_DEFERRED_ISSUES[@]:-0} issue(s)
- Budget used: ${FIX_COUNT:-0} / ${BUDGET_PER_CYCLE_FIXES:-unlimited}

### Final State
- Open issues: $FINAL_OPEN total ($FINAL_FAST_LANE unmilestoned)
REPORT

# Per-issue terminal-state disposition table (GitHub-verified).
# Sources DISPATCHED_ISSUES accumulated across all dispatch paths this cycle.
# This table is the canonical record of what autopilot dispatched and what state each reached.
if [ "${#DISPATCHED_ISSUES[@]}" -gt 0 ]; then
  echo ""
  echo "### Dispatch Disposition (GitHub-verified terminal state)"
  echo ""
  echo "| Issue | Title (50 chars) | GitHub Label | Terminal? |"
  echo "|-------|-----------------|-------------|-----------|"
  DISPATCH_TERMINAL_COUNT=0
  DISPATCH_STALLED_COUNT=0
  for ISSUE_NUM in "${DISPATCHED_ISSUES[@]}"; do
    ISSUE_DATA=$(gh issue view "$ISSUE_NUM" $GH_FLAG \
      --json number,title,labels,state \
      --jq '{n: .number, title: (.title | .[0:50]), labels: (.labels | map(.name) | join(",")), state: .state}' \
      2>/dev/null || echo "{\"n\":$ISSUE_NUM,\"title\":\"(fetch failed)\",\"labels\":\"unknown\",\"state\":\"unknown\"}")
    DISP_LABELS=$(echo "$ISSUE_DATA" | jq -r '.labels // "unknown"')
    DISP_STATE=$(echo "$ISSUE_DATA" | jq -r '.state // "unknown"')
    DISP_TITLE=$(echo "$ISSUE_DATA" | jq -r '.title // "(unknown)"')
    if echo "$DISP_LABELS" | grep -qE 'workflow:merged|workflow:invalid|needs-human' || [ "$DISP_STATE" = "CLOSED" ]; then
      echo "| #$ISSUE_NUM | $DISP_TITLE | \`$DISP_LABELS\` | ✓ yes |"
      DISPATCH_TERMINAL_COUNT=$((DISPATCH_TERMINAL_COUNT + 1))
    else
      echo "| #$ISSUE_NUM | $DISP_TITLE | \`$DISP_LABELS\` | ✗ no — stalled |"
      DISPATCH_STALLED_COUNT=$((DISPATCH_STALLED_COUNT + 1))
    fi
  done
  echo ""
  echo "**Summary**: ${DISPATCH_TERMINAL_COUNT}/${#DISPATCHED_ISSUES[@]} dispatched issues reached terminal state. ${DISPATCH_STALLED_COUNT} stalled."
  if [ "$DISPATCH_STALLED_COUNT" -gt 0 ]; then
    echo ""
    echo "⚠ Stalled issues re-enter the fast-lane queue on the next /autopilot run."
    echo "  Persistent stalls (3+ cycles): gh issue list $GH_FLAG --label workflow:building"
  fi
else
  echo ""
  echo "### Dispatch Disposition"
  echo "No issues dispatched this cycle."
fi

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

Rules are listed in **precedence order** — when two rules appear to conflict, the rule with the lower number wins. Rule 0 is inviolable; no other rule can override it.

**Rule 0 (INVIOLABLE): `--dry-run` means NO side effects.** When `DRY_RUN=true`, autopilot produces a report and exits. No issues are created, no PRs are merged, no labels are changed, no sub-skills with side effects are invoked. This holds regardless of priority (P0, P1, or any other), regardless of loop state, and regardless of what any other rule says. Every dispatch block in this spec checks `DRY_RUN` before acting. If a code path appears to conflict with this rule, `DRY_RUN` wins.

**Rule 1: `/autopilot` overrides "never merge to main"** — autopilot IS the authorized deploy system. staging→main is normal operation in Phases 2 and 3.

**Rule 2: Never process `needs-human` issues.** Issues labeled `needs-human` must never be autonomously worked on, regardless of priority. The engine-first dispatch path (Phase 2, Step 1 and Phase 3, Step 1) enforces this with an explicit jq filter. The /orchestrate fallback path delegates this guarantee to /orchestrate and /work-on, which skip `needs-human` issues at their own phase entry. A P0 issue labeled `needs-human` — meaning a human explicitly parked it as requiring human judgment — is reported in the Phase 1C recon output but never added to any dispatch queue. Rule 0 (dry-run) takes precedence over this rule: a dry-run run reports the `needs-human` P0 and takes no action.

**Rule 3: Never skip investigation** — all issues go through the full `/work-on` pipeline (via /orchestrate or the durable engine) before any fix lands.

**Rule 4: Never create duplicate issues** — always dedup against existing open issues before creating.

**Rule 5: Loop safety cap** — max 20 fast-lane iterations prevents infinite loops on stuck state.

**Rule 6: Autopilot never directly mutates issues or labels.** All issue close and workflow label changes must route through `/cleanup` (for label hygiene) or `/recover-orphans` (for orphan recovery) — commands that verify state before acting and maintain an audit trail. Autopilot composes; it does not own destructive writes. If either command is not installed, log an informational message and continue — no bare `gh issue close` or `gh issue edit --add-label` calls are acceptable in this spec.

**Rule 6a: Graceful sub-skill degradation** — if /recover-orphans or /cleanup is not installed (extras tier), log an informational message and continue. The pipeline proceeds without hygiene rather than failing.

**Rule 7: State always re-read** — never trust a cached issue count. Re-query GitHub at each loop iteration.

**Rule 8: deploy-pr result is authoritative** — if status is not "merged", do not assume the deploy succeeded. Log and continue the loop.

**Rule 9: Terminal-state verification is mandatory after every dispatch batch.** After every `forgedock run-issue … wait` block or `Skill(orchestrate)` call, autopilot MUST query the actual GitHub label state for each dispatched issue. An issue whose process exits 0 but whose GitHub label is still `workflow:in-review` or `workflow:building` is NOT done — the close phase may have been interrupted. Stalls at `workflow:in-review` with a merged PR are the known recoverable class; autopilot resumes them via `Skill("recover-orphans", args="--issue N")` once before recording them as stalled. The Phase 4 report MUST emit a per-issue disposition table sourced from these GitHub-verified states — self-reported sub-process success is not sufficient. <!-- Added: forge#1751 -->

**Headless / unattended operation**: `/autopilot` has no human checkpoint and never waits for user input. When invoked via `/loop 4h /autopilot` or any other unattended runner, it runs to completion and exits. Human escalation is exclusively via the `needs-human` label (Rule 2 above) — autopilot surfaces `needs-human` issues in the recon report but never stalls waiting for a response. There is no "Phase 4B confirm before fixing" gate in the current design; that checkpoint was intentionally removed in the #1673 rewrite. If a future design adds a confirmation gate, it must be guarded by both Rule 0 (dry-run) and Rule 2 (needs-human) to remain safe.

---

## Operational Notes

- **Runtime**: Recon-only ~2-3 min. Full cycle time depends on open issue count — typically 20-90 min per loop.
- **Token budget**: Recon is cheap (mostly API calls). Each orchestrate+deploy cycle is expensive (full /work-on per issue via /orchestrate).
- **Idempotent**: Safe to run multiple times — /work-on resumes from pipeline checkpoints, /deploy-pr detects existing open PRs.
- **Pairs with /loop**: Run `/loop 4h /autopilot` for continuous improvement cycles.
- **Event-driven complement**: `/autopilot` is a periodic loop. For targeted signal-driven response (metric regression, incident, CI failure spike), use `/signal-planner` instead — it converts a specific signal into a dependency-ordered issue DAG, executes via `/orchestrate`, and verifies the originating signal is resolved after the work merges. Use `/autopilot` for scheduled sweeps; use `/signal-planner` for targeted responses.
