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

**Agent model policy**: `model: "haiku"`, `effort: low` (mechanical tier — label transitions, annotation posting, board updates). Fallback: `model: "sonnet"` if rate-limited. Feature gate: pass `effort` only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — work-on/close.md loaded and active. Agent is bound by this spec. -->

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

## Phase C0.5: Close-Scope Invariant Assertions (MANDATORY)

Run before any close actions. Evaluates `close`-scope invariants declared in
`forge-invariants.yaml` via `bin/engine/invariants.mjs`. A failed assertion
logs the violated proposition by name and flags the anomaly in the trajectory
log — it does NOT abort the close phase (advisory enforcement: flag, then continue).

**Skip if**: `forge-invariants.yaml` is absent or `bin/engine/invariants.mjs`
is unavailable (e.g. fresh install before this file ships). Fail-open.

```bash
# Read local run-log for this issue (absolute path matches engine run-log dir)
RUN_LOG_DIR="${HOME}/.forge/runs"
RUN_LOG_FILE="${RUN_LOG_DIR}/{NUMBER}.jsonl"

INVARIANT_ANOMALIES=""

if [ -f "${RUN_LOG_FILE}" ] && [ -f "$(dirname "$(which node)")/node" ] 2>/dev/null; then
  # Check close-scope invariants via the evaluator
  INVARIANT_RESULT=$(node -e "
    import(new URL('file://$(pwd)/bin/engine/invariants.mjs'))
      .then(m => {
        const decls = m.loadInvariants('$(pwd)/forge-invariants.yaml');
        const fs = require('fs');
        let events = [];
        try {
          const lines = fs.readFileSync('${RUN_LOG_FILE}', 'utf-8').split('
').filter(Boolean);
          events = lines.flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
        } catch {}
        const results = m.assertCloseInvariants(decls, events);
        const failed = results.filter(r => !r.ok);
        if (failed.length) {
          failed.forEach(r => process.stderr.write(m.formatViolation(r) + '
'));
          process.exit(1);
        }
      })
      .catch(() => process.exit(0));  // fail-open on any error
  " 2>&1) || INVARIANT_ANOMALIES="${INVARIANT_RESULT}"

  if [ -n "$INVARIANT_ANOMALIES" ]; then
    echo "CLOSE-SCOPE INVARIANT ANOMALY (flagging — close continues):"
    echo "$INVARIANT_ANOMALIES"
    # The anomaly will be recorded in the trajectory log Anomalies field.
    # It does NOT block the close phase.
  fi
fi

# Also check: issue must be in CLOSED state after close attempt.
# This check runs AFTER Phase C2 (ensure issue is closed). Set a sentinel
# here to be evaluated post-C2:
CLOSE_INVARIANT_ISSUE_CHECK=true
```

**Post-C2 check** (evaluate after Phase C2 runs the `gh issue close` command):

```bash
if [ "${CLOSE_INVARIANT_ISSUE_CHECK:-false}" = "true" ]; then
  ISSUE_STATE=$(gh issue view {NUMBER} {GH_FLAG} --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
  if [ "$ISSUE_STATE" != "CLOSED" ]; then
    INVARIANT_ANOMALIES="${INVARIANT_ANOMALIES:+$INVARIANT_ANOMALIES; }issue_closed_at_terminal: issue state is ${ISSUE_STATE} (not CLOSED) after close attempt"
    echo "INVARIANT ANOMALY: issue_closed_at_terminal — issue is ${ISSUE_STATE}, not CLOSED"
    # Flag but continue — trajectory Anomalies field will surface this.
  fi
fi
```

The `INVARIANT_ANOMALIES` variable is read in Phase C4.5 (trajectory post) and written to the **Anomalies** field.

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

## Phase C1.7: Module Dossier Append (MANDATORY when PR exists) <!-- Added: forge#1733 -->

**Goal**: After each merge that touches a module covered by `devdocs/modules/`, append a dated entry so future agents working on that module receive current institutional knowledge through the binding devdocs channel.

**This phase is non-blocking** — if the dossier write fails, log the reason and continue to Phase C1.5. Never stall close for dossier maintenance.

