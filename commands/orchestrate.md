---
description: Orchestrate parallel work on multiple issues or an entire milestone — spawns sub-agents that each run the full /work-on pipeline
argument-hint: [milestone <slug> | #1 #2 #3 | next <N> | fast-lane | priority:P0]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Multi-Issue Parallel Orchestrator

**Input**: $ARGUMENTS

## HARD RULES — READ BEFORE ANYTHING ELSE

1. **Every agent MUST invoke `/work-on` via the Skill tool.** You do NOT write implementation prompts. You copy the Phase 4A template verbatim and fill in the `{VARIABLES}`. Nothing else. No custom prompts. No "just read and edit" shortcuts. The Skill tool invocation is what triggers labels, investigation comments, structured review, and trajectory tracking. Without it, the agent's work has no paper trail and is worthless.

2. **You are a dispatcher, not a builder.** You resolve issues, build the dependency DAG, spawn agents, and report results. You NEVER read code, edit files, or implement fixes yourself.

3. **After each agent completes, verify it used `/work-on`.** Check that completed issues have `workflow:*` labels and structured comments. If an agent bypassed the pipeline, report it as a failure.

---

You are the top-level orchestrator. Your job is to take a batch of issues, plan the execution order, spawn parallel sub-agents (each running the full `/work-on` pipeline), and report consolidated results.

**You have access to ALL tools** — Agent tool (critical), Task tool, Skill tool, Bash, everything. Use the Agent tool aggressively to parallelize work.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`. User can override with `--model <name>`.

---

## Config Resolution

Read `forge.yaml` at the project root to resolve all project-specific variables before running any commands:

```bash
# Parse forge.yaml for project context
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
PROJECT_NAME=$(yq '.project.name' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE")
DEFAULT_BRANCH=$(yq '.branches.default' "$CONFIG_FILE")
# Build satellite repo map from repos.satellites list
# Each satellite: { prefix, repo, staging_branch }
```

All `{GH_REPO}`, `{GH_FLAG}`, `{REPO_PATH}`, `{PROJECT_NAME}`, `{STAGING_BRANCH}`, and `{DEFAULT_BRANCH}` references below are populated from `forge.yaml`.

---

## Multi-Repo Support

This orchestrator supports issues across multiple repositories. See `/work-on` → "Multi-Repo Support" and `forge.yaml → repos` for the full project registry and context variables.

### Cross-Repo Issue References

Issues can be prefixed with a project shorthand derived from `forge.yaml → repos.satellites`:
- `#123` or `123` → default repo (`{GH_REPO}`)
- `{satellite_prefix}:5` → satellite repo (e.g., `mcp:5`, `n8n:12`) — prefixes and repos come from `forge.yaml → repos.satellites`
- `all-repos` → Scan all configured repos for open issues (combine and prioritize)

When spawning sub-agents, pass the project prefix so `/work-on` resolves to the correct repo.

---

## Phase 1: Resolve the Issue Set

Parse `$ARGUMENTS` to determine which issues to work on:

### Input Patterns

| Input | Resolution |
|-------|------------|
| `milestone <slug>` | All open issues assigned to that GitHub milestone (default repo) |
| `#1 #2 #3` or `1 2 3` | Specific issue numbers, optionally repo-prefixed (e.g., `#123 mcp:5 n8n:12`) |
| `next <N>` | Top N priority open issues (priority:P0 first, then priority:P1, etc.) |
| `next <N> all-repos` | Top N across ALL ecosystem repos |
| `fast-lane` or `fast` | All open fast-lane issues (no milestone, bugs/fixes) |
| `priority:P0` or `priority:P1` | All open issues with that priority label |
| `mcp:fast` or `n8n:next 3` | Repo-scoped queries |
| `<slug>` (no keyword) | Try milestone first, then fall back to label search |

### Fetch the issues

For each resolved repo, use the appropriate `-R` flag:

```bash
# Default repo (no flag needed if using GH_FLAG="" for the default):
gh issue list {GH_FLAG} --milestone "{TITLE}" --state open --limit 500 --json number,title,labels,milestone --jq '.[] | {number, title, labels: [.labels[].name], milestone: .milestone.title}'

# Satellite repos — always include -R flag with the satellite repo from forge.yaml:
# For each satellite in forge.yaml → repos.satellites:
gh issue list -R {SATELLITE_REPO} --milestone "{TITLE}" --state open --limit 500 --json number,title,labels,milestone

# For specific numbers with repo prefix:
gh issue view {NUMBER} -R {SATELLITE_REPO} --json number,title,labels,state,milestone,body

# For "all-repos" — fetch from all configured repos and combine:
gh issue list {GH_FLAG} --state open --limit {N} --json number,title,labels,milestone
# For each satellite in forge.yaml → repos.satellites:
gh issue list -R {SATELLITE_REPO} --state open --limit 500 --json number,title,labels,milestone
# Combine, sort by priority, take top N
```

**Count validation**: After fetching issues, log the count returned. If a milestone query returns exactly 30 issues, warn the user: "WARNING: Exactly 30 issues returned — gh CLI default may have truncated results. Re-running with --limit 500 is recommended." (The --limit 500 above prevents this for standard runs, but verify if the count seems suspiciously low relative to milestone expectations.)

**Tag each issue with its project prefix** in your internal tracking so sub-agents receive the correct repo context.

### Filter out ineligible issues

Remove issues that should NOT be worked on:
- Already closed or has `workflow:merged` label
- Has `workflow:invalid` label
- Has `needs-human` label (requires manual action)
- Has `workflow:decomposed` label (parent tracker — its sub-issues should be picked up instead)
- Has `workflow:building` or `workflow:in-review` label (already in progress)
- Is an epic (`epic` label) — these are planning containers, not buildable

If a `workflow:decomposed` issue is found, automatically expand it to its open sub-issues instead.

### CRITICAL: No duplicate detection at orchestrator level

**The orchestrator NEVER closes, merges, or deduplicates issues.** Even if two issues look like duplicates (similar titles, same error message, same symptoms), they may target different code paths, different ORM objects, or different failure modes. Only a `/work-on` investigation agent — after reading the actual code — can determine whether an issue is truly a duplicate.

**What the orchestrator must NOT do:**
- Close an issue as "duplicate" based on title/symptom similarity
- Skip an issue because another issue "covers it"
- Merge two issues into one agent
- Make ANY judgment about issue validity

**What the orchestrator SHOULD do:**
- If two issues look related, add a note in the agent prompt: "Note: #{OTHER} has similar symptoms — investigate whether this is the same root cause or a different code path"
- Let both agents run independently — if one finds it's truly a duplicate, `/work-on`'s investigation phase will close it as invalid with evidence
- Flag potential overlap in the DAG plan for the user's awareness, but NEVER act on it

**Why**: Surface-level similarity hides critical differences. #3842 (api_key.id lazy load) and #4039 (user.id lazy load) had identical error messages but targeted completely different ORM objects. Closing #4039 as a "duplicate" would have left a customer-impacting P0 bug unfixed.

---

## Phase 2: Investigation-First Triage

**Purpose**: Investigation issues produce NEW GitHub issues as their output. If the batch contains investigations, they must run FIRST so their output can be folded into the execution plan.

**If no investigations are found in Step 2A, skip this entire phase and proceed directly to Phase 3.**

### Step 2A: Classify each issue

For each issue in the resolved set, read its title and body to classify it:

```bash
for NUM in {issue_numbers}; do
  gh issue view $NUM --json title,body,labels --jq '{title: .title, labels: [.labels[].name], body_preview: (.body[:500])}'
done
```

**Classification rules:**

| Signal | Classification |
|--------|---------------|
| Title contains "Investigate", "Audit", "Research", "Evaluate", "Assess", "Deep dive" | **Investigation** |
| Issue body is primarily questions (`- [ ]` checklist) with no concrete code changes | **Investigation** |
| Issue body says "Deliverable: execution plan" or "create issues" | **Investigation** |
| Issue has `enhancement` label + title starts with "Enable" + body describes toggling a feature flag | **Implementation** |
| Issue has `bug`, `refactor`, `dead-code`, or `feature` label | **Implementation** |

Tag each issue internally as `INVESTIGATION` or `IMPLEMENTATION`.

### Step 2B: Run investigations first (Wave 0)

If ANY issues are classified as `INVESTIGATION`:

1. **Move them to Wave 0** — they run BEFORE all implementation issues
2. **Spawn Wave 0 agents** using the same agent template as Phase 4A, but emphasize that `/work-on` will detect the investigation task type and produce issues (not code)
3. **Wait for ALL Wave 0 agents to complete** before proceeding to Phase 3

### Step 2C: Collect newly created issues

After Wave 0 completes, each investigation agent will have created new GitHub issues. Collect them:

```bash
# For each investigation issue that completed successfully:
# Read the FORGE:BUILDER comment to find created issue numbers
for INV_NUM in {investigation_numbers}; do
  gh api repos/{GH_REPO}/issues/${INV_NUM}/comments \
    --jq '.[] | select(.body | contains("<!-- FORGE:BUILDER -->")) | .body' \
    | grep -oP '#\K\d+' | sort -u
done

# Also check: if the investigation issue had a milestone, the new issues should too
# Verify milestone assignment:
for NEW_NUM in {newly_created_numbers}; do
  gh issue view $NEW_NUM --json milestone --jq '.milestone.title // "NO MILESTONE"'
done
```

### Step 2C.5: Collect Knowledge Gist URLs from investigations

For each completed investigation issue, query its comments for `FORGE:KNOWLEDGE_GIST` annotations. Store the mapping of investigation issue number → Gist URL(s) so the agent template in Step 4A can include prior investigation context.

```bash
# Build a map: investigation_number → gist_url(s)
declare -A INVESTIGATION_GISTS
for INV_NUM in {investigation_numbers}; do
  GIST_URLS=$(gh api repos/{GH_REPO}/issues/${INV_NUM}/comments \
    --jq '[.[] | select(.body | test("<!-- FORGE:KNOWLEDGE_GIST: https://")) | .body | capture("<!-- FORGE:KNOWLEDGE_GIST: (?<url>https://[^ ]+) -->").url] | unique | .[]')
  if [ -n "$GIST_URLS" ]; then
    INVESTIGATION_GISTS[$INV_NUM]="$GIST_URLS"
    echo "Investigation #${INV_NUM}: found Gist URL(s)"
  fi
done
```

When spawning agents for implementation issues in Step 4A, include any Gist URLs from parent/sibling investigations in the agent prompt's context block. See the `{GIST_CONTEXT}` variable in the agent template.

**Milestone index Gist**: If the milestone has a `<!-- FORGE:MILESTONE_INDEX: {url} -->` annotation in its description, read the index URL and store it for inclusion in agent context. The milestone index aggregates all investigation Gist URLs for the milestone into a single reference.

```bash
# Read milestone index URL from milestone description (if milestone exists)
MILESTONE_INDEX_URL=""
if [ -n "$MILESTONE_NUM" ]; then
  MILESTONE_DESC=$(gh api repos/{GH_REPO}/milestones/${MILESTONE_NUM} --jq '.description // ""' 2>/dev/null)
  MILESTONE_INDEX_URL=$(echo "$MILESTONE_DESC" | grep -oP '(?<=<!-- FORGE:MILESTONE_INDEX: )https://[^ ]+(?= -->)' | head -1)
  if [ -n "$MILESTONE_INDEX_URL" ]; then
    echo "Milestone index Gist found: ${MILESTONE_INDEX_URL}"
  fi
fi
```

### Step 2D: Merge new issues into the batch

Add the newly created issues to the issue set. Re-check each one:
- Filter out any that are already ineligible (same rules as Phase 1)
- Tag them as `IMPLEMENTATION` (investigations don't spawn more investigations)
- They inherit the milestone from their parent investigation if applicable

**Issue body standard**: Any new issues created by investigation agents MUST use the **Pipeline Issue Template** from `issue.md` Phase 3D as their body structure. Investigation agents that produce issues as output should be prompted to use that template — not ad-hoc body formats — so every spawned issue enters the pipeline with the correct structure (Problem, Root Cause, Affected Files, Acceptance Criteria). Verify spawned issues have all mandatory sections before adding them to the batch; if sections are missing, the `/issue` body-validation step (Phase 4C.5) will repair them. <!-- Added: forge#293 -->

**Updated issue set** = original `IMPLEMENTATION` issues + newly spawned issues from investigations.

### Step 2E: Report Wave 0 results to user

```
## Wave 0: Investigations Complete

| # | Investigation | Result | Issues Created |
|---|--------------|--------|---------------|
| #{INV1} | {title} | ✓ Closed | #{N1}, #{N2}, #{N3} |
| #{INV2} | {title} | ✓ Closed | #{N4}, #{N5} |

**New issues added to batch**: {count}
**Updated total**: {original_count} → {new_total} issues

Proceeding to dependency analysis with the expanded issue set...
```

---

## Phase 3: Dependency Analysis & Execution Plan

### Step 3A: Analyze explicit dependencies

For each issue (including newly spawned ones from Phase 2), check:
1. **Explicit dependencies**: Issue body contains "Depends on #X" or "Blocked by #X"
2. **Milestone ordering**: Issues within a milestone may have a natural order (foundation → features → UI)
3. **File conflicts**: If two issues modify the same files, they should be sequential (not parallel)
4. **Parent-child links**: If issue body contains "Parent investigation: #{X}", it was spawned by an investigation — no special ordering needed unless explicitly stated

Read each issue's body briefly to check for dependency markers:
```bash
for NUM in {issue_numbers}; do
  gh issue view $NUM --json body --jq '.body' | grep -iE 'depends on|blocked by|after #|parent investigation' || echo "no deps"
done
```

### Step 3B: Domain estimation

For each issue, estimate which domains it touches based on title, body, and labels. This improves DAG construction — issues in the same domain likely touch the same files and should be serialized (one becomes a predecessor of the other).

```bash
for NUM in {issue_numbers}; do
  ISSUE=$(gh issue view $NUM --json title,body,labels --jq '{title: .title, labels: [.labels[].name], body: (.body[:300])}')
  echo "=== #$NUM ==="
  echo "$ISSUE" | grep -qiE "credit|billing|pricing|stripe|charge|refund" && echo "  BILLING" || true
  echo "$ISSUE" | grep -qiE "auth|session|jwt|login|permission|oauth" && echo "  AUTH" || true
  echo "$ISSUE" | grep -qiE "worker|queue|job|task|background|consumer" && echo "  WORKER" || true
  echo "$ISSUE" | grep -qiE "migration|\.sql|database|postgres|alembic" && echo "  DATABASE" || true
  echo "$ISSUE" | grep -qiE "component|page|layout|dashboard|ui|ux|frontend|web/src" && echo "  FRONTEND" || true
  echo "$ISSUE" | grep -qiE "docker|deploy|traefik|nginx|ci|cd|infra|github.action" && echo "  INFRA" || true
  echo "$ISSUE" | grep -qiE "llm|extract|schema|format|embedding|model" && echo "  AI" || true
  # For project-specific domains, configure keywords in forge.yaml → review.domains and extend above
done
```

**Use domain info for DAG edge construction:**
- Issues in the SAME domain (especially WORKER, BILLING, DATABASE) are more likely to touch the same files → add predecessor edges to serialize them
- Issues in DIFFERENT domains are more likely independent → safe to parallelize
- BILLING + AUTH issues should be prioritized early (security-critical)
- **DATABASE issues are ALWAYS serialized — hard rule, no exceptions.** Multiple agents writing migrations simultaneously will produce duplicate migration numbers (e.g., two `0067_*.sql` files), which breaks the migration runner. DATABASE issues form a linear predecessor chain in the DAG. If 3 DATABASE issues are in a batch: A has no predecessors, B has {A} as predecessor, C has {B} as predecessor.

**Store domain tags per issue** for use in the plan presentation (Step 3E).

### Step 3C: Multi-layer conflict detection

Domain estimation (above) catches broad category overlap but misses cases where two issues modify the exact same file without mentioning the same keywords, or where two issues touch different files that share indirect dependencies (imports, config, barrel exports). This step uses three layers of structural analysis to catch conflicts the keyword heuristic misses.

#### Layer 1: Explicit file-overlap extraction

**For issues that already have an INVESTIGATOR comment** (from Wave 0 or a prior session), extract their Affected Files list:

```bash
for NUM in {issue_numbers}; do
  echo "=== #$NUM ==="
  gh api repos/{GH_REPO}/issues/${NUM}/comments \
    --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' 2>/dev/null \
    | grep -oP '`[^`]*\.(py|tsx?|jsx?|sql|json|ya?ml)`' | sort -u
done
```

**For issues WITHOUT an investigation comment**, fall back to parsing the issue body for file paths:

```bash
gh issue view $NUM --json body --jq '.body' | grep -oP '`[^`]*\.(py|tsx?|jsx?|sql|json|ya?ml)`' | sort -u
```

**Cross-reference all extracted file lists:**
- If two issues share ANY affected file → one MUST be a predecessor of the other (serialized)
- The issue with lower issue number goes first (stable ordering), unless an explicit `Depends on #` says otherwise
- Add a conflict note to the DAG plan: "#{A} and #{B} both modify `{file}` — #{A} is predecessor of #{B}"

#### Layer 2: Directory-proximity detection

Two issues that modify different files in the **same leaf directory** have a high probability of conflicting through shared `__init__.py`, `index.ts`, barrel re-exports, or tightly coupled sibling modules. This layer catches indirect conflicts that Layer 1 misses.

**Extract the leaf directory for each affected file:**

```bash
# For each issue's file list, extract unique directories
for NUM in {issue_numbers}; do
  echo "=== #$NUM directories ==="
  # From the file list already extracted in Layer 1:
  echo "$FILES_FOR_NUM" | xargs -I{} dirname {} | sort -u
done
```

**Cross-reference directory lists:**
- If two issues share a leaf directory AND that directory is "small" (contains fewer than 10 tracked files), flag as **probable conflict** → serialize
- If the shared directory is a broad container (e.g., `services/api/app/routers/` with 15+ files), downgrade to **possible conflict** → serialize only if same domain tag (from Step 3B)
- **Known high-conflict directories** (always serialize if shared):
  - `services/api/app/models/` (SQLAlchemy models often share Base, imports)
  - `services/api/app/core/` (shared dependencies)
  - `services/worker/worker/` (tightly coupled consumer modules)
  - `web/src/lib/` (shared utilities)
  - `shared/` (volume-mounted, affects all services)
  - `infra/migrations/` (already covered by DATABASE hard rule, but explicit here too)

#### Layer 3: Shared-module inference

When two issues modify different files that **import from the same utility/init module**, both agents often end up modifying that shared module (adding imports, updating re-exports). This creates merge conflicts invisible to Layer 1.

**Heuristic rules (no git operations needed — pattern-based):**

| Pattern | Inference | Action |
|---------|-----------|--------|
| Issue A modifies `routers/billing.py`, Issue B modifies `routers/auth.py` | Both likely import from `routers/__init__.py` or `dependencies.py` | Flag as possible conflict if same service |
| Issue A modifies `models/user.py`, Issue B modifies `models/subscription.py` | Both likely modify `models/__init__.py` (SQLAlchemy model registry) | Flag as probable conflict → serialize |
| Issue A modifies `web/src/components/X.tsx`, Issue B modifies `web/src/components/Y.tsx` | May share `index.ts` barrel export | Flag only if same parent directory |
| Issue A modifies `services/api/app/main.py` | `main.py` is a high-fan-in file (router registration, middleware) | Serialize with ANY other API issue |
| Issue A modifies `docker-compose.yml` or `docker-compose.prod.yml` | Global config — any concurrent modification conflicts | Serialize with ALL other issues that touch infra |

**Apply inferences:**
```
# High-fan-in files — if ANY issue touches these, serialize it with all same-service issues.
# Read layout paths from forge.yaml review.layout; fall back to sensible generic defaults.
# Example (pseudo-code — adapt to your forge.yaml parsing method):
#   API_MAIN    = forge_yaml.review.layout.api_main    ?? "services/api/app/main.py"
#   WORKER_MAIN = forge_yaml.review.layout.worker_main ?? "services/worker/worker/main.py"
#   PAGES_ROOT  = forge_yaml.review.layout.pages       ?? "web/src/app"

HIGH_FAN_IN = [
  API_MAIN,                          # e.g. "services/api/app/main.py" — router/middleware registration
  WORKER_MAIN,                       # e.g. "services/worker/worker/main.py" — worker entrypoint (set forge.yaml review.layout.worker_main)
  PAGES_ROOT + "/layout.tsx",        # e.g. "web/src/app/layout.tsx" — root layout for all pages
  "docker-compose.yml",
  "docker-compose.prod.yml",
  ".env.example"
]

# For each issue, check if affected files include a high-fan-in file
# If yes: that issue cannot be parallelized with any other issue touching the same service
```

#### Layer 4: Conservative fallback (low-confidence cases)

When file extraction yields **fewer than 2 file paths** for an issue (common for issues without investigation comments, or issues described in prose without backtick-wrapped paths), the conflict detection has low confidence. Rather than assuming independence, apply conservative serialization.

**Rules:**
- If an issue has 0-1 extracted file paths AND shares a domain tag (from Step 3B) with another issue → serialize them
- If an issue has 0 extracted file paths AND no domain tag could be determined → add it as a predecessor of the next same-domain issue, or if no domain match exists, serialize it after the most recently added issue (safest default)
- Add a note to the plan: "#{N} — low file-extraction confidence, serialized conservatively"

**Rationale**: The cost of a false-negative (two agents conflict → one fails with merge error, wasting the full agent run) far exceeds the cost of a false-positive (an issue waits for one predecessor before starting). Always err toward serialization when uncertain.

#### Combining all layers

Build the final conflict graph by merging signals from all four layers:

| Signal | Strength | Action |
|--------|----------|--------|
| Layer 1: Same file | **Hard conflict** | Always serialize |
| Layer 2: Same small directory | **Probable conflict** | Serialize |
| Layer 2: Same broad directory + same domain | **Probable conflict** | Serialize |
| Layer 2: Same broad directory + different domain | **Possible conflict** | Parallelize (accept risk) |
| Layer 3: High-fan-in file touched | **Probable conflict** | Serialize with same-service issues |
| Layer 3: Shared model/init pattern | **Probable conflict** | Serialize |
| Layer 4: Low confidence + same domain | **Conservative** | Serialize |
| Layer 4: Low confidence + no domain | **Conservative** | Add predecessor edge to most recent issue |

**This supplements, not replaces, the domain keyword estimation.** Domain tags still help with broad sequencing decisions. Multi-layer conflict detection catches the specific cases keywords miss (e.g., two issues that both modify files in `services/api/app/models/` where one is labeled WORKER and the other BILLING — Layer 2 catches this even though Layer 1 shows no direct file overlap).

### Step 3D: Build the dependency DAG

Build a **directed acyclic graph (DAG)** of per-issue dependencies. Each issue gets a `predecessors` set — the specific issues that must reach a terminal state before this issue can dispatch. This replaces the previous wave-grouping model where all issues in a wave had to complete before any issue in the next wave could start.

**DAG construction rules:**
- Investigation issues already ran in Phase 2 — they are NOT included in this DAG
- Each issue starts with an empty predecessor set
- **Explicit dependencies**: If issue B says "Depends on #A" or "Blocked by #A", add A to B's predecessors
- **File-conflict edges**: If two issues share affected files (from Step 3C Layer 1), add a directed edge: lower issue number → higher issue number (unless explicit deps say otherwise). The later issue has the earlier issue in its predecessors.
- **Domain serialization edges**: DATABASE issues form a linear chain (each has the previous DATABASE issue as its predecessor). Same-small-directory issues (Layer 2) and high-fan-in file issues (Layer 3) get directed edges as per Step 3C rules.
- **Conservative fallback edges**: Low-confidence issues (Layer 4) get edges to same-domain issues as per Step 3C rules.
- **No artificial concurrency limit** — all issues with empty predecessor sets dispatch simultaneously. The only constraints are file overlap and explicit dependencies.

**Terminology:**
- **Ready issues**: Issues whose predecessor set is empty (all predecessors have reached terminal state or were never added)
- **Blocked issues**: Issues with one or more unresolved predecessors
- **Critical path**: The longest chain of dependent issues in the DAG — determines minimum wall-clock time

**Example DAG:**
```
Phase 2 (already done): #2644 (investigation) → spawned #2645, #2646, #2647

Dependency graph:
  #2633 (orphaned queues)     → predecessors: {}          ← READY
  #2636 (invalidation sub)    → predecessors: {}          ← READY
  #2645 (new finding)         → predecessors: {}          ← READY
  #2646 (new finding)         → predecessors: {}          ← READY
  #2634 (enable daemon)       → predecessors: {#2633}     ← blocked until #2633 completes
  #2647 (depends on #2645)    → predecessors: {#2645}     ← blocked until #2645 completes

Critical path: #2633 → #2634 (2 steps) or #2645 → #2647 (2 steps)
Initial dispatch: #2633, #2636, #2645, #2646 (all ready — launched simultaneously)
```

**Key advantage over waves**: When #2633 completes, #2634 dispatches immediately — it does not wait for #2636, #2645, or #2646 to finish. Similarly, when #2645 completes, #2647 dispatches immediately regardless of other issues' status.

### Step 3D.5: Cycle Detection (MANDATORY) <!-- Added: forge#1085 -->

**Run immediately after Step 3D's DAG edge construction, before presenting the plan (Step 3E).** This step validates that the predecessor graph is acyclic. Without it, mutual `Depends on` declarations (e.g., A depends on B AND B depends on A) cause both issues to remain permanently blocked in Step 4B's dispatch loop — no error, no timeout, indefinite deadlock.

**Algorithm**: Kahn's topological sort. Runs in O(V+E) — negligible overhead for typical batch sizes.

```bash
# --- Step 3D.5: Cycle Detection ---
# Inputs:
#   ISSUES[]         — array of all issue numbers in the DAG
#   PREDECESSORS[N]  — space-separated list of predecessor issue numbers for issue N

# Step 1: Compute in-degree for each issue
declare -A IN_DEGREE
for NUM in "${ISSUES[@]}"; do
  IN_DEGREE[$NUM]=0
done
for NUM in "${ISSUES[@]}"; do
  for PRED in ${PREDECESSORS[$NUM]:-}; do
    IN_DEGREE[$NUM]=$(( ${IN_DEGREE[$NUM]:-0} + 1 ))
  done
done

# Step 2: Seed the queue with zero-in-degree issues (no predecessors)
KAHN_QUEUE=()
for NUM in "${ISSUES[@]}"; do
  [ "${IN_DEGREE[$NUM]}" -eq 0 ] && KAHN_QUEUE+=("$NUM")
done

# Step 3: Process queue — reduce successor in-degrees, enqueue newly freed issues
PROCESSED_COUNT=0
PROCESSED_ORDER=()
while [ "${#KAHN_QUEUE[@]}" -gt 0 ]; do
  # Dequeue
  CURRENT="${KAHN_QUEUE[0]}"
  KAHN_QUEUE=("${KAHN_QUEUE[@]:1}")
  PROCESSED_ORDER+=("$CURRENT")
  PROCESSED_COUNT=$(( PROCESSED_COUNT + 1 ))

  # Reduce in-degree of all issues that depend on CURRENT (i.e., CURRENT is in their PREDECESSORS)
  for SUCCESSOR in "${ISSUES[@]}"; do
    for PRED in ${PREDECESSORS[$SUCCESSOR]:-}; do
      if [ "$PRED" = "$CURRENT" ]; then
        IN_DEGREE[$SUCCESSOR]=$(( ${IN_DEGREE[$SUCCESSOR]} - 1 ))
        [ "${IN_DEGREE[$SUCCESSOR]}" -eq 0 ] && KAHN_QUEUE+=("$SUCCESSOR")
      fi
    done
  done
done

# Step 4: Any issue not processed has in-degree > 0 — part of a cycle
CYCLE_ISSUES=()
EXCLUDED_CYCLE=()
for NUM in "${ISSUES[@]}"; do
  FOUND=false
  for P in "${PROCESSED_ORDER[@]}"; do [ "$P" = "$NUM" ] && FOUND=true && break; done
  [ "$FOUND" = "false" ] && CYCLE_ISSUES+=("$NUM")
done

# Step 5: Handle cycles
if [ "${#CYCLE_ISSUES[@]}" -gt 0 ]; then
  echo "CYCLE DETECTED in dependency graph — the following issues form a circular dependency:"
  for C in "${CYCLE_ISSUES[@]}"; do
    echo "  #${C}: predecessors=[${PREDECESSORS[$C]}]"
    # Label each cyclic issue needs-human
    gh issue edit "$C" -R {GH_REPO} --add-label "needs-human" 2>/dev/null || true
    gh issue comment "$C" -R {GH_REPO} --body "**Cycle detected by /orchestrate**: This issue is part of a circular dependency chain involving issues: ${CYCLE_ISSUES[*]/#/#}. The orchestrator cannot dispatch it automatically. Please fix the \`Depends on\` declarations so that no cycle exists, then re-run /orchestrate." 2>/dev/null || true
    # Remove from DAG — store in EXCLUDED_CYCLE for Step 3E reporting
    EXCLUDED_CYCLE+=("$C")
    # Remove from ISSUES array for all downstream processing
    # Use exact-match filter loop — pattern substitution (${array[@]/pattern}) leaves blank
    # slots and corrupts partial matches (e.g., removing 100 changes 1000 to 0).
    NEW_ISSUES=()
    for I in "${ISSUES[@]}"; do
      [ "$I" != "$C" ] && NEW_ISSUES+=("$I")
    done
    ISSUES=("${NEW_ISSUES[@]}")
  done
  echo ""
  echo "These issues have been labeled needs-human and excluded from the DAG."
  echo "Fix their dependency declarations and re-run /orchestrate."
else
  echo "DAG cycle check: PASS — no cycles detected. Proceeding with ${#PROCESSED_ORDER[@]} issues."
fi

# Guard: if all issues were cyclic, ISSUES[] is now empty — abort before presenting an empty plan
if [ "${#ISSUES[@]}" -eq 0 ]; then
  echo ""
  echo "ERROR: All issues in this batch form circular dependencies and have been excluded."
  echo "Every issue has been labeled needs-human."
  echo "Fix the Depends on / Blocked by declarations so no cycle exists, then re-run /orchestrate."
  exit 1
fi
# --- End Step 3D.5 ---
```

**After this step**:
- `ISSUES[]` contains only acyclic issues — safe to dispatch
- `EXCLUDED_CYCLE[]` contains cyclic issue numbers — reported in Step 3E, never dispatched
- If `EXCLUDED_CYCLE` is non-empty, report it clearly in the Step 3E plan before asking for user confirmation
- If `ISSUES[]` is empty after cycle exclusion (all issues were cyclic), the guard above aborts with `exit 1` — Step 3E is never reached with an empty plan <!-- Added: forge#1110 -->

### Step 3E: Present the plan to the user

```
## Orchestration Plan

**Scope**: {milestone name / "N issues" / "fast-lane"}
**Total issues**: {count} ({investigation_count} investigations + {implementation_count} implementations)
**Execution model**: Dependency-graph streaming (issues dispatch as predecessors complete)

{IF investigations exist:}
### Investigations (run first, may spawn new issues)
| # | Title | Expected Output |
|---|-------|----------------|
| #{INV1} | {title} | New issues → folded into dependency graph |

### Implementation (after investigations complete)
{END IF}

### Domain Distribution
| Domain | Issues | Notes |
|--------|--------|-------|
| FRONTEND | {N} | {Independent pages / Shared components} |
| BILLING | {N} | {Critical — dispatches immediately} |
| DATABASE | {N} | {Serialized chain — migration order matters} |
| AUTH | {N} | {Critical — dispatches immediately} |
| WORKER | {N} | {High overlap risk within worker service} |
| AI | {N} | {Independent} |
| INFRA | {N} | {Independent} |

(Omit rows with 0 issues. Add project-specific domain rows from forge.yaml → review.domains.)

### Dependency Graph

| Issue | Predecessors | Domain | Status |
|-------|-------------|--------|--------|
| #{A} | — | FRONTEND | Ready (dispatches immediately) |
| #{B} | — | BILLING | Ready (dispatches immediately) |
| #{C} | — | WORKER | Ready (dispatches immediately) |
| #{D} | #{A} | FRONTEND | Blocked (waits for #{A} only) |
| #{E} | — | DATABASE | Ready (dispatches immediately) |
| #{F} | #{E} | DATABASE | Blocked (serialized — waits for #{E}) |

**Critical path**: #{E} → #{F} (2 steps, determines minimum wall-clock time)
**Initial dispatch**: #{A}, #{B}, #{C}, #{E} (all predecessors resolved)
**Streaming**: #{D} dispatches as soon as #{A} completes — does NOT wait for #{B}, #{C}, or #{E}

**Note**: Investigations may create additional issues that will be automatically added to the dependency graph. The final graph will be confirmed after investigations complete.

**Excluded** (already in progress / ineligible):
- #{X} — {reason}

{IF EXCLUDED_CYCLE is non-empty:}
### ⚠ Circular Dependencies Detected — Manual Fix Required

The following issues form a circular dependency chain and **cannot be dispatched** until the cycle is resolved:

| Issue | Depends On | Problem |
|-------|------------|---------|
{rows: each EXCLUDED_CYCLE issue, its predecessor list, "mutual dependency — forms cycle with #{other}"}

**Action required**: Edit each issue's body to remove or correct the `Depends on` / `Blocked by` declarations so no cycle exists. Each issue has been labeled `needs-human`. After fixing, re-run `/orchestrate` to dispatch them.
{END IF}

Proceed? (yes / adjust / pick specific issues)
```

**Wait for user confirmation before spawning agents.** This is the checkpoint — once agents launch, they run autonomously.

**After confirmation**: If investigations exist, execute Phase 2B-E first. Then re-present the expanded plan (with newly spawned issues added to the dependency graph) for a quick confirmation before launching implementation.

---

## Phase 4: Streaming DAG Execution

### Step 4A-pre: Staging baseline tracking (MANDATORY — continuous)

**WHY THIS EXISTS**: Milestone-code-onto-staging contamination incidents (see issue #150) produce unexpected growth on the staging branch that is otherwise invisible until after a deploy. In the streaming DAG model, there are no discrete wave boundaries — instead, track a running baseline and check after each agent completion.

**When to run**: Capture the initial baseline before the first dispatch. Then re-check after every agent that merges a PR targeting `staging`. Skip for pure milestone-branch batches where all issues target `milestone/*`.

```bash
# Capture initial staging baseline before first dispatch
git fetch origin
if [ "$DEFAULT_BRANCH" = "$STAGING_BRANCH" ]; then
  STAGING_LINES_BASELINE=0
  echo "Staging baseline: skipped — single-branch repo (staging == default)"
else
  STAGING_LINES_BASELINE=$(git diff --stat origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH 2>/dev/null \
    | tail -1 \
    | grep -oP '\d+ insertion' \
    | grep -oP '\d+' \
    || echo "0")
  echo "Staging baseline: ${STAGING_LINES_BASELINE} lines ahead of $DEFAULT_BRANCH"
fi

# Track cumulative expected growth from merged PRs
CUMULATIVE_EXPECTED_DELTA=0
```

**Per-agent-completion integrity check** (run in Step 4B after each agent merges a PR targeting staging):

```bash
# After agent completes and its PR merges to staging:
git fetch origin
if [ "$DEFAULT_BRANCH" != "$STAGING_BRANCH" ]; then
  STAGING_LINES_NOW=$(git diff --stat origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH 2>/dev/null \
    | tail -1 \
    | grep -oP '\d+ insertion' \
    | grep -oP '\d+' \
    || echo "0")
  STAGING_TOTAL_GROWTH=$((STAGING_LINES_NOW - STAGING_LINES_BASELINE))

  # Add this PR's line count to cumulative expected delta
  CUMULATIVE_EXPECTED_DELTA=$((CUMULATIVE_EXPECTED_DELTA + {THIS_PR_LINE_COUNT}))

  UNEXPECTED_GROWTH=$((STAGING_TOTAL_GROWTH - CUMULATIVE_EXPECTED_DELTA))
  if [ "$UNEXPECTED_GROWTH" -gt 500 ]; then
    echo "ALERT: Staging grew by ${STAGING_TOTAL_GROWTH} lines (+${UNEXPECTED_GROWTH} beyond expected ${CUMULATIVE_EXPECTED_DELTA})."
    echo "This may indicate milestone-code contamination via agent merge commits."
    echo "Review: git log --oneline --merges origin/$DEFAULT_BRANCH..origin/$STAGING_BRANCH"
    echo "Do NOT merge $STAGING_BRANCH → $DEFAULT_BRANCH until the unexpected growth is investigated."
    # Do NOT auto-stop — alert the user and let them decide
  fi
fi
```

If `UNEXPECTED_GROWTH > 500`, report the alert clearly before dispatching any more agents. The user confirms whether to continue.

---

### Step 4A.pre.0: Pre-create milestone branches for ready issues (MANDATORY before classify-lane) <!-- Added: forge#901 -->

**WHY THIS EXISTS**: Feature-lane milestone branches were created lazily — by whichever feature-lane agent reached its build phase first. When multiple agents are dispatched simultaneously, they each run the lane check at roughly the same time. Every agent that runs before the branch is first pushed observes "branch absent" and is misrouted (hard-fail / `needs-human`, or fallback to staging in older code paths). The result is a single milestone's PRs scattered across the milestone branch and staging — a branch-routing nondeterminism that recurs under parallelism.

The fix is deterministic: create every milestone branch the ready issues will target **once, up front, before any agent runs `classify-lane.sh`**. After this step, every agent's lane check sees the branch and routes consistently.

**When to run**: Before the classify-lane loop in Step 4A.pre, for every dispatch group (initial ready set + each subsequent batch of newly unblocked issues). The step is a no-op for pure fast-lane issues (no issue in the group has a milestone).

**Requires bash 4+**: This snippet uses an associative array (`declare -A SEEN_MILESTONE_SLUG`) to de-dupe milestone slugs, so it must run under bash 4 or newer. Under a non-bash POSIX shell (`sh`/dash), `declare -A` fails and the de-dupe silently no-ops. This degrades gracefully — branch creation stays correct because the `git ls-remote --exit-code` exists-check below still skips any milestone branch that already exists; the only effect is redundant, idempotent `ls-remote`/`push` attempts for milestones referenced by more than one issue. Run this command's blocks under bash 4+. <!-- Added: forge#901 -->

```bash
# Pre-create the origin milestone branch for every distinct milestone referenced by ready issues.
# Slugification MUST byte-match scripts/classify-lane.sh — otherwise a branch is created that
# the classifier will not select. Keep these two slug pipelines identical.
git fetch origin

# Collect distinct milestone titles among the ready issues
declare -A SEEN_MILESTONE_SLUG
for NUM in {ready_issue_numbers}; do
  MILESTONE_TITLE=$(gh issue view "$NUM" -R {GH_REPO} --json milestone --jq '.milestone.title // empty' 2>/dev/null || echo "")
  [ -z "$MILESTONE_TITLE" ] && continue  # fast-lane issue — no milestone branch needed

  # Slugify — IDENTICAL to classify-lane.sh: lowercase → spaces-to-hyphens →
  # strip non-[a-z0-9-] → collapse hyphens → strip leading/trailing hyphens.
  SLUG=$(echo "$MILESTONE_TITLE" \
    | tr '[:upper:]' '[:lower:]' \
    | tr ' ' '-' \
    | tr -cd 'a-z0-9-' \
    | sed 's/--*/-/g' \
    | sed 's/^-//;s/-$//')

  # Empty-slug guard (matches classify-lane.sh): a title with no ASCII letters/digits/hyphens
  # would produce "milestone/", an invalid ref. Skip and let classify-lane surface the error.
  if [ -z "$SLUG" ]; then
    echo "WARN: milestone title '$MILESTONE_TITLE' (issue #$NUM) produced an empty slug — skipping pre-creation; classify-lane will hard-fail." >&2
    continue
  fi

  # De-dupe: only attempt creation once per milestone
  [ -n "${SEEN_MILESTONE_SLUG[$SLUG]:-}" ] && continue
  SEEN_MILESTONE_SLUG[$SLUG]=1

  LANE="milestone/$SLUG"
  if git ls-remote --exit-code origin "$LANE" >/dev/null 2>&1; then
    echo "Milestone branch '$LANE' already exists on origin — no action."
    continue
  fi

  # Create-if-absent from the default branch (matches /milestone create).
  # $DEFAULT_BRANCH is resolved from forge.yaml at the top of this command.
  echo "Pre-creating milestone branch '$LANE' from origin/$DEFAULT_BRANCH …"
  if git push origin "origin/$DEFAULT_BRANCH:refs/heads/$LANE" 2>/dev/null; then
    echo "Created milestone branch '$LANE'."
  elif git ls-remote --exit-code origin "$LANE" >/dev/null 2>&1; then
    # A concurrent orchestrator (or an agent) created it first — harmless. Never force-push.
    echo "Milestone branch '$LANE' was created concurrently — proceeding with the existing branch."
  else
    echo "ERROR: failed to pre-create milestone branch '$LANE' from origin/$DEFAULT_BRANCH." >&2
    echo "       classify-lane.sh will hard-fail for issues in this milestone until the branch exists." >&2
  fi
done
```

This step is the deterministic counterpart to fix #2 (atomic create-if-absent in the classifier): by guaranteeing the branch exists before the lane checks run, no agent can observe a missing branch. `classify-lane.sh`'s hard-fail is intentionally preserved as the phantom-slug gate for any path that bypasses this step.

### Step 4A.pre: Classify lane for each issue (MANDATORY before dispatching agents)

Before building agent prompts, run `classify-lane.sh` for every issue in the current dispatch group to compute `{LANE}` and `{PR_BASE}` deterministically. The script output is authoritative — the LLM MUST NOT override or reason around it.

```bash
# Requires classify-lane.sh to be available at ~/.claude/scripts/classify-lane.sh
# (installed by `npx forgedock` — see bin/forgedock.mjs linkScripts step)
# Fallback: bash "$FORGE_HOME/scripts/classify-lane.sh" if ~/.claude/scripts/ is unavailable

declare -A ISSUE_LANE
declare -A ISSUE_PR_BASE

for NUM in {ready_issue_numbers}; do
  PR_BASE=$(bash ~/.claude/scripts/classify-lane.sh "$NUM" -R {GH_REPO}) || {
    echo "ERROR: classify-lane.sh failed for #$NUM — adding needs-human label and skipping" >&2
    gh issue edit "$NUM" -R {GH_REPO} --add-label "needs-human" 2>/dev/null || true
    continue
  }
  # Derive LANE label from PR_BASE
  if [ "$PR_BASE" = "staging" ]; then
    LANE="fast-lane"
  else
    LANE="feature-lane"
  fi
  ISSUE_LANE[$NUM]="$LANE"
  ISSUE_PR_BASE[$NUM]="$PR_BASE"
  echo "#$NUM → lane=$LANE, PR_BASE=$PR_BASE"
done
```

Use `${ISSUE_LANE[$NUM]}` and `${ISSUE_PR_BASE[$NUM]}` to populate `{LANE}` and `{PR_BASE}` in the agent template below. Never substitute prose guesses for these values — the script output is the only valid source. <!-- Added: forge#677 -->

### Step 4A: Dispatch ready issues

**REMINDER: You MUST use the template below verbatim. Only fill in `{VARIABLES}`. Do NOT rewrite the agent prompt. Do NOT write custom implementation instructions. The agent MUST invoke `/work-on` via the Skill tool — this is the HARD RULE from the top of this file.**

For each **ready** issue (all predecessors resolved or no predecessors), spawn an Agent sub-agent that runs the full `/work-on` pipeline. On the initial dispatch, this is every issue with an empty predecessor set. On subsequent dispatches (triggered by agent completions in Step 4B), this is every newly-unblocked issue.

**One agent per issue.** Do NOT group multiple issues into a single agent. `/work-on` handles branching, labels, and PRs per-issue.

**Copy this template. Fill in variables. Do not modify the structure:**

```
Agent(
  subagent_type="general-purpose",
  model="sonnet",
  description="Work on {PROJECT_PREFIX}#{NUMBER}",
  run_in_background=true,
  prompt="You are working on GitHub issue #{NUMBER} for the {PROJECT_NAME} project.

**Project**: {PROJECT_NAME}
**Repository**: {GH_REPO}
**Repo path**: {REPO_PATH}

**YOUR MISSION**: Invoke `/work-on` via the Skill tool and let it run to completion. `/work-on` is a self-contained routing loop that handles the ENTIRE pipeline: investigate → build (context → architect → implement → validate) → review (push → PR → /review-pr --auto-merge) → close (project board → trajectory log → worktree cleanup). Do NOT intervene, compensate, or manually close issues — `/work-on` handles everything including issue closure and label updates in its close phase.

**CRITICAL — DO NOT STOP EARLY**: /work-on runs as a multi-phase routing loop. Each phase (investigate, build, review, close) returns an intermediate result — these are NOT completion signals. You are NOT done until the issue reaches a terminal state: `workflow:merged`, `workflow:invalid`, or `needs-human`. If /work-on returns after only one phase (e.g., investigation), you MUST invoke it again immediately — it will re-read GitHub state and continue to the next phase. Keep invoking /work-on until it reaches a terminal state. Never output 'done' or stop after an intermediate result.

**HOW REVIEW FINDINGS WORK**: /review-pr may create GitHub issues (with `review-finding` label) for findings it discovers. These are NOT blockers — they are separate work items that will go through their own /work-on pipeline later. The original PR should ALWAYS merge after review. The only exception is build errors (code doesn't compile) — those must be fixed before merging.

**IMPORTANT RULES**:
- **MANDATORY**: You MUST use the Skill tool to invoke 'work-on' with args '{PROJECT_PREFIX}{NUMBER}'. Do NOT implement manually — /work-on handles the full pipeline including label state machine (workflow:investigating → workflow:building → workflow:in-review → workflow:merged), investigation reports, PR creation, and cleanup.
  - For default repo issues: `Skill(skill='work-on', args='{NUMBER}')`
  - For satellite repo issues: `Skill(skill='work-on', args='{SATELLITE_PREFIX}:{NUMBER}')` (prefix from forge.yaml → repos.satellites)
- NEVER bypass /work-on with manual git/gh commands — the label updates and structured comments are critical for tracking
- NEVER target `main` for PRs targeting the default repo. Use `{STAGING_BRANCH}` for fast-lane issues, or `milestone/{slug}` for milestone issues.
- Satellite repos (MCP, n8n) have no staging branch — fast-lane PRs go to `main` for those.
- If the issue is INVALID after investigation, close it with a comment explaining why
- If you hit merge conflicts or blockers, post a comment on the issue and STOP — do not force anything
- Do not interact with the user — you are running autonomously in the background
- **NEVER ask the user questions** — you are a background agent. If review finds issues, auto-fix simple ones and proceed. For complex findings, merge anyway and create follow-up issues.

**LABEL-STATE LOOP CONTRACT — enforce after EVERY Skill return**:
After EVERY `Skill(skill='work-on', ...)` call returns, immediately check the issue's current workflow label:
```bash
gh issue view {NUMBER} -R {GH_REPO} --json labels --jq '[.labels[].name | select(startswith("workflow:"))]'
```
**Terminal labels** (only these allow you to stop): `workflow:merged`, `workflow:invalid`
**Terminal condition also**: `needs-human` label present OR issue state is `closed`
If the label is NOT terminal (e.g., `workflow:investigating`, `workflow:ready-to-build`, `workflow:building`, `workflow:in-review`), invoke `Skill(skill='work-on', args='{NUMBER}')` again immediately. The `/work-on` skill will re-read GitHub state and advance to the next phase. Do NOT output a summary, do NOT pause, do NOT ask for confirmation — just invoke it again.

**CRITICAL — SOURCE BRANCH DETECTION**:
- If the issue has the `review-finding` label, read the issue body for `**Code branch**: \`{branch}\``
- If found, that is the SOURCE_BRANCH — the code ONLY exists on that branch (e.g., `staging`), NOT on `origin/main`
- Investigation MUST use `git show origin/{SOURCE_BRANCH}:{filepath}` to verify the code exists
- Worktree MUST branch from `origin/{SOURCE_BRANCH}`, NOT `origin/main`
- PR target is `{SOURCE_BRANCH}` (the fix goes back to where the code lives)

**LANE**: {LANE} (PR target: {PR_BASE})
**Issue title**: {ISSUE_TITLE}
{GIST_CONTEXT}
"
)
```

**`{GIST_CONTEXT}` generation**: For each issue being dispatched, check if it was spawned by an investigation that has a Knowledge Gist (from Step 2C.5). If so, include the Gist URL(s) in the agent prompt:

```bash
# Build GIST_CONTEXT for an issue
GIST_CONTEXT=""
PARENT_INV=$(gh issue view {NUMBER} -R {GH_REPO} --json body --jq '.body' \
  | grep -oP '(?i)parent[: ]*#\K\d+|spawned from[: ]*#\K\d+' | head -1)

if [ -n "$PARENT_INV" ] && [ -n "${INVESTIGATION_GISTS[$PARENT_INV]:-}" ]; then
  GIST_CONTEXT="
**CONTEXT FROM PRIOR INVESTIGATION**: Investigation #${PARENT_INV} produced Knowledge Gist(s) with findings relevant to this issue:
$(echo "${INVESTIGATION_GISTS[$PARENT_INV]}" | while IFS= read -r url; do echo "- ${url}"; done)
Fetch the Gist content during the context-gathering phase for implementation guidance."
fi

# Include milestone index URL if available (from Step 2C.5)
if [ -n "$MILESTONE_INDEX_URL" ]; then
  GIST_CONTEXT="${GIST_CONTEXT}

**MILESTONE KNOWLEDGE INDEX**: All investigation findings for this milestone are aggregated in a single index Gist:
- ${MILESTONE_INDEX_URL}
The context-gathering phase can fetch this index to discover all investigation Gists for the milestone."
fi
```

If `GIST_CONTEXT` is empty (no parent investigation or milestone index found), the variable resolves to a blank line in the template — no impact on the agent prompt. <!-- Updated: forge#341 -->

**Capture agent IDs at spawn time (MANDATORY)**: Each `Agent(...)` call returns an agent ID. Store it in `AGENT_ISSUE_MAP` keyed by issue number immediately after the spawn. This map is the only way to resume a stalled agent by ID in Steps 4B and 4B.5:

```
# After each Agent() spawn, capture the returned ID:
AGENT_ISSUE_MAP[{NUMBER}] = <agent_id returned by Agent()>
```

`AGENT_ISSUE_MAP` starts empty and accumulates entries as agents are spawned. For multiple simultaneous spawns (parallel dispatch), capture each ID immediately after the corresponding spawn call before invoking the next one. Without this capture, `resume=` calls in Steps 4B and 4B.5 will have no agent ID to reference and the resume will fail. <!-- Added: forge#1083 -->

**Launch all ready agents simultaneously** by putting multiple Agent tool calls in a single message. Use `run_in_background=true` so they execute in parallel.

### Step 4B: Monitor completions and dispatch newly ready issues

You will be automatically notified when each background agent completes. **Do NOT use `sleep` loops to poll for completion.** Instead, wait for the automatic notification. When you receive a notification that an agent completed, immediately process it.

**Core streaming dispatch loop**: After processing each agent completion, check the DAG for newly unblocked issues. If any issue now has all predecessors in a terminal state, dispatch it immediately (run Steps 4A.pre.0, 4A.pre, and 4A for the newly ready issues). This is the key difference from the wave model — issues dispatch as soon as their specific predecessors complete, not after an entire group finishes.

```bash
# After each agent completion, check for newly ready issues:
for BLOCKED_NUM in {all_blocked_issue_numbers}; do
  ALL_PREDS_DONE=true
  for PRED in {predecessors_of_BLOCKED_NUM}; do
    PRED_STATE=$(gh issue view $PRED -R {GH_REPO} --json labels,state --jq '{state: .state, workflow: [.labels[].name | select(startswith("workflow:"))]}')
    # Terminal states: workflow:merged, workflow:invalid, needs-human, or state=CLOSED
    if ! echo "$PRED_STATE" | grep -qE 'workflow:merged|workflow:invalid|needs-human|CLOSED'; then
      ALL_PREDS_DONE=false
      break
    fi
  done
  if [ "$ALL_PREDS_DONE" = "true" ]; then
    echo "#{BLOCKED_NUM} is now READY — all predecessors resolved. Dispatching."
    # Add to dispatch batch for this completion cycle
  fi
done
# Run Steps 4A.pre.0 → 4A.pre → 4A for newly ready issues (batch them in a single message)
```

**CRITICAL — Stall detection and recovery**: Background agents sometimes stop mid-pipeline (`stop_reason=end_turn`) after completing a sub-phase (e.g., investigation completes but build never starts). This causes the agent to "complete" from the Agent tool's perspective even though the `/work-on` pipeline is only partially done. When you receive a completion notification:

1. **Check if the agent completed the FULL pipeline** — not just one phase:
   ```bash
   # Check final workflow state — only workflow:merged or workflow:invalid means truly done
   FINAL_STATE=$(gh issue view $NUM -R {GH_REPO} --json labels,state --jq '{state: .state, workflow: [.labels[].name | select(startswith("workflow:"))]}')
   echo "#{NUM}: $FINAL_STATE"
   ```

2. **If the issue is NOT in a terminal state** (`workflow:merged`, `workflow:invalid`, or `needs-human`), the agent stalled mid-pipeline. **Resume it immediately**:
   ```
   Agent(
     resume=AGENT_ISSUE_MAP[{NUMBER}],
     description="Resume #{NUMBER} pipeline",
     run_in_background=true,
     prompt="The previous /work-on invocation stopped before completing the full pipeline. The issue is currently at {CURRENT_WORKFLOW_STATE}. Continue — invoke Skill(skill='work-on', args='{NUMBER}') to resume the routing loop from the current state. /work-on will re-read GitHub state and pick up where it left off."
   )
   ```
   **Resume ALL stalled agents in a single message** (parallel resume). Do not wait between resumes.

3. **Track resume cycles per agent.** If an agent has been resumed 2+ times and still hasn't reached a terminal state, report it as a failure — do not resume again.

4. **Record completed results**: Success (PR merged), Invalid (issue closed), Blocked (needs human), or Error

5. **Check for newly unblocked issues** — run the DAG readiness check above. If any issues are now ready, dispatch them immediately (Steps 4A.pre.0 → 4A.pre → 4A). Batch all newly ready issues into a single dispatch message.

6. **Handle predecessor failures** — if a completed agent's issue FAILED (needs-human, invalid, or error), check for dependent issues in the DAG. Mark all transitive dependents as "skipped — dependency #{X} failed" and report them. Do NOT dispatch them.

7. **Verify pipeline compliance** — for each truly completed issue, check that the agent used `/work-on`:
   ```bash
   LABELS=$(gh issue view $NUM -R {GH_REPO} --json labels --jq '[.labels[].name | select(startswith("workflow:"))] | length')
   COMMENTS=$(gh api repos/{GH_REPO}/issues/${NUM}/comments --jq '[.[] | select(.body | test("FORGE:INVESTIGATOR|FORGE:BUILDER"))] | length')
   if [ "$LABELS" -eq 0 ] || [ "$COMMENTS" -eq 0 ]; then
     echo "PIPELINE FAILURE: #{NUM} — agent bypassed /work-on (no labels or structured comments)"
   fi
   ```
   If an agent bypassed the pipeline, report it as a **failure** regardless of whether a PR exists.

8. **Post a brief status update** to the user after each agent reaches terminal state:
   ```
   ✓ #{NUMBER} — {title} → PR #{PR} merged to {target}
   ✗ #{NUMBER} — {title} → {reason for failure}
   ⚠ #{NUMBER} — {title} → PIPELINE BYPASS (no /work-on — PR invalid)
   ⏳ Progress: {completed}/{total} complete, {active} active, {blocked} blocked
   → Dispatched #{NEWLY_READY} (predecessor #{PRED} completed)
   ```

9. **Run staging integrity check** (from Step 4A-pre) if the completed agent merged a PR targeting staging.

**Termination condition**: All issues in the DAG are in a terminal state (merged, invalid, needs-human, or skipped due to dependency failure). When this condition is met, check whether deferred review-spawned findings exist (accumulated in `DEFERRED_FINDINGS` during Step 4C). If deferred findings exist → proceed to Step 4F (Completion Sweep). If no deferred findings → proceed to Phase 5.

**Anti-pattern — DO NOT DO THIS:**
- `sleep 60/120/180/300` loops to check status — you will be notified automatically
- Spawning separate "progress check" agents — they waste tokens and add noise
- Reading agent JSONL output files to check progress — use GitHub labels as the source of truth
- Polling the same status check repeatedly on a timer
- Waiting for a "batch" of completions before checking for newly ready issues — check after EVERY completion

### Step 4B.5: Time-Based Stall Detection

**Purpose**: Catches agents that have stopped responding WITHOUT exiting (e.g., rate-limited, context-frozen, or silently hung). The reactive check in Step 4B only fires on agent completion — this check catches agents that never complete at all.

**When to run** (NOT a sleep loop — two trigger points only):
1. On every background agent completion event (run BEFORE the terminal-state check in Step 4B)
2. Before posting any "waiting for agents..." status update to the user

**Do NOT poll on a timer. Do NOT use sleep. Run at these two trigger points only.**

**Read stall timeout from config**:
```bash
STALL_TIMEOUT=$(yq '.pipeline.stall_timeout_minutes // 15' forge.yaml 2>/dev/null || echo 15)
```

**For each non-terminal agent in the current batch**:
```bash
for NUM in {active_issue_numbers}; do
  # Skip issues already in terminal state
  TERMINAL=$(gh issue view $NUM -R {GH_REPO} --json labels \
    --jq '[.labels[].name | select(. == "workflow:merged" or . == "workflow:invalid" or . == "needs-human")] | length')
  [ "$TERMINAL" -gt 0 ] && continue

  # Get last activity timestamp — prefer last comment (catches FORGE:HEARTBEAT updates)
  LAST_ACTIVITY=$(gh api repos/{GH_REPO}/issues/${NUM}/comments \
    --jq '.[-1].updated_at // empty' 2>/dev/null)
  # Fall back to issue updated_at if no comments
  if [ -z "$LAST_ACTIVITY" ]; then
    LAST_ACTIVITY=$(gh issue view $NUM -R {GH_REPO} --json updatedAt --jq '.updatedAt')
  fi

  # Compute elapsed minutes (GNU date — adjust for macOS: date -j -f "%Y-%m-%dT%H:%M:%SZ")
  LAST_EPOCH=$(date -d "$LAST_ACTIVITY" +%s 2>/dev/null \
    || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_ACTIVITY" +%s 2>/dev/null)
  NOW_EPOCH=$(date +%s)
  ELAPSED_MIN=$(( (NOW_EPOCH - LAST_EPOCH) / 60 ))

  if [ "$ELAPSED_MIN" -gt "$STALL_TIMEOUT" ]; then
    # Count prior stall events on this issue
    STALL_COUNT=$(gh api repos/{GH_REPO}/issues/${NUM}/comments \
      --jq '[.[] | select(.body | contains("FORGE:STALL_DETECTED"))] | length')

    CURRENT_STATE=$(gh issue view $NUM -R {GH_REPO} --json labels \
      --jq '[.labels[].name | select(startswith("workflow:"))] | .[0] // "unknown"')

    if [ "$STALL_COUNT" -lt 2 ]; then
      # Auto-resume: post stall annotation and re-invoke /work-on
      RESUME_ATTEMPT=$(( STALL_COUNT + 1 ))
      gh issue comment $NUM -R {GH_REPO} --body "<!-- FORGE:STALL_DETECTED -->
## Stall Detected

**Issue**: #${NUM}
**Elapsed since last activity**: ${ELAPSED_MIN} min (threshold: ${STALL_TIMEOUT} min)
**Current workflow state**: ${CURRENT_STATE}
**Auto-resume attempt**: ${RESUME_ATTEMPT} of 2
**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

      # Resume the agent — collect all resumes and launch in a single message (see Step 4B rule)
      # STALL_RESUME_LIST is accumulated and launched in parallel after the loop
      STALL_RESUME_LIST="$STALL_RESUME_LIST $NUM"
    else
      # 2+ prior stalls — auto-resume exhausted, escalate to needs-human
      gh issue edit $NUM -R {GH_REPO} --add-label "needs-human"
      gh issue comment $NUM -R {GH_REPO} --body "<!-- FORGE:STALL_DETECTED -->
## Stall Escalated — Needs Human Intervention

Issue #${NUM} has been auto-resumed ${STALL_COUNT} times without reaching a terminal state. Auto-resume limit (2) exhausted. Manual intervention required.

**Last workflow state**: ${CURRENT_STATE}
**Total elapsed since last activity**: ${ELAPSED_MIN} min
**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "STALL ESCALATED: #{NUM} → needs-human (${STALL_COUNT} prior resumes)"
    fi
  fi
done

# Launch all stall resumes in parallel (single message — same rule as Step 4B)
# For each NUM in $STALL_RESUME_LIST, call Agent(resume=AGENT_ISSUE_MAP[NUM], run_in_background=true, ...)
```

**Resume all stalled agents in a single message** (parallel). Use the same `Agent(resume=...)` pattern as Step 4B — do not wait between individual resumes.

**Track stall resume cycles separately** from completion-event resumes (Step 4B). If the same issue accumulates ≥ 2 `FORGE:STALL_DETECTED` comments AND still hasn't reached terminal state, do not resume again — the `needs-human` label is already set.

### Step 4C: Collect review-finding issues from completed agents

After each agent reaches a terminal state, check if its `/work-on` run spawned review-finding issues during the review phase. These are new work items that should be added to the dependency DAG and dispatched when ready.

```bash
# Method 1: Read TRAJECTORY comments from completed issues for "Finding issues" row
for NUM in {completed_issue_number}; do
  gh api repos/{GH_REPO}/issues/${NUM}/comments \
    --jq '.[] | select(.body | contains("FORGE:TRAJECTORY")) | .body' 2>/dev/null \
    | grep -oP 'Finding issues\s*\|\s*#?\K\d+[^|]*' | grep -oP '\d+' | sort -u
done

# Method 2 (fallback): Check for recently created review-finding issues that reference PRs from this batch
gh issue list -R {GH_REPO} --state open --label "review-finding" --limit 20 \
  --json number,title,body,createdAt \
  --jq "[.[] | select(.createdAt > \"$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)\")]"
```

**If review-finding issues were spawned:**

**Cascade control (MANDATORY — run before folding findings into the DAG):**

For each spawned finding, determine whether it should be **executed** or **deferred**:

**Evaluation order** (first matching rule wins):
1. **Generation ≥ 2** (always defer, even for P1/P2): Finding was spawned by an issue that was itself a review-finding. Check the source issue's labels for `review-finding` — if the source has that label, the new finding is generation 2. Always defer. Rationale: gen-2+ cascade is theoretically unbounded — cap it here.
2. **Priority override** (P1 or P2 → always execute): If the finding is labeled P1 or P2, skip all remaining heuristics and execute. Rationale: high-priority findings must never be suppressed by keyword matching.
3. **Comment/typo heuristic** (P3 and below only): Finding title contains the word "comment" or "typo" (case-insensitive). These are 1-line cosmetic fixes that do not block other work.
4. **P3 + same-file overlap**: Finding is labeled `P3` AND the file it targets overlaps with ANY file already in the current batch (active or queued in the DAG). Rationale: same-file P3 findings add predecessor edges that serialize agents — one finding per original issue increases wall-clock time with no proportional value.

**Defer** (do NOT add to the DAG) if rules 1, 3, or 4 match.

**Execute** (add to the DAG) if:
- Rule 2 matches (P1 or P2)
- None of the defer rules matched (generation 1, P3 with no file overlap, not a keyword match)

**Before running the loop, build the batch file list (MANDATORY for Heuristic 3):**

Collect all file paths from every issue in the current batch — both completed and remaining queued issues in the DAG. This produces `ALL_BATCH_FILES`, a newline-separated list of file paths used by Heuristic 3 to test same-file overlap.

```bash
# Build ALL_BATCH_FILES: collect file paths from ALL batch issues (completed + queued)
# Use the same extraction pattern as Step 3C Layer 1
ALL_BATCH_FILES=""
for NUM in {all_batch_issue_numbers}; do
  # Try INVESTIGATOR comment first (most reliable source of affected files)
  FILES=$(gh api repos/{GH_REPO}/issues/${NUM}/comments \
    --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' 2>/dev/null \
    | grep -oP '`[^`]*\.(py|tsx?|jsx?|sql|json|ya?ml|sh|md)`' | tr -d '`' | sort -u)
  # Fall back to issue body if no investigator comment
  if [ -z "$FILES" ]; then
    FILES=$(gh issue view $NUM -R {GH_REPO} --json body --jq '.body' \
      | grep -oP '`[^`]*\.(py|tsx?|jsx?|sql|json|ya?ml|sh|md)`' | tr -d '`' | sort -u)
  fi
  ALL_BATCH_FILES=$(printf '%s\n%s' "$ALL_BATCH_FILES" "$FILES")
done
ALL_BATCH_FILES=$(echo "$ALL_BATCH_FILES" | sort -u | grep -v '^$')
```

```bash
# For each finding, check its priority label and generation
for FINDING_NUM in {spawned_finding_numbers}; do
  FINDING_DATA=$(gh issue view $FINDING_NUM -R {GH_REPO} --json labels,title,body \
    --jq '{labels: [.labels[].name], title: .title, body: .body}')

  PRIORITY=$(echo "$FINDING_DATA" | jq -r '.labels[] | select(startswith("priority:P")) | ltrimstr("priority:")' | head -1)
  TITLE=$(echo "$FINDING_DATA" | jq -r '.title')

  # Heuristic 1: Generation check — source issue has review-finding label (always defer, even for P1/P2)
  if SOURCE_NUM=$(echo "$FINDING_DATA" | jq -r '.body' | grep -oP '(?i)spawned from issue #\K\d+|source issue[: #]+\K\d+' | head -1) && \
       [ -n "$SOURCE_NUM" ] && \
       gh issue view $SOURCE_NUM -R {GH_REPO} --json labels --jq '[.labels[].name]' 2>/dev/null | grep -q "review-finding"; then
    DEFER=true; DEFER_REASON="generation >= 2 (source #${SOURCE_NUM} is also a review-finding)"
  # Priority override: P1 or P2 always execute — skip remaining heuristics
  elif [ "$PRIORITY" = "P1" ] || [ "$PRIORITY" = "P2" ]; then
    DEFER=false
  # Heuristic 2: Comment/typo keyword (only applies to P3 and below)
  elif echo "$TITLE" | grep -qi "comment\|typo"; then
    DEFER=true; DEFER_REASON="comment/typo heuristic"
  # Heuristic 3: P3 + same-file overlap
  elif [ "$PRIORITY" = "P3" ]; then
    # Extract file target from finding body (look for code block or backtick path)
    FINDING_FILE=$(echo "$FINDING_DATA" | jq -r '.body' | grep -oP '`[^\`]+\.(py|ts|tsx|sh|md)`' | head -1 | tr -d '`')
    if [ -n "$FINDING_FILE" ] && echo "$ALL_BATCH_FILES" | grep -qF "$FINDING_FILE"; then
      DEFER=true; DEFER_REASON="P3 + same file as batch: $FINDING_FILE"
    else
      DEFER=false
    fi
  else
    DEFER=false
  fi

  if [ "$DEFER" = "true" ]; then
    DEFERRED_FINDINGS+=($FINDING_NUM)
    DEFERRED_REASONS[$FINDING_NUM]="$DEFER_REASON"
    echo "Deferred #${FINDING_NUM}: $DEFER_REASON"
  else
    QUEUED_FINDINGS+=($FINDING_NUM)
  fi
done
```

**For queued (non-deferred) findings:**

1. **Add them to the dependency DAG.** They are implementation issues — same as issues spawned by investigations in Phase 2. Compute their predecessor sets using the same conflict detection (Step 3C Layers 1-4) against all remaining blocked/active issues.
2. **Respect source branch context.** Review-finding issues have `**Code branch**: \`{branch}\`` in their body — the `/work-on` agent will read this and branch from the right origin. No special handling needed from the orchestrator.
3. **Report to user:**
   ```
   Agent #{COMPLETED} spawned {count} new finding issues: #{A}, #{B}
   Added to DAG: #{A} (predecessors: {}), #{B} (predecessors: {#{X}})
   Deferred (cascade control): #{C} (P3 same-file), #{D} (comment heuristic)
   ```
4. **Re-run file-overlap detection** (Step 3C) on the expanded issue set — finding issues may conflict with active or queued issues that touch the same files. Ready findings dispatch immediately via the standard Step 4B dispatch loop.

**For deferred findings:**

Track them in `DEFERRED_FINDINGS` for re-evaluation in Step 4F (Completion Sweep) after the DAG drains. Do NOT close or label them yet — the sweep will determine their final disposition.

**If no review-finding issues were spawned:** Continue monitoring for the next agent completion.

### Step 4C.5: Milestone lane-consistency check (periodic) <!-- Added: forge#901 -->

**WHY THIS EXISTS**: A milestone's feature-lane PRs must all target the same milestone branch. If a branch-routing race ever scatters them — some on the milestone branch, some on staging — the milestone branch becomes incomplete relative to staging, and the split is otherwise invisible until the milestone tries to ship. Step 4A.pre.0 prevents the split deterministically; this check detects any residual split so it surfaces immediately instead of at ship time.

**When to run**: After every 3rd agent completion (or after all agents complete, whichever comes first), for any batch where at least one issue has a milestone. Skip for pure fast-lane batches. This check is **non-blocking** — it alerts; it does not auto-resolve or stop the pipeline.

```bash
# For each distinct milestone in the batch, assert all of its feature-lane PRs share one base.
for NUM in {all_batch_issue_numbers}; do
  MILESTONE_TITLE=$(gh issue view "$NUM" -R {GH_REPO} --json milestone --jq '.milestone.title // empty' 2>/dev/null || echo "")
  [ -z "$MILESTONE_TITLE" ] && continue

  SLUG=$(echo "$MILESTONE_TITLE" \
    | tr '[:upper:]' '[:lower:]' \
    | tr ' ' '-' \
    | tr -cd 'a-z0-9-' \
    | sed 's/--*/-/g' \
    | sed 's/^-//;s/-$//')
  [ -z "$SLUG" ] && continue
  EXPECTED_BASE="milestone/$SLUG"

  # Collect the base branch of every PR that closes an issue in this milestone.
  # Iterate the milestone's issues and read each one's linked PR base.
  # Exclude CLOSED-unmerged PRs: a closed-but-not-merged PR is a superseded/abandoned
  # routing attempt and does NOT reflect the live lane. Keep only OPEN (in-flight) and
  # MERGED (landed) PRs. `gh pr list --state` cannot combine open+merged, so query all
  # and drop CLOSED in jq.
  BASES=$(gh pr list -R {GH_REPO} --state all --search "milestone:\"$MILESTONE_TITLE\"" \
    --json baseRefName,state --jq '.[] | select(.state != "CLOSED") | .baseRefName' 2>/dev/null | sort -u)
  # Fallback: if PR search by milestone is unavailable, derive from the issues' linked PRs.
  if [ -z "$BASES" ]; then
    BASES=$(for IN in {all_batch_issue_numbers}; do
      IM=$(gh issue view "$IN" -R {GH_REPO} --json milestone --jq '.milestone.title // empty' 2>/dev/null)
      [ "$IM" = "$MILESTONE_TITLE" ] || continue
      gh pr list -R {GH_REPO} --state all --search "$IN in:body" \
        --json baseRefName,state --jq '.[] | select(.state != "CLOSED") | .baseRefName' 2>/dev/null
    done | sort -u)
  fi

  STRAY_BASES=$(echo "$BASES" | grep -v "^${EXPECTED_BASE}\$" | grep -v '^$' || true)
  if [ -n "$STRAY_BASES" ]; then
    echo "ALERT: milestone '$MILESTONE_TITLE' has feature-lane PRs split across multiple base branches." >&2
    echo "       Expected base: $EXPECTED_BASE" >&2
    echo "       Found bases:" >&2
    echo "$BASES" | sed 's/^/         - /' >&2
    echo "       This indicates a branch-routing split — reconcile the stray PRs onto $EXPECTED_BASE" >&2
    echo "       (rebase/cherry-pick the stray branch onto the milestone branch) before the milestone ships." >&2
    # Do NOT auto-stop or auto-resolve — surface the alert and let the user decide.
  else
    echo "Lane-consistency OK: all '$MILESTONE_TITLE' PRs target $EXPECTED_BASE."
  fi
done
```

Report any `ALERT` lines prominently before dispatching more agents. Reconciliation of an existing split is a manual/`/milestone`-assisted step — this check only ensures the split is never silent.

### Step 4D: Milestone integration build gate (MANDATORY — periodic for milestone batches)

**WHY THIS EXISTS**: Session Intelligence milestone shipped 116 PRs across multiple dispatches with zero integration testing. Each PR built in isolation — type errors from cross-PR interactions (wrong prop types, missing components, incompatible interfaces) were invisible until the milestone→staging merge broke the build with 4 distinct errors. This gate catches those failures early.

**When to run**: After every 3rd milestone-targeted agent completion (or when all milestone issues are complete), IF the batch targets a milestone branch AND any `.tsx`/`.ts` files were changed by agents in the completed set. Running after every single agent would be too frequent — batch the check to reduce overhead while still catching integration errors before they accumulate.

All tool commands are read from `forge.yaml → verification.commands`; each step logs `SKIPPED — not configured` when the corresponding key is absent rather than silently passing.

```bash
# Read toolchain commands from forge.yaml
TS_TYPECHECK=$(yq '.verification.commands.typescript.typecheck // ""' forge.yaml 2>/dev/null || echo '')
TS_BUILD=$(yq '.verification.commands.typescript.build // ""' forge.yaml 2>/dev/null || echo '')
PYTHON_FORMAT=$(yq '.verification.commands.python.format // ""' forge.yaml 2>/dev/null || echo '')

# Check if this is a milestone batch with TypeScript changes
MILESTONE_BRANCH="milestone/{milestone_slug}"
TS_CHANGED=$(git diff origin/{DEFAULT_BRANCH}...origin/${MILESTONE_BRANCH} --name-only | grep -E '\.(tsx?|jsx?)$' | head -1)

if [ -n "$TS_CHANGED" ]; then
    echo "=== Integration Build Gate (TypeScript): batch checkpoint ==="
    cd {REPO_PATH}
    git fetch origin ${MILESTONE_BRANCH}
    git checkout origin/${MILESTONE_BRANCH} --detach 2>/dev/null

    if [ -n "$TS_TYPECHECK" ]; then
        eval "$TS_TYPECHECK" 2>&1 | head -30
        TSC_EXIT=$?
    else
        echo "SKIPPED — typescript.typecheck not configured in verification.commands"
        TSC_EXIT=0
    fi

    if [ "$TSC_EXIT" -eq 0 ] && [ -n "$TS_BUILD" ]; then
        eval "$TS_BUILD" 2>&1 | tail -30
        BUILD_EXIT=$?
    elif [ -z "$TS_BUILD" ]; then
        echo "SKIPPED — typescript.build not configured in verification.commands"
        BUILD_EXIT=0
    fi

    git checkout - 2>/dev/null

    if [ "$TSC_EXIT" -ne 0 ]; then
        echo "BLOCKING: TypeScript errors on ${MILESTONE_BRANCH} after batch checkpoint."
        echo "Fix type errors before dispatching more milestone agents."
    elif [ "${BUILD_EXIT:-0}" -ne 0 ]; then
        echo "BLOCKING: build failed on ${MILESTONE_BRANCH} after batch checkpoint."
        echo "Build/prerender errors — fix before dispatching more milestone agents."
    fi
fi

# Python format check
PY_CHANGED=$(git diff origin/{DEFAULT_BRANCH}...origin/${MILESTONE_BRANCH} --name-only | grep -E '\.py$' | head -1)
if [ -n "$PY_CHANGED" ]; then
    echo "=== Integration Build Gate (Python): batch checkpoint ==="
    cd {REPO_PATH}
    git checkout origin/${MILESTONE_BRANCH} --detach 2>/dev/null

    if [ -n "$PYTHON_FORMAT" ]; then
        eval "$PYTHON_FORMAT" 2>&1 | tail -10
        FORMAT_EXIT=$?
    else
        echo "SKIPPED — python.format not configured in verification.commands"
        FORMAT_EXIT=0
    fi

    git checkout - 2>/dev/null

    if [ "$FORMAT_EXIT" -ne 0 ]; then
        echo "WARNING: Python formatting issues on ${MILESTONE_BRANCH} after batch checkpoint."
        echo "Not blocking but should be fixed before milestone→staging."
    fi
fi
```

**If the gate fails**: Report the errors to the user. Do NOT dispatch any more milestone-targeted agents until the integration errors are resolved. The accumulated milestone branch has integration errors that will only get worse with more PRs on top. Build failures are BLOCKING — SSG/prerender crashes are invisible to typecheck alone — configure `typescript.build` in `verification.commands` to catch them. Non-milestone (fast-lane) agents may continue dispatching normally.

### Step 4E: Handle individual agent failures

If an agent reports failure or error:
- **Merge conflict**: Report to user, mark issue as needing human attention
- **Invalid issue**: Already handled by the agent (closed with comment) — just report it
- **Build/test failure**: Report the error, suggest manual intervention
- **Agent timeout**: Report which issue timed out, suggest re-running with `/work-on #{N}`
- **Dependency cascade**: Mark all transitive dependents in the DAG as "skipped — dependency #{X} failed"

**Do NOT retry failed agents automatically.** Report the failure and let the user decide.

### Step 4F: Completion Sweep (deferred review-spawned findings) <!-- Added: forge#1105 -->

**When to run**: After all DAG issues reach terminal state AND `DEFERRED_FINDINGS` is non-empty. Skip if no findings were deferred during this batch.

**WHY THIS EXISTS**: Deferred findings accumulate during the batch because of file-overlap and cascade-control heuristics (Step 4C). But once the DAG drains, the conditions that caused deferral often no longer apply — completed issues no longer occupy files, so same-file overlap vanishes. Without this sweep, deferred findings silently pile up across runs and never get resolved.

**Step 4F.1: Classify deferred findings into permanent vs re-evaluable**

```bash
PERMANENT_DEFERRED=()
SWEEP_CANDIDATES=()

for FINDING_NUM in "${DEFERRED_FINDINGS[@]}"; do
  DEFER_REASON="${DEFERRED_REASONS[$FINDING_NUM]}"

  # Generation >= 2 deferrals are PERMANENT — unbounded cascade prevention
  if echo "$DEFER_REASON" | grep -qi "generation"; then
    PERMANENT_DEFERRED+=($FINDING_NUM)
  else
    # All other deferrals (comment/typo, P3 same-file) are re-evaluable
    SWEEP_CANDIDATES+=($FINDING_NUM)
  fi
done

echo "Completion sweep: ${#SWEEP_CANDIDATES[@]} re-evaluable, ${#PERMANENT_DEFERRED[@]} permanent"
```

**Step 4F.2: Re-evaluate sweep candidates**

Re-run the Step 4C heuristics against the now-empty DAG. Since all original batch issues are in terminal state, the `ALL_BATCH_FILES` list for file-overlap detection is empty — P3 same-file deferrals will now pass.

```bash
SWEEP_EXECUTE=()
SWEEP_STILL_DEFERRED=()

for FINDING_NUM in "${SWEEP_CANDIDATES[@]}"; do
  FINDING_DATA=$(gh issue view $FINDING_NUM -R {GH_REPO} --json labels,title,body,state \
    --jq '{labels: [.labels[].name], title: .title, body: .body, state: .state}')

  # Skip if already closed (resolved by another process)
  STATE=$(echo "$FINDING_DATA" | jq -r '.state')
  [ "$STATE" = "CLOSED" ] && continue

  PRIORITY=$(echo "$FINDING_DATA" | jq -r '.labels[] | select(startswith("priority:P")) | ltrimstr("priority:")' | head -1)
  TITLE=$(echo "$FINDING_DATA" | jq -r '.title')

  # Re-apply heuristics against the drained DAG (no active batch files)
  # Comment/typo heuristic still applies — these are cosmetic regardless of DAG state
  if echo "$TITLE" | grep -qi "comment\|typo"; then
    SWEEP_STILL_DEFERRED+=($FINDING_NUM)
    echo "Sweep: #${FINDING_NUM} still deferred (comment/typo — cosmetic)"
  else
    # P3 same-file overlap no longer applies (DAG is drained, no active files)
    # All other findings are safe to execute
    SWEEP_EXECUTE+=($FINDING_NUM)
    echo "Sweep: #${FINDING_NUM} cleared for execution (file overlap resolved)"
  fi
done
```

**Step 4F.3: Dispatch cleared findings**

For each finding in `SWEEP_EXECUTE`, add it to a fresh sweep DAG and dispatch using the same Steps 4A.pre.0, 4A.pre, and 4A logic. Run file-overlap detection between the swept findings themselves (they may conflict with each other).

```bash
if [ ${#SWEEP_EXECUTE[@]} -gt 0 ]; then
  echo "Completion sweep: dispatching ${#SWEEP_EXECUTE[@]} cleared findings"

  # Build sweep DAG — same conflict detection as Step 3C Layers 1-4
  # but only among the swept findings (no original batch issues remain active)
  # Dispatch ready findings, monitor completions using the same Step 4B loop
  # This is a SINGLE pass — findings spawned during the sweep are NOT swept again
  # (they follow the standard Step 4C triage: queued or deferred for next run)

  for FINDING_NUM in "${SWEEP_EXECUTE[@]}"; do
    # Standard dispatch — same as Step 4A
    Agent(subagent_type="general-purpose",
      prompt="Run /work-on ${FINDING_NUM}",
      run_in_background=true)
  done

  # Monitor sweep agents using the same Step 4B completion loop
  # IMPORTANT: Findings spawned by sweep agents are NOT re-swept —
  # they follow standard Step 4C triage to prevent recursive cascades
fi
```

**Step 4F.4: Report sweep results**

```
Completion Sweep Results:
  Dispatched: #{A}, #{B} (file overlap cleared after DAG drain)
  Still deferred (cosmetic): #{C} (comment/typo)
  Permanently deferred (gen2): #{D} (generation >= 2 cascade cap)
```

**After sweep agents complete** (or if no findings were dispatched): proceed to Phase 5.

**Anti-patterns — DO NOT DO THIS:**
- Re-sweeping findings spawned during the sweep itself — this creates unbounded recursion. Sweep is a single pass.
- Overriding generation >= 2 deferrals — the cascade cap is absolute.
- Skipping the sweep because "there are only a few" deferred findings — even one deferred finding represents unresolved work.

---

## Phase 5: Post-Batch Cleanup

**This phase is MANDATORY after every orchestration batch.** It prevents the rot that accumulates when multiple agents merge PRs in parallel — stale labels, orphaned worktrees, unclosed issues.

### Step 5A: Run cleanup sweep

Invoke the `/cleanup` skill with `all` to sweep everything:

```
Skill(skill="cleanup", args="all")
```

This will:
- Fix stale workflow labels on any issues the agents left behind
- Close orphaned open issues whose PRs were merged (common when merging to `staging`)
- Remove worktrees created by agents in this batch
- Delete local/remote branches for merged PRs
- Report milestones that hit 0 open issues — these are ready for `/milestone ship` (staging review + merge). Do NOT close them; closure happens after code reaches staging.
- Sync Project board state

### Step 5B: Run agent audit

Invoke `/audit-agents` on this session to measure pipeline efficiency:

```
Skill(skill="audit-agents", args="latest")
```

Include the audit summary in the final report (Phase 6). Key metrics to surface:
- **Avg idle%** — percentage of time agents spent stalled vs working
- **Resume cycles** — how many times agents had to be resumed
- **Stall boundaries** — which phase transitions cause the most stalls

### Step 5C: Report cleanup results

Include the cleanup summary in the final report (Phase 6). If cleanup found problems, call them out — they indicate agent pipeline failures that may need investigation.

---

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
| Findings after synthesis | {N} (deduplicated/arbitrated) |
| Findings validated | {N} |
| False positives | {N} ({%}) |
| Anomalies flagged | {N} |

**Domain breakdown**: {N} scraping, {N} frontend, {N} billing, ...
**Routing**: {N} fast-lane, {N} feature-lane

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

---

## Safety Rules

1. **Every agent MUST invoke `/work-on` via the Skill tool.** No custom prompts. No manual implementation. Copy the Phase 4A template, fill in variables, done. (See HARD RULES at top of file.)
2. **NEVER merge anything to `main`** — agents merge to `staging` or `milestone/{slug}` only
3. **No artificial concurrency limit** — spawn as many agents as there are independent issues. Only file overlap and dependencies require sequencing.
4. **Always confirm with user before launching** — Step 3E is the mandatory checkpoint
5. **No retries** — if an agent fails, report it and move on
6. **Respect existing work** — skip issues already being worked on (`workflow:building`, `workflow:in-review`)
7. **Dependency failures cascade** — if A fails and B depends on A, all transitive dependents of A are skipped (not attempted)
8. **Always run post-batch cleanup** — Phase 5 is mandatory. Never skip `/cleanup all` after orchestration.
9. **NEVER close/skip issues as duplicates** — only `/work-on` investigation agents can make that call after examining the actual code. The orchestrator delegates, it does not adjudicate.
10. **Per-completion verification** — after each agent completes, check that it has `workflow:*` labels and structured comments. If an agent bypassed `/work-on`, report it as a pipeline failure.

---

## Examples

### "orchestrate milestone api-expansion"
→ Fetches all open issues in "API Expansion v1" milestone
→ Builds DAG: #1526 → #1527 → #1528 → #1529 (chain), #1530 (no predecessors)
→ Confirms with user, dispatches #1526 + #1530 immediately
→ When #1526 completes, dispatches #1527 immediately (doesn't wait for #1530)
→ Streaming continues until all issues reach terminal state

### "orchestrate #1533 #1250"
→ Fetches those 2 issues, no deps between them
→ DAG: both have empty predecessor sets
→ Confirms, dispatches both simultaneously

### "orchestrate next 5"
→ Gets top 5 priority issues, builds DAG
→ Confirms, dispatches all ready issues immediately
→ Dependent issues dispatch as predecessors complete

### "orchestrate P0"
→ Gets all P0 issues, runs them all (presumably urgent)
→ DAG: likely all independent — dispatches simultaneously
→ Confirms, executes

### "orchestrate fast-lane"
→ Gets all unmilestoned bugs/fixes
→ Builds DAG from file-conflict and domain-serialization edges
→ Dispatches all ready issues, streams dependent issues as predecessors complete

### "orchestrate milestone user-auth-v2"
→ Fetches all open issues in "User Auth v2" milestone
→ Detects #42 is an investigation issue (title: "Investigate: session expiry race condition under high concurrency")
→ Phase 2: Runs `/work-on 42` — investigation creates 3 new issues (#55-#57)
→ Re-fetches milestone issues, now includes #55-#57
→ Builds DAG: #38, #41, #55, #56 have no predecessors (ready); #39 depends on #38; #57 depends on #55
→ Dispatches #38, #41, #55, #56 simultaneously
→ When #38 completes, #39 dispatches immediately (doesn't wait for #41, #55, or #56)
→ When #55 completes, #57 dispatches immediately (doesn't wait for others)
→ Final report shows investigation spawned issues and streaming execution results
