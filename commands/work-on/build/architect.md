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

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet", `effort: xhigh` (deep tier — full code-path tracing, multi-file architecture planning). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — work-on/build/architect.md loaded and active. Agent is bound by this spec. -->

---

## COMPLEXITY_BAND Guard (check BEFORE all phases)

Read COMPLEXITY_BAND from the `<!-- FORGE:FAST_PATH -->` comment on the issue:

```bash
COMPLEXITY_BAND=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:FAST_PATH")) | .body' 2>/dev/null \
  | sed -n 's/.*\*\*COMPLEXITY_BAND\*\*: \([A-Z_]*\).*/\1/p' | head -1)
COMPLEXITY_BAND="${COMPLEXITY_BAND:-STANDARD}"
```

**If COMPLEXITY_BAND: TRIVIAL** → skip all phases (A0 through A5), post NO comment, return empty plan to caller immediately. Do not read any files. This is not an error — trivial single-file changes have no cross-path consistency risk. <!-- Added: forge#679 -->

**If COMPLEXITY_BAND: STANDARD or COMPLEX** → proceed to Phase A0 below.

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
- `{MEMORY_PRIORS}` — structured prior run blocks emitted by investigate Phase 0.5 (empty string if no priors found or investigate predates memory). When non-empty, treat each `[MEMORY PRIOR]` block as a high-confidence prior: if any prior's affected files overlap with the current plan's affected files, explicitly note the prior's root cause and key lesson in the FORGE:ARCHITECT comment's **Prior Run Priors** section (add this section after **Context Briefing** when priors exist). <!-- Added: forge#1316 -->

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

## Phase A0: Read Custom Instructions and Project Conventions

Read project-resident authoritative docs **before** any code path tracing. `project/custom-instructions.md` has the highest precedence of all knowledge sources — its directives are BINDING and override agent defaults, training knowledge, and all other context. Other applicable `project/*.md` files provide authoritative project conventions the architect must enforce.

**Time budget**: 30 seconds. If exceeded, log a skip note and continue to Phase A1.

**Skip if**: `{REPO_PATH}` is not set, devdocs path does not exist, or path contains no markdown files.

### Step 0: Resolve devdocs path

Read `forge.yaml → devdocs.path` from the project root. Default to `devdocs` if the key is absent or unreadable.

```bash
DEVDOCS_PATH=""

FORGE_YAML_PATH="{REPO_PATH}/forge.yaml"

if [ -f "$FORGE_YAML_PATH" ]; then
  DEVDOCS_REL=$(grep -A5 '^devdocs:' "$FORGE_YAML_PATH" \
    | grep '^\s*path:' \
    | head -1 \
    | sed 's/.*path:\s*//' \
    | tr -d '"'"'"' \
    | tr -d '[:space:]')
fi

DEVDOCS_REL="${DEVDOCS_REL:-devdocs}"
DEVDOCS_PATH="{REPO_PATH}/${DEVDOCS_REL}"

if [ ! -d "$DEVDOCS_PATH" ]; then
  echo "Devdocs path '${DEVDOCS_PATH}' does not exist — skipping Phase A0 (no blocking)"
  DEVDOCS_PATH=""
fi
```

> **Note**: `devdocs/` must be tracked in git for the worktree to contain it. If the project gitignores `devdocs/`, the path will not exist in the worktree and this phase silently skips — this is by design. Run `git check-ignore -v devdocs/` to confirm tracking status.

### Step 1: Priority read — custom instructions (HIGHEST PRECEDENCE)

Always read `project/custom-instructions.md` first if it exists. Directives in this file are BINDING — they override everything else.

```bash
CUSTOM_INSTRUCTIONS=""

if [ -n "$DEVDOCS_PATH" ]; then
  CUSTOM_INSTRUCTIONS_FILE="${DEVDOCS_PATH}/project/custom-instructions.md"
  if [ -f "$CUSTOM_INSTRUCTIONS_FILE" ]; then
    TOTAL_LINES=$(wc -l < "$CUSTOM_INSTRUCTIONS_FILE" 2>/dev/null || echo 0)
    if [ "$TOTAL_LINES" -gt 200 ]; then
      CUSTOM_INSTRUCTIONS=$(head -200 "$CUSTOM_INSTRUCTIONS_FILE")
      CUSTOM_INSTRUCTIONS="${CUSTOM_INSTRUCTIONS}

_[Truncated at 200 lines — ${TOTAL_LINES} total. Read full file for complete directives.]_"
    else
      CUSTOM_INSTRUCTIONS=$(cat "$CUSTOM_INSTRUCTIONS_FILE")
    fi
  fi
fi
```

