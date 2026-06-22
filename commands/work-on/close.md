---
description: Close subcommand — update project board, final issue body, parent tracker, summary report, trajectory log
argument-hint: [issue number] [--repo GH_REPO] [--gh-flag GH_FLAG] [--pr PR_NUMBER] [--base PR_BASE] [--branch BRANCH] [--worktree WORKTREE_PATH]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/close — Close & Trajectory Subcommand

**Input**: $ARGUMENTS

**Invoked by**: `work-on.md` Phase 6–7, after `review.md` returns `REVIEW_RESULT: status: COMPLETE`.
**Output**: Update project board, close issue, update parent tracker, post trajectory log. Return final summary.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.
**NEVER use plan mode (EnterPlanMode).**

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--pr {PR_NUMBER}` — merged PR number
- `--base {PR_BASE}` — branch the PR merged into (e.g. `milestone/modular-pipeline-architecture`)
- `--branch {BRANCH}` — feature branch name (for worktree cleanup reference)
- `--worktree {WORKTREE_PATH}` — absolute path to the git worktree to remove (optional — skip cleanup if not provided)

---

## Phase C0: Load State from GitHub (MANDATORY)

Re-read current state before doing anything:

```bash
# Issue full context
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,milestone

# PR state
gh pr view {PR_NUMBER} {GH_FLAG} --json state,mergedAt,mergeCommit

# All agent comments (to reconstruct pipeline results)
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | {body: .body, created_at: .created_at}'
```

Extract from agent comments:
- From FORGE:INVESTIGATOR: verdict, confidence, task type
- From FORGE:BUILDER: branch, commits, files changed
- From FORGE:TRAJECTORY (if exists): prior trajectory entries

**Resume check**:
- If `<!-- FORGE:TRAJECTORY -->` comment already exists → trajectory already posted, EXIT with `CLOSE_RESULT: status: ALREADY_DONE`
- If issue is already CLOSED and PR is MERGED → skip to C3 (just post trajectory if missing)

---

## Phase C1: Final Issue Body Update

**Multi-phase guard**: Before checking off items, detect whether the issue has multiple phases. Only check off items belonging to the current completed phase — not all remaining items across future phases.

```bash
# Read current body
BODY=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body')

# Count remaining unchecked items BEFORE any edit
REMAINING_BEFORE=$(echo "$BODY" | grep -c '^- \[ \]' || true)
```

**If `REMAINING_BEFORE == 0`** (no unchecked items): skip body edit — all items already checked, proceed to add PR reference only:
```bash
UPDATED_BODY="${BODY}"$'\n\n'"**PR**: #{PR_NUMBER} → merged to \`{PR_BASE}\`"
gh issue edit {NUMBER} {GH_FLAG} --body "{UPDATED_BODY}"
REMAINING_AFTER=0
```

**If `REMAINING_BEFORE > 0`**: check whether ANY `- [ ]` items will still remain after a full check-off — i.e., does the issue have multi-phase structure?

Multi-phase issues have checkbox groups separated by phase headings (lines starting with `##` or `###`) where at least one group has unchecked items. Detect this:
```bash
# Conservative heuristic: if the issue body contains a phase heading (## or ###)
# AND unchecked items remain, treat as multi-phase — do NOT check off items from
# future phases; only add the PR reference and leave unchecked items intact.
HAS_PHASE_HEADINGS=$(echo "$BODY" | grep -cP '^#{2,3} ' || true)

if [ "$HAS_PHASE_HEADINGS" -gt 0 ]; then
  # Multi-phase issue: do NOT check off any [ ] items
  # Only add the PR reference so progress is recorded
  UPDATED_BODY="${BODY}"$'\n\n'"**PR**: #{PR_NUMBER} → merged to \`{PR_BASE}\` (phase complete — remaining phases open)"
  gh issue edit {NUMBER} {GH_FLAG} --body "{UPDATED_BODY}"
  REMAINING_AFTER="$REMAINING_BEFORE"
else
  # Single-phase issue: check off all remaining [ ] items
  UPDATED_BODY=$(echo "$BODY" | sed 's/^- \[ \]/- [x]/g')
  UPDATED_BODY="${UPDATED_BODY}"$'\n\n'"**PR**: #{PR_NUMBER} → merged to \`{PR_BASE}\`"
  gh issue edit {NUMBER} {GH_FLAG} --body "{UPDATED_BODY}"
  REMAINING_AFTER=0
fi
```

