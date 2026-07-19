---
description: Post the pipeline summary card, trajectory log, and Graph Decision Record — Phase 7 of the /work-on pipeline
argument-hint: "[issue number] [--repo {owner}/{repo}] [--gh-flag \"-R {owner}/{repo}\"] [--pr {number}] [--base {branch}]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/phase-7-trajectory — Summary & Trajectory

**Input**: $ARGUMENTS

Phase 7 (final phase) of the `/work-on` pipeline: renders the shareable Pipeline Summary
Card, posts the `FORGE:TRAJECTORY` phase-by-phase results table, and posts the
`FORGE:DECISION_RECORD` (Graph Decision Record) provenance artifact to the PR. Runs after
Phase 6 (Close & Cleanup) closes the issue. Also documents error-handling recovery guidance
used throughout the pipeline.

**Agent model policy**: see `work-on.md` section "Model and Effort Tiering — What Actually
Applies" (`FORGE:MODEL_TIER_NOTE`) — this file's steps are mechanical (stats gathering,
comment posting) end-to-end, a legitimate `effort: low` candidate; `model` overrides are
non-functional for `Skill()`-dispatched sub-phases per that note.
Plan mode: see `commands/shared/agent-policies.md` § Plan mode ban if not already in context.

<!-- FORGE:SPEC_LOADED — work-on/phase-7-trajectory.md loaded and active. -->

## Phase 7: Summary & Trajectory

### 7A: Report + Pipeline Summary Card

Output the terse report, then render the shareable **Pipeline Summary Card** — the shareable
moment a developer screenshots. Gather real stats (commits, additions/deletions, PR target,
review summary, elapsed time) and render exactly as specified in `work-on/close.md` Phase C4.5
(`C4.5a` stats gathering → `C4.5b` box-drawing card to stdout → `C4.5c` machine-readable twin).
This inline path and the delegated `close.md` path MUST produce an identical card.

```
## Done: #{NUMBER} — {TITLE}
- Investigation: {VERDICT} ({CONFIDENCE})
- Lane: {FAST/FEATURE}
- Fix: {BRANCH} → PR #{PR_NUMBER} → merged to `{PR_BASE}`
- Files changed: {COUNT}
```

Then print the card to stdout (inner width 51; truncate long titles with `…`; missing stats
render `—`; pipeline line reflects the actual terminal state — merged / decomposed / invalid /
blocked; draft PRs append `(draft)`):

```
╔═══════════════════════════════════════════════════╗
║  ForgeDock Pipeline Complete                      ║
╠═══════════════════════════════════════════════════╣
║                                                   ║
║  Issue:    #{NUMBER} — {TITLE}                    ║
║  Pipeline: investigate → architect → build →      ║
║            review → merge ✓                       ║
║  Commits:  {COMMITS} ({ADDITIONS} additions, {DELETIONS} deletions) ║
║  PR:       #{PR_NUMBER} (merged to {PR_BASE})     ║
║  Review:   {REVIEW_SUMMARY}                       ║
║  Time:     {ELAPSED}                              ║
║                                                   ║
╚═══════════════════════════════════════════════════╝
```

**Gather real stats** (C4.5a — this block MUST run on the inline path to populate card variables;
do NOT rely on the cross-reference to `close.md` alone):