**Skip if**: `{PR_NUMBER}` is empty (investigation-only tasks) OR `{REPO_PATH}` is unset OR `devdocs/index.yaml` does not contain a `modules:` section OR no PR files match any module glob.

### Step 1: Resolve affected files from FORGE:BUILDER comment

```bash
# Read FORGE:BUILDER comment to get the list of changed files
BUILDER_COMMENT=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:BUILDER"))] | last | .body // ""' 2>/dev/null || echo "")

# Extract file paths from the Changes section (lines starting with `- \`filepath\``)
CHANGED_FILES_RAW=$(echo "$BUILDER_COMMENT" \
  | sed -n '/^### Changes/,/^###/p' \
  | grep -oE '`[^`]+`' \
  | tr -d '`' \
  | grep -E '\.' \
  | head -20)

# Fallback: try the FORGE:INVESTIGATOR affected files list
if [ -z "$CHANGED_FILES_RAW" ]; then
  CHANGED_FILES_RAW=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
    --jq '[.[] | select(.body | contains("FORGE:INVESTIGATOR"))] | last | .body // ""' 2>/dev/null \
    | sed -n '/### Affected Files/,/###/p' \
    | grep -oE '`[^`]+`' \
    | tr -d '`' \
    | grep -E '\.' \
    | head -20)
fi

if [ -z "$CHANGED_FILES_RAW" ]; then
  echo "Phase C1.7: No changed files found from FORGE:BUILDER or FORGE:INVESTIGATOR — skipping dossier append"
  # → continue to Phase C1.5
