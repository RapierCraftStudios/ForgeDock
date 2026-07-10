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

**Also collect the machine-readable summary cards** (embedded in each issue's `FORGE:TRAJECTORY`
comment by `/work-on` close phase as a `<!-- FORGE:CARD: v1 sha:... b64:... -->` line). These
power the per-issue and batch cards in Step 6C.

**CODEC PATH (forge#1727)**: Cards are now Base64url-encoded. Use the protocol CLI's `parse`
subcommand to decode them — do NOT use the old `sed -n 's/.*<!-- FORGE:CARD \(.*\) -->.*/\1/p'`
regex extraction, which only worked for the deprecated inline-JSON form:

```bash
CARDS=""
for NUM in {all_completed_issue_numbers}; do
  # Fetch the TRAJECTORY comment body for this issue
  TRAJ_BODY=$(gh api repos/{GH_REPO}/issues/${NUM}/comments \
    --jq '[.[] | select(.body | contains("FORGE:CARD:"))] | last | .body // ""' 2>/dev/null || true)
  if [ -n "$TRAJ_BODY" ]; then
    # Decode via protocol CLI — handles both Base64url form (forge#1727) and gracefully
    # exits 1 (skips) for pre-migration inline-JSON entries.
    CARD=$(echo "$TRAJ_BODY" | node packages/protocol/src/cli.js parse --type CARD 2>/dev/null || true)
    [ -n "$CARD" ] && CARDS="${CARDS}${CARD}"$'\n'
  fi
done
# CARDS is now a newline-delimited list of per-issue JSON objects decoded from FORGE:CARD payloads.
# Skip any issue whose card is absent — pre-card runs or non-merged terminal states degrade gracefully.
```

### Step 6A.5: Collect merge-ready PRs (`workflow:awaiting-merge`) <!-- Added: forge#1811 -->

**Why a separate collection pass**: `workflow:awaiting-merge` issues are open (their PR hasn't
merged yet), so they are excluded from `{all_completed_issue_numbers}` above — that set only
contains issues that reached a closed/merged terminal state. Iterate the full batch issue set
(`{all_batch_issue_numbers}` — same prose-variable used by the batch-wide loops in
`phase-4-execution.md`) instead, and filter to the awaiting-merge label.

For each awaiting-merge issue, resolve its open PR using the `"Closes #N"`-anchored search
established by forge#1634/#1646 — **do not** use a bare-number `search "${NUM} in:body"`, which
can false-positive on changelogs or cross-references and resolve the wrong PR:

```bash
MERGE_READY_PRS=()   # each entry: "NUM|PR_NUMBER|TITLE"

for NUM in {all_batch_issue_numbers}; do
  IS_AWAITING=$(gh issue view "$NUM" -R {GH_REPO} --json labels \
    --jq '[.labels[].name | select(. == "workflow:awaiting-merge")] | length' 2>/dev/null || echo "0")
  [ "$IS_AWAITING" -gt 0 ] || continue

  TITLE=$(gh issue view "$NUM" -R {GH_REPO} --json title --jq '.title' 2>/dev/null || echo "")

  # Anchor on "Closes #N" first (forge#1634/#1646 precedent).
  PR_NUM=$(gh pr list -R {GH_REPO} --state open --search "\"Closes #${NUM}\" in:body" \
    --json number,updatedAt --jq 'sort_by(.updatedAt) | last | .number' 2>/dev/null || echo "")
  if [ -z "$PR_NUM" ]; then
    # Fallback: a PR may close the issue via "Fixes #N"/"Resolves #N" rather than
    # "Closes #N". Use the bare number only to generate candidates, then RE-VALIDATE
    # each candidate's body against an anchored (Closes|Fixes|Resolves) #N word-boundary
    # regex before accepting it — never accept a bare mention (changelog / cross-reference),
    # which could resolve the wrong PR into the one-shot batch-merge command. This mirrors
    # the recover-orphans.md re-validation precedent. <!-- forge#1822 -->
    PR_NUM=$(gh pr list -R {GH_REPO} --state open --search "${NUM} in:body" \
      --json number,updatedAt,body \
      --jq --arg n "${NUM}" '[ .[] | select(.body | test("(?i)(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#" + $n + "\\b")) ] | sort_by(.updatedAt) | last | .number // empty' 2>/dev/null || echo "")
  fi

  [ -n "$PR_NUM" ] && MERGE_READY_PRS+=("${NUM}|${PR_NUM}|${TITLE}")
done
# MERGE_READY_PRS now holds one entry per merge-ready PR in the batch (empty array if none).
# Feeds the "### Merge-Ready" report block and the Implementation Results table row (Step 6B).

# Pre-build the batch-merge command (rendered verbatim as {MERGE_READY_CMD} in Step 6B —
# computed here, not inside the report template, so Step 6B stays plain template text with no
# nested code fences of its own). `gh pr merge` accepts only ONE PR selector per invocation,
# so chain one `gh pr merge` per PR with && rather than passing a space-separated list (which
# `gh` rejects). <!-- forge#1838 review: BUG-3 -->
MERGE_READY_CMD=""
if [ "${#MERGE_READY_PRS[@]}" -gt 0 ]; then
  for _entry in "${MERGE_READY_PRS[@]}"; do
    _pr=$(printf '%s' "$_entry" | cut -d'|' -f2)
    [ -z "$_pr" ] && continue
    [ -n "$MERGE_READY_CMD" ] && MERGE_READY_CMD="${MERGE_READY_CMD} && "
    MERGE_READY_CMD="${MERGE_READY_CMD}gh pr merge ${_pr} --merge -R {GH_REPO}"
  done
fi
```

### Step 6A.6: Collect blocked-on-human-merge dependents (`blocked-on-human-merge`) <!-- Added: forge#1812 -->

**Why a separate collection pass**: A `blocked-on-human-merge` issue is a *dependent* of a `GATED`
predecessor (`needs-human` or `workflow:awaiting-merge` — see `phase-4-execution.md` Step 4B's
Predecessor Classification), not itself blocked or failed. It has no PR of its own yet — it hasn't
even been dispatched. It is excluded from both `{all_completed_issue_numbers}` (never ran) and
`MERGE_READY_PRS` (Step 6A.5, which only covers issues that themselves reached `workflow:awaiting-merge`).
Reporting it as `⏭ Skipped (dep)` would be wrong — that label means the predecessor `FAILED` and the
work is abandoned; this state means the work is queued and will auto-dispatch on merge, no manual
re-run required.

```bash
BLOCKED_ON_MERGE=()   # each entry: "NUM|GATING_PRED|GATING_PR|TITLE"

for NUM in {all_batch_issue_numbers}; do
  IS_BLOCKED=$(gh issue view "$NUM" -R {GH_REPO} --json labels \
    --jq '[.labels[].name | select(. == "blocked-on-human-merge")] | length' 2>/dev/null || echo "0")
  [ "$IS_BLOCKED" -gt 0 ] || continue

  TITLE=$(gh issue view "$NUM" -R {GH_REPO} --json title --jq '.title' 2>/dev/null || echo "")
  GATING_PRED=$(gh api repos/{GH_REPO}/issues/${NUM}/comments \
    --jq '[.[] | select(.body | contains("FORGE:BLOCKED_ON_HUMAN_MERGE"))] | last | (.body | capture("Gating predecessor\\*\\*: #(?<p>[0-9]+)").p) // ""' 2>/dev/null || echo "")
  GATING_PR=""
  if [ -n "$GATING_PRED" ]; then
    GATING_PR=$(gh pr list -R {GH_REPO} --state open --search "\"Closes #${GATING_PRED}\" in:body" \
      --json number --jq '.[0].number // empty' 2>/dev/null || echo "")
  fi

  BLOCKED_ON_MERGE+=("${NUM}|${GATING_PRED}|${GATING_PR}|${TITLE}")
done
# BLOCKED_ON_MERGE now holds one entry per dependent queued behind a human-gated predecessor
# (empty array if none). Feeds the "Blocked-on-Merge" report block and the Implementation
# Results table row (Step 6B).
```

### Step 6A.7: Determine idle-policy end state <!-- Added: forge#1814 -->

**Why**: `phase-4-execution.md` Step 4B item 6.7 can end the live monitoring loop in two visibly
different ways: a **clean/paused drain** (every original-batch issue reached `DONE`/`FAILED`, or
is `blocked-on-human-merge` with no cascade activity left to suppress), or an **idle-policy
pause** (`BATCH_FULLY_GATED` was true at the moment the batch stopped, meaning Step 4C actively
suppressed one or more newly-spawned review-finding dispatches). Both are legitimate stopping
points, but rendering an idle-policy pause under the same "Orchestration Complete" header as a
genuine full drain misrepresents a paused run as finished — the whole point of #1814 is to make
this pause visible, not silent.

```bash
# BATCH_FULLY_GATED is the value computed in phase-4-execution.md Step 4B item 6.7 at the point
# the live loop stopped — threaded into Phase 6 as a plain boolean, not recomputed here (Phase 6
# runs after the live loop has already ended, so re-running item 6.7's per-issue classification
# would be redundant; carry the value forward instead).
ORCHESTRATION_ENDED_IDLE="${BATCH_FULLY_GATED:-false}"

# Count of findings deferred this run for the idle-policy reason specifically (distinct from
# generation>=2 and comment/typo/P3-same-file deferrals, which are unaffected by this policy).
IDLE_POLICY_DEFERRED_COUNT=0
for FINDING_NUM in "${DEFERRED_FINDINGS[@]:-}"; do
  [ -z "$FINDING_NUM" ] && continue
  echo "${DEFERRED_REASONS[$FINDING_NUM]:-}" | grep -qi "batch fully human-gated" && \
    IDLE_POLICY_DEFERRED_COUNT=$((IDLE_POLICY_DEFERRED_COUNT + 1))
done
```

### Step 6B: Present consolidated report

```
{IF ORCHESTRATION_ENDED_IDLE == "true":}
## Orchestration Paused — Idle (waiting on {#MERGE_READY_PRS[@]:-0} + {#BLOCKED_ON_MERGE[@]:-0} merge(s))

This run stopped because the remaining batch is fully human-gated — every original issue is
merged/invalid, or blocked on a human decision/merge. {IDLE_POLICY_DEFERRED_COUNT} newly-spawned
review-finding issue(s) were deferred (not dispatched) rather than added to the open-issue count.
See "Merge-Ready" and "Blocked-on-Merge" below for the exact action needed to resume. Re-run
`/orchestrate` (or let a still-running session's live wake pick it up) once you've merged the
PR(s) listed there — deferred findings are re-evaluated automatically by the next Completion
Sweep (Step 4F.2.5) once the batch is no longer fully gated.
{ELSE:}
## Orchestration Complete
{END IF}

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
| #{F} | {title} | original | ⏸ Awaiting Merge | #{PR} | staging |
| #{E} | {title} | original | ⏭ Skipped (dep) | — | — |
| #{G} | {title} | original | 🔗 Blocked-on-Merge (gated by #{PRED}) | — | — |

`⏸ Awaiting Merge` (`workflow:awaiting-merge`) is structurally distinct from `⚠ Blocked`
(`needs-human`): a Blocked row means the pipeline hit something it cannot resolve on its own
and a human must diagnose it; an Awaiting Merge row means the PR was already remediated and
re-reviewed to a clean APPROVED verdict — a human only needs to click merge. Never render an
awaiting-merge PR as `⚠ Blocked`.

`🔗 Blocked-on-Merge` (`blocked-on-human-merge`, forge#1812) is distinct from all three of the
above: it is a *dependent* of a GATED predecessor (one currently `⚠ Blocked` or `⏸ Awaiting
Merge`) — the dependent issue itself was never dispatched and has no problem of its own. It is
also distinct from `⏭ Skipped (dep)`, which means the predecessor `FAILED` outright and the work
was abandoned. A Blocked-on-Merge row means the work is queued and will auto-dispatch the instant
the gating predecessor's PR merges — no manual `/orchestrate` re-run required. Never render a
blocked-on-human-merge dependent as `⏭ Skipped (dep)`.

{IF `MERGE_READY_PRS` (Step 6A.5) is non-empty:}

### Merge-Ready — {N} PR(s) awaiting only a human merge

These PRs were remediated and re-reviewed to a clean `APPROVED` verdict after an earlier
`needs-human` escalation. They do not need further diagnosis — merge them to land the batch.

| # | Issue | PR | Title |
|---|-------|----|----|
{one row per `MERGE_READY_PRS` entry: | {n} | #{NUM} | #{PR} | {title} |}

**One action to land all {N}:** `{MERGE_READY_CMD}`

(`{MERGE_READY_CMD}` is pre-built in Step 6A.5 by chaining one `gh pr merge <pr> --merge` per PR
in `MERGE_READY_PRS` with `&&` — `gh pr merge` takes a single PR selector, so a space-separated
list would be rejected. Render it verbatim here as plain text, no code fence.)

{ELSE: omit this section entirely — do not print an empty "Merge-Ready" heading.}

{IF `BLOCKED_ON_MERGE` (Step 6A.6) is non-empty:}

### Blocked-on-Merge — {N} issue(s) queued behind a human-gated predecessor

These issues are dependents of a predecessor that is currently `⚠ Blocked` or `⏸ Awaiting Merge`.
They were never dispatched — no work has started on them — and they need no action right now.
Each will auto-dispatch the instant its gating predecessor's PR merges (live-session wake via
`phase-4-execution.md` Step 4B item 6.6, or next-`/orchestrate`-invocation wake via
`phase-3-dependency.md`'s wake/compaction reconstruction). This batch is a **paused drain**, not
a complete one — re-running `/orchestrate` after merging the gating PR(s) below will pick these up.

| # | Issue | Gated By | Gating PR | Title |
|---|-------|----------|-----------|-------|
{one row per `BLOCKED_ON_MERGE` entry: | {n} | #{NUM} | #{GATING_PRED} | #{GATING_PR} | {title} |}

**To unblock**: merge the gating PR(s) referenced above, then re-run `/orchestrate` (or let the
current session's live wake pick them up automatically if it is still running).

{ELSE: omit this section entirely — do not print an empty "Blocked-on-Merge" heading.}

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
- **Review findings**: {N} spawned, {M} resolved in-batch, {K} swept, {J} deferred (cosmetic), {L} deferred (gen2), {IDLE_POLICY_DEFERRED_COUNT} deferred (idle policy, forge#1814)
- **Succeeded**: {N} issues resolved (implementation + sweep)
- **Failed**: {N} issues need attention
- **Merge-ready**: {#MERGE_READY_PRS[@]:-0} PRs awaiting only a human merge (see "Merge-Ready" section above)
- **Blocked-on-merge**: {#BLOCKED_ON_MERGE[@]:-0} issues queued behind a human-gated predecessor, will auto-dispatch on merge (see "Blocked-on-Merge" section above)
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
| Findings deferred — idle policy (forge#1814) | {IDLE_POLICY_DEFERRED_COUNT} (batch fully human-gated at defer time — see Step 4B item 6.7) |
| Competing recommendations reconciled (Phase 2.5) | {RECONCILED_COUNT} (investigation plans arbitrated in place + serialized) |
| Findings validated | {N} |
| False positives | {N} ({%}) |
| Anomalies flagged | {N} |
| Budget limit | ${BUDGET_LIMIT:-uncapped} |
| Projected spend (dispatched issues) | ${PROJECTED_SPEND:-—} |
| Actual spend (best-effort telemetry) | ${ACTUAL_SPEND:-—} |
| Issues deferred (budget ceiling) | {#DEFERRED_BUDGET_ISSUES[@]:-0} |
| ε-reserve issued (no-prior dispatch) | {EPSILON_DISPATCHED:-no} |
| **Value-weighted throughput** | **{VALUE_THROUGHPUT:-—} value-pts/USD** |

`value-weighted throughput` = Σ(priority_weight × danger_zone_weight) for **merged** issues ÷ actual spend (USD). A higher value means more high-priority issues were resolved per dollar. Trend this across runs via `/pipeline-health` to measure the economic scheduling ROI. <!-- Added: forge#1743 -->

**Compute value-weighted throughput** (populate before rendering the table):

```bash
# Collect value scores for merged issues (ISSUE_VALUE[] populated in Step 3E.5)
MERGED_VALUE_SUM="0"
for NUM in {all_completed_issue_numbers}; do
  IS_MERGED=$(gh issue view "$NUM" -R {GH_REPO} --json labels \
    --jq '[.labels[].name | select(. == "workflow:merged")] | length' 2>/dev/null || echo "0")
  if [ "$IS_MERGED" -gt 0 ] && [ -n "${ISSUE_VALUE[$NUM]:-}" ]; then
    MERGED_VALUE_SUM=$(echo "scale=4; $MERGED_VALUE_SUM + ${ISSUE_VALUE[$NUM]}" | bc 2>/dev/null \
      || echo "$MERGED_VALUE_SUM")
  fi
done

if [ "${ACTUAL_SPEND:-0}" != "0" ] && echo "${ACTUAL_SPEND:-0}" | grep -qP '^\d+(\.\d+)?$'; then
  VALUE_THROUGHPUT=$(echo "scale=2; $MERGED_VALUE_SUM / $ACTUAL_SPEND" | bc 2>/dev/null || echo "—")
else
  VALUE_THROUGHPUT="—"  # no spend telemetry available
fi
```

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
- **Value-weighted throughput trending down** → high-value issues deferred or blocked; check Step 3E.5 score distribution

### Next Steps
{If ORCHESTRATION_ENDED_IDLE == "true": "This run paused on the human-gated idle policy (forge#1814) — merge the PR(s) listed in the Merge-Ready section above, then re-run `/orchestrate` (or let a still-running session's live wake pick it up automatically) to resume dispatch of blocked-on-merge dependents and re-evaluate the {IDLE_POLICY_DEFERRED_COUNT} deferred finding(s)."}
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