```bash
PR_STATS=$(gh pr view {PR_NUMBER} {GH_FLAG} --json commits,additions,deletions,baseRefName,isDraft 2>/dev/null)
COMMITS=$(echo "$PR_STATS"   | jq -r '(.commits | length) // empty' 2>/dev/null); COMMITS=${COMMITS:-—}
ADDITIONS=$(echo "$PR_STATS" | jq -r '.additions // empty' 2>/dev/null); ADDITIONS=${ADDITIONS:-—}
DELETIONS=$(echo "$PR_STATS" | jq -r '.deletions // empty' 2>/dev/null); DELETIONS=${DELETIONS:-—}
PR_TARGET=$(echo "$PR_STATS" | jq -r '.baseRefName // empty' 2>/dev/null); PR_TARGET=${PR_TARGET:-{PR_BASE}}
IS_DRAFT=$(echo "$PR_STATS"  | jq -r '.isDraft // false' 2>/dev/null)

REVIEW_BODIES=$(gh pr view {PR_NUMBER} {GH_FLAG} --json reviews,comments \
  --jq '[.reviews[].body // ""] + [.comments[].body // ""] | .[]' 2>/dev/null)
# NOTE: `grep -c` already prints `0` on no match (and exits non-zero) — do NOT add
# `|| echo 0`, which would append a second line ("0\n0") and break the arithmetic
# and `--argjson` below. Swallow the non-zero exit with `|| true`, then default.
APPROVED=$(echo "$REVIEW_BODIES" | grep -cE 'APPROVED:' 2>/dev/null || true); APPROVED=${APPROVED:-0}
CHANGES=$(echo  "$REVIEW_BODIES" | grep -cE 'CHANGES REQUESTED:' 2>/dev/null || true); CHANGES=${CHANGES:-0}
TOTAL_AGENTS=$((APPROVED + CHANGES))
BLOCKERS=$(echo "$REVIEW_BODIES" | grep -ciE 'blocker|merge.?block' 2>/dev/null || true); BLOCKERS=${BLOCKERS:-0}
if [ "$TOTAL_AGENTS" -gt 0 ]; then
  REVIEW_SUMMARY="${APPROVED}/${TOTAL_AGENTS} agents passed, ${BLOCKERS} blockers"
else
  REVIEW_SUMMARY="—"   # review data unavailable (e.g. review skipped)
fi

FIRST_TS=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:")) | .created_at] | sort | .[0] // empty' 2>/dev/null)
if [ -n "$FIRST_TS" ]; then
  START_EPOCH=$(date -u -d "$FIRST_TS" +%s 2>/dev/null \
    || python3 -c "import sys,datetime; ts=sys.argv[1].rstrip('Z'); print(int(datetime.datetime.fromisoformat(ts+'+00:00').timestamp()))" "$FIRST_TS" 2>/dev/null \
    || echo "")
  NOW_EPOCH=$(date -u +%s)
  if [ -n "$START_EPOCH" ]; then
    ELAPSED_SECS=$((NOW_EPOCH - START_EPOCH))
    ELAPSED=$(printf '%dm %02ds' $((ELAPSED_SECS / 60)) $((ELAPSED_SECS % 60)))
  else ELAPSED="—"; ELAPSED_SECS=0; fi
else ELAPSED="—"; ELAPSED_SECS=0; fi

case "{TERMINAL_STATE}" in
  decomposed) PIPELINE_LINE="investigate → decompose ⏹"; CARD_STATUS="decomposed" ;;
  invalid)    PIPELINE_LINE="investigate → invalid ✗";   CARD_STATUS="invalid" ;;
  blocked)    PIPELINE_LINE="investigate → build → blocked ⚠"; CARD_STATUS="blocked" ;;
  *)          PIPELINE_LINE="investigate → architect → build → review → merge ✓"; CARD_STATUS="merged" ;;
esac
[ "$IS_DRAFT" = "true" ] && PIPELINE_LINE="${PIPELINE_LINE} (draft)"
```

**Build the machine-readable twin** (C4.5c — MUST run this block to assign `CARD_JSON` before
Phase 7B embeds it; the cross-reference to `close.md` above is insufficient on the inline path): <!-- forge#1178 -->

```bash
CARD_JSON=$(jq -nc \
  --argjson issue {NUMBER} \
  --arg title "{TITLE}" \
  --arg status "$CARD_STATUS" \
  --arg pipeline "$PIPELINE_LINE" \
  --arg pr "{PR_NUMBER}" \
  --arg target "$PR_TARGET" \
  --arg commits "$COMMITS" --arg adds "$ADDITIONS" --arg dels "$DELETIONS" \
  --arg review "$REVIEW_SUMMARY" --argjson blockers "${BLOCKERS:-0}" \
  --argjson elapsed "${ELAPSED_SECS:-0}" \
  '{issue:$issue, title:$title, status:$status, pipeline:$pipeline,
    pr:($pr|tonumber? // null), pr_target:$target,
    commits:($commits|tonumber? // null),
    additions:($adds|tonumber? // null),
    deletions:($dels|tonumber? // null),
    review:$review, blockers:$blockers, elapsed_seconds:$elapsed}')
```

