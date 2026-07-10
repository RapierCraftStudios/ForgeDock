---
description: Build subcommand — create worktree, post contract, sequence context/architect/implement/validate
argument-hint: [issue number] [--repo GH_REPO] [--gh-flag GH_FLAG] [--base PR_BASE]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/build — Build Phase Orchestrator

**Input**: $ARGUMENTS

**Invoked by**: `work-on.md` Phase 3 — entered when the issue carries label `workflow:ready-to-build` or `workflow:building` (see Universal Phase Dispatcher in work-on.md).
**Output**: Create worktree, post contract, run build phases, return result to work-on.md.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

**CRITICAL: You MUST execute ALL phases B0–B6 in order. Phases B3 (context) and B4 (architect) are skipped ONLY when COMPLEXITY_BAND: TRIVIAL (read from FORGE:FAST_PATH comment in Phase B0). For STANDARD and COMPLEX tasks they are NOT optional — skipping them degrades build quality.**

### Canonical Build Path (STANDARD/fast-lane) <!-- Added: forge#1276 -->

**Default execution model: inline.** For STANDARD and fast-lane issues, phases B3 (context gathering) and B4 (architecture planning) run **inline in the current context window** — not as separate `Skill()` sub-agent spawns. B5 (implement) and B6 (validate) also run inline.

`Skill()` invocations for context/architect sub-phases are only permitted when the Spawn-Decision Table (work-on.md `##Spawn-Decision Policy`) explicitly applies — specifically Row (c) (parent context near overflow: ≥20 Skill invocations or ≥10 files already changed before the build sub-phase). For most issues, the Skill() forms shown in B3 and B4 below are **reference documentation** describing the sub-phase contract, not mandatory sub-agent invocations.

**Build topology summary**:

| Path | When | Phases |
|------|------|--------|
| **STANDARD/fast-lane (default)** | All issues not matching exceptions below | B0 → B1 → B2 → B2.5 → [B3] → [B4] → B5 → B6 — all inline |
| **Spawn exception (Row c)** | ≥20 Skill invocations OR ≥10 files changed before build | Spawn B3/B4 as fresh sub-agents via `Skill()` |
| **TRIVIAL fast-path** | COMPLEXITY_BAND: TRIVIAL | Skip B3 and B4 entirely |

This resolves the three-topology conflict: `work-on.md` Phase 3 (inline 3A–3M), `work-on/build.md` (this file), and `work-on-monolithic.md` ([BENCHMARK]) all describe the **same canonical inline path**. `work-on/build.md` adds worktree lifecycle management (B1) and the FORGE:CONTRACT handoff (B2) that the monolithic variant omits for brevity. The `Skill()` forms in B3/B4 below document the sub-phase contract and serve as the exception path only. <!-- Added: forge#1276 -->