fi
```

### Step 2: Match against module globs and append entries

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
DEVDOCS_REL=$(yq '.devdocs.path // "devdocs"' "$CONFIG_FILE" 2>/dev/null || echo "devdocs")
DEVDOCS_PATH="${REPO_PATH:-{REPO_PATH}}/${DEVDOCS_REL}"
INDEX_PATH="${DEVDOCS_PATH}/index.yaml"

if [ ! -f "$INDEX_PATH" ]; then
  echo "Phase C1.7: ${INDEX_PATH} not found — skipping dossier append"
  # → continue to Phase C1.5
fi

# Extract modules entries: "name|glob|path"
MODULE_ENTRIES=$(yq '.modules[]? | .name + "|" + .glob + "|" + .path' "$INDEX_PATH" 2>/dev/null || echo "")

if [ -z "$MODULE_ENTRIES" ]; then
  echo "Phase C1.7: No modules[] section in index.yaml — skipping dossier append"
  # → continue to Phase C1.5
fi

DOSSIER_TIMESTAMP=$(date -u +"%Y-%m-%d")
DOSSIER_UPDATED_MODULES=""

# Iterate module entries; for each: check if any changed file matches the glob
while IFS='|' read -r MOD_NAME MOD_GLOB MOD_PATH; do
  [ -z "$MOD_GLOB" ] || [ -z "$MOD_PATH" ] && continue
  DOSSIER_ABS="${DEVDOCS_PATH}/${MOD_PATH}"

  MATCHED=0
  # Iterate changed files using while read — not bare for-in (IFS word-split guard per c39758d)
  while IFS= read -r af; do
    [ -z "$af" ] && continue
    AF_BASENAME=$(basename "$af")
    case "$AF_BASENAME" in
      $MOD_GLOB) MATCHED=1; break ;;
    esac
    case "$af" in
      $MOD_GLOB) MATCHED=1; break ;;
    esac
  done <<< "$CHANGED_FILES_RAW"

  if [ "$MATCHED" -eq 0 ]; then
    continue
  fi

  echo "Phase C1.7: Module '${MOD_NAME}' matched (glob '${MOD_GLOB}') — appending entry to ${MOD_PATH}"

  # Build entry text
  # One-line summary from the PR title + issue number
  PR_TITLE=$(gh pr view {PR_NUMBER} {GH_FLAG} --json title --jq '.title' 2>/dev/null || echo "untitled")
  DOSSIER_ENTRY="## Entry ${DOSSIER_TIMESTAMP} — ${PR_TITLE} (#{NUMBER})

PR #{PR_NUMBER} touched \`${MOD_NAME}\`. See FORGE:BUILDER comment on issue #{NUMBER} for full change list.
Key gotcha recorded: (update this entry by editing \`${MOD_PATH}\` in a follow-up PR if the change revealed a new failure mode).
Cite: #${NUMBER} / PR #{PR_NUMBER}."

  # Ensure dossier file exists (create skeleton if missing — allows operator to create
  # a new module entry in index.yaml before the dossier file is seeded)
  if [ ! -f "$DOSSIER_ABS" ]; then
    mkdir -p "$(dirname "$DOSSIER_ABS")"
    cat > "$DOSSIER_ABS" <<DOSSIER_INIT_EOF
---
module: ${MOD_NAME}
glob: "${MOD_GLOB}"
authority: required
token_cost: 200
last_compacted: "${DOSSIER_TIMESTAMP}"
---

# Module Dossier: ${MOD_NAME}

Rolling per-module knowledge log. Each entry is 3–5 lines with a citation.
Hard cap: 150 lines. Entries are appended by close.md Phase C1.7 after each
PR that touches this module. When the file exceeds 150 lines, oldest entries
are compacted into the Summary block (LLM compaction, in-run).

## Summary

_No compacted history yet. Dossier was auto-created on ${DOSSIER_TIMESTAMP} by close.md Phase C1.7._
DOSSIER_INIT_EOF
    echo "Phase C1.7: Created new dossier skeleton at ${DOSSIER_ABS}"
  fi

  # Append entry (avoid subshell — use file redirect directly)
  printf '\n%s\n' "$DOSSIER_ENTRY" >> "$DOSSIER_ABS"

  # Compact if over 150 lines
  DOSSIER_LINE_COUNT=$(wc -l < "$DOSSIER_ABS" 2>/dev/null || echo 0)
  if [ "$DOSSIER_LINE_COUNT" -gt 150 ]; then
    echo "Phase C1.7: Dossier ${MOD_PATH} has ${DOSSIER_LINE_COUNT} lines (>150) — compacting oldest entries"
    # LLM compaction: read the dossier, summarize oldest Entry blocks into the ## Summary
    # section, keeping the most recent 3 entries intact.
    # Implementation note: this is prose-instruction compaction (LLM reads the file and
    # rewrites it). The compacted file must preserve the frontmatter and ## Summary block;
    # it may replace old ## Entry blocks with a single "## Archived Summary (compacted)"
    # block. After compaction, update frontmatter last_compacted to today's date.
    # The compacted file MUST be ≤ 150 lines. If compaction fails (e.g. LLM context
    # overflow), log a warning and leave the file as-is — never delete entries silently.
    echo "COMPACT INSTRUCTION: Read ${DOSSIER_ABS}. Keep the frontmatter (lines between ---), keep the ## Summary section, keep the 3 most recent ## Entry blocks, and replace all older ## Entry blocks with a single '## Archived Summary (compacted — ${DOSSIER_TIMESTAMP})' block containing a 5–8 line distillation of the key failure modes, gotchas, and citations from the archived entries. Write the result back to ${DOSSIER_ABS}. The output MUST be ≤ 150 lines. Update frontmatter last_compacted to ${DOSSIER_TIMESTAMP}."
  fi

  DOSSIER_UPDATED_MODULES="${DOSSIER_UPDATED_MODULES} ${MOD_NAME}"

done <<< "$MODULE_ENTRIES"
```

### Step 3: Commit dossier changes and post annotation