`CARD_JSON` is now set and embedded in the trajectory comment by 7B.

### 7B: Trajectory Log (MANDATORY)

**Review-presence check** (run before filling in Phase 4-5 row): <!-- Added: forge#381 -->
```bash
# Check whether /review-pr was actually invoked — look for review agent comments on the PR
REVIEW_PRESENT=$(gh pr view {PR_NUMBER} {GH_FLAG} --json reviews,comments \
  --jq '([.reviews[].body // ""] + [.comments[].body // ""]) |
        map(select(test("APPROVED:|CHANGES REQUESTED:|FORGE:REVIEWER|review-pr";"i"))) |
        length > 0')
# Set Phase 4-5 row: ✅ Merged if review present, ⚠ Skipped (no review) if not
REVIEW_ROW=$([ "$REVIEW_PRESENT" = "true" ] && echo "✅ Merged" || echo "⚠ Skipped (no review)")
```

This check is **audit-only** — it annotates the trajectory for visibility. It cannot retroactively block a merged PR. If `⚠ Skipped (no review)` is emitted, log it in the Anomalies field so the skip is surfaced during pipeline health review.

Post `<!-- FORGE:TRAJECTORY -->` comment with phase-by-phase results table:

```bash
# Not DRY_RUN-gated — the trajectory log is the unconditional final artifact
# of every /work-on run, matching sibling phase files.
# Compute verification row from VERIFICATION_SKIPPED_CHECKS (set in Phase 3H)
if [ -z "$VERIFICATION_SKIPPED_CHECKS" ]; then
  VERIFICATION_ROW="✅ Ran"
else
  VERIFICATION_ROW="⚠ Skipped — verification.commands not configured for: ${VERIFICATION_SKIPPED_CHECKS}"
fi

gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:TRAJECTORY -->
## Pipeline Trajectory — #{NUMBER}

| Phase | Result | Notes |
|-------|--------|-------|
| Phase 0: Context Load | ✅ Complete | {lane} → \`{PR_BASE}\` |
| Phase 1: Investigation | ✅ {VERDICT} ({CONFIDENCE}) | Task type: {TASK_TYPE} |
| Phase 2: Decomposition | ⏭ Skipped | {reason} |
| Phase 3: Build | ✅ Complete | Branch: \`{BRANCH}\` |
| Phase 3G: Quality Gate | ✅ Gate passed | {iterations} iterations |
| Phase 3H: Verification | ${VERIFICATION_ROW} | |
| Phase 4–5: Review + PR | {REVIEW_ROW} | PR #{PR_NUMBER} → \`{PR_BASE}\` |
| Phase 6: Close | ✅ Complete | Issue closed |

**Decisions**: {key decisions}
**Anomalies**: {anomalies or None}
**Pipeline completed**: {TIMESTAMP}

<!-- FORGE:CARD ${CARD_JSON} -->"
```

Append the `<!-- FORGE:CARD {...} -->` block (machine-readable twin from 7A / close.md C4.5c)
as the last line of the trajectory comment. It is HTML-comment-wrapped so it stays hidden in
the rendered view but greppable for platform consumption (`/orchestrate` Phase 6 reads it for
per-issue cards). Additive — does not affect existing `FORGE:TRAJECTORY` table consumers.

### 7C: Graph Decision Record (MANDATORY when PR exists)

**Skip if**: `{PR_NUMBER}` is empty (investigation-only tasks with no PR) OR `<!-- FORGE:DECISION_RECORD -->` already posted on the PR.

**Purpose**: Post a single consolidated provenance artifact to the PR that proves the merge was backed by citable evidence. Enables downstream benchmarking queries (repeated-mistake rate, stale-edge hit rate, review escape rate) by making every pipeline run queryable via `gh api`.