### Step 2: Secondary reads — other applicable project files

**Index-first path** (preferred when `index.yaml` exists): Use domain-filtered selective loading instead of O(N) enumerate. Falls back to full enumerate when index is absent. Skip `project/custom-instructions.md` (already read in Step 1). Sort by authority (`required` first).

```bash
PROJECT_CONVENTIONS=""
INDEX_PATH="${DEVDOCS_PATH}/index.yaml"

# --- Read devdocs.index_path override from forge.yaml (optional) ---
if [ -f "$FORGE_YAML_PATH" ]; then
  INDEX_PATH_OVERRIDE=$(grep -A5 '^devdocs:' "$FORGE_YAML_PATH" \
    | grep '^\s*index_path:' \
    | head -1 \
    | sed 's/.*index_path:\s*//' \
    | tr -d '"'"'"' \
    | tr -d '[:space:]')
  if [ -n "$INDEX_PATH_OVERRIDE" ]; then
    case "$INDEX_PATH_OVERRIDE" in
      /*) INDEX_PATH="$INDEX_PATH_OVERRIDE" ;;
      *)  INDEX_PATH="{REPO_PATH}/${INDEX_PATH_OVERRIDE}" ;;
    esac
  fi
fi

if [ -n "$DEVDOCS_PATH" ] && [ -f "$INDEX_PATH" ]; then
  # --- Index-first loading path ---
  echo "Devdocs index found at ${INDEX_PATH} — using selective domain loading"

  # Read issue labels to determine domain(s)
  ISSUE_LABELS=$(gh issue view {NUMBER} -R {GH_REPO} --json labels \
    --jq '[.labels[].name] | join(" ")' 2>/dev/null || echo "")
  echo "Issue labels: ${ISSUE_LABELS:-none}"
  # Separate newline-joined list for the loop below — GitHub label names CAN
  # contain spaces (e.g. "good first issue"), so the space-joined $ISSUE_LABELS
  # above is only safe for display, never for iteration.
  ISSUE_LABELS_LIST=$(gh issue view {NUMBER} -R {GH_REPO} --json labels \
    --jq '.labels[].name' 2>/dev/null || echo "")

  # Read index content
  INDEX_CONTENT=$(cat "$INDEX_PATH" 2>/dev/null || echo "")

  # Extract always_load paths (lines with "path:" under "always_load:" block)
  ALWAYS_LOAD_PATHS=$(echo "$INDEX_CONTENT" \
    | awk '/^always_load:/,/^[a-z]/' \
    | grep '^\s*-\s*path:' \
    | sed 's/.*path:\s*//' \
    | tr -d '"'"'"' \
    | tr -d '[:space:]')

  # Extract domain blocks matching any issue label keyword
  DOMAIN_PATHS=""
  # $ISSUE_LABELS_LIST is one label per line — herestring (not a piped
  # `| while read`, which would run the loop body in a subshell and discard
  # DOMAIN_PATHS once the loop exits) preserves newline-safety for labels
  # containing spaces.
  while IFS= read -r label; do
    [ -z "$label" ] && continue
    KEYWORD=$(echo "$label" | sed 's/^workflow://; s/^priority://; s/^review-finding$//')
    [ -z "$KEYWORD" ] && continue
    # Sanitize KEYWORD before AWK injection — strip chars that would break awk regex delimiters
    SAFE_KEYWORD=$(printf '%s' "$KEYWORD" | tr -cd 'a-zA-Z0-9_-')
    [ -z "$SAFE_KEYWORD" ] && continue

    BLOCK_PATHS=$(echo "$INDEX_CONTENT" \
      | awk "/^  ${SAFE_KEYWORD}:/{found=1; next} found && /^  [a-z]/{found=0} found && /^\s*-\s*path:/{print}" \
      | sed 's/.*path:\s*//' \
      | tr -d '"'"'"' \
      | tr -d '[:space:]')

    if [ -n "$BLOCK_PATHS" ]; then
      echo "Domain '${SAFE_KEYWORD}' matched — adding docs: $(echo "$BLOCK_PATHS" | tr '\n' ' ')"
      DOMAIN_PATHS="${DOMAIN_PATHS}${BLOCK_PATHS}"$'\n'
    fi
  done <<< "$ISSUE_LABELS_LIST"

  # Combine always_load + domain paths (deduplicate)
  ALL_PATHS=$(printf "%s\n%s" "$ALWAYS_LOAD_PATHS" "$DOMAIN_PATHS" \
    | grep -v '^$' | sort -u)

  # When no domain labels matched, load only always_load entries
  if [ -z "$DOMAIN_PATHS" ]; then
    echo "No domain labels matched index — loading always_load entries only"
    ALL_PATHS="$ALWAYS_LOAD_PATHS"
  fi

  APPLICABLE_FILES=""
  while IFS= read -r rel_path; do
    [ -z "$rel_path" ] && continue
    # Skip custom-instructions — already read in Step 1
    [ "$rel_path" = "project/custom-instructions.md" ] && continue
    ABS_PATH="${DEVDOCS_PATH}/${rel_path}"
    [ -f "$ABS_PATH" ] || { echo "WARN: index references missing file: ${rel_path} — skipping"; continue; }

    FRONTMATTER=$(awk '/^---/{c++; if(c==1){next} if(c==2){exit}} c==1{print}' "$ABS_PATH" 2>/dev/null)
    AUTHORITY=$(echo "$FRONTMATTER" | grep 'authority:' | head -1 | sed 's/.*authority:\s*//' | tr -d ' ')
    case "$AUTHORITY" in
      required)    SORT_KEY="1" ;;
      recommended) SORT_KEY="2" ;;
      *)           SORT_KEY="3" ;;
    esac
    APPLICABLE_FILES="${APPLICABLE_FILES}${SORT_KEY}|${ABS_PATH}"$'\n'
  done <<< "$ALL_PATHS"

  APPLICABLE_FILES=$(printf "%s" "$APPLICABLE_FILES" | sort | cut -d'|' -f2-)

elif [ -n "$DEVDOCS_PATH" ]; then
  # --- Fallback: O(N) enumerate (backward compatible — no index.yaml present) ---
  echo "No index.yaml found at ${INDEX_PATH} — falling back to full enumerate (backward compatible)"

  APPLICABLE_FILES=""

  while IFS= read -r -d '' mdfile; do
    # Skip custom-instructions — already read as priority
    [ "$mdfile" = "${DEVDOCS_PATH}/project/custom-instructions.md" ] && continue

    FRONTMATTER=$(awk '/^---/{c++; if(c==1){next} if(c==2){exit}} c==1{print}' "$mdfile" 2>/dev/null)

    if echo "$FRONTMATTER" | grep -q 'applies_to:.*work-on'; then
      AUTHORITY=$(echo "$FRONTMATTER" | grep 'authority:' | head -1 | sed 's/.*authority:\s*//' | tr -d ' ')
      case "$AUTHORITY" in
        required)    SORT_KEY="1" ;;
        recommended) SORT_KEY="2" ;;
        *)           SORT_KEY="3" ;;
      esac
      APPLICABLE_FILES="${APPLICABLE_FILES}${SORT_KEY}|${mdfile}"$'\n'
    fi
  done < <(find "$DEVDOCS_PATH" -name "*.md" -print0 2>/dev/null)

  APPLICABLE_FILES=$(printf "$APPLICABLE_FILES" | sort | cut -d'|' -f2-)
fi

while IFS= read -r mdfile; do
  [ -z "$mdfile" ] && continue
  TOTAL_LINES=$(wc -l < "$mdfile" 2>/dev/null || echo 0)
  if [ "$TOTAL_LINES" -gt 200 ]; then
    FILE_CONTENT=$(head -200 "$mdfile")
    TRUNCATION_NOTE="_[Truncated at 200 lines — ${TOTAL_LINES} total.]_"
  else
    FILE_CONTENT=$(cat "$mdfile")
    TRUNCATION_NOTE=""
  fi

  REL_PATH="${mdfile#${DEVDOCS_PATH}/}"
  PROJECT_CONVENTIONS="${PROJECT_CONVENTIONS}

#### \`${REL_PATH}\`
${FILE_CONTENT}
${TRUNCATION_NOTE}"
done <<< "$APPLICABLE_FILES"

### Step 3: Precedence rules to enforce

When `CUSTOM_INSTRUCTIONS` or `PROJECT_CONVENTIONS` is non-empty, the architect MUST apply them throughout the plan. The precedence order is:

```
project/custom-instructions.md  ← HIGHEST PRIORITY (binding directives)
    ↑
