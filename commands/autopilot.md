---
description: Autonomous platform improvement cycle — recon, triage, fix, report. Runs recon+triage by default; pass --fix to also pick up and fix top issues. Human gates all deploys.
argument-hint: [--fix | --recon-only | --fix --limit 5 | --dry-run | --fix --yes]
install: extras
---

# /autopilot — Recursive Platform Improvement Cycle

**Input**: $ARGUMENTS (default: recon + triage + report, no fixing)

**Config variables used by this command** (set in `forge.yaml`):
- `{CREDENTIALS_FILE}` ← `paths.credentials.file` (optional) — path to credentials YAML for analytics APIs
- `{SERVER_SSH}` ← `services.server_ssh` (optional) — SSH target for production server health checks (e.g., `ubuntu@1.2.3.4`)
- `{OPS_INBOX_PATH}` ← `services.ops_inbox_path` (optional) — path on production server to a directory of open work-item files (e.g. `/srv/ops/inbox`)
- `{BILLING_ENABLED}` ← `billing.enabled` (optional, default `false`) — set to `true` to enable Stripe data collection in the Analytics Snapshot agent

Resolve `{BILLING_ENABLED}` from `forge.yaml` before executing any phase:

```bash
BILLING_ENABLED=$(yq '.billing.enabled // false' "$(git rev-parse --show-toplevel)/forge.yaml" 2>/dev/null || echo 'false')
```

**NEVER use plan mode (EnterPlanMode).**
**NEVER use the Agent tool** — autopilot dispatches work via `Skill(skill="work-on", ...)` only. The Agent tool bypasses the Skill pipeline's label state machine, investigation comments, and structured review — leaving no audit trail.

<!-- FORGE:SPEC_LOADED — autopilot.md loaded and active. Agent is bound by this spec. -->

You are an autonomous improvement engine for this project. Your job is to **find what's wrong, create trackable issues, and optionally fix the highest-impact ones** — all in a single cycle. Every cycle leaves the platform measurably better than before.

**This is designed to run repeatedly.** Each cycle builds on the last — issues created in cycle N get fixed in cycle N+1. The platform compounds improvements over time.

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. User can override with `--model <name>`. Pass model explicitly in every `Agent`/`Task` tool call. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.

---

## Argument Parsing

| Flag | Effect |
|------|--------|
| (none) | Phases 1-3 only (recon, triage, report) |
| `--fix` | Also run Phase 4 (pick top issues, fix via /work-on) |
| `--fix --limit N` | Fix at most N issues (default: 3) |
| `--recon-only` | Phase 1 only (data collection, no issue creation) |
| `--dry-run` | Run everything but don't create issues or PRs — just report what would happen |
| `--fix --yes` | Auto-approve low-risk fixes (P3, single-file, non-sensitive domain); P0/P1, multi-file, and sensitive-domain fixes still require confirmation |

Parse `$ARGUMENTS` and set these variables:
```
MODE = "full" | "recon-only" | "fix"    # derived from flags
DO_FIX = true if --fix present
FIX_LIMIT = N from --limit N, default 3
DRY_RUN = true if --dry-run present
AUTO_YES = true if --yes present
```

---

## Phase 0: Cycle Context

**Goal**: Understand what happened since the last cycle.

### 0A: Timestamp & baseline

```bash
echo "=== Autopilot Cycle: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# Portable ISO-8601 date arithmetic using python3 (works on Windows, macOS, Linux).
# Replaces GNU-only `date -u -d 'N days ago'` which fails on Windows and macOS.
DATE_3D_AGO=$(python3 -c "from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc) - timedelta(days=3)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
DATE_7D_AGO=$(python3 -c "from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
DATE_1D_AGO=$(python3 -c "from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc) - timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ'))")

# Recent closed issues (last 3 days) — what was fixed recently?
gh issue list --state closed --json number,title,labels,closedAt \
  --jq '[.[] | select(.closedAt > "'"$DATE_3D_AGO"'")] | length' 2>/dev/null || echo "0"

# Open issue count by priority
gh issue list --state open --label "priority:P0" --json number --jq 'length'
gh issue list --state open --label "priority:P1" --json number --jq 'length'
gh issue list --state open --label "priority:P2" --json number --jq 'length'

# Stale issues (open, no workflow label, older than 7 days)
gh issue list --state open --limit 200 --json number,title,labels,createdAt \
  --jq '[.[] | select(
    (.labels | map(.name) | any(startswith("workflow:")) | not) and
    (.createdAt < "'"$DATE_7D_AGO"'")
  )] | length'

# Failed CI runs in last 24h
gh run list --limit 30 --json conclusion,createdAt \
  --jq '[.[] | select(.conclusion == "failure" and .createdAt > "'"$DATE_1D_AGO"'")] | length'
```