```bash
if [ -n "$DOSSIER_UPDATED_MODULES" ]; then
  # Commit the updated dossier files
  cd "{REPO_PATH}"
  CHANGED_DOSSIER_FILES=$(echo "$DOSSIER_UPDATED_MODULES" | tr ' ' '\n' | while IFS= read -r mod; do
    yq ".modules[]? | select(.name == \"${mod}\") | \"${DEVDOCS_REL}/\" + .path" "$INDEX_PATH" 2>/dev/null
  done | grep -v '^$')

  if [ -n "$CHANGED_DOSSIER_FILES" ]; then
    git -C "{REPO_PATH}" add $CHANGED_DOSSIER_FILES 2>/dev/null || true
    # Only commit if there are staged changes (new or modified dossier files)
    if ! git -C "{REPO_PATH}" diff --cached --quiet 2>/dev/null; then
      git -C "{REPO_PATH}" commit -s -m "docs(dossier): append entry for PR #{PR_NUMBER} (#${NUMBER})" 2>/dev/null || true
      echo "Phase C1.7: Dossier commit created for modules:${DOSSIER_UPDATED_MODULES}"
    else
      echo "Phase C1.7: No staged dossier changes — skipping commit"
    fi
  fi

  # Post annotation on the issue
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:DOSSIER_UPDATED -->
Module dossier(s) updated:${DOSSIER_UPDATED_MODULES}

Entries appended to \`devdocs/modules/\` after PR #{PR_NUMBER} merged. Future agents working
on these modules will receive the updated knowledge through the devdocs channel (context.md Phase C-1).

<!-- FORGE:DOSSIER_UPDATED:COMPLETE -->" 2>/dev/null || true
else
  echo "Phase C1.7: No module dossiers matched changed files — skipping"
fi
```

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
# Post phase-complete marker — work-on.md's Universal continuation rule will re-read labels and continue to the next phase
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:PHASE:COMPLETE -->
Phase complete. PR #{PR_NUMBER} merged to \`{PR_BASE}\`. ${REMAINING_AFTER} phase item(s) remain — leaving issue open for next pipeline iteration."

# Update labels to reflect phase complete — remove current-phase labels and set next-phase label
# so the router has a signal for which phase comes next (fixes: issue #1381)
gh issue edit {NUMBER} {GH_FLAG} \
  --remove-label "workflow:in-review,workflow:building,workflow:investigating" \
  --add-label "workflow:investigating" 2>/dev/null || true

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

## Phase C4.5: Pipeline Summary Card (MANDATORY)

The shareable artifact. After the close completes, render a box-drawing summary card to
stdout (terminal screenshot moment) AND compute a machine-readable twin that Phase C5
embeds in the `FORGE:TRAJECTORY` comment for platform consumption.

**All stats are real — pulled from `gh`/`git`. Every lookup degrades gracefully: a missing
value renders as `—` and NEVER aborts the card. Do NOT fabricate stats.**

### C4.5a: Gather real stats

