---
description: Build subcommand — create worktree, post contract, sequence context/architect/implement/validate
argument-hint: [issue number] [--repo GH_REPO] [--gh-flag GH_FLAG] [--base PR_BASE]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/build — Build Phase Orchestrator

**Input**: $ARGUMENTS

**Invoked by**: `work-on.md` state 8 (READY_TO_BUILD).
**Output**: Create worktree, post contract, sequence build subcommands, return result to router.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.
**NEVER use plan mode (EnterPlanMode).**

**CRITICAL: You MUST execute ALL phases B0–B6 in order. After each Skill() call returns, you MUST continue to the next phase. Do NOT skip phases B3 (context) or B4 (architect) — they post mandatory `FORGE:CONTEXT` and `FORGE:ARCHITECT` comments that the implement phase reads as its primary input. Skipping them degrades build quality.**

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--base {PR_BASE}` — PR target branch (e.g. `milestone/modular-pipeline-architecture` or `staging`)

---

## Phase B0: Load State from GitHub (MANDATORY)

Re-read current state before doing anything:

```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,milestone

# Check investigation report
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'

# Check if build already completed
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:BUILDER")) | .body'
```

**Resume check**:
- If `<!-- FORGE:BUILDER -->` comment exists → build already complete. Return `BUILD_RESULT: status: ALREADY_DONE` to router.
- If no `<!-- FORGE:INVESTIGATOR -->` comment with `<!-- INVESTIGATION:COMPLETE -->` → EXIT with `BUILD_RESULT: status: BLOCKED`, blocker: "Investigation not complete — run investigate first".

Extract from investigation report:
- Affected files list
- Root cause
- Recommendation
- Task type (Bug Fix / Feature / Refactor / Maintenance / UI/UX / Full-Stack)

---

## Phase B1: Create Worktree & Branch

### B1A: Derive branch name

From issue title: lowercase, hyphenated, max 40 chars (truncate if needed).
- Bug / fix issues → prefix `fix/`
- Feature issues → prefix `feat/`
- Refactor / maintenance → prefix `fix/` or `refactor/`

Append `-{NUMBER}` to ensure uniqueness: e.g. `fix/work-on-build-landing-file-85`.

### B1B: Determine source branch

- Review-finding issue → parse `**Code branch**: \`{branch}\`` from issue body; branch from `origin/{branch}`
  - **Milestone review-finding hybrid lane** (ONLY when Code branch matches `milestone/*`): This is a high-risk lane. The worktree will carry the full milestone history. The PR target is `staging` (or the base specified). **DANGER: Agents MUST NOT use `git merge` to resolve any conflicts in this lane.** Merge-based conflict resolution will pull the entire milestone commit tree onto staging, contaminating it with unapproved code. Use `git rebase` or `git cherry-pick` only. If conflicts cannot be resolved without a merge, post a comment on the issue, add `needs-human`, and STOP.
- Feature lane (has milestone) → branch from `origin/{PR_BASE}`
- Fast lane (no milestone) → branch from `origin/staging`

### B1C: Create worktree

```bash
WORKTREE_PATH="/path/to/repo/.claude/worktrees/{BRANCH_SLUG}"
git worktree add {WORKTREE_PATH} -b {BRANCH} origin/{SOURCE_BRANCH}
```

If worktree already exists at that path:
```bash
# Reuse existing worktree — verify it's on the correct branch
git -C {WORKTREE_PATH} branch --show-current
```
If wrong branch, remove and recreate:
```bash
git worktree remove {WORKTREE_PATH} --force
git worktree add {WORKTREE_PATH} -b {BRANCH} origin/{SOURCE_BRANCH}
```

### B1D: Set building label

```bash
gh issue edit {NUMBER} {GH_FLAG} \
  --add-label "workflow:building" \
  --remove-label "workflow:ready-to-build"
```

---

## Phase B2: Post Builder Contract

Post `<!-- FORGE:CONTRACT -->` comment documenting what will be built and why:

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CONTRACT -->
## Builder Contract

**Task type**: {TASK_TYPE}

### Proposed Approach

{BRIEF_APPROACH_DESCRIPTION}

### Deliverables

| File | Change | Why |
|------|--------|-----|
{DELIVERABLES_ROWS}

### Acceptance Criteria

{ACCEPTANCE_CRITERIA_CHECKLIST}

### Quality Considerations

{AUTH_MODEL_NEW_ENV_VARS_SQL_SAFETY_SECURITY_SURFACE}

### Out of Scope

{OUT_OF_SCOPE_ITEMS}"
```

Contract must be grounded in the investigation report. Every deliverable file must appear in the affected files list from the investigator. Adversarially validate the proposed fix against adjacent system layers before posting.

---

## Phase B2.5: Extract FUNCTION_NAMES from Contract

After posting the Builder Contract, extract the primary function/class names from the contract's deliverables table. These are passed to the context subcommand for Phase C3 caller/importer discovery.

```bash
FUNCTION_NAMES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTRACT")) | .body' \
  | awk '/^### Deliverables/{p=1; next} /^### /{p=0} p' \
  | grep -oP '`[A-Za-z_][A-Za-z0-9_]*`' \
  | tr -d '`' \
  | sort -u \
  | tr '\n' ' ' \
  | xargs)