Store these as `BASELINE` metrics for the cycle report.

### 0B: Check for open P0s

```bash
gh issue list --state open --label "priority:P0" --json number,title --jq '.[] | "#\(.number) \(.title)"'
```

If any P0 issues exist:
- **STOP the normal cycle**
- Print: `P0 issue(s) open — autopilot prioritizing these above all else`
- Set `FIX_TARGETS` to the P0 issue numbers
- Skip to Phase 4 (fix mode, regardless of flags)

---

## Phase 1: Recon (Parallel Data Collection)

**Goal**: Pull signals from every available source. Launch ALL collectors simultaneously.

### 1A: Launch parallel recon agents

Spawn these as **background agents** (all `run_in_background=true`, all `model="sonnet"`):

**Agent: Production Health**
```
Check production system health:
1. SSH to check for open ops-inbox items: if {SERVER_SSH} is configured, run: ssh {SERVER_SSH} "ls {OPS_INBOX_PATH}/*-open-* 2>/dev/null" — skip this step if SERVER_SSH or OPS_INBOX_PATH is not set in forge.yaml
2. If any exist, cat each one and summarize
3. Check container health via MCP: get_production_status, run_production_health_check
4. Check recent error logs: get_production_logs for api and worker (last 100 lines), grep for ERROR/CRITICAL
5. Return: memo summaries, unhealthy containers, error patterns with counts
```

**Agent: Scraping Intelligence**
```
Pull scraping performance data:
1. Read scrape_diagnostics summary from admin API or production logs
2. Check Redis for tier feedback stats: tier success/fail rates across domains
3. Look for patterns: domains with >50% failure rate, tiers with degraded performance
4. Return: top failing domains (count + tier), tier pass rates, any new anti-bot patterns
```

**Agent: CI/CD Health**
```
Check CI pipeline health:
1. gh run list --limit 30 — count failures by workflow name
2. For each failed run: gh run view {id} --json jobs — identify which job failed
3. Check if ecosystem-sync is consistently failing (known issue vs new)
4. Return: failure rate, recurring failures, new failures
```

**Agent: Issue Backlog Health**
```
Analyze GitHub issue backlog:
1. gh issue list --state open --limit 200 — full list with labels, milestones, dates
2. Count by: priority (P0-P3), type (bug/feature/etc), milestone, age
3. Find stale issues: open > 14 days, no workflow label, no recent comments
4. Find orphaned issues: workflow:in-review but no open PR
5. Find blocked issues: depends on another open issue
6. Return: backlog summary, stale issues list, orphans, blockers
```

**Agent: Analytics Snapshot** (lightweight — not the full /analytics audit)
```
Quick analytics pulse — just the key metrics, not a full audit:
1. Read credentials from {CREDENTIALS_FILE} (set via paths.credentials.file in forge.yaml)
2. GSC: mcp__gsc__search_analytics for last 7 days — total clicks, impressions, avg position
3. Stripe (only if {BILLING_ENABLED} is true): mcp__stripe__retrieve_balance — current balance.
   Skip this step entirely if {BILLING_ENABLED} is false — do NOT call any Stripe MCP tools.
4. Return: clicks trend (up/down), revenue (or "N/A — billing.enabled: false" if skipped), notable changes
```

### 1B: Collect results

Wait for all agents to complete. Aggregate into a `RECON_DATA` object:
```
RECON_DATA = {
  production: { memos, unhealthy_containers, error_patterns },
  scraping: { failing_domains, tier_rates, new_patterns },
  ci: { failure_rate, recurring_failures, new_failures },
  backlog: { summary, stale_issues, orphans, blockers },
  analytics: { clicks_trend, revenue, notable_changes }
}
```

If `MODE == "recon-only"`, print RECON_DATA as a formatted report and **stop here**.

---

## Phase 2: Triage & Issue Creation

