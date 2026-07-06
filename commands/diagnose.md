---
description: Trace a failed or stalled pipeline run — identify which FORGE annotation is missing or malformed, diagnose the failure point, and suggest specific remediation steps
argument-hint: [issue number] [--repo prefix]
install: extras
---

# /diagnose — Pipeline Failure Tracer

**Input**: $ARGUMENTS

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.

You are the pipeline's diagnostic layer. Given a single GitHub issue number, you reconstruct the full FORGE annotation chain for that pipeline run, identify the exact failure point, and suggest specific remediation steps. This command is **read-only** — it never mutates GitHub state.

---

## Config Resolution

Before executing any phase, read `forge.yaml` to resolve project references:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ -f "$CONFIG_FILE" ]; then
  GH_OWNER=$(yq '.project.owner' "$CONFIG_FILE")
  GH_REPO_NAME=$(yq '.project.repo' "$CONFIG_FILE")
  GH_REPO="${GH_OWNER}/${GH_REPO_NAME}"
  GH_FLAG="-R $GH_REPO"
  REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
  # FORGE_REPO: the self-pipeline repo (may differ from GH_REPO for multi-repo setups)
  FORGE_REPO=$(yq '.project.forge_repo // ""' "$CONFIG_FILE")
  [ -z "$FORGE_REPO" ] && FORGE_REPO="$GH_REPO"
else
  echo "ERROR: forge.yaml not found. Run: npx forgedock init"
  exit 1
fi
```

## Input Parsing

Parse `$ARGUMENTS` for:
- **`{NUMBER}`** — issue number (required). Exit with usage message if absent.
- **`--repo prefix`** — satellite repo prefix (optional). Look up in `forge.yaml → repos.satellites[]`.

```bash
NUMBER=$(echo "$ARGUMENTS" | grep -oE '^[0-9]+' | head -1)
if [ -z "$NUMBER" ]; then
  echo "Usage: /diagnose {issue-number} [--repo prefix]"
  echo "Example: /diagnose 611"
  exit 1
fi

# Optional satellite repo routing
REPO_PREFIX=$(echo "$ARGUMENTS" | grep -oE -- '--repo [^ ]+' | sed 's/--repo //' | head -1)
if [ -n "$REPO_PREFIX" ]; then
  SATELLITE_REPO=$(yq ".repos.satellites[] | select(.prefix == \"$REPO_PREFIX\") | .repo" "$CONFIG_FILE" 2>/dev/null)
  if [ -n "$SATELLITE_REPO" ] && [ "$SATELLITE_REPO" != "null" ]; then
    GH_REPO="$SATELLITE_REPO"
    GH_FLAG="-R $GH_REPO"
    echo "Satellite repo: $GH_REPO"
  else
    echo "WARNING: --repo prefix '$REPO_PREFIX' not found in forge.yaml — using default repo"
  fi
fi
```

---

## Phase 1: Load Issue Context

### 1A: Fetch issue

```bash
ISSUE=$(gh issue view "$NUMBER" $GH_FLAG \
  --json number,title,body,labels,state,comments,milestone,createdAt,closedAt)

echo "Issue #$NUMBER: $(echo "$ISSUE" | jq -r '.title')"
echo "State: $(echo "$ISSUE" | jq -r '.state')"
echo "Labels: $(echo "$ISSUE" | jq -r '[.labels[].name] | join(", ")')"
echo "Created: $(echo "$ISSUE" | jq -r '.createdAt')"
[ "$(echo "$ISSUE" | jq -r '.closedAt')" != "null" ] && \
  echo "Closed: $(echo "$ISSUE" | jq -r '.closedAt')"
```

### 1B: Fetch all comments

```bash
COMMENTS=$(gh api "repos/${GH_REPO}/issues/${NUMBER}/comments" \
  --jq '[.[] | {id: .id, author: .user.login, body: .body, created_at: .created_at}]')