<!-- FORGE:SPEC_LOADED — work-on/build.md loaded and active. Agent is bound by this spec. -->

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--base {PR_BASE}` — PR target branch (e.g. `milestone/modular-pipeline-architecture` or `staging`)

**Phase notation**: This file uses **B0–B6** for its own phases. The calling orchestrator (`work-on.md`) uses **3A–3M** for its sub-phases. Mapping: work-on.md Phase 3A = B0 (load state), Phase 3B = complexity classification (posts `FORGE:FAST_PATH` before invoking build), Phase 3C onward maps to B1+ in this file. When cross-references mention "Phase 3B", they refer to work-on.md's Phase 3B, not a phase in this file. <!-- Added: forge#1380 -->

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
- If `<!-- FORGE:BUILDER:COMPLETE -->` is present in a BUILDER comment → build already complete. Return `BUILD_RESULT: status: ALREADY_DONE` to router.
- If `<!-- FORGE:BUILDER -->` exists BUT `<!-- FORGE:BUILDER:COMPLETE -->` is ABSENT → build was interrupted after the comment was posted but before the commit (validate.md V5). Delete the partial comment and restart from Phase B2 (contract): <!-- Added: forge#1305 -->
  ```bash
  PARTIAL_ID=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
    --jq '[.[] | select(.body | contains("FORGE:BUILDER") and (contains("FORGE:BUILDER:COMPLETE") | not))] | last | .id // ""')
  if [ -n "$PARTIAL_ID" ]; then
    gh api repos/{GH_REPO}/issues/comments/$PARTIAL_ID -X DELETE
    echo "Deleted partial FORGE:BUILDER comment (no FORGE:BUILDER:COMPLETE) — restarting build from Phase B2"
  fi
  ```
- If no `<!-- FORGE:INVESTIGATOR -->` comment with `<!-- INVESTIGATION:COMPLETE -->` → EXIT with `BUILD_RESULT: status: BLOCKED`, blocker: "Investigation not complete — run investigate first".

Extract from investigation report:
- Affected files list
- Root cause
- Recommendation
- Task type (Bug Fix / Feature / Refactor / Maintenance / UI/UX / Full-Stack)

**Read COMPLEXITY_BAND** (from `FORGE:FAST_PATH` comment posted by Phase 3B of `work-on.md` — the complexity classification step that runs before invoking this file): <!-- Fixed: forge#1380 -->
```bash
COMPLEXITY_BAND=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:FAST_PATH")) | .body' 2>/dev/null \
  | sed -n 's/.*\*\*COMPLEXITY_BAND\*\*: \([A-Z_]*\).*/\1/p' | head -1)
# Default to STANDARD if not found (conservative — runs full pipeline)
COMPLEXITY_BAND="${COMPLEXITY_BAND:-STANDARD}"
echo "COMPLEXITY_BAND: $COMPLEXITY_BAND"
```

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
  - **Missing ref fallback**: After parsing, verify the Code branch still exists on remote. If not, fall back to the lane default (`staging` for fast lane, `milestone/{slug}` for feature lane) and note the fallback:
    ```bash
    SOURCE_BRANCH="{CODE_BRANCH_FROM_ISSUE_BODY}"
    if ! git ls-remote --exit-code origin "$SOURCE_BRANCH" >/dev/null 2>&1; then
      echo "WARNING: Code branch '$SOURCE_BRANCH' not found on remote — falling back to lane default '$PR_BASE'"
      SOURCE_BRANCH="$PR_BASE"
    fi
    ```
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

### B2.1: Post FORGE:CLAIM on coordination issue (conditional — when running under orchestration batch) <!-- Added: forge#1736 -->

**Skip if**: `FORGE_COORD_ISSUE` is not set (agent is not running under an orchestration batch). This step is a no-op outside of `/orchestrate` dispatch — no error, no output.

**When `FORGE_COORD_ISSUE` is set**: Post a `FORGE:CLAIM` annotation on the coordination issue to advertise this agent's active resource reservation to the orchestrator and peer agents. This enables the claims-board Layer-2/4 relaxation sweep (orchestrate Step 4B) to identify issue-pairs with disjoint file sets and downgrade unnecessary serialization edges.

```bash
if [ -n "${FORGE_COORD_ISSUE:-}" ]; then
  COORD_NUM=$(echo "$FORGE_COORD_ISSUE" | grep -oE '[0-9]+$')
  if [ -n "$COORD_NUM" ]; then
    # Extract file paths from the just-posted FORGE:CONTRACT deliverables table
    CLAIMED_FILES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
      --jq '[.[] | select(.body | contains("FORGE:CONTRACT"))] | last | .body' 2>/dev/null \
      | awk '/^### Deliverables/{p=1; next} /^### /{p=0} p' \
      | grep -oP '`[^`]+\.(py|tsx?|jsx?|sql|json|ya?ml|md|mjs|sh)`' \
      | tr -d '`' | sort -u | tr '\n' '\n' | head -20)
    CLAIMED_FILES="${CLAIMED_FILES:-"(files listed in FORGE:CONTRACT deliverables table)"}"

    # Extract preserved interfaces from the FORGE:ARCHITECT affected paths table (if present)
    CLAIMED_INTERFACES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
      --jq '[.[] | select(.body | contains("FORGE:ARCHITECT"))] | last | .body' 2>/dev/null \
      | awk '/^### Affected Paths/{p=1; next} /^### /{p=0} p' \
      | grep -oP 'Function/Class.*\|.*\|' | head -10 || echo "(see FORGE:ARCHITECT for interface details)")
    CLAIMED_INTERFACES="${CLAIMED_INTERFACES:-"(see FORGE:ARCHITECT comment for interface details)"}"

    CLAIM_HOLDER="#${NUMBER} / $(date -u +%Y%m%dT%H%M%S)"
    CLAIM_TTL="terminal state of Holder issue #${NUMBER}"

    gh issue comment "$COORD_NUM" -R {GH_REPO} --body "<!-- FORGE:CLAIM -->