**Goal**: Convert recon signals into actionable, deduplicated GitHub issues.

### 2A: Deduplication check

Before creating ANY issue, search for existing open issues that cover the same problem:

```bash
# For each finding, search existing issues
gh issue list --state open --limit 200 --json number,title,labels \
  --jq '.[] | "\(.number) \(.title)"'
```

**Rule**: If an existing open issue covers the finding (even partially), DO NOT create a duplicate. Instead, add a comment to the existing issue with the new data point.

### 2B: Classify and prioritize findings

For each finding from RECON_DATA, assign:

| Signal | Priority | Type |
|--------|----------|------|
| Open ops-inbox item | P1 | bug |
| Container unhealthy | P0 | bug |
| Error spike (>5x normal) | P1 | bug |
| Tier degradation (>20% drop) | P2 | bug |
| CI consistently failing | P2 | bug |
| Stale issue (>14 days) | — | (comment, don't create new issue) |
| Orphaned workflow state | — | (fix via /cleanup, not new issue) |
| Analytics decline (>20% week-over-week) | P2 | improvement |
| New anti-bot pattern detected | P2 | feature |

### 2C: Create issues

For each finding that passes dedup check, create a GitHub issue:

```bash
gh issue create \
  --title "{fix|feat|refactor}: {concise description}" \
  --label "{priority},{type}" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

{Description of the finding with specific data points. What's wrong or what's missing.}

## Root Cause (if known)

{What's causing the issue — specific code path, config gap, or behavior. If unknown: "Root cause unknown — investigation needed."}

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific, testable criterion}
- [ ] No regression in {related feature}

## Context

Found by \`/autopilot\` cycle on {DATE}.

## Evidence

{Logs, metrics, error messages — concrete data, not speculation}

## Suggested Approach

{Brief suggestion — the /work-on investigation will validate this}

---
*Created by autopilot recon cycle. Will be validated before any fix is applied.*
ISSUE_EOF
)"
```

**DRY_RUN check**: If `DRY_RUN == true`, print what would be created but don't actually create issues.

### 2D: Quick hygiene (inline, no separate /cleanup invocation)

While we have the backlog data, fix obvious hygiene issues directly:

```bash
# Close orphaned issues (merged PR but still open)
for orphan in {ORPHAN_LIST}; do
  gh issue close $orphan --comment "Auto-closed by autopilot: linked PR was already merged."
done

# Fix stale labels on closed issues
for stale in {STALE_LABEL_LIST}; do
  gh issue edit $stale --add-label "workflow:merged" --remove-label "workflow:in-review,workflow:building" 2>/dev/null || true
done
```

Store list of created issues as `CREATED_ISSUES`.

---

## Phase 3: Cycle Report

**Goal**: Present findings and actions taken to the user.

Print a structured report:

```markdown
## Autopilot Cycle Report — {DATE}

### Production Health
- Containers: {all healthy / N unhealthy}
- Open ops-inbox items: {count}
- Error patterns: {summary or "none"}

### Scraping Performance
- Tier pass rates: T1 {X}%, T2 {X}%, T3 {X}%, T4 {X}%
- Top failing domains: {list or "all healthy"}
- New patterns: {any or "none detected"}

### CI/CD
- Failure rate (24h): {X}/{Y} runs
- Recurring failures: {list or "none"}

### Issue Backlog
- Open: {P0: N, P1: N, P2: N, P3: N}
- Stale (>14d): {count}
- Orphaned: {count fixed}

### Analytics Pulse
- Clicks (7d): {N} ({trend})
- Revenue: ${N} (or "N/A — billing.enabled: false" if Stripe step was skipped)

### Actions Taken
- Issues created: {count} ({list with numbers})
- Issues commented: {count}
- Orphans closed: {count}
- Stale labels fixed: {count}
- Spec-edit impact analyses logged: {count} (FORGE:AUTOPILOT_IMPACT — blast radius surfaced before spec fixes)

### Recommended Next Steps
{Prioritized list of what the user should look at or deploy}
```

If `DO_FIX == false`, **stop here**. Print:
```
Run `/autopilot --fix` to also pick up and fix the top {FIX_LIMIT} issues.
```

---

## Phase 4: Fix (Optional, requires --fix flag)

**Goal**: Pick the highest-impact fixable issues and run them through `/work-on`.

### 4A: Select fix targets

If `FIX_TARGETS` was set by Phase 0 (P0 issues), use those. Otherwise:

Pick the top `FIX_LIMIT` issues by this priority:
1. P0 issues (always first)
2. P1 bugs (production-impacting)
3. Issues created by THIS cycle (freshest signal)
4. P2 bugs with `validated` or `needs-validation` label
5. Oldest P1 issues (prevent aging)

**Exclude** from fix targets:
- Issues with `needs-human` label
- Issues in milestones (feature lane — don't autopilot feature work)
- Issues already in `workflow:building` or `workflow:in-review`
- Issues with open dependencies

```bash
# Get candidates
gh issue list --state open --label "bug" --limit 50 --json number,title,labels,createdAt \
  --jq 'sort_by(.labels | map(select(.name | startswith("priority:P"))) | .[0].name) | .[:{FIX_LIMIT}] | .[] | "#\(.number) \(.title)"'
```

### 4B: Present fix plan to user

**MANDATORY CHECKPOINT — do NOT proceed without user confirmation.**

**Exception**: when `AUTO_YES = true`, classify each fix target by risk tier before prompting. Low-risk fixes are auto-approved; high-risk fixes still require confirmation.

**Risk classification** (evaluate per-issue at this step):

```
LOW_RISK = all of the following are true:
  - Priority is P2 or P3 (not P0 or P1)
  - Affects only a single file (from issue body or recon finding)
  - No sensitive-domain labels: auth, billing, database, security, payments, gdpr

HIGH_RISK = any of the following:
  - Priority P0 or P1
  - Multi-file change (2+ files)
  - Has a sensitive-domain label (auth, billing, database, security, payments, gdpr)
  - Issue has `needs-human` label
```

When `AUTO_YES = true`:
- **LOW_RISK issues**: auto-approve, log `[AUTO-APPROVED: low-risk]`, proceed to 4B.5/4C without waiting.
- **HIGH_RISK issues**: present the checkpoint below and wait for user response. If user skips, remove from fix targets and continue with remaining low-risk issues.

When `AUTO_YES = false` (default): present the full checkpoint for ALL fix targets and wait.

```markdown
## Autopilot Fix Plan

I'll run `/work-on` for these {N} issues:

| # | Title | Priority | Estimated Scope | Risk Tier |
|---|-------|----------|-----------------|-----------|
| {number} | {title} | {priority} | {small/medium/large} | LOW / HIGH |

Each issue goes through: investigate → validate → build → review → merge to staging.
Nothing merges to `main` — you deploy when ready.

{If AUTO_YES and any HIGH_RISK: "Note: {N_low} low-risk issues were auto-approved. The {N_high} high-risk issue(s) above require your confirmation."}

**Proceed?** (yes / adjust / skip)
```

Wait for user response on high-risk issues. If they adjust, re-select. If they skip all, end the cycle.

### 4B.5: Spec-Edit Impact Analysis (MANDATORY before any spec-touching fix) <!-- Added: forge#870 -->

**Goal**: Before autopilot dispatches a fix that edits ForgeDock's own command specs (`commands/*.md`), surface the blast radius of the change so the edit doesn't silently break downstream consumers (every spec that reads a changed FORGE annotation, every command in a changed sub-phase chain, every script/label a touched node feeds).

This step **consumes the read-only query interface** shipped by the Spec Knowledge Graph (`scripts/graph-query.sh`, subcommand `impact`). It does **not** reimplement graph traversal — the blast radius is computed once, in `graph-query.sh`, and autopilot only reads its output.

**When it runs**: for each approved fix target whose affected files (from the issue body's `## Affected Files` section, or the recon finding that created it) include any path matching `commands/*.md`. Non-spec fixes skip this step entirely.

**Graceful degradation**: `graph-query.sh` ships only with the Spec Knowledge Graph. If it is absent (fast-lane repos, or a checkout predating the milestone), **skip with a noted reason — never block the cycle**.

```bash
GRAPH_QUERY="$(git rev-parse --show-toplevel)/scripts/graph-query.sh"

# For each approved fix target that edits commands/*.md:
for issue in $SPEC_FIX_TARGETS; do
  if [ ! -x "$GRAPH_QUERY" ]; then
    echo "skip impact analysis for #$issue — graph-query.sh not present (Spec Knowledge Graph not installed)"
    continue
  fi

  # Derive the spec node(s) the fix changes. Prefer the FORGE annotation or
  # command/sub-phase named in the issue's Affected Files / recon finding.
  # graph-query.sh normalizes all of these forms:
  #   FORGE:CONTRACT  ==  CONTRACT  ==  ann:FORGE:CONTRACT
  #   work-on:build:implement  ==  cmd:work-on:build:implement
  #   classify-lane.sh  ==  script:classify-lane.sh
  #   workflow:merged  ==  label:workflow:merged
  for node in $CHANGED_SPEC_NODES; do
    echo "### Impact of changing $node (fix #$issue)"
    bash "$GRAPH_QUERY" impact "$node" --human
  done
done
```

**Log the result in a FORGE annotation.** Post one `FORGE:AUTOPILOT_IMPACT` comment per spec-touching fix target on its issue, BEFORE invoking `/work-on` in 4C:

```bash
gh issue comment $issue --body "<!-- FORGE:AUTOPILOT_IMPACT -->
## Spec-Edit Impact Analysis

**Changed spec node(s)**: \`$CHANGED_SPEC_NODES\`
**Query**: \`graph-query.sh impact <node> --human\` (Spec Knowledge Graph, read-only)

### Blast Radius (downstream consumers of this change)
\`\`\`
$IMPACT_OUTPUT
\`\`\`

Every command/spec listed above reads the changed annotation or sits in the changed sub-phase chain. The \`/work-on\` build for this fix MUST keep these consumers working — verify the changed field/marker is still produced in the shape they expect.

<!-- FORGE:AUTOPILOT_IMPACT:COMPLETE -->"
```

If `graph-query.sh` was absent, post the same annotation with the blast-radius block set to `(skipped — Spec Knowledge Graph not installed)` so the skip is auditable.

**Worked example** — autopilot picks up a fix that renames a field inside the `FORGE:CONTRACT` annotation. Before dispatching `/work-on`, it runs:

```bash
$ graph-query.sh impact FORGE:CONTRACT --human
Impact (blast radius) of changing ann:FORGE:CONTRACT:
  cmd:milestone
  cmd:orchestrate
  cmd:resume
  cmd:review-pr
  cmd:work-on
  cmd:work-on-monolithic
  cmd:work-on:build
  cmd:work-on:build:implement
  cmd:work-on:review
```

The summary makes the nine downstream consumers explicit before the edit lands, so the contract-field rename is reviewed against every reader — not discovered as a broken consumer later.

**`FORGE:AUTOPILOT_IMPACT`** is a leaf annotation: autopilot is its only writer and no downstream pipeline phase consumes it. It exists to record the blast radius on the issue thread for human and reviewer visibility.

### 4C: Execute fixes

For each approved fix target, invoke `/work-on` via the Skill tool:

```
Skill(skill: "work-on", args: "{ISSUE_NUMBER}")
```

Run them **sequentially** (not parallel) — each `/work-on` invocation is heavyweight and benefits from full context. If one fails, continue to the next.

After each `/work-on` completes, record the result:
```
FIX_RESULTS.push({
  issue: NUMBER,
  outcome: "merged" | "invalid" | "failed" | "needs-human",
  pr: PR_NUMBER or null,
  branch: BRANCH_NAME
})
```

### 4D: Fix summary

```markdown
## Fix Results

| Issue | Outcome | PR |
|-------|---------|-----|
| #{N} | {outcome} | #{PR} |

**Merged to staging**: {count}
**Needs attention**: {list}
**Spec-edit impact analyses**: {count} blast-radius summaries logged (FORGE:AUTOPILOT_IMPACT) before spec fixes

When ready to deploy, merge `staging` → `main` via GitHub.
```

### 4E: Deploy Train Check <!-- Added: forge#1332 -->

After fixes are merged to staging, check the deploy train state. The deploy train is the single rolling staging→main PR — one per deploy cycle. Do NOT open a new staging→main PR if one is already open.

```bash
# Check for an open staging→main deploy PR (the current train)
TRAIN_PR=$(gh pr list {GH_FLAG} \
  --head "{STAGING_BRANCH}" \
  --base "{DEFAULT_BRANCH}" \
  --state open \
  --json number,url \
  --jq '.[0] // empty' 2>/dev/null)

TRAIN_PR_NUMBER=$(echo "$TRAIN_PR" | jq -r '.number // empty')

if [ -n "$TRAIN_PR_NUMBER" ]; then
  # Train exists — check if it is held by open findings
  HELD_BY_COUNT=$(gh issue list {GH_FLAG} \
    --label "review-finding" \
    --state open \
    --search "PR #${TRAIN_PR_NUMBER}" \
    --json number --jq '. | length' 2>/dev/null || echo 0)

  if [ "$HELD_BY_COUNT" -gt 0 ]; then
    echo "Deploy train PR #${TRAIN_PR_NUMBER} is HELD by ${HELD_BY_COUNT} open finding(s)."
    echo "The fixes merged in this autopilot cycle may resolve some of them."
    echo "Re-run /review-pr-staging ${TRAIN_PR_NUMBER} to re-evaluate the train gate."
  else
    echo "Deploy train PR #${TRAIN_PR_NUMBER} is CLEAR — no open findings. Ready to merge when you authorize."
  fi
else
  echo "No open staging→main PR found. The merged fixes are queued in staging."
  echo "Run /review-pr-staging to open a new train PR when ready."
fi
```

**Deploy policy**: Autopilot NEVER merges staging→main. It merges issue fixes TO staging only. The train PR is a human-gated merge — the user decides when to ship.

---

## Safety Rules

1. **NEVER merge to `main`** — all fixes go to `staging`. User deploys manually.
2. **NEVER skip investigation** — every fix goes through full `/work-on` (investigate → validate → build → review → merge).
3. **NEVER fix `needs-human` issues** — these require human judgment (legal, external services, etc.).
4. **NEVER fix milestone issues** — feature work is scoped to milestones, not autopilot.
5. **NEVER create duplicate issues** — always dedup against existing open issues first.
6. **NEVER run more than FIX_LIMIT fixes per cycle** — prevent runaway resource consumption.
7. **If a fix fails, move on** — don't retry. Log it and let the next cycle or human handle it.
8. **DRY_RUN means NO side effects** — no issues created, no PRs, no label changes. Report only.
9. **P0 overrides everything** — if P0 exists, skip normal recon and fix P0 immediately.
10. **Always gate high-risk fixes on user approval** — Phase 4B checkpoint is non-negotiable for P0/P1, multi-file, or sensitive-domain changes. `--yes` only auto-approves LOW_RISK tier (P2/P3, single-file, non-sensitive).

---

## Recursion: How Cycles Compound

Each cycle feeds the next:
```
Cycle N: CI recon detects recurring lint failures across 3 files → autopilot triage creates issue #X
Cycle N+1: autopilot picks up #X → /work-on adds pre-commit hook → merged to staging
Cycle N+2: CI recon shows lint failures resolved — no new issue needed
```

```
Cycle N: /analytics finds CTR dropped on /pricing → creates issue #Y
Cycle N+1: autopilot picks up #Y → /work-on rewrites SERP snippet → merged
Cycle N+2: /analytics shows CTR recovered → improvement confirmed
```

The platform gets better every cycle. Issues that aren't picked up age and rise in priority. Issues that keep recurring indicate a deeper structural problem — autopilot will eventually create a "meta" issue about the pattern.

---

## Operational Notes

- **Runtime**: Recon-only ~3-5 min. Full cycle with fixes ~15-45 min depending on issue count.
- **Token budget**: Recon is cheap (mostly MCP + API calls). Fixes are expensive (full /work-on per issue).
- **Idempotent**: Safe to run multiple times — dedup prevents duplicate issues, /work-on resumes from checkpoints.
- **Pairs with /loop**: Run `/loop 4h /autopilot` for continuous improvement, `/loop 4h /autopilot --fix --limit 2` for autonomous fixing with a human checkpoint every cycle, or `/loop 4h /autopilot --fix --yes` for fully unattended low-risk fixes (high-risk issues still surface for approval).
- **Event-driven complement**: `/autopilot` is a periodic cycle. When a specific production signal fires (metric regression, incident, GEO gap), use `/signal-planner` instead — it converts the signal into a dependency-ordered issue DAG, executes via `/orchestrate`, and verifies the originating signal is resolved after the work merges. Use `/autopilot` for scheduled health sweeps; use `/signal-planner` for targeted signal-driven response.