COMMENT_COUNT=$(echo "$COMMENTS" | jq 'length')
echo "Comments found: $COMMENT_COUNT"
```

### 1C: Extract workflow labels

```bash
WORKFLOW_LABELS=$(echo "$ISSUE" | jq -r '[.labels[].name | select(startswith("workflow:"))] | join(", ")')
echo "Workflow labels: ${WORKFLOW_LABELS:-none}"
```

---

## Phase 2: Classify Annotation Chain

Walk the comments in creation order and classify each by FORGE marker.

**Canonical annotation sequence** (from work-on.md — update this list when work-on.md adds new markers):

| Order | Marker | Completion Marker | Phase |
|-------|--------|-------------------|-------|
| 1 | `<!-- FORGE:INVESTIGATOR -->` | `<!-- INVESTIGATION:COMPLETE -->` | Phase 1: Investigation |
| 2 | `<!-- FORGE:CONTRACT -->` | (none — standalone) | Phase 3C: Builder Contract |
| 3 | `<!-- FORGE:CONTEXT -->` | `<!-- FORGE:CONTEXT:COMPLETE -->` | Phase 3C.5: Context |
| 4 | `<!-- FORGE:ARCHITECT -->` | `<!-- FORGE:ARCHITECT:COMPLETE -->` | Phase 3C.6: Architecture |
| 5 | `<!-- FORGE:BUILDER -->` | `<!-- FORGE:BUILDER:COMPLETE -->` | Phase 3M: Implementation |
| 6 | `<!-- FORGE:REVIEW_STARTED -->` | (none — standalone) | Phase 5B: Review initiated |
| 7 | `<!-- FORGE:TRAJECTORY -->` | (none — terminal) | Phase 7B: Trajectory log |

**Alternative path markers** (indicate non-standard outcomes):

| Marker | Meaning |
|--------|---------|
| `<!-- FORGE:DECOMPOSED -->` | Issue was decomposed into sub-issues |
| `<!-- FORGE:DECOMPOSED:COMPLETE -->` | Decomposition completed cleanly |
| `<!-- FORGE:GATE_FAILED -->` | Quality gate blocked the build |
| `<!-- FORGE:PUSH_BLOCKED -->` | Branch push was blocked |
| `<!-- FORGE:ANCESTRY_FAILED -->` | Post-commit ancestry audit failed |

**Classify each comment**:

```bash
# For each comment body, check for FORGE markers and completion markers
# Build an ordered map: marker → {present: bool, complete: bool, partial: bool, comment_id}

FOUND_INVESTIGATOR=false; INVESTIGATOR_COMPLETE=false
FOUND_CONTRACT=false
FOUND_CONTEXT=false; CONTEXT_COMPLETE=false; CONTEXT_PARTIAL=false
FOUND_ARCHITECT=false; ARCHITECT_COMPLETE=false; ARCHITECT_PARTIAL=false
FOUND_BUILDER=false; BUILDER_COMPLETE=false
FOUND_REVIEW_STARTED=false
FOUND_TRAJECTORY=false
FOUND_DECOMPOSED=false; DECOMPOSED_COMPLETE=false
FOUND_GATE_FAILED=false
FOUND_PUSH_BLOCKED=false
FOUND_ANCESTRY_FAILED=false

