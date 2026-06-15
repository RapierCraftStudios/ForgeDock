---
description: Pipeline-wide situational awareness — groups open issues by workflow state, shows active PRs, flags stale items, and reports milestone progress
argument-hint: [--repo <owner/repo> | --stale-days <N>]
---

# /status — Pipeline Status

**Input**: $ARGUMENTS (optional: `--repo <owner/repo>`, `--stale-days <N>`)

Read-only snapshot of the ForgeDock pipeline. Shows open issues grouped by workflow label, active PRs with age, stale items, and milestone progress.

**This command is fully read-only.** It makes no label changes, posts no comments, and creates no issues.

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

---

## Config Resolution

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE")

# Optional: --repo flag overrides the default repo
if echo "$ARGUMENTS" | grep -q -- "--repo"; then
    GH_REPO=$(echo "$ARGUMENTS" | sed 's/.*--repo[[:space:]]\([^[:space:]]*\).*/\1/')
    GH_FLAG="-R $GH_REPO"
fi

# Optional: --stale-days flag (default: 7)
STALE_DAYS=7
if echo "$ARGUMENTS" | grep -q -- "--stale-days"; then
    STALE_DAYS=$(echo "$ARGUMENTS" | sed 's/.*--stale-days[[:space:]]\([^[:space:]]*\).*/\1/')
fi