The `REMAINING_AFTER` variable is passed to Phase C2 to decide whether to close.

---

## Phase C1.5: Project Board Update (Status=Done, Workflow=Merged)

Update the project board to reflect the merged state. This replaces the old Phase 5E project board update that existed before the modular refactor.

**Read project board config from `forge.yaml`**. If the `project_board` section is absent or commented out, skip this phase entirely:

```bash
# Read project board config from forge.yaml
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
PROJECT_BOARD_OWNER=$(yq '.project_board.owner // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
PROJECT_ID=$(yq '.project_board.project_id // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
PROJECT_NUMBER=$(yq '.project_board.project_number // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
STATUS_FIELD_ID=$(yq '.project_board.field_ids.status // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
WORKFLOW_FIELD_ID=$(yq '.project_board.field_ids.workflow // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
STATUS_DONE_OPTION_ID=$(yq '.project_board.option_ids.status.done // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
WORKFLOW_MERGED_OPTION_ID=$(yq '.project_board.option_ids.workflow.merged // ""' "$CONFIG_FILE" 2>/dev/null || echo "")

if [ -z "$PROJECT_BOARD_OWNER" ] || [ -z "$PROJECT_ID" ] || [ -z "$STATUS_FIELD_ID" ]; then
  echo "INFO: project_board not configured in forge.yaml — skipping board update"
  # → STOP: do not proceed to ITEM_ID fetch or board update — continue to Phase C2
else
  # Project board is configured — find the item and update it

  # Find the project item ID for this issue
  ISSUE_URL="https://github.com/{GH_REPO}/issues/{NUMBER}"
  ITEM_ID=$(gh project item-list "$PROJECT_NUMBER" --owner "$PROJECT_BOARD_OWNER" --format json --limit 200 \
    --jq ".items[] | select(.content.url == \"$ISSUE_URL\") | .id" 2>/dev/null | head -1)

  if [ -n "$ITEM_ID" ]; then
    # Set Status=Done
    if [ -n "$STATUS_FIELD_ID" ] && [ -n "$STATUS_DONE_OPTION_ID" ]; then
      gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
        --field-id "$STATUS_FIELD_ID" --single-select-option-id "$STATUS_DONE_OPTION_ID" 2>/dev/null || true
    fi

    # Set Workflow=Merged
    if [ -n "$WORKFLOW_FIELD_ID" ] && [ -n "$WORKFLOW_MERGED_OPTION_ID" ]; then
      gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
        --field-id "$WORKFLOW_FIELD_ID" --single-select-option-id "$WORKFLOW_MERGED_OPTION_ID" 2>/dev/null || true
    fi
  else
    echo "INFO: Issue #{NUMBER} not found on project board — skipping board update"
  fi
fi
```

**Project board field IDs are read from `forge.yaml → project_board`**. To configure:
```yaml
project_board:
  owner: "{your-github-org}"
  project_number: 1
  project_id: "PVT_kwHO..."
  field_ids:
    status: "PVTSSF_..."
    workflow: "PVTSSF_..."
  option_ids:
    status:
      done: "..."
    workflow:
      merged: "..."
```
To find your project IDs: `gh project list --owner {owner}` and `gh project field-list {number} --owner {owner}`.

---

## Phase C2: Ensure Issue is Closed

**Multi-phase guard**: If `REMAINING_AFTER > 0` (set in Phase C1), uncompleted phases remain — do NOT close the issue. Instead, post a phase-complete comment and exit early so the router can pick up the next phase on the next pipeline iteration.

```bash
ISSUE_STATE=$(gh issue view {NUMBER} {GH_FLAG} --json state --jq '.state')
```

**If `REMAINING_AFTER > 0`** (multi-phase: uncompleted phases remain):
```bash
# Post phase-complete marker — router state 10 (MULTI_PHASE) will re-detect this issue
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:PHASE:COMPLETE -->
Phase complete. PR #{PR_NUMBER} merged to \`{PR_BASE}\`. ${REMAINING_AFTER} phase item(s) remain — leaving issue open for next pipeline iteration."

# Update labels to reflect phase complete (not yet fully merged)
gh issue edit {NUMBER} {GH_FLAG} \
  --remove-label "workflow:in-review,workflow:building,workflow:investigating" 2>/dev/null || true

# EXIT — do not close, do not post trajectory, do not run C3–C6
# Return CLOSE_RESULT: status: PHASE_COMPLETE to caller
exit 0
```