## Resource Claim

**Holder**: ${CLAIM_HOLDER}
**Files**: ${CLAIMED_FILES}
**Interfaces**: ${CLAIMED_INTERFACES}
**TTL**: ${CLAIM_TTL}

<!-- CLAIM:COMPLETE -->" 2>/dev/null || true
    echo "FORGE:CLAIM posted on coordination issue #${COORD_NUM} for #${NUMBER}"
  fi
fi
```

**After posting**: Continue to Phase B2.5. The claim is now visible to the orchestrator and peer agents. The orchestrator's claims-board relaxation sweep (orchestrate Step 4B) will read this claim when determining whether serialized peers can be unblocked.

---

## Phase B2.5: Extract FUNCTION_NAMES from Contract

After posting the Builder Contract, extract the primary function/class names from the contract's deliverables table. These are passed to the context subcommand for Phase C3 caller/importer discovery.

```bash
FUNCTION_NAMES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTRACT")) | .body' \
  | awk '/^### Deliverables/{p=1; next} /^### /{p=0} p' \
  | grep -oE '`[A-Za-z_][A-Za-z0-9_]*`' \
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

## Phase B3: Context Gathering (MANDATORY for STANDARD/COMPLEX — skip for TRIVIAL)

**Skip if COMPLEXITY_BAND: TRIVIAL** (read from FORGE:FAST_PATH in Phase B0) — skip this phase entirely. Proceed directly to Phase B4.

**For STANDARD and COMPLEX tasks**: Always run. Do NOT skip without a TRIVIAL COMPLEXITY_BAND.

**Execution model**: Run **inline** (see Canonical Build Path above). Read the `commands/work-on/build/context.md` spec and execute its steps directly in this context window. Only spawn a Skill() sub-agent when the Spawn-Decision Table Row (c) applies (≥20 prior Skill invocations or ≥10 files already changed). <!-- Added: forge#1276 -->

Surface historical review findings and bug patterns for the affected files. The full step-by-step logic is defined in `commands/work-on/build/context.md`. Key steps: search closed issues with `review-finding` label on the affected files; check git log for past bug patterns; synthesize a `FORGE:CONTEXT` annotation and post it as a GitHub comment.

**Spawn exception** (only when Row (c) applies):
```
Skill("work-on:build:context", args="{NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --repo-path {WORKTREE_PATH} {AFFECTED_FILES} --functions {FUNCTION_NAMES}")
```
If `FUNCTION_NAMES` is empty, omit `--functions`. The Skill() form above is the exception path — not the default. <!-- Added: forge#1276 -->

**After context gathering**:
- Structured context briefing produced (or no relevant history found) → continue to B4
- Context gathering timed out or errored → log warning, continue to B4 with empty context (non-blocking)
# MUST CONTINUE to Phase B4 — context result is intermediate, NOT terminal.

---

## Phase B4: Architecture Planning (MANDATORY for STANDARD/COMPLEX — skip for TRIVIAL)