other project/*.md              ← Authoritative project conventions
agent/*.md                      ← ForgeDock/GitHub usage instructions
agent memory                    ← Recalled knowledge
agent defaults                  ← Built-in behaviors
    ↓ LOWEST PRIORITY
```

`CUSTOM_INSTRUCTIONS` and `PROJECT_CONVENTIONS` are used in the `### Custom Instructions (HIGHEST PRECEDENCE)` and `### Project Conventions` sections of the FORGE:ARCHITECT output. If both are empty (devdocs path absent), these sections are replaced with skip notes.

---

## Phase A1.5: Prior Decision Injection (MANDATORY for STANDARD/COMPLEX — skip for TRIVIAL) <!-- Added: forge#1737 -->

**Purpose**: Surface ADRs from prior pipeline runs whose anchor paths overlap the contract files before any code is written. Architect plans open with binding prior decisions ("prior decision NNN: chose process substitution over pipes because pipe-RHS subshell loss — #1689") so tradeoffs are not silently re-litigated.

**Skip if**: COMPLEXITY_BAND: TRIVIAL OR `devdocs/decisions/` does not exist at `{REPO_PATH}/devdocs/decisions/` OR the directory is empty.

**Token budget**: ≤300 tokens total (max 3 ADRs × ~100 tokens each). Truncate each ADR body to first 20 lines.

```bash
DECISIONS_DIR="{REPO_PATH}/devdocs/decisions"

if [ -d "$DECISIONS_DIR" ] && [ -n "$(ls -A "$DECISIONS_DIR" 2>/dev/null | grep -v '\.gitkeep')" ]; then
  echo "Scanning $DECISIONS_DIR for ADRs overlapping contract files..."

  # Build list of contract file basenames for anchor matching
  IFS=' ' read -ra CONTRACT_FILES_ARR <<< "{AFFECTED_FILES}"
  MATCHED_ADRS=()
  ADR_COUNT=0

  for adr_file in "$DECISIONS_DIR"/*.md; do
    [ -f "$adr_file" ] || continue
    # Skip needs-review ADRs — anchor is dead, don't inject as constraints
    if grep -q "^status: needs-review" "$adr_file" 2>/dev/null; then
      echo "  Skipped (needs-review): $(basename $adr_file)"
      continue
    fi
    # Check if this ADR's anchor path overlaps any contract file
    ANCHOR=$(grep "^anchor:" "$adr_file" 2>/dev/null | head -1 | sed 's/^anchor:\s*//')
    if [ -z "$ANCHOR" ]; then continue; fi

    for contract_file in "${CONTRACT_FILES_ARR[@]}"; do
      if echo "$ANCHOR" | grep -qF "$(basename "$contract_file" | cut -d. -f1)" || \
         echo "$contract_file" | grep -qF "$ANCHOR"; then
        MATCHED_ADRS+=("$adr_file")
        ADR_COUNT=$((ADR_COUNT + 1))
        break
      fi
    done

    [ "$ADR_COUNT" -ge 3 ] && break  # Hard cap: 3 ADRs max
  done

  if [ "${#MATCHED_ADRS[@]}" -gt 0 ]; then
    echo ""
    echo "### Prior Decisions (${#MATCHED_ADRS[@]} ADRs overlapping contract files)"
    echo "<!-- Each ADR is a prior tradeoff that constrains this implementation. -->"
    for adr_file in "${MATCHED_ADRS[@]}"; do
      echo ""
      echo "#### $(basename "$adr_file")"
      head -20 "$adr_file"  # ~100 tokens per ADR — stays within 300-token budget
    done
    echo ""
    echo "<!-- FORGE:PRIOR_DECISIONS: ${#MATCHED_ADRS[@]} ADR(s) injected above — treat as constraints, not suggestions -->"
  else
    echo "No matching ADRs found for contract files — proceeding without prior decision constraints"
  fi