**If `REMAINING_AFTER == 0`** (all phases complete — single-phase or final phase of multi-phase):

If state is `OPEN`:
```bash
gh issue close {NUMBER} {GH_FLAG} \
  --comment "Closed: PR #{PR_NUMBER} merged to \`{PR_BASE}\`. Closes #{NUMBER}."
```

Add merged label:
```bash
gh issue edit {NUMBER} {GH_FLAG} \
  --add-label "workflow:merged" \
  --remove-label "workflow:in-review,workflow:building,workflow:investigating" 2>/dev/null || true
```

---

## Phase C3: Parent Tracker Update (Sub-Issues Only)

**Skip if**: Issue body does NOT contain a parent issue reference (e.g. `Part of #NNN`) or the issue has no parent in its milestone tracker.

Detect parent reference:
```bash
PARENT_REF=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body' \
  | grep -oP '(?i)(part of|spawned from|sub-issue of|parent issue[:]?|parent[:])\s*#\K\d+' \
  | head -1)
```

If no parent reference found → log a warning and skip this phase:
```bash
echo "WARNING: No parent reference found in issue body — skipping parent tracker update"
```

If parent found:
```bash
# Read parent body
PARENT_BODY=$(gh issue view {PARENT_REF} {GH_FLAG} --json body --jq '.body')

# Check off this sub-issue in parent body (replace "- [ ] #{NUMBER}" with "- [x] #{NUMBER}")
UPDATED_PARENT=$(echo "$PARENT_BODY" | sed "s/- \[ \] #${NUMBER}/- [x] #${NUMBER}/g")
gh issue edit {PARENT_REF} {GH_FLAG} --body "$UPDATED_PARENT"

# Check if all sub-issues are now closed
OPEN_SUBS=$(echo "$UPDATED_PARENT" | grep -c '\- \[ \]' || true)
```

If `OPEN_SUBS == 0` (all sub-issues checked off):
```bash
gh issue close {PARENT_REF} {GH_FLAG} \
  --comment "All sub-issues complete. Closing parent tracker. Last completed: #{NUMBER} (PR #{PR_NUMBER})."
gh issue edit {PARENT_REF} {GH_FLAG} --add-label "workflow:merged"
```

---

## Phase C4: Summary Report

Reconstruct the pipeline summary from GitHub state:

```bash
# Get investigation verdict from FORGE:INVESTIGATOR comment
VERDICT=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' \
  | grep -oP '(?<=\*\*Verdict\*\*: )\w+' | head -1)

CONFIDENCE=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' \
  | grep -oP '(?<=\*\*Confidence\*\*: )\w+' | head -1)

# Get files changed from FORGE:BUILDER comment
FILES_CHANGED=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:BUILDER")) | .body' \
  | grep -oP '(?<=\*\*Files changed\*\*: )\d+' | head -1)
```

Output to stdout (returned to calling agent):

```
## Done: #{NUMBER} — {TITLE}
- Investigation: {VERDICT} ({CONFIDENCE})
- Lane: FEATURE
- Fix: {BRANCH} → PR #{PR_NUMBER} → merged to `{PR_BASE}`
- Files changed: {FILES_CHANGED}
```

---

## Phase C4.5: Shareable Pipeline Summary

Generate a comprehensive, stakeholder-readable pipeline run report and post it as a `<!-- FORGE:SUMMARY -->` comment on the issue. Optionally write a local markdown file.

**Skip if**: `<!-- FORGE:SUMMARY -->` already exists on the issue (idempotency guard).

### Idempotency check
```bash
SUMMARY_EXISTS=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:SUMMARY"))] | length > 0' 2>/dev/null || echo "false")

if [ "$SUMMARY_EXISTS" = "true" ]; then
  echo "INFO: FORGE:SUMMARY already exists on issue #{NUMBER} — skipping Phase C4.5"
  # → proceed to Phase C5
fi
```

### Extract pipeline data from FORGE annotations