**Idempotency check**:
```bash
GDR_EXISTS=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:DECISION_RECORD"))] | length > 0' 2>/dev/null || echo "false")
```

**Extract context edge counts** from FORGE:CONTEXT comment (already posted on issue):
```bash
CONTEXT_COMMENT=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTEXT")) | .body' 2>/dev/null | head -1)

# Count historical review-finding issue references (#NNN patterns in Context comment)
REVIEW_FINDING_COUNT=$(echo "$CONTEXT_COMMENT" | grep -oE '#[0-9]+' | wc -l | tr -d ' ')
REVIEW_FINDING_COUNT=${REVIEW_FINDING_COUNT:-0}
```

**Extract review verdict and findings count** from PR review summary (Phase 9 of review-pr):
```bash
REVIEW_SUMMARY=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:REVIEWER") or (.body | test("APPROVED:|CHANGES REQUESTED:"; "i")))] | last | .body // ""' 2>/dev/null || echo '')

REVIEW_VERDICT=$(echo "$REVIEW_SUMMARY" | sed -n 's/.*Verdict: \(APPROVED\|CHANGES REQUESTED\).*/\1/p' | head -1 || echo "APPROVED")
REVIEW_VERDICT="${REVIEW_VERDICT:-APPROVED}"
FINDINGS_COUNT=$(echo "$REVIEW_SUMMARY" | grep -oE '[0-9]+ findings' | grep -oE '[0-9]+' | head -1 || echo "0")
FINDINGS_COUNT="${FINDINGS_COUNT:-0}"
AGENTS_RUN=$(echo "$REVIEW_SUMMARY" | grep -oE '[0-9]+ agents' | grep -oE '[0-9]+' | head -1 || echo "0")
AGENTS_RUN="${AGENTS_RUN:-0}"
```

**Capture best-effort cost signal** from session telemetry before posting GDR. This is best-effort — if the signal is unavailable, the cost block is omitted rather than blocking the pipeline or fabricating a number. Field names align with `bin/runner.mjs` usage accounting from #1295 so downstream tooling shares one schema:
```bash
# Best-effort: read per-stage usage from FORGE:BUILDER/FORGE:CONTEXT/FORGE:ARCHITECT phase annotations
# Source: session telemetry when available (e.g. OTEL_LOG_TOOL_DETAILS, Claude Code usage reporting).
# If unavailable, set COST_BLOCK to null — the field is omitted from the GDR rather than fabricated.
COST_INVESTIGATION=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body] | last // ""' 2>/dev/null \
  | grep -oP '(?<=cost_usd: )\S+' | head -1 || echo "")  # <!-- allowlist: relocated verbatim from work-on.md, forge#2676; portability tracked under forge#1608 -->
COST_BUILD=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:BUILDER")) | .body] | last // ""' 2>/dev/null \
  | grep -oP '(?<=cost_usd: )\S+' | head -1 || echo "")  # <!-- allowlist: relocated verbatim from work-on.md, forge#2676; portability tracked under forge#1608 -->
COST_REVIEW=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:REVIEWER")) | .body] | last // ""' 2>/dev/null \
  | grep -oP '(?<=cost_usd: )\S+' | head -1 || echo "")  # <!-- allowlist: relocated verbatim from work-on.md, forge#2676; portability tracked under forge#1608 -->

# Build cost block JSON only if at least one stage value is present; otherwise null
if [ -n "$COST_INVESTIGATION" ] || [ -n "$COST_BUILD" ] || [ -n "$COST_REVIEW" ]; then
  COST_INV_JSON="${COST_INVESTIGATION:-null}"
  COST_BUILD_JSON="${COST_BUILD:-null}"
  COST_REVIEW_JSON="${COST_REVIEW:-null}"
  COST_BLOCK="\"cost\": {
    \"stages\": {
      \"investigation\": $COST_INV_JSON,
      \"build\": $COST_BUILD_JSON,
      \"review\": $COST_REVIEW_JSON
    },
    \"total_usd\": null,
    \"source\": \"session-telemetry\"
  },"
else
  COST_BLOCK=""
fi
```

