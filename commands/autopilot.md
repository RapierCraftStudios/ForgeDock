---
description: Autonomous platform improvement cycle — recon, triage, fix, report. Runs recon+triage by default; pass --fix to also pick up and fix top issues. Human gates all deploys.
argument-hint: [--fix | --recon-only | --fix --limit 5 | --dry-run]
---

# /autopilot — Recursive Platform Improvement Cycle

**Input**: $ARGUMENTS (default: recon + triage + report, no fixing)

**Config variables used by this command** (set in `forge.yaml`):
- `{CREDENTIALS_FILE}` ← `paths.credentials.file` (optional) — path to credentials YAML for analytics APIs
- `{SERVER_SSH}` ← `services.server_ssh` (optional) — SSH target for production server health checks (e.g., `ubuntu@1.2.3.4`)
- `{EMEMO_PATH}` ← `services.ememo_path` (optional) — path on production server to open eMemo files

You are an autonomous improvement engine for this project. Your job is to **find what's wrong, create trackable issues, and optionally fix the highest-impact ones** — all in a single cycle. Every cycle leaves the platform measurably better than before.

**This is designed to run repeatedly.** Each cycle builds on the last — issues created in cycle N get fixed in cycle N+1. The platform compounds improvements over time.

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`. User can override with `--model <name>`. Pass the resolved model in every `Agent`/`Task` tool call. Each agent prompt is scoped to a specific data source or issue — the model executes the explicit steps without needing broad inference.

---

## Argument Parsing

| Flag | Effect |
|------|--------|
| (none) | Phases 1-3 only (recon, triage, report) |
| `--fix` | Also run Phase 4 (pick top issues, fix via /work-on) |
| `--fix --limit N` | Fix at most N issues (default: 3) |
| `--recon-only` | Phase 1 only (data collection, no issue creation) |
| `--dry-run` | Run everything but don't create issues or PRs — just report what would happen |

Parse `$ARGUMENTS` and set these variables:
```
MODE = "full" | "recon-only" | "fix"    # derived from flags
DO_FIX = true if --fix present
FIX_LIMIT = N from --limit N, default 3
DRY_RUN = true if --dry-run present
```

---

## Phase 0: Cycle Context

**Goal**: Understand what happened since the last cycle.

### 0A: Timestamp & baseline

```bash
echo "=== Autopilot Cycle: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# Recent closed issues (last 3 days) — what was fixed recently?
gh issue list --state closed --json number,title,labels,closedAt \
  --jq '[.[] | select(.closedAt > "'$(date -u -d '3 days ago' +%Y-%m-%dT%H:%M:%SZ)'")] | length' 2>/dev/null || echo "0"

# Open issue count by priority
gh issue list --state open --label P0 --json number --jq 'length'
gh issue list --state open --label P1 --json number --jq 'length'
gh issue list --state open --label P2 --json number --jq 'length'

# Stale issues (open, no workflow label, older than 7 days)
gh issue list --state open --limit 200 --json number,title,labels,createdAt \
  --jq '[.[] | select(
    (.labels | map(.name) | any(startswith("workflow:")) | not) and
    (.createdAt < "'$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)'")
  )] | length'

# Failed CI runs in last 24h
gh run list --limit 30 --json conclusion,createdAt \
  --jq '[.[] | select(.conclusion == "failure" and .createdAt > "'$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)'")] | length'
```

Store these as `BASELINE` metrics for the cycle report.

### 0B: Check for open P0s

```bash
gh issue list --state open --label P0 --json number,title --jq '.[] | "#\(.number) \(.title)"'
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
1. SSH to check for open eMemos: if {SERVER_SSH} is configured, run: ssh {SERVER_SSH} "ls {EMEMO_PATH}/*-open-* 2>/dev/null" — skip this step if SERVER_SSH or EMEMO_PATH is not set in forge.yaml
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
3. Stripe: mcp__stripe__retrieve_balance — current balance
4. Return: clicks trend (up/down), any revenue, notable changes
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
| Production eMemo (open) | P1 | bug |
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
- Open eMemos: {count}
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
- Revenue: ${N}

### Actions Taken
- Issues created: {count} ({list with numbers})
- Issues commented: {count}
- Orphans closed: {count}
- Stale labels fixed: {count}

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
  --jq 'sort_by(.labels | map(select(.name | startswith("P"))) | .[0].name) | .[:{FIX_LIMIT}] | .[] | "#\(.number) \(.title)"'
```

### 4B: Present fix plan to user

**MANDATORY CHECKPOINT — do NOT proceed without user confirmation.**

```markdown
## Autopilot Fix Plan

I'll run `/work-on` for these {N} issues:

| # | Title | Priority | Estimated Scope |
|---|-------|----------|-----------------|
| {number} | {title} | {priority} | {small/medium/large} |

Each issue goes through: investigate → validate → build → review → merge to staging.
Nothing merges to `main` — you deploy when ready.

**Proceed?** (yes / adjust / skip)
```

Wait for user response. If they adjust, re-select. If they skip, end the cycle.

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

When ready to deploy, merge `staging` → `main` via GitHub.
```

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
10. **Always gate fixes on user approval** — Phase 4B checkpoint is non-negotiable.

---

## Recursion: How Cycles Compound

Each cycle feeds the next:
```
Cycle N: /failure-recon finds tier 3 headers broken → creates issue #X
Cycle N+1: autopilot picks up #X → /work-on fixes it → merged to staging
Cycle N+2: /failure-recon shows tier 3 pass rate improved 30% → no new issue needed
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
- **Pairs with /loop**: Run `/loop 4h /autopilot` for continuous improvement, or `/loop 4h /autopilot --fix --limit 2` for autonomous fixing with a human checkpoint every cycle.