All data is reconstructed from comments already posted during the pipeline run:

```bash
# Issue metadata
ISSUE_TITLE=$(gh issue view {NUMBER} {GH_FLAG} --json title --jq '.title' 2>/dev/null || echo "")
ISSUE_MILESTONE=$(gh issue view {NUMBER} {GH_FLAG} --json milestone --jq '.milestone.title // "none"' 2>/dev/null || echo "none")

# From FORGE:INVESTIGATOR
INVESTIGATOR_BODY=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' 2>/dev/null | head -c 10000)
VERDICT=$(echo "$INVESTIGATOR_BODY" | grep -oE '\*\*Verdict\*\*: [A-Z]+' | sed 's/\*\*Verdict\*\*: //' | head -1)
CONFIDENCE=$(echo "$INVESTIGATOR_BODY" | grep -oE '\*\*Confidence\*\*: [A-Z]+' | sed 's/\*\*Confidence\*\*: //' | head -1)
TASK_TYPE=$(echo "$INVESTIGATOR_BODY" | grep -oE '\*\*Task Type\*\*: [^\n]+' | sed 's/\*\*Task Type\*\*: //' | head -1)
SEVERITY=$(echo "$INVESTIGATOR_BODY" | grep -oE '\*\*Severity\*\*: [A-Z]+' | sed 's/\*\*Severity\*\*: //' | head -1)

# From FORGE:BUILDER
BUILDER_BODY=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:BUILDER")) | .body' 2>/dev/null | head -c 10000)
BUILD_BRANCH=$(echo "$BUILDER_BODY" | grep -oE '\*\*Branch\*\*: `[^`]+`' | sed "s/\*\*Branch\*\*: \`//;s/\`//" | head -1)
BUILD_COMMITS=$(echo "$BUILDER_BODY" | grep -oE '\*\*Commits\*\*: [^\n]+' | sed 's/\*\*Commits\*\*: //' | head -1)
BUILD_FILES_CHANGED=$(echo "$BUILDER_BODY" | grep -oE '\*\*Files changed\*\*: [0-9]+' | sed 's/\*\*Files changed\*\*: //' | head -1)

# Lane classification (from FORGE:CONTRACT or milestone)
if [ "$ISSUE_MILESTONE" != "none" ] && [ -n "$ISSUE_MILESTONE" ]; then
  LANE="Feature lane (milestone: ${ISSUE_MILESTONE})"
else
  LANE="Fast lane (staging)"
fi

# Review findings (from PR review comment — optional, may not exist)
REVIEW_SUMMARY=""
if [ -n "{PR_NUMBER}" ]; then
  REVIEW_SUMMARY=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
    --jq '[.[] | select(.body | (contains("FORGE:REVIEWER") or test("APPROVED:|CHANGES REQUESTED:"; "i")))] | last | .body // ""' \
    2>/dev/null || echo "")
fi
REVIEW_VERDICT=$(echo "$REVIEW_SUMMARY" | grep -oE 'Verdict: (APPROVED|CHANGES REQUESTED)' | sed 's/Verdict: //' | head -1)
REVIEW_VERDICT="${REVIEW_VERDICT:-APPROVED}"
FINDINGS_COUNT=$(echo "$REVIEW_SUMMARY" | grep -oE '[0-9]+ findings' | grep -oE '[0-9]+' | head -1 || echo "0")
FINDINGS_COUNT="${FINDINGS_COUNT:-0}"
AGENTS_RUN=$(echo "$REVIEW_SUMMARY" | grep -oE '[0-9]+ agents' | grep -oE '[0-9]+' | head -1 || echo "0")
AGENTS_RUN="${AGENTS_RUN:-0}"

# Quality gate result (from FORGE:BUILDER or FORGE:TRAJECTORY if already posted)
QUALITY_GATE_RESULT=$(echo "$BUILDER_BODY" | grep -oiE 'quality gate[: ]+[a-z]+' | head -1 || echo "")

# Decompose routing decision (from FORGE:INVESTIGATOR)
DECOMPOSE=$(echo "$INVESTIGATOR_BODY" | grep -oE '\*\*(YES|NO)\*\* —[^\n]+' | sed 's/\*\*//g' | head -1)