# Walk comments in order
echo "$COMMENTS" | jq -c '.[]' | while IFS= read -r comment; do
  BODY=$(echo "$comment" | jq -r '.body')
  COMMENT_ID=$(echo "$comment" | jq -r '.id')

  echo "$BODY" | grep -q "FORGE:INVESTIGATOR" && FOUND_INVESTIGATOR=true && \
    echo "$BODY" | grep -q "INVESTIGATION:COMPLETE" && INVESTIGATOR_COMPLETE=true

  echo "$BODY" | grep -q "FORGE:CONTRACT" && FOUND_CONTRACT=true

  echo "$BODY" | grep -q "FORGE:CONTEXT" && FOUND_CONTEXT=true && \
    echo "$BODY" | grep -q "FORGE:CONTEXT:COMPLETE" && CONTEXT_COMPLETE=true && \
    echo "$BODY" | grep -q "FORGE:CONTEXT:PARTIAL" && CONTEXT_PARTIAL=true

  echo "$BODY" | grep -q "FORGE:ARCHITECT" && FOUND_ARCHITECT=true && \
    echo "$BODY" | grep -q "FORGE:ARCHITECT:COMPLETE" && ARCHITECT_COMPLETE=true && \
    echo "$BODY" | grep -q "FORGE:ARCHITECT:PARTIAL" && ARCHITECT_PARTIAL=true

  echo "$BODY" | grep -q "FORGE:BUILDER" && FOUND_BUILDER=true && \
    echo "$BODY" | grep -q "FORGE:BUILDER:COMPLETE" && BUILDER_COMPLETE=true

  echo "$BODY" | grep -q "FORGE:REVIEW_STARTED" && FOUND_REVIEW_STARTED=true
  echo "$BODY" | grep -q "FORGE:TRAJECTORY" && FOUND_TRAJECTORY=true
  echo "$BODY" | grep -q "FORGE:DECOMPOSED" && FOUND_DECOMPOSED=true && \
    echo "$BODY" | grep -q "FORGE:DECOMPOSED:COMPLETE" && DECOMPOSED_COMPLETE=true

  echo "$BODY" | grep -q "FORGE:GATE_FAILED" && FOUND_GATE_FAILED=true
  echo "$BODY" | grep -q "FORGE:PUSH_BLOCKED" && FOUND_PUSH_BLOCKED=true
  echo "$BODY" | grep -q "FORGE:ANCESTRY_FAILED" && FOUND_ANCESTRY_FAILED=true
done
```

---

## Phase 3: Discover Associated PR

```bash
# Find PRs that reference this issue number in their body
PR_LIST=$(gh pr list $GH_FLAG --state all --limit 50 \
  --json number,title,state,body,headRefName,baseRefName,mergedAt \
  --jq "[.[] | select(.body | test(\"(#|Closes )${NUMBER}([^0-9]|$)\"))]")

PR_COUNT=$(echo "$PR_LIST" | jq 'length')

