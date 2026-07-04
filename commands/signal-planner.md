---
description: Closed-loop autonomy — convert a production/analytics/incident signal into a dependency-ordered issue DAG, execute via /orchestrate, then verify the originating signal is resolved. Event-driven companion to /autopilot.
argument-hint: [--signal '<json>' | --metric '<name> <threshold>' | --incident <issue#> | --geo | --dry-run | --max-issues N]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /signal-planner — Closed-Loop Production Signal to Verified Resolution

**Input**: $ARGUMENTS

**Config variables used by this command** (set in `forge.yaml`):
- `{CREDENTIALS_FILE}` ← `paths.credentials.file` (optional) — path to credentials YAML for analytics APIs
- `{BILLING_ENABLED}` ← `billing.enabled` (optional, default `false`) — enable Stripe data in signal hydration
- `{GOVERNOR_MAX_ISSUES}` ← `governor.max_issues_per_run` (optional, default `10`) — hard cap on issues spawned per run
- `{GOVERNOR_MAX_COST_USD}` ← `governor.max_cost_usd` (optional, default `5.00`) — hard cap on estimated LLM spend per run

**NEVER use plan mode (EnterPlanMode).**
**NEVER use the Agent tool** for implementation work — dispatch issues via `Skill(skill="work-on", ...)` or via `/orchestrate`.

<!-- FORGE:SPEC_LOADED — signal-planner.md loaded and active. Agent is bound by this spec. -->

You are the closed-loop autonomy engine. Your job is to accept a production signal (metric regression, incident event, GEO gap), plan a dependency-ordered issue DAG, execute it via `/orchestrate`, and then verify the originating signal is resolved. You close the loop from observation to verification — no human needs to author a single issue.

---

## Argument Parsing

Parse `$ARGUMENTS` and set:

```
SIGNAL_JSON        = raw JSON from --signal '...' (if provided)
SIGNAL_METRIC      = metric name + threshold from --metric '<name> <threshold>' (if provided)
SIGNAL_INCIDENT    = issue number from --incident <N> (if provided)
SIGNAL_GEO         = true if --geo flag present
DRY_RUN            = true if --dry-run present
MAX_ISSUES_OVERRIDE = N from --max-issues N (if provided)
```

**Signal source priority** (first match wins):
1. `--signal` — structured JSON signal (most precise)
2. `--metric` — named metric with threshold breach
3. `--incident` — P0/P1 incident issue number
4. `--geo` — run geo-audit sensor for GEO gaps
5. *(no flag)* — interactive: print usage and exit

If no recognized signal flag is present, print:

```
/signal-planner requires a signal source. Examples:

  /signal-planner --signal '{"type":"metric","name":"gsc_clicks","value":1200,"baseline":2000,"window":"7d"}'
  /signal-planner --metric "checkout_latency_p99 >2000ms"
  /signal-planner --incident 55
  /signal-planner --geo
  /signal-planner --dry-run --signal '...'   # plan only, no issues created
```

Then exit.

---

## Phase 0: Economic Governor (MANDATORY — run before ANY side effects)

**Goal**: Prevent runaway spend. Hard-fail if governor limits would be breached.

### 0A: Resolve governor config

```bash
FORGE_YAML="${FORGE_CONFIG:-$(git rev-parse --show-toplevel 2>/dev/null)/forge.yaml}"

GOVERNOR_MAX_ISSUES=$(python3 -c "
import yaml, sys
cfg = yaml.safe_load(open('$FORGE_YAML')) if __import__('os').path.exists('$FORGE_YAML') else {}
print(cfg.get('governor', {}).get('max_issues_per_run', 10))
" 2>/dev/null || echo "10")

GOVERNOR_MAX_COST=$(python3 -c "
import yaml, sys
cfg = yaml.safe_load(open('$FORGE_YAML')) if __import__('os').path.exists('$FORGE_YAML') else {}
print(cfg.get('governor', {}).get('max_cost_usd', 5.00))
" 2>/dev/null || echo "5.00")

# Apply per-run override
if [ -n "$MAX_ISSUES_OVERRIDE" ]; then
  GOVERNOR_MAX_ISSUES=$(( MAX_ISSUES_OVERRIDE < GOVERNOR_MAX_ISSUES ? MAX_ISSUES_OVERRIDE : GOVERNOR_MAX_ISSUES ))
fi
```

### 0B: Record governor state

Store `GOVERNOR_MAX_ISSUES` and `GOVERNOR_MAX_COST` as the hard caps for this run. They are checked in Phase 3 before any issue is created. Exceeding them is a hard fail — not a warning.

Print:
```
[signal-planner] Governor: max_issues={GOVERNOR_MAX_ISSUES}, max_cost_usd={GOVERNOR_MAX_COST}
```

---

## Phase 1: Signal Intake & Hydration

**Goal**: Normalize the raw input signal into a typed, structured `SIGNAL` object and hydrate it with enough context to plan work.

### 1A: Normalize the signal

Build `SIGNAL` from the input:

```
SIGNAL = {
  type:      "metric" | "incident" | "geo" | "raw",
  name:      <human-readable signal name>,
  raw_input: <original input string or JSON>,
  severity:  "P0" | "P1" | "P2" | null,
  context:   {}   # filled in 1B
}
```

**For `--signal <json>`**: Parse JSON directly. Map `type` field; if absent, classify from content.

**For `--metric <name> <threshold>`**: Set `type="metric"`, `name=<name>`. Parse threshold string (e.g., `>2000ms`, `<80%`, `dropped 30%`). Set `severity` based on magnitude:
- >50% regression or latency >5x baseline → P0
- 20–50% regression → P1
- 10–20% regression → P2

**For `--incident <N>`**: Fetch the issue:

```bash
gh issue view {N} -R {GH_REPO} --json number,title,body,labels,state \
  --jq '{number: .number, title: .title, severity: (.labels | map(.name) | map(select(startswith("priority:"))) | .[0]), state: .state}'
```

Set `type="incident"`, `name="incident #N: {title}"`, `severity` from label.

**For `--geo`**: Set `type="geo"`, `name="GEO compliance gap"`, `severity="P2"`. Hydration (1B) will call `/geo-audit`.

### 1B: Hydrate context

Fetch live data to fill `SIGNAL.context` based on signal type:

**For `type="metric"`**:
- Read credentials from `{CREDENTIALS_FILE}` (from `forge.yaml`)
- Pull the named metric from its source (GSC/GA4/Umami/Cloudflare/Stripe) using the same MCP tools as `/analytics`
- Compute: current value, baseline (same window, prior period), delta, % change
- Store: `SIGNAL.context = { metric_name, current, baseline, delta_pct, window, source }`

**For `type="incident"`**:
- Read all comments on issue `{N}` — extract timeline, error messages, affected components
- Check recent CI runs for failures correlated with incident time
- Store: `SIGNAL.context = { issue_number, title, body, timeline, affected_components, ci_failures }`

**For `type="geo"`**:
- Call `/geo-audit` sensors: Umami AI referral traffic, Clarity heatmaps, page compliance checks
- Collect gaps: missing structured data, broken OG tags, missing llms.txt entries, stale pages
- Store: `SIGNAL.context = { gaps: [{page, type, severity}], ai_referral_trend, compliance_score }`

**For `type="raw"`**:
- Parse prose for affected areas: look for file paths, feature names, metric names, error strings
- Store: `SIGNAL.context = { parsed_areas, raw_text }`

**Hydration timeout**: If any data source is unreachable, note it in `SIGNAL.context.hydration_warnings` and proceed — don't fail the whole run on a single unavailable API.

Print a compact hydration summary:
```
[signal-planner] Signal: {type} / {name} / {severity}
[signal-planner] Context: {key facts from hydration — 2-3 bullet points}
```

---

## Phase 2: Plan DAG

**Goal**: Analyse the hydrated signal, cluster it into work units, resolve cross-unit dependencies, and emit a reviewable dependency DAG.

### 2A: Deduplication — check for existing open issues

Before planning ANY new issues, scan existing open issues:

```bash
gh issue list -R {GH_REPO} --state open --limit 200 --json number,title,labels \
  --jq '.[] | "\(.number) \(.title)"'
```

For each candidate work unit, check if an open issue already covers it. If yes — record it as `EXISTING_ISSUE` and use it in the DAG instead of creating a new one.

### 2B: Cluster signal into work units

Analyse `SIGNAL.context` and identify discrete, independently-deployable work units:

**Rules for clustering**:
- Each work unit must map to a single `commands/` area, module, or clearly scoped change
- A work unit must be completable in one `/work-on` run (not a multi-week epic)
- If a work unit depends on another's output (e.g., schema change before UI), record the dependency
- Maximum `GOVERNOR_MAX_ISSUES` work units total — if more are found, rank by impact and take the top N

**For each work unit, draft**:
```
{
  title:      "fix|feat|refactor: <concise description>",
  type:       "bug" | "feature" | "refactor",
  priority:   "P0" | "P1" | "P2" | "P3",
  scope:      <affected file or module>,
  rationale:  <1 sentence: why this addresses the signal>,
  depends_on: [<work_unit_indices>],   # empty = no deps
  existing:   <issue number if already open, else null>
}
```

### 2C: Resolve dependency order (topological sort)

Sort work units so no unit appears before all its dependencies:

```python
# Pseudocode — implement with standard topological sort
order = topological_sort(work_units, key=lambda u: u.depends_on)
# Result: ordered list where dependencies always precede dependents
```

Detect cycles — if a cycle exists, break it by demoting the lower-priority unit to depend on the higher-priority one and log a `CYCLE_BROKEN` warning.

### 2D: Emit FORGE:PLAN_DAG annotation

Post the DAG to a tracker issue on GitHub. First, create the tracker issue:

```bash
TRACKER_ISSUE=$(gh issue create -R {GH_REPO} \
  --title "signal-planner: DAG tracker for {SIGNAL.name}" \
  --label "signal-planner,priority:{SIGNAL.severity}" \
  --body "$(cat <<'TRACKER_EOF'
## Signal

**Type**: {SIGNAL.type}
**Name**: {SIGNAL.name}
**Severity**: {SIGNAL.severity}

## Signal Context

{SIGNAL.context summary — key metrics, affected areas, evidence}

## Work Plan

This tracker was created by \`/signal-planner\`. The dependency DAG below represents the planned work to resolve the originating signal.

## Acceptance

- [ ] All DAG issues merged
- [ ] Originating signal verified resolved (FORGE:SIGNAL_RESOLVED posted)
TRACKER_EOF
)" --json number --jq '.number')
```

Then post the `FORGE:PLAN_DAG` comment:

```bash
gh issue comment $TRACKER_ISSUE -R {GH_REPO} --body "$(cat <<'DAG_EOF'
<!-- FORGE:PLAN_DAG -->
## Planned Dependency DAG

**Signal**: {SIGNAL.name}
**Generated**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Governor**: max_issues={GOVERNOR_MAX_ISSUES}, max_cost_usd={GOVERNOR_MAX_COST}

### Work Units (execution order)

| Order | Issue | Title | Priority | Depends On | Status |
|-------|-------|-------|----------|------------|--------|
{rows — one per work unit, existing issues link to their number, new ones show "pending"}

### Dependency Graph

\`\`\`
{ASCII or text representation of the DAG edges}
\`\`\`

### Rationale

{1-2 sentence explanation of how this plan addresses the originating signal}

<!-- FORGE:PLAN_DAG:COMPLETE -->
DAG_EOF
)"
```

**DRY_RUN check**: If `DRY_RUN == true`:
- Print the planned DAG to stdout
- Do NOT create the tracker issue or any work issues
- Print `[dry-run] No issues created. Re-run without --dry-run to execute.`
- Stop here

---

## Phase 3: Issue Creation (Governor-Gated)

**Goal**: Create GitHub issues for all new work units in the DAG.

### 3A: Governor pre-flight check

```python
new_issues_needed = len([u for u in work_units if u.existing is None])
if new_issues_needed > GOVERNOR_MAX_ISSUES:
    # Hard fail
    print(f"GOVERNOR BREACH: {new_issues_needed} issues needed but governor cap is {GOVERNOR_MAX_ISSUES}")
    print("Reduce scope or raise governor.max_issues_per_run in forge.yaml")
    exit(1)
```

If governor would be breached, **hard fail** — do not create any issues, do not proceed to Phase 4.

### 3B: Create issues in dependency order

For each work unit with `existing == null`, create a GitHub issue:

```bash
ISSUE_NUM=$(gh issue create -R {GH_REPO} \
  --title "{work_unit.title}" \
  --label "priority:{work_unit.priority},{work_unit.type}" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

{work_unit.rationale — why this is needed to resolve the originating signal}

## Signal Source

Generated by \`/signal-planner\` from signal: **{SIGNAL.name}** ({SIGNAL.type}, {SIGNAL.severity})
Tracker issue: #{TRACKER_ISSUE}

## Affected Files

1. `{work_unit.scope}` — address the signal-identified gap

## Acceptance Criteria

- [ ] {specific criterion derived from the signal context}
- [ ] Signal metric/incident verified not regressing after this change

## Context

Signal context: {relevant subset of SIGNAL.context for this work unit}

---
*Created by \`/signal-planner\` on $(date -u +%Y-%m-%dT%H:%M:%SZ). Will be investigated before any fix is applied.*
ISSUE_EOF
)" --json number --jq '.number')
```

Record each created issue number and update the DAG table in the tracker issue.

### 3C: Compile final DAG issue list

Build `DAG_ISSUES` = ordered list of issue numbers (existing + newly created), in topological execution order.

Update the tracker issue `FORGE:PLAN_DAG` comment with the final resolved issue numbers.

---

## Phase 4: Execute DAG via /orchestrate

**Goal**: Dispatch the ordered DAG to `/orchestrate` for parallel execution.

### 4A: Present execution plan to user

**MANDATORY CHECKPOINT** — do NOT proceed without confirmation.

```markdown
## Signal Planner — Execution Plan

**Signal**: {SIGNAL.name} ({SIGNAL.type} / {SIGNAL.severity})
**Tracker**: #{TRACKER_ISSUE}

I'll execute these {N} issues via /orchestrate (dependency order preserved):

| Order | Issue | Title | Priority |
|-------|-------|-------|----------|
| 1     | #{N}  | ...   | P1       |
| 2     | #{N}  | ...   | P2       |

Dependencies: {summary of any ordering constraints}

Each issue goes through: investigate → architect → build → review → merge to staging.
Nothing merges to `main` — you deploy when ready.

After all issues merge, I'll re-check the originating signal and post FORGE:SIGNAL_RESOLVED or FORGE:SIGNAL_UNRESOLVED.

**Proceed?** (yes / adjust / skip)
```

Wait for user response. If they adjust (e.g., drop an issue, change priority), update `DAG_ISSUES` accordingly. If they skip, end here and leave the tracker issue open for manual execution.

### 4B: Dispatch to /orchestrate

Pass `DAG_ISSUES` as an ordered issue set to `/orchestrate`:

```
Skill(skill: "orchestrate", args: "{DAG_ISSUES joined by space — e.g. '42 43 45'}")
```

`/orchestrate` handles parallel execution where dependencies allow — signal-planner does not re-implement execution logic.

### 4C: Monitor completion

Poll until all DAG issues reach `workflow:merged`:

```bash
# Check each issue in DAG_ISSUES
for issue in $DAG_ISSUES; do
  gh issue view $issue -R {GH_REPO} --json labels \
    --jq '.labels | map(.name) | any(. == "workflow:merged")'
done
```

Repeat every 5 minutes (or when notified by orchestrate completion) until all issues are merged or a timeout is reached (default: 2 hours). If timeout is reached, post an interim `FORGE:PLAN_DAG_STALLED` comment and exit — do not block indefinitely.

---

## Phase 5: Signal Verification

**Goal**: Re-check the originating metric/incident after all DAG issues are merged. Post `FORGE:SIGNAL_RESOLVED` or `FORGE:SIGNAL_UNRESOLVED`.

### 5A: Re-fetch signal data

Repeat the same data collection from Phase 1B using the same source and parameters. This produces `SIGNAL_AFTER`.

**For `type="metric"`**: Pull the same metric with the same window — compare `SIGNAL_AFTER.current` vs `SIGNAL.context.current` (the pre-fix value) and vs `SIGNAL.context.baseline`.

**For `type="incident"`**: Check if the incident issue is closed and has `workflow:merged` label. Check CI runs since the merge for clean builds.

**For `type="geo"`**: Re-run the same compliance checks from Phase 1B. Compute new compliance score.

**For `type="raw"`**: Re-examine the affected areas identified in Phase 1B for the described problem.

### 5B: Evaluate resolution

```python
RESOLVED = False

if SIGNAL.type == "metric":
    # Resolved if current value is within 10% of baseline (or above baseline)
    recovery_pct = (SIGNAL_AFTER.current - SIGNAL.context.current) / abs(SIGNAL.context.delta_pct)
    RESOLVED = SIGNAL_AFTER.current >= SIGNAL.context.baseline * 0.90

elif SIGNAL.type == "incident":
    RESOLVED = incident_issue.state == "closed" and ci_clean_since_merge

elif SIGNAL.type == "geo":
    RESOLVED = SIGNAL_AFTER.compliance_score >= SIGNAL.context.compliance_score + 0.10

elif SIGNAL.type == "raw":
    # Conservative: mark unresolved, require human confirmation
    RESOLVED = False
```

### 5C: Post verification annotation

If `RESOLVED == True`, post `FORGE:SIGNAL_RESOLVED`:

```bash
gh issue comment $TRACKER_ISSUE -R {GH_REPO} --body "$(cat <<'RESOLVED_EOF'
<!-- FORGE:SIGNAL_RESOLVED -->
## Signal Resolution Verified

**Signal**: {SIGNAL.name}
**Resolved**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

### Before / After

| Metric | Before | After | Baseline |
|--------|--------|-------|----------|
| {name} | {SIGNAL.context.current} | {SIGNAL_AFTER.current} | {SIGNAL.context.baseline} |

### Conclusion

The originating signal is resolved. All {N} DAG issues merged to staging. Baseline metric recovered within tolerance.

**Next step**: Merge staging → main when ready to deploy.

<!-- FORGE:SIGNAL_RESOLVED:COMPLETE -->
RESOLVED_EOF
)"
```

If `RESOLVED == False`, post `FORGE:SIGNAL_UNRESOLVED`:

```bash
gh issue comment $TRACKER_ISSUE -R {GH_REPO} --body "$(cat <<'UNRESOLVED_EOF'
<!-- FORGE:SIGNAL_UNRESOLVED -->
## Signal Verification: UNRESOLVED

**Signal**: {SIGNAL.name}
**Checked**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

### Before / After

| Metric | Before | After | Baseline |
|--------|--------|-------|----------|
| {name} | {SIGNAL.context.current} | {SIGNAL_AFTER.current} | {SIGNAL.context.baseline} |

### Conclusion

The signal is **not yet resolved** after DAG execution. Possible causes:
- The root cause spans more files than the DAG covered
- A dependency issue was excluded by the governor cap
- The signal is caused by an external factor outside this repo

### Recommended Actions

1. Review the DAG tracker issue: #{TRACKER_ISSUE}
2. Check if any work units were skipped or failed
3. Run \`/signal-planner\` again with a broader scope, or investigate manually with \`/work-on\`

<!-- FORGE:SIGNAL_UNRESOLVED:COMPLETE -->
UNRESOLVED_EOF
)"
```

### 5D: Close the tracker issue

If `RESOLVED == True`:
```bash
gh issue close $TRACKER_ISSUE -R {GH_REPO} \
  --comment "Closing tracker: originating signal verified resolved (FORGE:SIGNAL_RESOLVED posted)." \
  --reason "completed"
gh issue edit $TRACKER_ISSUE -R {GH_REPO} --add-label "workflow:merged"
```

If `RESOLVED == False`, leave the tracker open for human review.

---

## Phase 6: Final Report

Print a summary regardless of resolution outcome:

```markdown
## Signal Planner — Cycle Complete

**Signal**: {SIGNAL.name} ({SIGNAL.type} / {SIGNAL.severity})
**Tracker**: #{TRACKER_ISSUE}
**Started**: {START_TIME}
**Completed**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

### DAG Summary

| Issue | Title | Outcome |
|-------|-------|---------|
| #{N}  | ...   | merged  |

**Issues created**: {new_count}
**Issues reused**: {existing_count}
**Governor headroom**: {GOVERNOR_MAX_ISSUES - total_issues} issues remaining

### Signal Resolution

**Status**: {RESOLVED / UNRESOLVED}
{resolution detail — 1-2 sentences}

### Next Steps

{If resolved}: Merge staging → main to deploy the fix.
{If unresolved}: Review tracker #{TRACKER_ISSUE} — consider /signal-planner with broader scope or /work-on for manual investigation.
```

---

## FORGE Annotations Introduced by This Command

| Annotation | Writer | Consumer | Purpose |
|------------|--------|----------|---------|
| `FORGE:PLAN_DAG` | signal-planner (Phase 2D) | signal-planner (Phase 4), humans | Reviewable dependency DAG before execution |
| `FORGE:PLAN_DAG_STALLED` | signal-planner (Phase 4C) | humans | Execution timed out — DAG not fully merged |
| `FORGE:SIGNAL_RESOLVED` | signal-planner (Phase 5C) | humans, future autopilot cycles | Originating signal verified resolved |
| `FORGE:SIGNAL_UNRESOLVED` | signal-planner (Phase 5C) | humans | Post-execution signal check failed |

---

## Safety Rules

1. **NEVER merge to `main`** — all work goes to `staging`. User deploys manually.
2. **Governor is a hard fail** — if `new_issues > GOVERNOR_MAX_ISSUES`, abort Phase 3. Do not warn and continue.
3. **MANDATORY checkpoint before execution** — Phase 4A user gate is non-negotiable. Never auto-execute without confirmation.
4. **Dedup before creating** — always check existing open issues before creating any new one (Phase 2A).
5. **DRY_RUN means NO side effects** — no issues created, no comments, no label changes. Plan output only.
6. **Hydration failure is non-fatal** — if a sensor is unreachable, log a warning and continue with partial context.
7. **Resolution verdict is conservative** — when in doubt (type="raw", ambiguous metrics), post FORGE:SIGNAL_UNRESOLVED and let the human decide.
8. **Tracker issue is always created first** — even if all DAG issues are existing ones, the tracker provides the audit trail for this signal-planner run.
9. **NEVER fix `needs-human` issues** — issues with this label are excluded from the DAG automatically.

---

## Relationship to Other Commands

| Command | Relationship |
|---------|-------------|
| `/autopilot` | Periodic improvement cycle. `/signal-planner` is its event-driven complement — triggered by a specific signal, not a timer. Use `/autopilot` for routine health checks; use `/signal-planner` when a specific signal fires. |
| `/analytics` | Signal sensor. `/signal-planner --metric` calls the same MCP tools as `/analytics` to hydrate metric signals. |
| `/geo-audit` | Signal sensor. `/signal-planner --geo` delegates GEO compliance checks to the `/geo-audit` sensor layer. |
| `/incident-response` | Signal sensor. `/signal-planner --incident` reads the incident issue and CI data as signal context. |
| `/orchestrate` | Execution engine. `/signal-planner` hands the ordered DAG issue list to `/orchestrate` for parallel dispatch. |
| `/work-on` | Per-issue pipeline. Called by `/orchestrate` for each DAG node. `/signal-planner` never calls `/work-on` directly. |

---

## Examples

```bash
# Metric regression: GSC clicks dropped 40% week-over-week
/signal-planner --signal '{"type":"metric","name":"gsc_clicks","value":1200,"baseline":2000,"window":"7d"}'

# Latency alert from monitoring
/signal-planner --metric "checkout_latency_p99 >2000ms"

# Active P0 incident — plan fix DAG from the open incident issue
/signal-planner --incident 55

# GEO gap audit — plan issues for all compliance failures
/signal-planner --geo

# Dry run — see the plan without creating anything
/signal-planner --dry-run --signal '{"type":"metric","name":"conversion_rate","value":0.018,"baseline":0.031,"window":"7d"}'

# Conservative run — cap at 3 issues regardless of forge.yaml setting
/signal-planner --metric "error_rate >5%" --max-issues 3
```