# Summary timestamp
SUMMARY_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
```

### Post FORGE:SUMMARY comment

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:SUMMARY -->
## Pipeline Run Summary — #${NUMBER}: ${ISSUE_TITLE}

> Generated at **${SUMMARY_TIMESTAMP}** | [View PR #${PR_NUMBER}](https://github.com/{GH_REPO}/pull/${PR_NUMBER}) | [View Issue](https://github.com/{GH_REPO}/issues/${NUMBER})

---

### Pipeline Overview

| Field | Value |
|-------|-------|
| **Issue** | #${NUMBER} — ${ISSUE_TITLE} |
| **Lane** | ${LANE} |
| **PR** | #${PR_NUMBER} → \`{PR_BASE}\` |
| **Branch** | \`${BUILD_BRANCH:-{BRANCH}}\` |
| **Terminal state** | \`workflow:merged\` |

---

### Agent Decisions

| Decision Point | Outcome |
|---------------|---------|
| **Lane classification** | ${LANE} |
| **Investigation verdict** | ${VERDICT:-—} (${CONFIDENCE:-—} confidence, severity: ${SEVERITY:-—}) |
| **Task type** | ${TASK_TYPE:-—} |
| **Decompose routing** | ${DECOMPOSE:-NO — single-concern change} |
| **Review verdict** | ${REVIEW_VERDICT} (${AGENTS_RUN} agents, ${FINDINGS_COUNT} finding(s) created) |

---

### Build Summary

| Field | Value |
|-------|-------|
| **Branch** | \`${BUILD_BRANCH:-{BRANCH}}\` |
| **Commits** | ${BUILD_COMMITS:-—} |
| **Files changed** | ${BUILD_FILES_CHANGED:-—} |
| **Quality gate** | ${QUALITY_GATE_RESULT:-see trajectory} |

---

### Review Findings

$(if [ -n "$REVIEW_SUMMARY" ] && [ "$FINDINGS_COUNT" != "0" ]; then
  echo "${FINDINGS_COUNT} finding(s) created during review by ${AGENTS_RUN} agents. Each finding was filed as a separate issue for traceability."
else
  echo "No review findings created (${AGENTS_RUN} agents run, 0 findings)."
fi)

---

### What Was Not Captured

- **Token usage**: Not available — Claude Code does not expose per-session token counts via API during pipeline execution.
- **Phase durations**: FORGE annotations do not include machine-readable start/end timestamps. Use \`/replay ${NUMBER}\` for chronological annotation display.

---

*Generated by ForgeDock \`/work-on\` Phase C4.5. Full pipeline trace: \`FORGE:TRAJECTORY\` comment on this issue. Queryable artifact: \`FORGE:DECISION_RECORD\` on PR #${PR_NUMBER}.*"
```

### Optional: Write local report file

**Skip if**: `forge.yaml → reports.save_local` is not set to `true`.

```bash
# Read forge.yaml using FORGE_CONFIG env override (never hardcode path)
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
SAVE_LOCAL=""
if command -v yq >/dev/null 2>&1 && [ -f "$CONFIG_FILE" ]; then
  SAVE_LOCAL=$(yq '.reports.save_local // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
fi

if [ "$SAVE_LOCAL" = "true" ]; then
  REPORTS_DIR="${REPO_PATH}/.forgedock/reports"
  mkdir -p "$REPORTS_DIR"
  REPORT_FILE="${REPORTS_DIR}/${NUMBER}.md"

  cat > "$REPORT_FILE" << REPORT_CONTENT_EOF
# Pipeline Run Report — Issue #${NUMBER}

**Title**: ${ISSUE_TITLE}
**Generated**: ${SUMMARY_TIMESTAMP}
**Lane**: ${LANE}
**PR**: #${PR_NUMBER} → \`{PR_BASE}\`
**Branch**: \`${BUILD_BRANCH:-{BRANCH}}\`
**Terminal state**: \`workflow:merged\`

## Agent Decisions

| Decision | Outcome |
|----------|---------|
| Investigation verdict | ${VERDICT:-—} (${CONFIDENCE:-—} confidence) |
| Severity | ${SEVERITY:-—} |
| Task type | ${TASK_TYPE:-—} |
| Decompose routing | ${DECOMPOSE:-NO — single-concern change} |
| Review verdict | ${REVIEW_VERDICT} |

## Build Summary

- **Commits**: ${BUILD_COMMITS:-—}
- **Files changed**: ${BUILD_FILES_CHANGED:-—}
- **Quality gate**: ${QUALITY_GATE_RESULT:-see trajectory}

## Review

- **Agents run**: ${AGENTS_RUN}
- **Findings created**: ${FINDINGS_COUNT}

## Links

- Issue: https://github.com/{GH_REPO}/issues/${NUMBER}
- PR: https://github.com/{GH_REPO}/pull/${PR_NUMBER}
REPORT_CONTENT_EOF

  echo "Local report saved: ${REPORT_FILE}"
else
  echo "INFO: reports.save_local not set — skipping local file write"
  echo "      To enable: add 'reports:\n  save_local: true' to forge.yaml"
fi
```

