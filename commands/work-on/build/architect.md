---
description: Pre-implementation architecture planning — traces ALL affected code paths and produces an ordered implementation plan before any code is written
argument-hint: [issue number] [--repo GH_REPO] [--gh-flag GH_FLAG] [--files AFFECTED_FILES]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/build/architect — Multi-Path Implementation Planning

**Invoked by**: `work-on.md` Step 3C.6, between Context Gathering and Implement.
**Time budget**: Max 3 minutes. Skip any file read that times out.
**Output**: Post `<!-- FORGE:ARCHITECT -->` comment on the issue, then return structured plan to caller.

---

## Mission

Eliminate cross-path inconsistency bugs before any code is written. The single biggest class of production bugs is a change applied to one code path but not all sibling paths that share the same logic. This agent traces the FULL request/data flow from every entry point, identifies every file that must change, and produces an ordered implementation plan the builder follows exactly.

**Principle**: A builder with an explicit plan produces consistent changes. Consistent changes produce zero cross-path review findings.

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required, positional first arg)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--repo-path {REPO_PATH}` — local filesystem path to the worktree (e.g. `/path/to/.claude/worktrees/fix/issue-121`); used by Phase A1 grep commands
- `--files {AFFECTED_FILES}` — space-separated list of files from investigation report (passed by `build.md` Phase B4)

Also read from the calling context (in-memory, passed by parent agent):
- `{INVESTIGATION_REPORT}` — full text of FORGE:INVESTIGATOR comment
- `{CONTEXT_BRIEFING}` — full text of FORGE:CONTEXT comment (empty string if context step was skipped)

If any of these are not passed directly, read them from GitHub (fallback/recovery path):

```bash
# Read investigation report
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'

# Read context briefing (may be absent — that's OK)
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTEXT")) | .body'
```

---

## Resume Check

Before doing any work:

```bash
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:ARCHITECT")) | .body'
```

- If `<!-- FORGE:ARCHITECT -->` comment exists AND `<!-- FORGE:ARCHITECT:COMPLETE -->` is present in the SAME comment → plan already complete, return existing plan to caller, EXIT.
- If `<!-- FORGE:ARCHITECT -->` comment exists BUT `<!-- FORGE:ARCHITECT:COMPLETE -->` is ABSENT → plan was interrupted, delete the partial comment and restart:
  ```bash
  COMMENT_ID=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
    --jq '.[] | select(.body | contains("FORGE:ARCHITECT")) | .id')
  gh api repos/{GH_REPO}/issues/comments/$COMMENT_ID -X DELETE
  ```

---

## Phase A1: Read Entry Points

Identify every entry point that initiates the affected logic. Start from the files named in the investigation report.

For each affected file, read it and identify:
1. The primary function/method being changed
2. All callers of that function (grep for usages)
3. All sibling implementations (same interface, different path — e.g. HTTP vs worker vs relay)

```bash
# Find all callers of the primary function
grep -r "{PRIMARY_FUNCTION}" {REPO_PATH} \
  --include="*.py" --include="*.ts" --include="*.tsx" \
  -l | grep -v "__pycache__" | grep -v ".pyc"

# Find sibling implementations (same base class or interface)
grep -r "class.*{BASE_CLASS}\|implements.*{INTERFACE}" {REPO_PATH} \
  --include="*.py" --include="*.ts" \
  -l | grep -v "__pycache__"