```bash
# Commit / diff stats from the merged PR (single API call). Fallbacks to "—" if absent.
PR_STATS=$(gh pr view {PR_NUMBER} {GH_FLAG} --json commits,additions,deletions,baseRefName,isDraft 2>/dev/null)
COMMITS=$(echo "$PR_STATS"   | jq -r '(.commits | length) // empty' 2>/dev/null); COMMITS=${COMMITS:-—}
ADDITIONS=$(echo "$PR_STATS" | jq -r '.additions // empty' 2>/dev/null); ADDITIONS=${ADDITIONS:-—}
DELETIONS=$(echo "$PR_STATS" | jq -r '.deletions // empty' 2>/dev/null); DELETIONS=${DELETIONS:-—}
PR_TARGET=$(echo "$PR_STATS" | jq -r '.baseRefName // empty' 2>/dev/null); PR_TARGET=${PR_TARGET:-{PR_BASE}}
IS_DRAFT=$(echo "$PR_STATS"  | jq -r '.isDraft // false' 2>/dev/null)

# Review summary — count domain-agent verdicts posted by /review-pr on the PR.
REVIEW_BODIES=$(gh pr view {PR_NUMBER} {GH_FLAG} --json reviews,comments \
  --jq '[.reviews[].body // ""] + [.comments[].body // ""] | .[]' 2>/dev/null)
# NOTE: `grep -c` already prints `0` on no match (and exits non-zero) — do NOT add
# `|| echo 0`, which would append a second line ("0\n0") and break the arithmetic
# and `--argjson` below. Swallow the non-zero exit with `|| true`, then default.
APPROVED=$(echo "$REVIEW_BODIES" | grep -cE 'APPROVED:' 2>/dev/null || true); APPROVED=${APPROVED:-0}
CHANGES=$(echo  "$REVIEW_BODIES" | grep -cE 'CHANGES REQUESTED:' 2>/dev/null || true); CHANGES=${CHANGES:-0}
TOTAL_AGENTS=$((APPROVED + CHANGES))
# Blockers = review-finding issues created by this PR that are still open (best-effort).
BLOCKERS=$(echo "$REVIEW_BODIES" | grep -ciE 'blocker|merge.?block' 2>/dev/null || true); BLOCKERS=${BLOCKERS:-0}
if [ "$TOTAL_AGENTS" -gt 0 ]; then
  REVIEW_SUMMARY="${APPROVED}/${TOTAL_AGENTS} agents passed, ${BLOCKERS} blockers"
else
  REVIEW_SUMMARY="—"   # review data unavailable (e.g. review skipped)
fi

# Elapsed wall-clock: first FORGE agent comment → now.
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

# Pipeline line + status — reflect the ACTUAL terminal state.
#   merged    → investigate → architect → build → review → merge ✓
#   decomposed→ investigate → decompose ⏹ (sub-issues spawned)
#   invalid   → investigate → invalid ✗
#   blocked   → investigate → … → blocked ⚠ (needs-human)
#   draft PR  → append "(draft)" to the merge segment
case "{TERMINAL_STATE}" in
  decomposed) PIPELINE_LINE="investigate → decompose ⏹"; CARD_STATUS="decomposed" ;;
  invalid)    PIPELINE_LINE="investigate → invalid ✗";   CARD_STATUS="invalid" ;;
  blocked)    PIPELINE_LINE="investigate → build → blocked ⚠"; CARD_STATUS="blocked" ;;
  *)          PIPELINE_LINE="investigate → architect → build → review → merge ✓"; CARD_STATUS="merged" ;;
esac
[ "$IS_DRAFT" = "true" ] && PIPELINE_LINE="${PIPELINE_LINE} (draft)"
```

### C4.5b: Render the card to stdout

Print the card to stdout (the calling agent surfaces it in the terminal). Card inner
width is **51** columns. Truncate the title with an ellipsis (`…`) if `#{NUMBER} — {TITLE}`
exceeds the field; pad shorter lines with spaces so the right border `║` stays aligned.

```
╔═══════════════════════════════════════════════════╗
║  ForgeDock Pipeline Complete                      ║
╠═══════════════════════════════════════════════════╣
║                                                   ║
║  Issue:    #{NUMBER} — {TITLE}                    ║
║  Pipeline: {PIPELINE_LINE}                        ║
║  Commits:  {COMMITS} ({ADDITIONS} additions, {DELETIONS} deletions) ║
║  PR:       #{PR_NUMBER} (merged to {PR_TARGET})   ║
║  Review:   {REVIEW_SUMMARY}                       ║
║  Time:     {ELAPSED}                              ║
║                                                   ║
╚═══════════════════════════════════════════════════╝
```

**Edge-case rendering**:
- Decomposed: title line stays; `Pipeline:` shows `investigate → decompose ⏹`; `PR:`, `Review:`, `Commits:` render `—`; the header reads `ForgeDock Pipeline — Decomposed`.
- Invalid: header `ForgeDock Pipeline — Closed (invalid)`; `Pipeline:` shows `investigate → invalid ✗`; downstream stats `—`.
- Blocked / needs-human: header `ForgeDock Pipeline — Blocked`; `Review:`/`PR:` reflect last known state; remaining stats `—`.
- Draft PR: `PR:` line appends `(draft)` and the merge segment is not marked `✓`.

### C4.5c: Build the machine-readable twin

Assemble the JSON object below (used verbatim by Phase C5). Numeric stats that were `—`
become `null` in JSON; never emit `"—"` as a number.

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

---

## Phase C5: Trajectory Log (MANDATORY)