# Scope is limited to the ### Deliverables section to avoid false matches from FORGE markers,
# phase labels (B2, C3), and identifiers mentioned in Acceptance Criteria or Quality sections.
# Fallback: if extraction yields nothing, FUNCTION_NAMES remains empty string
# context.md Phase C3 skips gracefully when FUNCTION_NAMES is empty (for-loop produces zero iterations)
```

If `FUNCTION_NAMES` is non-empty, it will be passed via `--functions` to the context subcommand. If empty, the `--functions` flag is omitted — Phase C3 will naturally skip with zero iterations and no error.

---

## Phase B3: Context Gathering (MANDATORY Subcommand)

**This phase is NOT optional.** Always invoke it regardless of issue size or complexity. Do NOT invent skip heuristics (e.g. "FAST_PATH") — the context subcommand handles trivial cases gracefully and returns quickly.

Invoke the context subcommand to surface historical review findings and bug patterns:

```
Skill("work-on:build:context", args="{NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --repo-path {WORKTREE_PATH} {AFFECTED_FILES} --functions {FUNCTION_NAMES}")
```

If `FUNCTION_NAMES` is empty, omit the `--functions` flag entirely:

```
Skill("work-on:build:context", args="{NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --repo-path {WORKTREE_PATH} {AFFECTED_FILES}")
```

**After subcommand returns**:
- Returns structured context briefing (or indicates no relevant history) → continue to B4
- If subcommand times out or errors → log warning, continue to B4 with empty context (non-blocking)
# MUST CONTINUE to Phase B4 — context result is intermediate, NOT terminal.

---

## Phase B4: Architecture Planning (MANDATORY Subcommand)

**This phase is NOT optional.** Always invoke it regardless of issue size or complexity. Do NOT invent skip heuristics — the architect subcommand handles simple changes gracefully and returns quickly. Even a 1-file fix benefits from cross-path consistency checks.

Invoke the architect subcommand to trace all affected code paths and produce an ordered implementation plan:

```
Skill("work-on:build:architect", args="{NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --repo-path {WORKTREE_PATH} --files {AFFECTED_FILES}")
```

**After subcommand returns**:
- Returns ordered implementation plan → continue to B5
- If subcommand returns BLOCKED → post comment, add `needs-human`, return `BUILD_RESULT: status: BLOCKED`
# MUST CONTINUE to Phase B5 — architect result is intermediate, NOT terminal.

---

## Phase B5: Implementation (Subcommand)

Invoke the implement subcommand to write code, stage, and post the builder comment:

```
Skill("work-on:build:implement", args="{NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --worktree {WORKTREE_PATH} --branch {BRANCH}")
```

**After subcommand returns**:
- `IMPLEMENT_RESULT: status: COMPLETE` → continue to B6
- `IMPLEMENT_RESULT: status: ALREADY_DONE` → skip to B6 (validate what's already there)
- `IMPLEMENT_RESULT: status: INVESTIGATION_COMPLETE` → issues created as deliverables; return `BUILD_RESULT: status: INVESTIGATION_COMPLETE`
- `IMPLEMENT_RESULT: status: BLOCKED` → post comment with blocker description, add `needs-human`, return `BUILD_RESULT: status: BLOCKED`
# MUST CONTINUE to Phase B6 — implement result is intermediate, NOT terminal (validation still required).

---

## Phase B6: Validation (Subcommand)

Invoke the validate subcommand to run the quality gate loop, formatting, and deploy checks:

```
Skill("work-on:build:validate", args="{NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --worktree {WORKTREE_PATH} --files {CHANGED_FILES}")
```

Where `{CHANGED_FILES}` is the space-separated list of files changed by the implement subcommand (read from `IMPLEMENT_RESULT` or from the `<!-- FORGE:BUILDER -->` comment).

**After subcommand returns**:
- `VALIDATE_RESULT: gate_passed: true` → build complete, return `BUILD_RESULT: status: COMPLETE`
- `VALIDATE_RESULT: gate_passed: false` → subcommand has already posted comment and added `needs-human` label; return `BUILD_RESULT: status: BLOCKED`

---

## Output

Output this structured block — the routing loop in `work-on.md` will read this result, re-evaluate state, and continue to the next phase. This subcommand is complete; control returns to the router's loop iteration.

```
BUILD_RESULT:
  status: COMPLETE | ALREADY_DONE | INVESTIGATION_COMPLETE | BLOCKED
  branch: {BRANCH}
  worktree: {WORKTREE_PATH}
  blocker: {description if status=BLOCKED}
```

---

## Integration Point in work-on.md

This module runs at **state 8 (READY_TO_BUILD)** in the routing loop:

```
state 8 → [THIS MODULE] worktree + contract + context + architect + implement + validate
        → BUILD_RESULT: COMPLETE
states 7, 6 → work-on:review (push + PR + /review-pr --auto-merge)
states 5, 4 → work-on:close (trajectory + parent tracker + summary)
```

The router re-reads GitHub state after this module returns COMPLETE — it will then detect state 6 (IN_REVIEW) or 7 (BUILD_NO_PR) and invoke `work-on:review`.