**Post GDR to PR** (not to issue — PR comment survives as permanent artifact on the merged diff):
```bash
if [ "$GDR_EXISTS" != "true" ] && [ -n "{PR_NUMBER}" ]; then
  GDR_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  HEAD_SHA=$(gh pr view {PR_NUMBER} {GH_FLAG} --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")
  MERGE_COMMIT=$(gh pr view {PR_NUMBER} {GH_FLAG} --json mergeCommit --jq '.mergeCommit.oid // ""' 2>/dev/null || echo "")

  gh pr comment {PR_NUMBER} {GH_FLAG} --body "<!-- FORGE:DECISION_RECORD -->
## Graph Decision Record — Issue #${NUMBER} / PR #${PR_NUMBER}

\`\`\`json
{
  \"schema_version\": \"1\",
  \"issue\": ${NUMBER},
  \"pr\": ${PR_NUMBER},
  \"repo\": \"{GH_REPO}\",
  \"lane\": \"{lane}\",
  \"pr_base\": \"{PR_BASE}\",
  \"branch\": \"{BRANCH}\",
  \"head_sha\": \"${HEAD_SHA}\",
  \"merge_commit\": \"${MERGE_COMMIT}\",
  \"investigation\": {
    \"verdict\": \"{VERDICT}\",
    \"confidence\": \"{CONFIDENCE}\",
    \"task_type\": \"{TASK_TYPE}\"
  },
  ${COST_BLOCK}
  \"context\": {
    \"historical_edges_referenced\": ${REVIEW_FINDING_COUNT},
    \"forge_annotations_read\": [\"FORGE:INVESTIGATOR\", \"FORGE:CONTRACT\", \"FORGE:CONTEXT\", \"FORGE:ARCHITECT\", \"FORGE:BUILDER\"]
  },
  \"build\": {
    \"files_changed\": {FILES_CHANGED},
    \"quality_gate\": \"{pass|fail}\",
    \"quality_gate_iterations\": {GATE_ITERATIONS}
  },
  \"review\": {
    \"verdict\": \"${REVIEW_VERDICT:-APPROVED}\",
    \"findings_created\": ${FINDINGS_COUNT},
    \"agents_run\": ${AGENTS_RUN}
  },
  \"merge\": {
    \"merged_at\": \"${GDR_TIMESTAMP}\",
    \"justification\": \"Investigation confirmed ({VERDICT}/{CONFIDENCE}), quality gate passed, review ${REVIEW_VERDICT:-approved}\"
  }
}
\`\`\`

**Queryable**: \`gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments --jq '[.[] | select(.body | contains(\"FORGE:DECISION_RECORD\"))] | .[0].body\`"
fi
```

**Benchmarking**: Query all GDRs for a repo to compute pipeline metrics:
```bash
# Fetch all merged PRs and extract their GDR JSON blocks for metric computation
# (used by /pipeline-health to measure repeated-mistake rate, stale-edge hit rate, etc.)
gh pr list -R {GH_REPO} --state merged --limit 100 --json number \
  --jq '.[].number' | while read pr; do
    gh api repos/{GH_REPO}/issues/$pr/comments \
      --jq '.[] | select(.body | contains("FORGE:DECISION_RECORD")) | .body' 2>/dev/null
  done
```

<!-- Added: forge#776 -->

---

## Error Handling

- Worktree exists: reuse or clean up
- PR creation fails: check if branch pushed, if PR already exists
- Merge conflicts: report to user, do NOT auto-resolve
- gh CLI fails: check `gh auth status`
- Label missing: run `npx forgedock labels setup` (from the project directory, or pass `--repo owner/repo`) to idempotently bootstrap all ForgeDock-managed labels with canonical colors and descriptions. Alternatively: `gh label create "{name}" --color {hex} --description "Managed by ForgeDock." --force -R {GH_REPO}`