**CODEC PATH (forge#1727)**: Post the `<!-- FORGE:TRAJECTORY -->` comment via the protocol codec — do NOT hand-roll the opening tag. Use `forge-annotation.sh write TRAJECTORY --field ...` or `node packages/protocol/src/cli.js emit TRAJECTORY` to produce the opening tag. The codec handles any field escaping automatically.

```bash
# Codec produces the opening <!-- FORGE:TRAJECTORY --> tag
TRAJECTORY_HEADER=$(node packages/protocol/src/cli.js emit TRAJECTORY)
# $TRAJECTORY_HEADER = "<!-- FORGE:TRAJECTORY -->"
# Append the Markdown body sections, then post via gh issue comment.
```

Post the `<!-- FORGE:TRAJECTORY -->` comment as the final pipeline record:

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

$(node packages/protocol/src/cli.js emit CARD --b64 \
  --field issue={NUMBER} \
  --field status={CARD_STATUS} \
  --field pipeline="${PIPELINE_LINE}" \
  --field pr={PR_NUMBER} \
  --field pr_target="${PR_TARGET}" \
  --field commits="${COMMITS}" \
  --field additions="${ADDITIONS}" \
  --field deletions="${DELETIONS}" \
  --field review="${REVIEW_SUMMARY}" \
  --field elapsed="${ELAPSED_SECS:-0}")"
```

The `<!-- FORGE:CARD: v1 sha:... b64:... -->` line carries the machine-readable summary computed in
Phase C4.5c, encoded as Base64url (design decision 2026-07-08: encoding beats escaping — the
Base64url alphabet cannot contain HTML comment delimiters by construction). It is wrapped in
the inline-value annotation form `<!-- FORGE:CARD: ... -->` so parse() extracts the encoded
payload. Platform consumers (e.g., `/orchestrate`) decode via `node packages/protocol/src/cli.js
parse --type CARD --field status`. This block is **additive**: all existing `FORGE:TRAJECTORY`
consumers select via `contains("FORGE:TRAJECTORY")` and parse the markdown table, so the
embedded CARD line does not affect them.

**CODEC PATH (forge#1727)**: The `$(node packages/protocol/src/cli.js emit CARD --b64 ...)` call
above replaces the previous `<!-- FORGE:CARD ${CARD_JSON} -->` inline-JSON form. The Base64url
form is safe against all HTML comment injection vectors and includes a sha8 integrity prefix for
truncation detection. Consumers that parsed the old inline-JSON form must migrate to the codec
parse path: `echo '...' | node packages/protocol/src/cli.js parse --type CARD --field <key>`.

Where:
- `{PARENT_STATUS}` = `⏭ Skipped` (if no parent) or `✅ Complete` (if parent updated)
- `{PARENT_NOTES}` = `No parent tracker` or `Checked off in #{PARENT_REF}`
- `{CLEANUP_STATUS}` = `✅ Removed` (worktree removed + branch deleted) or `⏭ Skipped` (no path provided or path not found)
- `{TIMESTAMP}` = current date/time in ISO format

---

## Phase C5.2: Memory Index Update <!-- Added: forge#1316 -->

**Goal**: Append this run's learnings to the per-repo memory index so future `investigate` runs can retrieve relevant priors. This is the write side of the compounding intelligence loop.

**This phase is non-blocking** — if Gist creation or update fails, log the reason and continue to Phase C5.5. Never stall close for memory.

**Skip if**: Terminal state is `INVALID` (nothing useful to learn from an invalid issue) OR `<!-- FORGE:TRAJECTORY -->` was already posted AND `<!-- FORGE:MEMORY_INDEXED -->` comment exists on the issue (idempotency guard).

### Step 1: Compose memory entry

Extract key fields from the pipeline:

```bash
ROOT_CAUSE=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' \
  | sed -n '/### Root Cause/{n;p;q}' | head -1 | cut -c1-120)

AFFECTED_FILES_BRIEF=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' \
  | sed -n '/### Affected Files/{n;p;q}' | head -1 | cut -c1-120)

DOMAIN_TAGS=$(gh issue view {NUMBER} {GH_FLAG} --json labels \
  --jq '[.labels[].name | select(test("^(auth|billing|database|security|payments|gdpr|perf|ui|api|config)"))] | join(",")' 2>/dev/null || echo "")

MEMORY_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

MEMORY_ENTRY="MEMORY_ENTRY: issue={NUMBER} title=\"{TITLE}\" domain=\"${DOMAIN_TAGS}\" root_cause=\"${ROOT_CAUSE}\" outcome=\"${CARD_STATUS}\" files=\"${AFFECTED_FILES_BRIEF}\" lesson=\"${ROOT_CAUSE}\" timestamp=${MEMORY_TIMESTAMP}"
```

### Step 2: Find or create the memory index Gist

```bash
MEMORY_INDEX_ID=$(gh gist list --limit 100 \
  --jq '.[] | select(.description | contains("FORGE:MEMORY_INDEX: {GH_REPO}")) | .id' 2>/dev/null | head -1)

if [ -z "$MEMORY_INDEX_ID" ]; then
  # First run — create the index Gist
  TMPFILE=$(mktemp --suffix=.md)
  cat > "$TMPFILE" <<GIST_EOF
# ForgeDock Memory Index — {GH_REPO}
<!-- FORGE:MEMORY_INDEX: {GH_REPO} -->
Generated by ForgeDock close phase. Each line is a prior pipeline run.

${MEMORY_ENTRY}
GIST_EOF
  # Memory gists MUST be secret — never pass --public here (forge#1587).
  # The entry content below embeds real issue titles, root causes, and file
  # paths; for a private consumer repo, --public would publish that content
  # to a world-readable Gist. `gh gist create` is secret by default, so
  # simply omitting --public is sufficient — the read side (investigate.md
  # Phase 0.5, via `gh gist view`/`gh gist list`) works unchanged against
  # secret gists for the authenticated owner.
  MEMORY_INDEX_URL=$(gh gist create "$TMPFILE" \
    --desc "FORGE:MEMORY_INDEX: {GH_REPO} — per-codebase learning index" \
    2>/dev/null | head -1)
  MEMORY_INDEX_ID=$(echo "$MEMORY_INDEX_URL" | sed 's|.*/||')
  rm -f "$TMPFILE"
  echo "[MEMORY] Created memory index Gist: ${MEMORY_INDEX_URL}"
else
  # Append to existing index
  EXISTING_CONTENT=$(gh gist view "$MEMORY_INDEX_ID" 2>/dev/null)
  UPDATED_CONTENT="${EXISTING_CONTENT}
${MEMORY_ENTRY}"
  INDEX_FILENAME=$(gh api gists/${MEMORY_INDEX_ID} --jq '.files | keys[0]' 2>/dev/null)
  INDEX_FILENAME="${INDEX_FILENAME:-memory_index.md}"
  TMPFILE=$(mktemp --suffix=.md)
  echo "$UPDATED_CONTENT" > "$TMPFILE"
  gh gist edit "$MEMORY_INDEX_ID" -f "$INDEX_FILENAME" "$TMPFILE" 2>/dev/null
  EDIT_EXIT=$?
  rm -f "$TMPFILE"
  MEMORY_INDEX_URL="https://gist.github.com/${MEMORY_INDEX_ID}"
  if [ $EDIT_EXIT -eq 0 ]; then
    echo "[MEMORY] Appended to memory index: ${MEMORY_INDEX_URL}"
  else
    echo "WARNING: Failed to update memory index — run will not be persisted"
    MEMORY_INDEX_URL=""
  fi
fi
```

### Migration: replacing an existing public memory-index Gist

GitHub does not support flipping a Gist's visibility from public to secret in place. If you find an existing `FORGE:MEMORY_INDEX: {GH_REPO}` Gist that is **public** (check with `gh api gists/${MEMORY_INDEX_ID} --jq '.public'`), replace it:

```bash
# The gist ID here is the same one found by the FORGE:MEMORY_INDEX search above.
OLD_PUBLIC_GIST_ID="$MEMORY_INDEX_ID"

# 1. Save the existing content so no learnings are lost — and verify the save
#    succeeded BEFORE deleting anything.
gh gist view "$OLD_PUBLIC_GIST_ID" > /tmp/memory_index_migrate.md
if [ ! -s /tmp/memory_index_migrate.md ]; then
  echo "ABORT: failed to save gist content — not deleting the public gist." >&2
  exit 1
fi

# 2. Delete the public gist (removes the world-readable copy)
gh gist delete "$OLD_PUBLIC_GIST_ID" --yes

# 3. Recreate it secret (no --public) with the same description tag so the
#    next close/investigate run finds it via the FORGE:MEMORY_INDEX search
gh gist create /tmp/memory_index_migrate.md \
  --desc "FORGE:MEMORY_INDEX: {GH_REPO} — per-codebase learning index"
```

This is a one-time manual step per affected repo — Phase C5.2 itself only ever creates the index once (Step 2's `if [ -z "$MEMORY_INDEX_ID" ]` branch) and appends afterward, so a stale public gist is never auto-recreated secret on its own.

### Step 3: Post audit annotation on the issue

```bash
if [ -n "$MEMORY_INDEX_URL" ]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:MEMORY_INDEXED -->
This run has been indexed in the per-repo memory: ${MEMORY_INDEX_URL}

Future \`investigate\` runs on \`{GH_REPO}\` will retrieve this entry as a prior when working on related issues.

<!-- FORGE:MEMORY_INDEXED:COMPLETE -->"
  echo "[MEMORY] Indexed issue #{NUMBER} into memory at: ${MEMORY_INDEX_URL}"
fi
```

---

---

## Phase C5.3: Repo Map Refresh (incremental) <!-- Added: forge#1734 -->

**Skip if**: `scripts/build-repo-map.mjs` does not exist under `{REPO_PATH}` OR no changed files can be determined from the merged PR.

**This phase is non-blocking** — if the map refresh or push fails, log the reason and continue to Phase C5.5. Never stall close for map maintenance.

**Purpose**: After each PR merge, refresh the blob-hash-keyed repo map entries for only the files changed in the merged PR. Unchanged files are skipped by the script's blob-hash check — cost is bounded to actual churn.

### Step 1: Collect changed files from the merged PR

```bash
CHANGED_FILES=$(gh pr view {PR_NUMBER} {GH_FLAG} --json files \
  --jq '[.files[].path] | join(",")' 2>/dev/null || echo "")

if [ -z "$CHANGED_FILES" ]; then
  echo "[repo-map] No changed files found in PR #{PR_NUMBER} — skipping map refresh"
fi
```

### Step 2: Run incremental refresh

```bash
REPO_MAP_SCRIPT="{REPO_PATH}/scripts/build-repo-map.mjs"
if [ -f "$REPO_MAP_SCRIPT" ] && [ -n "$CHANGED_FILES" ]; then
  REFRESH_RESULT=$(node "$REPO_MAP_SCRIPT" refresh \
    --root "{REPO_PATH}" \
    --files "$CHANGED_FILES" \
    --quiet 2>&1) || REFRESH_RESULT="error"
  echo "[repo-map] Refresh result: $REFRESH_RESULT"
else
  echo "[repo-map] Skipping repo map refresh (script not found or no changed files)"
  REFRESH_RESULT=""
fi
```

### Step 3: Push updated map to forge-knowledge branch (non-blocking)

```bash
if [ -f "$REPO_MAP_SCRIPT" ] && [ -n "$REFRESH_RESULT" ] && [ "$REFRESH_RESULT" != "error" ]; then
  node "$REPO_MAP_SCRIPT" push \
    --root "{REPO_PATH}" \
    --quiet 2>/dev/null || true
  echo "[repo-map] Map pushed to forge-knowledge branch (or skipped if remote unavailable)"
fi
```

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

Where `PHASE_COMPLETE` means the current phase was closed but uncompleted phases remain — the issue is left OPEN for work-on.md to re-evaluate on the next invocation (via Universal continuation rule: re-read labels, check terminal state, continue to next phase).

---

## Integration Point in work-on.md

This module runs at **Phases 6–7** — after review.md returns `REVIEW_RESULT: status: COMPLETE`:

```
4–5  → Review (by review.md) — PR created, reviewed, merged, issue closed
6–7  → [THIS MODULE] Final body update, parent tracker, summary, trajectory
```

This is the terminal phase — after CLOSE_RESULT returns, the pipeline is complete.
