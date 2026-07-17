---
description: Pipeline-wide situational awareness — groups open issues by workflow state, shows active PRs, flags stale items, and reports milestone progress
argument-hint: "[--repo <owner/repo> | --stale-days <N>]"
install: extras
---

# /pipeline-status — Pipeline Status

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

### Fleet Snapshot (single read for Phases 1, 3B, 5)

**One parser, one truth** (forge#2393): every workflow-state read below (issues-by-state grouping, engine lease state, bottleneck counts) is derived from a single `npx forgedock query fleet` call instead of separate per-label `gh issue list` calls. `query fleet` is the agent-facing JSON face over `bin/observe.mjs`'s fleet-observability core — the same data `forgedock watch` renders interactively. Its exit code (`0` healthy, `2` stalls present, `3` blocked present) is captured but not branched on here — `/pipeline-status` is purely observational and always reports, it never gates on the result the way `/autopilot`/`/orchestrate` do.

```bash
FLEET_JSON=$(npx forgedock query fleet --repo "$GH_REPO" 2>/dev/null)
FLEET_EXIT=$?
if [ -z "$FLEET_JSON" ] || ! echo "$FLEET_JSON" | jq -e '.schema' >/dev/null 2>&1; then
    echo "WARNING: forgedock query fleet failed or returned no data (exit ${FLEET_EXIT}) — Phases 1, 3B, and 5 below will show degraded/empty output." >&2
    FLEET_JSON='{"schema":"forge-observe/1","agents":[],"counts":{"running":0,"stalled":0,"blocked":0,"leased":0,"quiet":true}}'
fi
```

---

## Phase 1: Issues by Workflow State

Group and count the fleet snapshot's `agents[]` by `workflowLabel` (in pipeline order). `agents[]` already covers every open issue carrying an active `workflow:*` label or `needs-human` — no separate `gh issue list` call per label.

```bash
echo ""
echo "=== Pipeline Issues — $(date +%Y-%m-%d) ==="
echo ""

# Workflow states to display (in pipeline order) — must match ACTIVE_WORKFLOW_LABELS
# (bin/engine-cli.mjs) + the blocked label, which is exactly what query fleet watches.
STATES="workflow:investigating workflow:building workflow:in-review workflow:ready-to-build needs-human"

for LABEL in $STATES; do
    ISSUES=$(echo "$FLEET_JSON" | jq -r --arg label "$LABEL" \
        '.agents[] | select(.workflowLabel == $label) |
         "#\(.issue) \(.title[0:60]) [updated: \(.heartbeat.at // .at // "unknown" | .[0:10])]"')

    COUNT=$(echo "$FLEET_JSON" | jq --arg label "$LABEL" '[.agents[] | select(.workflowLabel == $label)] | length')

    if [ "$COUNT" -gt 0 ]; then
        echo "[$LABEL] ($COUNT open)"
        echo "$ISSUES" | while IFS= read -r line; do
            echo "  $line"
        done
        echo ""
    else
        echo "[$LABEL] — none"
    fi
done

# Issues with no workflow label (untracked / not yet entered pipeline) — query fleet
# only watches workflow:*/needs-human issues, so untracked issues are genuinely outside
# its scope and still need their own gh issue list call.
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

## Phase 3B: Engine Lease State (FORGE:STATE)

For issues managed by the durable engine, display lease status derived from the fleet snapshot's `lease`/`phase`/`status` fields (`FLEET_JSON`, captured once above). This gives ground-truth stall detection beyond `updatedAt` heuristics. `bin/observe.mjs`'s `deriveAgent()` already parses each issue's `FORGE:STATE` block server-side (GitHub wins on any local/remote disagreement — the same trust rule the durable engine itself uses), so no separate per-label `gh issue list` + body-parsing loop is needed here.

```bash
echo "=== Engine Lease State ==="
echo ""

NOW_MS=$(date +%s)000
ENGINE_OUTPUT=$(echo "$FLEET_JSON" | jq -r --argjson now "$NOW_MS" '
  .agents[]
  | select(.lease != null and .status != "terminal")
  | . as $a
  | if ($a.lease.until > $now) then
      "  #\($a.issue) \($a.title[0:55]) [\($a.phase // "unknown")] LEASED (\($a.lease.by // "unknown"), \((($a.lease.until - $now) / 60000) | floor)m left)"
    else
      "  #\($a.issue) \($a.title[0:55]) [\($a.phase // "unknown")] STALLED (lease expired \((($now - $a.lease.until) / 60000) | floor)m ago)"
    end
')

if [ -z "$ENGINE_OUTPUT" ]; then
    echo "  No engine-managed issues in flight (or none with FORGE:STATE blocks)."
else
    echo "$ENGINE_OUTPUT"
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

INVESTIGATING=$(echo "$FLEET_JSON" | jq '[.agents[] | select(.workflowLabel == "workflow:investigating")] | length')
BUILDING=$(echo "$FLEET_JSON" | jq '[.agents[] | select(.workflowLabel == "workflow:building")] | length')
IN_REVIEW=$(echo "$FLEET_JSON" | jq '[.agents[] | select(.workflowLabel == "workflow:in-review")] | length')
BLOCKED=$(echo "$FLEET_JSON" | jq '[.agents[] | select(.workflowLabel == "needs-human")] | length')
READY=$(echo "$FLEET_JSON" | jq '[.agents[] | select(.workflowLabel == "workflow:ready-to-build")] | length')

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
    echo "$FLEET_JSON" | jq -r '.agents[] | select(.workflowLabel == "needs-human") | "    #\(.issue) \(.title[0:70])"'
fi

if [ "$IN_REVIEW" -gt 3 ]; then
    echo ""
    echo "  ⚠  Review queue depth is $IN_REVIEW — consider running /review-pr or /orchestrate fast-lane"
fi

echo ""
echo "=== Status complete — $(date +%Y-%m-%d\ %H:%M:%S) ==="
```