<!-- Added: forge#951 -->

---

## Phase C5: Trajectory Log (MANDATORY)

Post the `<!-- FORGE:TRAJECTORY -->` comment as the final pipeline record:

**Before posting, read the attribution config**:
```bash
SHOW_ATTRIBUTION=$(yq '.branding.show_attribution // "true"' forge.yaml 2>/dev/null || echo "true")
[ "$SHOW_ATTRIBUTION" = "false" ] && ATTRIBUTION_LINE="" || ATTRIBUTION_LINE="> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)"
```

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:TRAJECTORY -->
## Pipeline Trajectory — #{NUMBER}

| Phase | Result | Notes |
|-------|--------|-------|
| Phase 0: Context Load | ✅ Complete | Feature lane → \`{PR_BASE}\` |
| Phase 1: Investigation | ✅ {VERDICT} ({CONFIDENCE}) | Task type: {TASK_TYPE} |
| Phase 2: Decomposition | ⏭ Skipped | Single-concern change, no decomposition needed |
| Phase 3: Build | ✅ Complete | Branch: \`{BRANCH}\` |
| Phase 3F.5: Validate | ✅ Gate passed | Quality gate: pass |
| Phase 4–5: Review + PR | ✅ Merged | PR #{PR_NUMBER} → \`{PR_BASE}\` |
| Phase 6: Parent Tracker | {PARENT_STATUS} | {PARENT_NOTES} |
| Phase C6: Cleanup | {CLEANUP_STATUS} | Worktree: {WORKTREE_PATH}, Branch: {BRANCH} |
| Phase 7: Close | ✅ Complete | Issue closed |

**Decisions**:
- Decomposition skipped: {DECOMPOSE_REASON}
- PR merged to: \`{PR_BASE}\` (feature lane, milestone branch)

**Anomalies**: None

**Pipeline completed**: {TIMESTAMP}
${ATTRIBUTION_LINE:+\n$ATTRIBUTION_LINE}"
```

Where:
- `{PARENT_STATUS}` = `⏭ Skipped` (if no parent) or `✅ Complete` (if parent updated)
- `{PARENT_NOTES}` = `No parent tracker` or `Checked off in #{PARENT_REF}`
- `{CLEANUP_STATUS}` = `✅ Removed` (worktree removed + branch deleted) or `⏭ Skipped` (no path provided or path not found)
- `{TIMESTAMP}` = current date/time in ISO format

---

## Phase C5.5: Graph Decision Record (MANDATORY when PR exists)

**Skip if**: `{PR_NUMBER}` is empty OR `<!-- FORGE:DECISION_RECORD -->` already posted on the PR.

Post a consolidated provenance artifact to the PR that proves the merge was backed by citable evidence. Mirrors the Phase 7C step in `work-on.md` — must stay in sync.

**Idempotency check**:
```bash
GDR_EXISTS=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:DECISION_RECORD"))] | length > 0' 2>/dev/null || echo "false")
```

**Extract context edge counts** from FORGE:CONTEXT comment:
```bash
CONTEXT_COMMENT=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTEXT")) | .body' 2>/dev/null | head -1)
REVIEW_FINDING_COUNT=$(echo "$CONTEXT_COMMENT" | grep -oP '#\d+' | wc -l | tr -d ' ')
REVIEW_FINDING_COUNT=${REVIEW_FINDING_COUNT:-0}
```