**Skip if COMPLEXITY_BAND: TRIVIAL** (read from FORGE:FAST_PATH in Phase B0) — skip this phase entirely. Proceed directly to Phase B5.

**For STANDARD and COMPLEX tasks**: Always run. Even a 1-file STANDARD fix benefits from cross-path consistency checks. Do NOT skip without a TRIVIAL COMPLEXITY_BAND.

**Execution model**: Run **inline** (see Canonical Build Path above). Read the `commands/work-on/build/architect.md` spec and execute its steps directly in this context window. Only spawn a Skill() sub-agent when the Spawn-Decision Table Row (c) applies. <!-- Added: forge#1276 -->

Trace all affected code paths and produce an ordered implementation plan. The full step-by-step logic is defined in `commands/work-on/build/architect.md`. Key steps: map all callers and importers of changed functions; check consistency rules across paths; post a `FORGE:ARCHITECT` annotation with the ordered plan and a risk table.

**Spawn exception** (only when Row (c) applies):
```
Skill("work-on:build:architect", args="{NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --repo-path {WORKTREE_PATH} --files {AFFECTED_FILES}")
```
The Skill() form above is the exception path — not the default. <!-- Added: forge#1276 -->

**After architecture planning**:
- Returns ordered implementation plan → continue to B5
- BLOCKED (conflicting constraints that cannot be resolved inline) → post comment, add `needs-human`, return `BUILD_RESULT: status: BLOCKED`
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
- `VALIDATE_RESULT: gate_passed: true` → continue to Phase B6.5 (acceptance gate)
- `VALIDATE_RESULT: gate_passed: false` → subcommand has already posted comment and added `needs-human` label; return `BUILD_RESULT: status: BLOCKED`

---

## Phase B6.5: Acceptance Gate (MANDATORY — cannot be silently skipped) <!-- Added: forge#1315 -->

**Goal**: Execute the machine-checkable acceptance spec emitted by investigate Phase 1C and block merge if any check fails. This is a hard gate — not advisory.

**Read acceptance spec from FORGE:INVESTIGATOR comment**:

```bash
ACCEPTANCE_CHECKS=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' \
  | grep "^ACCEPTANCE_CHECK:" )
```

**If `ACCEPTANCE_CHECKS` is empty** (investigation predates this feature or comment was deleted): post a warning comment and **block** — do not silently pass:

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — No Spec Found

No \`ACCEPTANCE_CHECK:\` lines found in the FORGE:INVESTIGATOR comment. This may mean:
- The investigation was run before acceptance spec emission was added (re-run investigate to generate the spec), or
- The investigator comment was deleted.

**Gate result: BLOCKED** — re-run \`/work-on:investigate {NUMBER}\` to regenerate the acceptance spec, then retry the build.

<!-- FORGE:ACCEPTANCE_GATE:BLOCKED -->"
gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
```
Return `BUILD_RESULT: status: BLOCKED`, blocker: "No acceptance spec — re-run investigate to emit ACCEPTANCE_CHECK lines".

**If all checks are `type=skipped`**: post a pass comment noting human review is required, then continue to the checkpoint (non-blocking — skip was deliberate):

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — Skipped (No Machine-Checkable Criteria)