```

Read the 3–5 most relevant files identified. Do NOT read more than 8 files total — this is a planning step, not a deep audit.

---

## Phase A2: Trace the Data Flow

From each entry point identified in A1, trace what happens to the data being changed:

1. **Entry**: Where does the data first arrive? (API endpoint, queue consumer, webhook handler)
2. **Transform**: What functions process it? Which fields are read/written?
3. **Persist or relay**: Is it saved to DB? Forwarded to another service? Queued?
4. **Exit**: Where does it leave the system? (response body, downstream call, emitted event)

For each step in the flow, check:
- Does the proposed change need to propagate here?
- Is there a validation or coercion that must be updated consistently?
- Is there a test that covers this path?

Produce a table of ALL files/functions that must change to maintain consistency.

---

## Phase A2.5: Pipeline Phase-Dependency Check

**Skip if**: None of the `{AFFECTED_FILES}` are Forge pipeline command files (i.e., no file matches `commands/**/*.md`). When skipped, proceed directly to A3.

**Applies when**: The change touches one or more files in `commands/` — these files define the pipeline's phase contracts, and a change to one phase frequently requires coordinated updates to sibling or downstream phases.

### Why This Phase Exists

GATE_LOGIC defects (phase-ordering errors, dropped functionality, missing implementations) are the #1 review finding category in the Forge pipeline. They occur when a change is applied to one pipeline phase but the downstream phases that depend on that phase's output contract are not updated. Code-level grep (A1) cannot catch these because pipeline dependencies are expressed in markdown artefact contracts — comment markers, structured output blocks, Skill() invocation signatures, and label state machine transitions — not in code imports.

### Steps

**P1: Identify artefact contracts produced by the changed file**

For each affected `commands/*.md` file, identify what it produces that other phases consume:

1. **Comment markers** — HTML comment markers the phase writes to GitHub (e.g., `<!-- FORGE:ARCHITECT -->`, `<!-- FORGE:ARCHITECT:COMPLETE -->`). Search for `<!-- FORGE:` patterns in the affected file.
2. **Structured output blocks** — named result blocks returned to the caller (e.g., `BUILD_RESULT:`, `VALIDATE_RESULT:`, `IMPLEMENT_RESULT:`). Search for lines ending in `:` that start a return block.
3. **Skill() invocation signatures** — parameters the file passes when invoking subcommands (e.g., `Skill("work-on:build:architect", args="... --files ...")`). Search for `Skill(` calls.
4. **Label state machine transitions** — `gh issue edit ... --add-label ... --remove-label ...` calls that define which label is set at the end of this phase.

**P2: Find downstream phases that consume these artefacts**

For each artefact identified in P1:

```bash
# Find which pipeline files reference this comment marker or output field
grep -r "{MARKER_OR_FIELD}" /path/to/repo/commands/ \
  --include="*.md" -l | grep -v {AFFECTED_FILE}

# Example: if FORGE:ARCHITECT is the marker
grep -r "FORGE:ARCHITECT" commands/ --include="*.md" -l
```

For each consumer file found: note the file and the specific phase/section that reads the artefact.

**P3: Check for invocation signature changes**

If the change modifies what parameters a phase accepts (adds, removes, or renames a `--flag` in its Inputs section), find all callers:

```bash
grep -r "Skill.*{SUBCOMMAND_NAME}" commands/ --include="*.md" -l
```

For each caller: verify the invocation still matches the new signature. Flag any caller that passes a parameter that is being renamed or removed.

**P4: Emit phase-dependency checklist**

For each downstream phase identified in P2 and P3, emit a checklist item. These items are appended to the `### Consistency Checks` section of the `<!-- FORGE:ARCHITECT -->` comment output:

```
- [ ] {DOWNSTREAM_FILE} Phase {N}: still reads `{ARTEFACT}` correctly after this change
- [ ] {CALLER_FILE} Phase {N}: invocation of `{SUBCOMMAND}` passes correct params after signature change
- [ ] Label state: `{LABEL}` set at end of changed phase matches what `{CONSUMER_FILE}` Phase {N} expects as entry condition
```

If no downstream phases are found (the change is additive only — new sections, new checklist items, no existing contract modified), emit:
```
- [ ] Phase-dependency check: ADDITIVE ONLY — no existing artefact contracts modified; no downstream updates required
```

---

## Phase A3: Consistency Rules

Identify invariants that ALL affected paths must satisfy. These become the builder's consistency checklist.

Common invariants to check:
- **Null handling**: All paths handle missing field the same way (None vs empty string vs omission)
- **Validation**: All paths apply the same size/type/format constraints
- **Logging**: All paths log the same fields at the same level
- **Error response**: All paths return the same error shape for the same failure mode
- **Auth check**: All paths enforce the same permission model

For each invariant: state the rule and note which files it applies to.

---

## Phase A4: Sequence the Implementation

Order the changes to minimize breakage during implementation:

1. **Schema/type changes first** — any shared types, Pydantic models, TypeScript interfaces
2. **Core logic** — the primary path (usually the API router or main function)
3. **Secondary paths** — worker consumers, relay handlers, batch endpoints
4. **Tests** — update or add tests for each changed path
5. **Config/env** — any new environment variables or feature flags

Rules for ordering:
- A file that is imported by others must be changed before its importers
- Tests change last (after the code they test is stable)
- If two paths are independent, order by risk (higher risk first so review catches it early)

---

## Phase A5: Risk Assessment

For each non-obvious interaction or potential failure mode:
- State the risk in one sentence
- Rate it: HIGH / MEDIUM / LOW
- Suggest a mitigation or check

Focus on:
- Files that have changed recently (check `git log --oneline -10 -- {FILE}`)
- Paths that are called in both sync and async contexts
- Any place where the change touches a serialization boundary (JSON in/out, DB read/write)
- Unused or dormant code that the change might activate

---

## Output Format

Post the following as a GitHub comment on `{NUMBER}`:

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ARCHITECT -->
## Implementation Plan for #{NUMBER}

### Affected Paths (ALL must be updated)
| # | File | Function/Class | Change Required | Why |
|---|------|----------------|-----------------|-----|
| 1 | {FILE} | {FUNCTION} | {CHANGE} | {REASON} |

### Implementation Order
1. {FIRST_CHANGE} — {WHY_FIRST}
2. {SECOND_CHANGE} — {WHY_SECOND}
...

### Consistency Checks
<!-- Builder must verify each of these before committing -->
- [ ] {INVARIANT_1}
- [ ] {INVARIANT_2}
- [ ] {INVARIANT_3}

### Risk Assessment
| Risk | Severity | Mitigation |
|------|----------|------------|
| {RISK_DESCRIPTION} | HIGH/MEDIUM/LOW | {MITIGATION} |

### Files to Read Before Coding
<!-- Builder MUST read these files before writing any code -->
- \`{FILE}\` — {WHY_READ_IT}

<!-- FORGE:ARCHITECT:COMPLETE -->
"
```

---

## Timing Rules

- Each file read: skip if the file exceeds 500 lines and only the first 100 lines are needed for structure
- Each `grep -r` call: timeout after 10s, skip if exceeded
- Total wall time budget: **3 minutes**. If budget exceeded, post partial results with `<!-- FORGE:ARCHITECT:PARTIAL -->` marker instead of `COMPLETE`.

---

## Skip Conditions

Skip this entire step (post nothing, return empty plan to caller) if:
- Issue creates only **new files** with no callers to find (e.g. a new command file with no existing integration point yet)
- Issue is a 1-file config or docs edit with no code logic
- Issue title starts with "docs:" or "chore:"
- `{AFFECTED_FILES}` is empty

When skipped, the builder proceeds with investigation report + context briefing only.

---

## Integration Point in work-on.md

This module runs at **Step 3C.6** — after Context Gathering, before Implement:

```
3C    → Builder Contract posted
3C.5  → Context Gathering (FORGE:CONTEXT comment)
3C.6  → [THIS MODULE] Architecture Planning (FORGE:ARCHITECT comment)
3F    → Implement (builder reads plan, implements ALL affected paths)
```

The builder agent reads the `<!-- FORGE:ARCHITECT -->` comment as its **primary input** before writing any code. The raw issue body is secondary context. If the architect step was skipped, the builder falls back to investigation report + contract.