**Extract review verdict** from PR review summary:
```bash
REVIEW_SUMMARY=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:REVIEWER") or (.body | test("APPROVED:|CHANGES REQUESTED:"; "i")))] | last | .body // ""' 2>/dev/null || echo '')
REVIEW_VERDICT=$(echo "$REVIEW_SUMMARY" | grep -oP '(?<=Verdict: )(APPROVED|CHANGES REQUESTED)' | head -1 || echo "APPROVED")
FINDINGS_COUNT=$(echo "$REVIEW_SUMMARY" | grep -oP '\d+(?= findings)' | head -1 || echo "0")
AGENTS_RUN=$(echo "$REVIEW_SUMMARY" | grep -oP '\d+(?= agents)' | head -1 || echo "0")
```

**Post GDR to PR** (not to issue — PR comment is the permanent artifact):
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
  \"lane\": \"feature\",
  \"pr_base\": \"{PR_BASE}\",
  \"branch\": \"{BRANCH}\",
  \"head_sha\": \"${HEAD_SHA}\",
  \"merge_commit\": \"${MERGE_COMMIT}\",
  \"investigation\": {
    \"verdict\": \"{VERDICT}\",
    \"confidence\": \"{CONFIDENCE}\",
    \"task_type\": \"{TASK_TYPE}\"
  },
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
\`\`\`"
fi
```

<!-- Added: forge#776 -->

---

## Phase C6: Worktree & Branch Cleanup

Remove the git worktree and delete the local feature branch after the PR has merged. This prevents worktree accumulation across pipeline runs.

**Skip if**: `{WORKTREE_PATH}` is not provided OR the path does not exist.

```bash
# Remove worktree (--force handles detached or uncommitted state)
if [ -n "{WORKTREE_PATH}" ] && [ -d "{WORKTREE_PATH}" ]; then
  # Use --git-common-dir to correctly resolve REPO_ROOT for linked worktrees.
  # --show-toplevel returns the worktree path itself (not the main repo root),
  # so xargs dirname would give the worktree's parent dir — not the repo root.
  # --git-common-dir returns the shared .git dir (e.g. /repo/.git), and
  # dirname of that is always the main repo root regardless of worktree depth.
  GIT_COMMON=$(git -C {WORKTREE_PATH} rev-parse --git-common-dir 2>/dev/null)
  REPO_ROOT=$(dirname "$(realpath "$GIT_COMMON" 2>/dev/null || echo "$GIT_COMMON")")
  git -C "$REPO_ROOT" worktree remove {WORKTREE_PATH} --force 2>/dev/null || true
  echo "Worktree removed: {WORKTREE_PATH}"

  # Delete local feature branch (remote branch already deleted by GitHub on merge)
  if [ -n "{BRANCH}" ]; then
    git -C "$REPO_ROOT" branch -D {BRANCH} 2>/dev/null || true
    echo "Local branch deleted: {BRANCH}"
  fi
else
  echo "Worktree cleanup skipped: path not provided or does not exist"
fi
```

Set `{CLEANUP_STATUS}` based on outcome:
- Worktree path provided and existed → `✅ Removed` (worktree removed, branch deleted)
- Worktree path not provided or path didn't exist → `⏭ Skipped`

Update the trajectory log `{CLEANUP_STATUS}` field accordingly (the trajectory was already posted in C5, so this is recorded in the output summary, not by re-editing the comment).

---

## Output

Return structured output to the caller:

```
CLOSE_RESULT:
  status: COMPLETE | ALREADY_DONE | PHASE_COMPLETE
  issue_state: closed | open
  trajectory_url: {url of FORGE:TRAJECTORY comment}
  decision_record_url: {url of FORGE:DECISION_RECORD comment on PR, or "" if skipped}
  parent_updated: {true|false}
  parent_closed: {true|false}
```

Where `PHASE_COMPLETE` means the current phase was closed but uncompleted phases remain — the issue is left OPEN for the router to re-evaluate on the next pipeline iteration (state 10, MULTI_PHASE).

---

## Integration Point in work-on.md

This module runs at **Phases 6–7** — after review.md returns `REVIEW_RESULT: status: COMPLETE`:

```
4–5  → Review (by review.md) — PR created, reviewed, merged, issue closed
6–7  → [THIS MODULE] Final body update, parent tracker, summary, trajectory
```

This is the terminal phase — after CLOSE_RESULT returns, the pipeline is complete.