STALE_THRESHOLD=$(date -d "${STALE_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -v-${STALE_DAYS}d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || echo "")

echo "Repo: $GH_REPO"
echo "Staging branch: $STAGING_BRANCH"
echo "Stale threshold: ${STALE_DAYS} days"
```

---

## Phase 1: Issues by Workflow State

Fetch all open issues with `workflow:*` labels. Group and count by state.

```bash
echo ""
echo "=== Pipeline Issues — $(date +%Y-%m-%d) ==="
echo ""

# Workflow states to display (in pipeline order)
STATES="workflow:investigating workflow:building workflow:in-review workflow:ready-to-build needs-human"

for LABEL in $STATES; do
    ISSUES=$(gh issue list $GH_FLAG \
        --state open \
        --label "$LABEL" \
        --limit 50 \
        --json number,title,updatedAt,assignees \
        --jq '.[] | "#\(.number) \(.title[:60]) [updated: \(.updatedAt[:10])]"' \
        2>/dev/null || echo "")

    COUNT=$(echo "$ISSUES" | grep -c '#' 2>/dev/null || echo 0)
    [ "$COUNT" = "0" ] && [ -z "$ISSUES" ] && COUNT=0

    if [ -n "$ISSUES" ] && [ "$COUNT" -gt 0 ]; then
        echo "[$LABEL] ($COUNT open)"
        echo "$ISSUES" | while IFS= read -r line; do
            echo "  $line"
        done
        echo ""
    else
        echo "[$LABEL] — none"
    fi
done

# Issues with no workflow label (untracked / not yet entered pipeline)
UNTRACKED=$(gh issue list $GH_FLAG \
    --state open \
    --limit 20 \
    --json number,title,labels,createdAt \
    --jq '.[] | select(
        (.labels | map(.name) | any(startswith("workflow:"))) | not
    ) | "#\(.number) \(.title[:60]) [created: \(.createdAt[:10])]"' \
    2>/dev/null || echo "")

UNTRACKED_COUNT=$(echo "$UNTRACKED" | grep -c '#' 2>/dev/null || echo 0)
if [ -n "$UNTRACKED" ] && [ "$UNTRACKED_COUNT" -gt 0 ]; then
    echo "[untracked] ($UNTRACKED_COUNT — not yet in pipeline)"
    echo "$UNTRACKED" | while IFS= read -r line; do
        echo "  $line"
    done
    echo ""
fi
```

---

## Phase 2: Active PRs

Show open PRs targeting `staging` or any `milestone/*` branch, with age and review status.

```bash
echo "=== Active PRs ==="
echo ""

gh pr list $GH_FLAG \
    --state open \
    --limit 30 \
    --json number,title,headRefName,baseRefName,createdAt,reviews,isDraft \
    --jq '.[] | {
        number: .number,
        title: .title[:55],
        head: .headRefName,
        base: .baseRefName,
        age_days: (((now - (.createdAt | fromdateiso8601)) / 86400) | floor),
        draft: .isDraft,
        review_state: (
            if (.reviews | length) == 0 then "no review"
            elif (.reviews | map(select(.state == "APPROVED")) | length) > 0 then "APPROVED"
            elif (.reviews | map(select(.state == "CHANGES_REQUESTED")) | length) > 0 then "CHANGES REQUESTED"
            else "COMMENTED"
            end
        )
    } | "  PR #\(.number) \(.title) [\(.age_days)d old] [\(.review_state)]\(if .draft then " [DRAFT]" else "" end)\n    → \(.head) → \(.base)"' \
    2>/dev/null || echo "  (none)"

echo ""
```

---

## Phase 3: Stale Items

Flag issues and PRs with no activity in the last `$STALE_DAYS` days.

```bash
echo "=== Stale Items (no activity > ${STALE_DAYS} days) ==="
echo ""

if [ -z "$STALE_THRESHOLD" ]; then
    echo "  (skipped — could not compute stale threshold on this platform)"
else
    # Stale open issues with workflow labels
    STALE_ISSUES=$(gh issue list $GH_FLAG \
        --state open \
        --limit 100 \
        --json number,title,updatedAt,labels \
        --jq --arg threshold "$STALE_THRESHOLD" \
        '[.[] |
            select(
                (.updatedAt < $threshold) and
                (.labels | map(.name) | any(startswith("workflow:")))
            )
        ] | .[] | "  ISSUE #\(.number) \(.title[:55]) [last updated: \(.updatedAt[:10])] [\(.labels | map(select(.name | startswith("workflow:"))) | .[0].name // "no-workflow")]"' \
        2>/dev/null || echo "")

    STALE_PRS=$(gh pr list $GH_FLAG \
        --state open \
        --limit 50 \
        --json number,title,updatedAt \
        --jq --arg threshold "$STALE_THRESHOLD" \
        '[.[] | select(.updatedAt < $threshold)] |
        .[] | "  PR #\(.number) \(.title[:55]) [last updated: \(.updatedAt[:10])]"' \
        2>/dev/null || echo "")

    if [ -z "$STALE_ISSUES" ] && [ -z "$STALE_PRS" ]; then
        echo "  None — pipeline is moving."
    else
        [ -n "$STALE_ISSUES" ] && echo "$STALE_ISSUES"
        [ -n "$STALE_PRS" ] && echo "$STALE_PRS"
    fi
fi

echo ""
```

---

## Phase 4: Milestone Progress

Show open milestones with open/closed issue counts and percentage complete.

```bash
echo "=== Milestone Progress ==="
echo ""

MILESTONES=$(gh api repos/$GH_REPO/milestones \
    --jq '.[] | select(.state == "open") | {
        title: .title,
        number: .number,
        open: .open_issues,
        closed: .closed_issues,
        total: (.open_issues + .closed_issues),
        due: (.due_on // "no due date")[:10],
        pct: (if (.open_issues + .closed_issues) > 0 then
            ((.closed_issues / (.open_issues + .closed_issues)) * 100) | floor
            else 0 end)
    } | "\(.title) [\(.pct)% done — \(.closed)/\(.total) issues] [due: \(.due)]"' \
    2>/dev/null || echo "")

if [ -z "$MILESTONES" ]; then
    echo "  No active milestones."
else
    echo "$MILESTONES" | while IFS= read -r line; do
        echo "  $line"
    done
fi

echo ""
```

---

## Phase 5: Bottleneck Summary

Highlight states where issues are piling up or stuck.

```bash
echo "=== Bottleneck Summary ==="
echo ""

INVESTIGATING=$(gh issue list $GH_FLAG --state open --label "workflow:investigating" --limit 100 --json number --jq '. | length' 2>/dev/null || echo 0)
BUILDING=$(gh issue list $GH_FLAG --state open --label "workflow:building" --limit 100 --json number --jq '. | length' 2>/dev/null || echo 0)
IN_REVIEW=$(gh issue list $GH_FLAG --state open --label "workflow:in-review" --limit 100 --json number --jq '. | length' 2>/dev/null || echo 0)
BLOCKED=$(gh issue list $GH_FLAG --state open --label "needs-human" --limit 100 --json number --jq '. | length' 2>/dev/null || echo 0)
READY=$(gh issue list $GH_FLAG --state open --label "workflow:ready-to-build" --limit 100 --json number --jq '. | length' 2>/dev/null || echo 0)

TOTAL_INFLIGHT=$((INVESTIGATING + BUILDING + IN_REVIEW + READY))

echo "  investigating  : $INVESTIGATING"
echo "  ready-to-build : $READY"
echo "  building       : $BUILDING"
echo "  in-review      : $IN_REVIEW"
echo "  needs-human    : $BLOCKED  $([ "$BLOCKED" -gt 0 ] && echo '← ACTION REQUIRED' || true)"
echo ""
echo "  Total in-flight: $TOTAL_INFLIGHT"

if [ "$BLOCKED" -gt 0 ]; then
    echo ""
    echo "  ⚠  $BLOCKED issue(s) need human attention:"
    gh issue list $GH_FLAG --state open --label "needs-human" --limit 20 \
        --json number,title \
        --jq '.[] | "    #\(.number) \(.title[:70])"' \
        2>/dev/null || true
fi

if [ "$IN_REVIEW" -gt 3 ]; then
    echo ""
    echo "  ⚠  Review queue depth is $IN_REVIEW — consider running /review-pr or /orchestrate fast-lane"
fi

echo ""
echo "=== Status complete — $(date +%Y-%m-%d\ %H:%M:%S) ==="
```