else
  echo "devdocs/decisions/ absent or empty — skipping prior decision injection"
fi
```

**Inject into FORGE:ARCHITECT comment**: If matching ADRs were found, add a `### Prior Decisions (Constraints)` section **before** `### Affected Paths` in the output comment. The builder reads this section before writing any code.

**Skip conditions**:
- COMPLEXITY_BAND: TRIVIAL — trivial changes have no cross-path consistency risk; ADR injection adds unnecessary context
- `devdocs/decisions/` absent or empty — no ADRs to inject
- All candidate ADRs are `status: needs-review` — dead-anchor ADRs are excluded from constraint injection

---

## Phase A1: Read Entry Points

Identify every entry point that initiates the affected logic. Start from the files named in the investigation report.

### A1.0: Code Index Query (run FIRST — deterministic, one tool call)

If `scripts/code-index.sh` exists under `{REPO_PATH}`, query the pre-built index before any grep. The index provides caller lists and import graphs without re-scanning the repo:

```bash
# Ensure index is current (cache-hit on unchanged HEAD — instant if already built)
bash {REPO_PATH}/scripts/code-index.sh --repo-path {REPO_PATH} 2>/dev/null || true

# Get callers of the primary function under change
bash {REPO_PATH}/scripts/code-index.sh query --callers {PRIMARY_FUNCTION} --repo-path {REPO_PATH} 2>/dev/null || true

# Get all files that import the affected module
bash {REPO_PATH}/scripts/code-index.sh query --importers {AFFECTED_FILE} --repo-path {REPO_PATH} 2>/dev/null || true

# Get all files in the same domain as affected files (for sibling path detection)
bash {REPO_PATH}/scripts/code-index.sh query --domain {DOMAIN} --repo-path {REPO_PATH} 2>/dev/null || true
```