The acceptance spec contains only a skip sentinel (\`type=skipped\`). No automated checks were run. Human review is required before merge.

<!-- FORGE:ACCEPTANCE_GATE:PASSED -->"
```

**Otherwise — execute each check**:

```bash
GATE_PASS=true
FAILED_CHECKS=""

while IFS= read -r check_line; do
  ID=$(echo "$check_line"    | sed -n 's/.*id=\([^ ]*\).*/\1/p')
  TYPE=$(echo "$check_line"  | sed -n 's/.*type=\([^ ]*\).*/\1/p')
  TARGET=$(echo "$check_line"| sed -n 's/.*target=\([^ ]*\).*/\1/p')
  MATCHER=$(echo "$check_line"| sed -n 's/.*matcher=\([^ ]*\).*/\1/p')
  DESC=$(echo "$check_line"  | sed -n 's/.*description=\(.*\)/\1/p')

  [ "$TYPE" = "skipped" ] && continue

  RESULT="PASS"
  DETAIL=""

  case "$TYPE" in
    exists)
      [ -e "$TARGET" ] || { RESULT="FAIL"; DETAIL="path not found: $TARGET"; }
      ;;
    contains)
      grep -qE "$MATCHER" "$TARGET" 2>/dev/null || { RESULT="FAIL"; DETAIL="'$MATCHER' not found in $TARGET"; }
      ;;
    command|behavior)
      if [ "$MATCHER" = "exit_0" ]; then
        eval "$TARGET" >/dev/null 2>&1 || { RESULT="FAIL"; DETAIL="command exited non-zero: $TARGET"; }
      else
        OUTPUT=$(eval "$TARGET" 2>&1)
        echo "$OUTPUT" | grep -qE "$MATCHER" || { RESULT="FAIL"; DETAIL="output did not match '$MATCHER'. Got: $(echo "$OUTPUT" | head -3)"; }
      fi
      ;;
    *)
      RESULT="FAIL"; DETAIL="unknown check type: $TYPE"
      ;;
  esac

  if [ "$RESULT" = "FAIL" ]; then
    GATE_PASS=false
    FAILED_CHECKS="${FAILED_CHECKS}\n- **$ID** ($DESC): $DETAIL"
  fi
done <<< "$ACCEPTANCE_CHECKS"
```

**Post gate result comment**:

```bash
if [ "$GATE_PASS" = "true" ]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — PASSED

All machine-checkable acceptance criteria verified against real behavior.

<!-- FORGE:ACCEPTANCE_GATE:PASSED -->"
else
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ACCEPTANCE_GATE -->
## Acceptance Gate — FAILED

The following acceptance checks did not pass:

$(echo -e "$FAILED_CHECKS")

Merge is blocked. Fix the failing criteria and re-run the validate phase.

<!-- FORGE:ACCEPTANCE_GATE:FAILED -->"
  gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
  # Return BLOCKED — merge gate failed
fi
```

If `GATE_PASS = false`: return `BUILD_RESULT: status: BLOCKED`, blocker: "Acceptance gate failed — see FORGE:ACCEPTANCE_GATE comment".

If `GATE_PASS = true`: continue to write the phase checkpoint below.

**When gate_passed is true — write machine-readable phase checkpoint before returning (MANDATORY)**:
```bash
CHECKPOINT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CHECKPOINT -->
\`\`\`json
{\"phase\": \"BUILD\", \"status\": \"COMPLETE\", \"next_phase\": \"REVIEW\", \"timestamp\": \"${CHECKPOINT_TIMESTAMP}\"}
\`\`\`"
```

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

This module runs during **Phase 3** of the work-on.md pipeline (label: `workflow:ready-to-build` or `workflow:building`). The full sequence is defined by the Universal Phase Dispatcher in work-on.md:

```
Phase 3 (Build)   → [THIS MODULE] worktree + contract + context + architect + implement + validate + acceptance-gate
                  → posts FORGE:BUILDER comment + FORGE:ACCEPTANCE_GATE comment, writes FORGE:CHECKPOINT next_phase=REVIEW
Phase 4 (PR)      → work-on:review — push branch, create PR, set workflow:in-review
Phase 5 (Review)  → work-on:review — invoke /review-pr --auto-merge
Phase 6 (Close)   → work-on:close — trajectory + parent tracker + summary + worktree cleanup
```

After this module posts `FORGE:BUILDER` and returns, work-on.md's Universal continuation rule re-reads the issue labels. Since the label is not yet terminal (`workflow:merged` / `workflow:invalid` / `needs-human`), it proceeds immediately to Phase 4 (PR Creation) and then Phase 5 (Auto-Review).