if [ "$PR_COUNT" -gt 0 ]; then
  PR_NUMBER=$(echo "$PR_LIST" | jq -r '.[0].number')
  PR_STATE=$(echo "$PR_LIST" | jq -r '.[0].state')
  PR_MERGED=$(echo "$PR_LIST" | jq -r '.[0].mergedAt // "not merged"')
  PR_BRANCH=$(echo "$PR_LIST" | jq -r '.[0].headRefName')
  PR_BASE=$(echo "$PR_LIST" | jq -r '.[0].baseRefName')
  echo "Associated PR: #$PR_NUMBER ($PR_STATE) on branch $PR_BRANCH → $PR_BASE"
  echo "Merged: $PR_MERGED"

  # Fetch PR comments and reviews for FORGE:REVIEWER
  PR_REVIEWS=$(gh pr view "$PR_NUMBER" $GH_FLAG --json reviews,comments \
    --jq '([.reviews[].body // ""] + [.comments[].body // ""]) |
          map(select(test("FORGE:REVIEWER|APPROVED:|CHANGES REQUESTED:"; "i")))')
  REVIEW_PRESENT=$(echo "$PR_REVIEWS" | jq 'length > 0')
else
  echo "No PR associated with issue #$NUMBER"
  PR_NUMBER=""
  PR_STATE="none"
  PR_MERGED="none"
  REVIEW_PRESENT=false
fi
```

---

## Phase 4: Diagnose Failure Point

Walk the expected annotation sequence in order and identify the first gap or incomplete marker.

**Failure classification logic** (evaluate in this exact order — first match wins):

### F0: Issue already in terminal state

```
IF issue state == CLOSED AND workflow:merged label present:
  → DIAGNOSIS: Pipeline completed successfully.
     FORGE:TRAJECTORY should be present. If absent: see F8.
  → REMEDIATION: None needed. Run /audit if the outcome was wrong.
```

### F1: Investigation interrupted

```
IF FORGE:INVESTIGATOR present AND INVESTIGATION:COMPLETE absent:
  → DIAGNOSIS: Investigation started but was interrupted before completion.
     The pipeline will re-detect this and restart investigation on next /work-on run.
  → REMEDIATION:
     1. Delete the incomplete investigator comment (find its ID from the comments list above)
        gh api repos/{GH_REPO}/issues/comments/{COMMENT_ID} -X DELETE
     2. Re-run: /work-on {NUMBER}
```

### F2: Investigation never started

```
IF FORGE:INVESTIGATOR absent AND issue state == OPEN:
  → DIAGNOSIS: Pipeline has not started on this issue.
  → REMEDIATION: /work-on {NUMBER}
```

### F3: Build never started (stuck at ready-to-build)

```
IF INVESTIGATION:COMPLETE present
   AND FORGE:CONTRACT absent
   AND workflow:ready-to-build label present:
  → DIAGNOSIS: Investigation completed but build phase never started.
     Issue is queued but no agent picked it up.
  → REMEDIATION: /work-on {NUMBER}
     (work-on will detect the ready-to-build label and jump to Phase 3)
```

### F4: Build interrupted at contract phase

```
IF INVESTIGATION:COMPLETE present
   AND FORGE:CONTRACT absent
   AND workflow:building label present:
  → DIAGNOSIS: Build phase started (building label set) but builder contract was never posted.
     Agent likely crashed or was interrupted during Phase 3C.
  → REMEDIATION:
     1. Remove stale label: gh issue edit {NUMBER} $GH_FLAG --remove-label "workflow:building" --add-label "workflow:ready-to-build"
     2. Re-run: /work-on {NUMBER}
```

### F5: Context or architect phases incomplete

```
IF FORGE:CONTRACT present AND FORGE:BUILDER absent:
  → Check context and architect status:

  CONTEXT PARTIAL (timed out):
  IF FORGE:CONTEXT present AND FORGE:CONTEXT:COMPLETE absent:
    → NOTE: Context gathering hit the 2-minute budget. Build will continue with partial context.
      This is a warning, not a hard failure. If the build completed, this is expected.
      If build stalled: re-run /work-on {NUMBER}

  ARCHITECT PARTIAL (budget exceeded):
  IF FORGE:ARCHITECT present AND FORGE:ARCHITECT:COMPLETE absent:
    → NOTE: Architecture plan hit the 3-minute budget. Build continues with partial plan.
      If build stalled: re-run /work-on {NUMBER}

  BUILD STALLED (contract posted, no builder):
  IF FORGE:CONTEXT:COMPLETE present AND FORGE:ARCHITECT:COMPLETE present AND FORGE:BUILDER absent:
    → DIAGNOSIS: All pre-build phases completed but implementation never ran.
      Agent was interrupted between Phase 3C.6 and Phase 3F.
    → REMEDIATION: /work-on {NUMBER}
      (work-on reads FORGE:BUILDER absence and resumes from implementation)

  NEEDS-HUMAN (contract posted, needs-human label set):
  IF needs-human label present:
    → DIAGNOSIS: Builder encountered an unresolvable blocker and flagged for human intervention.
      Read the most recent comment on the issue for the specific blocker details.
    → REMEDIATION: Read the blocker comment, resolve manually, then remove the needs-human label
      and run: /work-on {NUMBER}
```

### F6: Quality gate or push blocked

```
IF FORGE:GATE_FAILED present:
  → DIAGNOSIS: Quality gate failed after 3 iterations. Implementation has unresolved HIGH/MEDIUM findings.
  → REMEDIATION:
     1. Read the FORGE:GATE_FAILED comment for the specific findings
     2. Fix the issues in the worktree branch
     3. Re-run quality gate: /quality-gate {FILES} --worktree {WORKTREE_PATH}
     4. When passing: git push and create PR manually, or re-run /work-on {NUMBER}

IF FORGE:PUSH_BLOCKED present:
  → DIAGNOSIS: Branch push was blocked (force-push rejected or remote conflict).
  → REMEDIATION:
     1. Read the FORGE:PUSH_BLOCKED comment for details
     2. Resolve the conflict or branch issue manually
     3. Re-run: /work-on {NUMBER}

IF FORGE:ANCESTRY_FAILED present:
  → DIAGNOSIS: Post-commit ancestry audit found merge commits in the PR branch.
     This indicates a git merge was used instead of rebase/cherry-pick.
  → REMEDIATION:
     1. Rebase the branch onto origin/{base_branch}: git rebase origin/{base_branch} {branch}
     2. Force-push: git push --force-with-lease
     3. Re-run: /work-on {NUMBER}
```

### F7: Build complete but no PR

```
IF FORGE:BUILDER:COMPLETE present AND no PR found:
  → DIAGNOSIS: Implementation committed to branch but PR was never created.
     Agent was interrupted between Phase 3M and Phase 4.
  → REMEDIATION: /work-on {NUMBER}
     (work-on detects FORGE:BUILDER without a PR and proceeds to Phase 4)

IF FORGE:BUILDER:COMPLETE present AND PR exists AND PR state == OPEN:
  → DIAGNOSIS: PR was created but review was never started.
  → REMEDIATION: /work-on {NUMBER}
     (work-on detects open PR + workflow:in-review and proceeds to Phase 5)
```

### F8: Review incomplete or PR not merged

```
IF FORGE:REVIEW_STARTED present AND PR state != MERGED:
  → DIAGNOSIS: Review was initiated but the PR was not merged.
  → Check PR state:
    - CLOSED (not merged): PR was closed without merging. Re-open or create a new PR.
    - OPEN: Review agent ran but did not auto-merge. Check for merge conflicts or blocking reviews.
  → REMEDIATION:
    - Merge conflicts: resolve manually on the branch, then:
      gh pr merge {PR_NUMBER} $GH_FLAG --merge
    - Auto-merge failure: gh pr merge {PR_NUMBER} $GH_FLAG --merge
    - If PR was closed: re-run /work-on {NUMBER} to create a fresh PR

IF FORGE:REVIEW_STARTED present AND PR state == MERGED AND FORGE:TRAJECTORY absent:
  → DIAGNOSIS: PR merged but pipeline close phase (Phase 6-7) did not complete.
     Issue may still be open and labels may not be updated.
  → REMEDIATION: Re-run /work-on {NUMBER}
     (work-on detects merged PR + open issue and runs Phase 6 close & cleanup)
```

### F9: Decomposition path issues

```
IF FORGE:DECOMPOSED present AND FORGE:DECOMPOSED:COMPLETE absent:
  → DIAGNOSIS: Decomposition started but sub-issues were not fully created.
  → REMEDIATION: Re-run /work-on {NUMBER}

IF FORGE:DECOMPOSED:COMPLETE present AND workflow:decomposed label absent:
  → DIAGNOSIS: Decomposition completed but label was not updated (minor state drift).
  → REMEDIATION:
     gh issue edit {NUMBER} $GH_FLAG --add-label "workflow:decomposed"
```

---

## Phase 5: Label Cross-Reference

Validate that workflow labels are consistent with annotation presence. Mismatches indicate a crash mid-phase.

```
Expected label states:
- workflow:investigating → FORGE:INVESTIGATOR present but INVESTIGATION:COMPLETE absent
- workflow:ready-to-build → INVESTIGATION:COMPLETE present, FORGE:CONTRACT absent
- workflow:building → FORGE:CONTRACT present, FORGE:BUILDER absent
- workflow:in-review → FORGE:BUILDER:COMPLETE present, FORGE:TRAJECTORY absent
- workflow:merged → FORGE:TRAJECTORY present, issue closed
- workflow:invalid → issue closed as invalid (no pipeline annotations expected)
- workflow:decomposed → FORGE:DECOMPOSED:COMPLETE present
```

Report any inconsistency between actual labels and expected labels given annotation state. Inconsistencies are not always blockers — they're diagnostic signals.

---

## Phase 6: Output Diagnosis Report

Produce a structured, human-readable report. Present it directly — do NOT post it as a GitHub comment (this command is read-only).

```
╔══════════════════════════════════════════════════════════════╗
║  DIAGNOSIS: Issue #{NUMBER} — {TITLE}
╚══════════════════════════════════════════════════════════════╝

State:    {OPEN|CLOSED}
Labels:   {WORKFLOW_LABELS}
PR:       {#PR_NUMBER (STATE) | none found}

── Annotation Chain ──────────────────────────────────────────

  Phase 1 — Investigation
  ├── FORGE:INVESTIGATOR     {✅ present | ❌ missing}
  └── INVESTIGATION:COMPLETE {✅ complete | ⚠ interrupted | ❌ missing}

  Phase 3C — Builder Contract
  └── FORGE:CONTRACT         {✅ present | ❌ missing}

  Phase 3C.5 — Context
  ├── FORGE:CONTEXT          {✅ present | ❌ missing}
  └── FORGE:CONTEXT:COMPLETE {✅ complete | ⚠ partial (timed out) | ❌ missing}

  Phase 3C.6 — Architecture
  ├── FORGE:ARCHITECT        {✅ present | ❌ missing}
  └── FORGE:ARCHITECT:COMPLETE {✅ complete | ⚠ partial (budget exceeded) | ❌ missing}

  Phase 3M — Build
  ├── FORGE:BUILDER          {✅ present | ❌ missing}
  └── FORGE:BUILDER:COMPLETE {✅ complete | ⚠ incomplete | ❌ missing}

  Phase 5 — Review
  ├── FORGE:REVIEW_STARTED   {✅ present | ❌ missing}
  └── FORGE:REVIEWER (PR)    {✅ present | ⚠ no review found | ❌ no PR}

  Phase 7 — Trajectory
  └── FORGE:TRAJECTORY       {✅ present | ❌ missing}

  Alternative paths
  ├── FORGE:DECOMPOSED        {present | absent}
  ├── FORGE:GATE_FAILED       {present | absent}
  ├── FORGE:PUSH_BLOCKED      {present | absent}
  └── FORGE:ANCESTRY_FAILED   {present | absent}

── Label Consistency ─────────────────────────────────────────

  {For each label, state whether it's consistent with annotation chain}
  {Flag any inconsistencies with ⚠}

── Failure Diagnosis ─────────────────────────────────────────

  FAILURE POINT: {F0–F9 class above | "No failure detected — pipeline complete"}
  FAILURE DESCRIPTION: {One clear sentence explaining what failed and why}

── Remediation ───────────────────────────────────────────────

  {Exact commands to resume the pipeline from the failure point}
  {If needs-human: specific action required and why}

── Notes ─────────────────────────────────────────────────────

  {Any additional context: partial annotations, decomposition sub-issues, etc.}
```

---

## Related Commands

| Command | When to use it instead |
|---------|------------------------|
| `/work-on {NUMBER}` | Resume a stalled pipeline run (most remediations above) |
| `/audit` | Trace a pipeline failure that produced wrong output (not a stall) |
| `/pipeline-health` | Aggregate health metrics across all recent pipeline runs |
| `/cleanup` | Fix stale labels and orphaned issues at scale (not single-issue diagnosis) |
| `/incident-response` | P0 production incidents (not pipeline stalls) |