Use index results to populate the caller list and sibling candidates below. If the index returns results, **skip the grep fallback** — do not re-scan what the index already answered. If the index is absent or returns nothing, fall back to grep.

### A1.1: Grep fallback (only when index absent or returned no results)

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
- Churn / hot-spot files (see below) — high historical change frequency correlates with defect density
- Paths that are called in both sync and async contexts
- Any place where the change touches a serialization boundary (JSON in/out, DB read/write)
- Unused or dormant code that the change might activate

### Churn (Hot-Spot) Signal

Recency alone (did the file appear in the last N commits?) is a weak, binary proxy. Compute a bounded per-file **churn tier** instead — how often each affected file has actually changed over a fixed window — and fold it into the risk table below.

For each file in `{AFFECTED_FILES}` (never repo-wide — this must stay O(affected files) to fit the Phase A0–A5 time budget):

```bash
CHURN_WINDOW="90 days ago"   # named constant — must match the same window used in review-pr.md Phase 3A

# {AFFECTED_FILES} is a space-separated argument (see --files contract at the top
# of this file), not newline-separated like review-pr.md's $FILES — so a herestring
# `while read` line-loop would misparse it as a single line. Split explicitly on
# IFS=' ' into an array instead of relying on a bare `for FILE in {AFFECTED_FILES}`
# (which word-splits on the shell's default IFS — space, tab, AND newline). This
# keeps the existing space-separated contract intact while narrowing the splitting
# surface to spaces only.
IFS=' ' read -ra AFFECTED_FILES_ARR <<< "{AFFECTED_FILES}"
for FILE in "${AFFECTED_FILES_ARR[@]}"; do
  COMMITS=$(git log --oneline --since="$CHURN_WINDOW" -- "$FILE" | wc -l)
  if [ "$COMMITS" -ge 15 ]; then TIER="HOT"
  elif [ "$COMMITS" -ge 5 ]; then TIER="MEDIUM"
  else TIER="LOW"
  fi
  echo "$FILE: $TIER ($COMMITS commits in last 90 days)"
done
```

