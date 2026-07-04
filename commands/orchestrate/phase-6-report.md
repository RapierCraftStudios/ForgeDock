---
install: internal
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Phase 6: Consolidated Report

## Phase 6: Consolidated Report

After ALL issues reach terminal state AND cleanup completes, present a final summary.

### Step 6A: Collect trajectory data

```bash
for NUM in {all_completed_issue_numbers}; do
  gh api repos/{GH_REPO}/issues/${NUM}/comments \
    --jq '.[] | select(.body | contains("<!-- FORGE:TRAJECTORY -->")) | .body' 2>/dev/null
done
```

Aggregate into the batch-level analytics for Step 6B.

**Also collect the machine-readable summary cards** (`<!-- FORGE:CARD {json} -->`, embedded in
each issue's `FORGE:TRAJECTORY` comment by `/work-on` close phase). These power the per-issue and
batch cards in Step 6C:

```bash
CARDS=""
for NUM in {all_completed_issue_numbers}; do
  CARD=$(gh api repos/{GH_REPO}/issues/${NUM}/comments \
    --jq '.[] | select(.body | contains("FORGE:CARD")) | .body' 2>/dev/null \
    | sed -n 's/.*<!-- FORGE:CARD \(.*\) -->.*/\1/p' | head -1)
  [ -n "$CARD" ] && CARDS="${CARDS}${CARD}"$'\n'
done
# CARDS is now a newline-delimited list of per-issue JSON objects (skip any issue whose
# card is absent — pre-card runs or non-merged terminal states degrade gracefully).
```

### Step 6B: Present consolidated report

```
## Orchestration Complete

**Scope**: {milestone / issue list}
**Duration**: {approximate time}

### Investigations (Phase 2)
{IF investigations ran:}
| # | Investigation | Issues Created | Result |
|---|-------------|---------------|--------|
| #{INV1} | {title} | #{N1}, #{N2}, #{N3} | ✓ Closed |
{ELSE: "No investigations in this batch."}

### Implementation Results

| # | Issue | Source | Result | PR | Target |
|---|-------|--------|--------|----|--------|
| #{A} | {title} | original | ✓ Merged | #{PR} | staging |
| #{B} | {title} | original | ✓ Merged | #{PR} | milestone/x |
| #{N1} | {title} | from #{INV1} | ✓ Merged | #{PR} | staging |
| #{C} | {title} | original | ✗ Invalid | — | — |
| #{D} | {title} | original | ⚠ Blocked | — | — |
| #{E} | {title} | original | ⏭ Skipped (dep) | — | — |

### Review-Spawned Issues

{IF review findings were created during any agent run:}
| # | Finding | Source Issue | Source PR | Status |
|---|---------|-------------|-----------|--------|
| #{F1} | {title} | #{A} | PR #{PR} | ✓ Merged (in-batch) / ✓ Swept (completion sweep) / ⏳ Deferred (cosmetic) / ⛔ Deferred (gen2 cascade cap) |

{ELSE: "No review findings created during this batch."}

### Completion Sweep <!-- Added: forge#1105 -->
- **Re-evaluated**: {N} deferred findings re-checked after DAG drain
- **Dispatched**: {N} findings cleared and executed (file overlap resolved)
- **Still deferred (cosmetic)**: {N} comment/typo findings (low-value, safe to leave)
- **Permanently deferred (gen2)**: {N} generation >= 2 findings (cascade cap — requires manual `/work-on`)

{IF permanently deferred > 0:}
**Action required**: The following findings were permanently deferred due to the generation >= 2 cascade cap. They will NOT be picked up automatically — run `/work-on #{N}` manually or include them in the next `/orchestrate` batch:
{list of permanently deferred issue numbers and titles}

{IF cosmetic deferred > 0:}
**Low-priority leftovers**: The following cosmetic findings remain open. They will be picked up by future runs or can be batched with `/orchestrate #{N1} #{N2}`:
{list of cosmetic deferred issue numbers and titles}

### Summary
- **Investigations**: {N} completed, spawned {M} new issues
- **Review findings**: {N} spawned, {M} resolved in-batch, {K} swept, {J} deferred (cosmetic), {L} deferred (gen2)
- **Succeeded**: {N} issues resolved (implementation + sweep)
- **Failed**: {N} issues need attention
- **Skipped**: {N} issues (dependency failures)

### Post-Batch Cleanup
- Labels fixed: {N}
- Orphaned issues closed: {N}
- Worktrees removed: {N}
- Branches pruned: {N}
- Milestones closed: {N}

### Agent Efficiency (from /audit-agents)

| Agent | Issue | Total | Active | Idle% | Resumes | Stall Points |
|-------|-------|-------|--------|-------|---------|--------------|
{per-agent rows from audit}

**Batch efficiency**: {avg_idle_pct}% idle time
**Total resume cycles**: {sum_resumes} across {agent_count} agents
**Clean agents** (no stalls): {clean_count}/{agent_count}

### Batch Trajectory Analytics

| Metric | Value |
|--------|-------|
| Issues attempted | {N} |
| Investigation invalidation rate | {N_invalid}/{N_investigated} ({%}) |
| Contracts posted | {N} |
| Contract→code divergences | {N} (agents that updated contract mid-build) |
| Review findings created | {N_total} |
| Findings queued after cascade control | {N_queued}/{N_total} ({N_deferred} deferred — see Step 4C) |
| Competing recommendations reconciled (Phase 2.5) | {RECONCILED_COUNT} (investigation plans arbitrated in place + serialized) |
| Findings validated | {N} |
| False positives | {N} ({%}) |
| Anomalies flagged | {N} |

**Domain breakdown**: {N} scraping, {N} frontend, {N} billing, ...
**Routing**: {N} fast-lane, {N} feature-lane

> `Findings queued after cascade control` reports Step 4C's defer/execute triage split (`QUEUED_FINDINGS` vs `DEFERRED_FINDINGS`) — it is NOT a dedup/arbitration computation; no such step exists for review findings. `Competing recommendations reconciled` is populated by Phase 2.5 (`RECONCILED_COUNT`), which reconciles investigation plans, not review findings. It is `0` when the batch had 0–1 investigations (synthesis is a no-op). <!-- Added: forge#1192, forge#1193 -->

**Systematic issues** (flag if detected):
- False positive rate > 30% → review agents may need tuning
- Invalidation rate < 10% or > 35% → investigation calibration off
- Same-domain merge conflicts between concurrent agents → domain serialization edges too loose
- Contract divergences > 20% → investigation quality may need improvement
- **Idle% > 50%** → agents stalling at phase boundaries; check work-on routing loop
- **Avg resumes > 1** → orchestrator having to compensate for agent stops

### Next Steps
{If milestone and all issues done: "Milestone ready to ship. Run `/milestone ship {slug}` when ready. The ship command includes a pre-merge hunk-loss audit (Step 2.5) that detects staging-only hunks in milestone-modified files and rebases the milestone branch to absorb them before creating the PR — protecting against squash-merge regressions."}
{If some failed: "Issues #{X}, #{Y} need manual attention. Re-run with `/work-on #{X}` after resolving blockers."}
{If fast-lane: "All fixes merged to staging. Merge staging → main via GitHub web UI when ready to deploy."}
```

### Step 6C: Pipeline Summary Cards (the shareable moment)

Render one compact summary card per completed issue (from the `CARDS` JSON collected in Step 6A),
then a single batch-level summary card. These are the shareable artifacts a developer screenshots
after an orchestration run. Print all cards to stdout.

**Per-issue card** — emit one for each JSON object in `CARDS`. Use the same box-drawing style and
51-column inner width as `work-on/close.md` Phase C4.5b. Read fields directly from the JSON
(`issue`, `title`, `pipeline`, `commits`, `additions`, `deletions`, `pr`, `pr_target`, `review`,
`elapsed_seconds`). Truncate long titles with `…`; render `null` numeric fields as `—`. The
`pipeline`/`status` field already encodes skipped phases (decomposed/invalid/blocked), so reflect
it verbatim. Skip issues with no card (graceful — pre-card or non-merged runs).

**Batch summary card** — aggregate across all collected cards:

```
╔═══════════════════════════════════════════════════╗
║  ForgeDock Orchestration Complete                 ║
╠═══════════════════════════════════════════════════╣
║                                                   ║
║  Scope:    {milestone / issue list}               ║
║  Issues:   {N} merged · {M} blocked · {K} invalid ║
║  Commits:  {SUM_COMMITS} ({SUM_ADD} additions, {SUM_DEL} deletions) ║
║  PRs:      {N} merged                             ║
║  Findings: {N} spawned · {M} resolved             ║
║  Time:     {BATCH_ELAPSED}                        ║
║                                                   ║
╚═══════════════════════════════════════════════════╝
```

Aggregate with `jq` over the collected cards (every sum degrades gracefully — `null`/missing
fields are treated as 0; never fabricate):

```bash
echo "$CARDS" | grep -v '^$' | jq -s '{
  merged:   (map(select(.status=="merged"))   | length),
  blocked:  (map(select(.status=="blocked"))  | length),
  invalid:  (map(select(.status=="invalid"))  | length),
  commits:  (map(.commits   // 0) | add),
  adds:     (map(.additions // 0) | add),
  dels:     (map(.deletions // 0) | add),
  prs:      (map(select(.pr != null)) | length),
  elapsed:  (map(.elapsed_seconds // 0) | add)
}'
```

The batch card's `Findings:` line is filled from the review-finding counts already computed in
the Summary section above. `BATCH_ELAPSED` is the wall-clock duration of the orchestration run
(Step 6B `Duration`), not the sum of per-issue elapsed times.

---