**Tiers** (fixed thresholds — keep identical to `review-pr.md` Phase 3A so both phases agree on what "hot" means):
- **HOT**: 15+ commits in the window
- **MEDIUM**: 5–14 commits in the window
- **LOW**: 0–4 commits in the window

Any file classified **HOT** MUST get an explicit row in the Risk Assessment table below (e.g. "High historical churn — {N} commits in last 90 days — changes here have a higher defect-density prior"), rated at least MEDIUM severity, with a mitigation such as "extra reviewer scrutiny" or "prefer smaller, isolated diffs to this file." MEDIUM-tier files may be noted inline without a dedicated row. LOW-tier files need no mention.

---

## Output Format

Post the following as a GitHub comment on `{NUMBER}`:

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ARCHITECT -->
## Implementation Plan for #{NUMBER}

### Custom Instructions (HIGHEST PRECEDENCE)
<!-- Binding directives from project/custom-instructions.md (Phase A0).
     These override agent defaults, training knowledge, and all other context.
     Builder MUST follow these exactly — violations are elevated to HIGH severity in review.
     If devdocs path was absent or file not found: 'No custom-instructions.md found at
     {DEVDOCS_PATH}/project/custom-instructions.md — skipping. Run `npx forgedock docs init`.' -->
{CUSTOM_INSTRUCTIONS}

### Project Conventions
<!-- Authoritative project knowledge from project/*.md and agent/*.md files
     with applies_to: work-on (Phase A0). Read these before finalizing the plan.
     If devdocs path was absent or no applicable files found: 'No applicable devdocs found.' -->
{PROJECT_CONVENTIONS}

### Prior Decisions (Constraints)
<!-- Auto-ADRs from prior TRAJECTORY runs whose anchor paths overlap the contract files.
     Injected by Phase A1.5. Builder MUST respect these tradeoffs — re-litigating requires
     explicit justification. Absent when devdocs/decisions/ is empty or no overlap found.
     status: needs-review ADRs are excluded — their anchors are dead. -->
{PRIOR_DECISIONS}

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

- Phase A0 devdocs read: 30s total budget (path resolution + file enumeration + content reads); skip if exceeded
- Each file read (A1): skip if the file exceeds 500 lines and only the first 100 lines are needed for structure
- Each `grep -r` call: timeout after 10s, skip if exceeded
- Total wall time budget: **3 minutes** (A0 through A5 combined). If budget exceeded, post partial results with `<!-- FORGE:ARCHITECT:PARTIAL -->` marker instead of `COMPLETE`.

---

## Skip Conditions

Skip this entire step (post nothing, return empty plan to caller) if:
- **COMPLEXITY_BAND: TRIVIAL** — checked via FORGE:FAST_PATH comment at entry (see guard above) <!-- Primary skip path: forge#679 -->
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
          Phase A0: Read Custom Instructions and Project Conventions (highest precedence)
          Phase A1: Read Entry Points
          Phase A2: Trace the Data Flow
          Phase A2.5: Pipeline Phase-Dependency Check
          Phase A3: Consistency Rules
          Phase A4: Sequence the Implementation
          Phase A5: Risk Assessment
3F    → Implement (builder reads plan, implements ALL affected paths)
```

The builder agent reads the `<!-- FORGE:ARCHITECT -->` comment as its **primary input** before writing any code. The raw issue body is secondary context. If the architect step was skipped, the builder falls back to investigation report + contract.

**Devdocs precedence** (Phase A0): `project/custom-instructions.md` has ABSOLUTE priority over all other context. The architect's plan must reflect any directives in that file — if custom instructions mandate a specific pattern, the implementation order and approach MUST follow it, even if the architect's general reasoning suggests an alternative. <!-- Added: forge#259 -->
