---
description: Orchestrate parallel work on multiple issues or an entire milestone — spawns sub-agents that each run the full /work-on pipeline
argument-hint: [milestone <slug> | #1 #2 #3 | next <N> | fast-lane | P0]
---

# /orchestrate — Multi-Issue Parallel Orchestrator

**Input**: $ARGUMENTS

## HARD RULES — READ BEFORE ANYTHING ELSE

1. **Every agent MUST invoke `/work-on` via the Skill tool.** You do NOT write implementation prompts. You copy the Phase 4A template verbatim and fill in the `{VARIABLES}`. Nothing else. No custom prompts. No "just read and edit" shortcuts. The Skill tool invocation is what triggers labels, investigation comments, structured review, and trajectory tracking. Without it, the agent's work has no paper trail and is worthless.

2. **You are a dispatcher, not a builder.** You resolve issues, plan waves, spawn agents, and report results. You NEVER read code, edit files, or implement fixes yourself.

3. **After each wave, verify agents used `/work-on`.** Check that completed issues have `workflow:*` labels and structured comments. If an agent bypassed the pipeline, report it as a failure.

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
# Build satellite repo map from repos.satellites list
# Each satellite: { prefix, repo, staging_branch }
```

All `{GH_REPO}`, `{GH_FLAG}`, `{REPO_PATH}`, `{PROJECT_NAME}`, and `{STAGING_BRANCH}` references below are populated from `forge.yaml`.

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
| `next <N>` | Top N priority open issues (P0 first, then P1, etc.) |
| `next <N> all-repos` | Top N across ALL ecosystem repos |
| `fast-lane` or `fast` | All open fast-lane issues (no milestone, bugs/fixes) |
| `P0` or `P1` | All open issues with that priority label |
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
- Flag potential overlap in the wave plan for the user's awareness, but NEVER act on it

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

For each issue, estimate which domains it touches based on title, body, and labels. This improves wave planning — issues in the same domain likely touch the same files and should be sequential.

```bash
for NUM in {issue_numbers}; do
  ISSUE=$(gh issue view $NUM --json title,body,labels --jq '{title: .title, labels: [.labels[].name], body: (.body[:300])}')
  echo "=== #$NUM ==="
  echo "$ISSUE" | grep -qiE "credit|billing|pricing|stripe|tier.*cost|charge|refund" && echo "  BILLING" || true
  echo "$ISSUE" | grep -qiE "auth|session|jwt|login|permission|oauth" && echo "  AUTH" || true
  echo "$ISSUE" | grep -qiE "scrape|tier|proxy|playwright|playbook|worker|unified_consumer|penetrat" && echo "  SCRAPING" || true
  echo "$ISSUE" | grep -qiE "migration|\.sql|database|postgres|alembic" && echo "  DATABASE" || true
  echo "$ISSUE" | grep -qiE "component|page|layout|dashboard|ui|ux|frontend|web/src" && echo "  FRONTEND" || true
  echo "$ISSUE" | grep -qiE "docker|deploy|traefik|nginx|ci|cd|infra|github.action" && echo "  INFRA" || true
  echo "$ISSUE" | grep -qiE "cortex|llm|extract|schema|format" && echo "  CORTEX" || true
done
```

**Use domain info for wave planning:**
- Issues in the SAME domain (especially SCRAPING, BILLING, DATABASE) are more likely to touch the same files → prefer sequential within a wave or adjacent waves
- Issues in DIFFERENT domains are more likely independent → safe to parallelize
- BILLING + AUTH issues should be prioritized early (security-critical)
- **DATABASE issues are ALWAYS serialized — hard rule, no exceptions.** Multiple agents writing migrations simultaneously will produce duplicate migration numbers (e.g., two `0067_*.sql` files), which breaks the migration runner. Every DATABASE issue must be in its own wave. If 3 DATABASE issues are in a batch: Wave 1 runs issue A, Wave 2 runs issue B, Wave 3 runs issue C.

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
- If two issues share ANY affected file → they MUST be in separate waves (sequential)
- The issue with lower issue number goes first (stable ordering), unless an explicit `Depends on #` says otherwise
- Add a conflict note to the wave plan: "#{A} and #{B} both modify `{file}` — serialized"

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
# Read layout paths from forge.yaml review.layout; fall back to AlterLab defaults.
# Example (pseudo-code — adapt to your forge.yaml parsing method):
#   API_MAIN   = forge_yaml.review.layout.api_main   ?? "services/api/app/main.py"
#   WORKER_DIR = forge_yaml.review.layout.worker      ?? "services/worker"
#   PAGES_ROOT = forge_yaml.review.layout.pages       ?? "web/src/app"

HIGH_FAN_IN = [
  API_MAIN,                          # e.g. "services/api/app/main.py" — router/middleware registration
  WORKER_DIR + "/unified_consumer.py",  # e.g. "services/worker/worker/unified_consumer.py" — adjust to your worker entrypoint
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
- If an issue has 0 extracted file paths AND no domain tag could be determined → serialize it with the immediately preceding wave (safest default)
- Add a note to the plan: "#{N} — low file-extraction confidence, serialized conservatively"

**Rationale**: The cost of a false-negative (two agents conflict → one fails with merge error, wasting the full agent run) far exceeds the cost of a false-positive (an issue waits one extra wave before starting). Always err toward serialization when uncertain.

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
| Layer 4: Low confidence + no domain | **Conservative** | Serialize with prior wave |

**This supplements, not replaces, the domain keyword estimation.** Domain tags still help with broad sequencing decisions. Multi-layer conflict detection catches the specific cases keywords miss (e.g., two issues that both modify files in `services/api/app/models/` where one is labeled SCRAPING and the other BILLING — Layer 2 catches this even though Layer 1 shows no direct file overlap).

### Step 3D: Build the execution plan

Organize issues into **waves** (groups that can run in parallel):

**Wave rules:**
- Investigation issues already ran in Wave 0 (Phase 2) — they are NOT included in these waves
- Issues with NO dependencies and NO file overlap → same wave (parallel)
- Issues that depend on other issues in the set → later wave (after dependency completes)
- **No artificial agent limit per wave** — spawn as many parallel agents as there are independent issues. The only constraint is file overlap and explicit dependencies.
- Issues that touch the **same files** must be in separate waves (sequential) to avoid merge conflicts
- If unsure about conflicts, err on the side of parallel — each agent works in its own worktree

**Example plan:**
```
Wave 0 (already done): #2644 (investigation) → spawned #2645, #2646, #2647
Wave 1 (parallel): #2633 (orphaned queues), #2636 (invalidation sub), #2645 (new finding), #2646 (new finding)
Wave 2 (after deps): #2634 (enable daemon — after #2633 fixes memory leak), #2647 (depends on #2645)
```

### Step 3E: Present the plan to the user

```
## Orchestration Plan

**Scope**: {milestone name / "N issues" / "fast-lane"}
**Total issues**: {count} ({investigation_count} investigations + {implementation_count} implementations)
**Estimated waves**: {wave_count} (Wave 0 = investigations, then implementation waves)

{IF investigations exist:}
### Wave 0 — Investigations (run first, may spawn new issues)
| # | Title | Expected Output |
|---|-------|----------------|
| #{INV1} | {title} | New issues → folded into subsequent waves |

### Implementation Waves (after investigations complete)
{END IF}

### Domain Distribution
| Domain | Issues | Notes |
|--------|--------|-------|
| SCRAPING | {N} | {High overlap risk / Independent targets} |
| FRONTEND | {N} | {Independent pages / Shared components} |
| BILLING | {N} | {Critical — prioritize in Wave 1} |
| DATABASE | {N} | {Sequential — migration order matters} |
| AUTH | {N} | {Critical — Wave 1} |
| INFRA | {N} | {Independent} |
| CORTEX | {N} | {Independent} |

(Omit rows with 0 issues.)

### Implementation Waves

| Wave | Issues | Strategy |
|------|--------|----------|
| 1 | #{A}, #{B}, #{C} | Parallel (no deps, different domains) |
| 2 | #{D} (after #{A}), #{E} | Parallel (D waits for A) |
| 3 | #{F} (after #{D}) | Sequential |

**Note**: Wave 0 investigations may create additional issues that will be automatically added to the implementation waves. The final wave plan will be confirmed after investigations complete.

**Excluded** (already in progress / ineligible):
- #{X} — {reason}

Proceed? (yes / adjust / pick specific issues)
```

**Wait for user confirmation before spawning agents.** This is the checkpoint — once agents launch, they run autonomously.

**After confirmation**: If Wave 0 exists, execute Phase 2B-E first. Then re-present the expanded plan (with newly spawned issues slotted into waves) for a quick confirmation before launching implementation waves.

---

## Phase 4: Execute Waves

### Step 4A-pre: Capture staging baseline (MANDATORY before each wave)

**WHY THIS EXISTS**: Milestone-code-onto-staging contamination incidents (see issue #150) produce unexpected growth on the staging branch that is otherwise invisible until after a deploy. Capturing a line-count baseline before each wave and re-checking after allows early detection of any contamination by agents in that wave.

**When to run**: Before launching EVERY wave in batches that target `staging` (fast-lane or milestone→staging). Skip only for pure milestone-branch batches where `{PR_BASE}` is `milestone/*` and staging is not involved.

```bash
# Capture staging baseline before launching the wave
git fetch origin
STAGING_LINES_BEFORE=$(git diff --stat origin/main...origin/staging 2>/dev/null \
  | tail -1 \
  | grep -oP '\d+ insertion' \
  | grep -oP '\d+' \
  || echo "0")
echo "Staging baseline before Wave {N}: ${STAGING_LINES_BEFORE} lines ahead of main"
```

Store `STAGING_LINES_BEFORE` per wave. After the wave completes (after Step 4C), run the integrity check:

```bash
# Check staging integrity after wave completes (run after Step 4C)
git fetch origin
STAGING_LINES_AFTER=$(git diff --stat origin/main...origin/staging 2>/dev/null \
  | tail -1 \
  | grep -oP '\d+ insertion' \
  | grep -oP '\d+' \
  || echo "0")
STAGING_GROWTH=$((STAGING_LINES_AFTER - STAGING_LINES_BEFORE))

echo "Staging after Wave {N}: ${STAGING_LINES_AFTER} lines (+${STAGING_GROWTH} vs baseline)"

# Alert if growth exceeds expected delta
# Expected: only the lines from PRs merged in this wave
# Alert threshold: growth > 500 lines more than the sum of changed lines from wave PRs
# (Use 0 as threshold if no PRs merged — any growth is unexpected)
EXPECTED_DELTA={SUM_OF_PR_LINE_COUNTS_THIS_WAVE}  # set from PR diffs collected in 4B
UNEXPECTED_GROWTH=$((STAGING_GROWTH - EXPECTED_DELTA))
if [ "$UNEXPECTED_GROWTH" -gt 500 ]; then
  echo "ALERT: Staging grew by ${STAGING_GROWTH} lines (+${UNEXPECTED_GROWTH} beyond expected ${EXPECTED_DELTA})."
  echo "This may indicate milestone-code contamination via agent merge commits."
  echo "Review: git log --oneline --merges origin/main..origin/staging"
  echo "Do NOT merge staging → main until the unexpected growth is investigated."
  # Do NOT auto-stop — alert the user and let them decide
fi
```

If `UNEXPECTED_GROWTH > 500`, report the alert clearly before launching the next wave. The user confirms whether to continue.

---

### Step 4A: Launch a wave

**REMINDER: You MUST use the template below verbatim. Only fill in `{VARIABLES}`. Do NOT rewrite the agent prompt. Do NOT write custom implementation instructions. The agent MUST invoke `/work-on` via the Skill tool — this is the HARD RULE from the top of this file.**

For each issue in the current wave, spawn an Agent sub-agent that runs the full `/work-on` pipeline.

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

**`{GIST_CONTEXT}` generation**: For each issue in the wave, check if it was spawned by an investigation that has a Knowledge Gist (from Step 2C.5). If so, include the Gist URL(s) in the agent prompt:

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

**Launch all agents in the current wave simultaneously** by putting multiple Agent tool calls in a single message. Use `run_in_background=true` so they execute in parallel.

### Step 4B: Monitor wave completion

You will be automatically notified when each background agent completes. **Do NOT use `sleep` loops to poll for completion.** Instead, wait for the automatic notification. When you receive a notification that an agent completed, immediately process it.

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
     resume="{AGENT_ID}",
     description="Resume #{NUMBER} pipeline",
     run_in_background=true,
     prompt="The previous /work-on invocation stopped before completing the full pipeline. The issue is currently at {CURRENT_WORKFLOW_STATE}. Continue — invoke Skill(skill='work-on', args='{NUMBER}') to resume the routing loop from the current state. /work-on will re-read GitHub state and pick up where it left off."
   )
   ```
   **Resume ALL stalled agents in a single message** (parallel resume). Do not wait between resumes.

3. **Track resume cycles per agent.** If an agent has been resumed 3+ times and still hasn't reached a terminal state, report it as a failure — do not resume again.

4. **Record completed results**: Success (PR merged), Invalid (issue closed), Blocked (needs human), or Error

5. **Verify pipeline compliance** — for each truly completed issue, check that the agent used `/work-on`:
   ```bash
   LABELS=$(gh issue view $NUM -R {GH_REPO} --json labels --jq '[.labels[].name | select(startswith("workflow:"))] | length')
   COMMENTS=$(gh api repos/{GH_REPO}/issues/${NUM}/comments --jq '[.[] | select(.body | test("FORGE:INVESTIGATOR|FORGE:BUILDER"))] | length')
   if [ "$LABELS" -eq 0 ] || [ "$COMMENTS" -eq 0 ]; then
     echo "PIPELINE FAILURE: #{NUM} — agent bypassed /work-on (no labels or structured comments)"
   fi
   ```
   If an agent bypassed the pipeline, report it as a **failure** regardless of whether a PR exists.

6. **Post a brief status update** to the user after each agent reaches terminal state:
   ```
   ✓ #{NUMBER} — {title} → PR #{PR} merged to {target}
   ✗ #{NUMBER} — {title} → {reason for failure}
   ⚠ #{NUMBER} — {title} → PIPELINE BYPASS (no /work-on — PR invalid)
   ⏳ Wave 1: 2/3 complete (1 resumed after stall)...
   ```

**Anti-pattern — DO NOT DO THIS:**
- `sleep 60/120/180/300` loops to check status — you will be notified automatically
- Spawning separate "progress check" agents — they waste tokens and add noise
- Reading agent JSONL output files to check progress — use GitHub labels as the source of truth
- Polling the same status check repeatedly on a timer

### Step 4C: Collect review-finding issues from completed wave

When ALL agents in the current wave have completed, check if any `/work-on` runs spawned review-finding issues during their review phase. These are new work items that should be folded into the remaining waves.

```bash
# Method 1: Read TRAJECTORY comments from completed issues for "Finding issues" row
for NUM in {completed_issue_numbers_this_wave}; do
  gh api repos/{GH_REPO}/issues/${NUM}/comments \
    --jq '.[] | select(.body | contains("FORGE:TRAJECTORY")) | .body' 2>/dev/null \
    | grep -oP 'Finding issues\s*\|\s*#?\K\d+[^|]*' | grep -oP '\d+' | sort -u
done

# Method 2 (fallback): Check for recently created review-finding issues that reference PRs from this wave
gh issue list -R {GH_REPO} --state open --label "review-finding" --limit 20 \
  --json number,title,body,createdAt \
  --jq "[.[] | select(.createdAt > \"$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)\")]"
```

**If review-finding issues were spawned:**

**Cascade control (MANDATORY — run before folding findings into waves):**

For each spawned finding, determine whether it should be **executed** or **deferred**:

**Evaluation order** (first matching rule wins):
1. **Generation ≥ 2** (always defer, even for P1/P2): Finding was spawned by an issue that was itself a review-finding. Check the source issue's labels for `review-finding` — if the source has that label, the new finding is generation 2. Always defer. Rationale: gen-2+ cascade is theoretically unbounded — cap it here.
2. **Priority override** (P1 or P2 → always execute): If the finding is labeled P1 or P2, skip all remaining heuristics and execute. Rationale: high-priority findings must never be suppressed by keyword matching.
3. **Comment/typo heuristic** (P3 and below only): Finding title contains the word "comment" or "typo" (case-insensitive). These are 1-line cosmetic fixes that do not block other work.
4. **P3 + same-file overlap**: Finding is labeled `P3` AND the file it targets overlaps with ANY file already in the current or remaining batch waves. Rationale: same-file P3 findings serialize the entire remaining batch — one finding per original issue doubles wall-clock time with no proportional value.

**Defer** (do NOT add to wave queue) if rules 1, 3, or 4 match.

**Execute** (add to wave queue) if:
- Rule 2 matches (P1 or P2)
- None of the defer rules matched (generation 1, P3 with no file overlap, not a keyword match)

**Before running the loop, build the batch file list (MANDATORY for Heuristic 3):**

Collect all file paths from every issue in the current batch — both completed waves and remaining queued waves. This produces `ALL_BATCH_FILES`, a newline-separated list of file paths used by Heuristic 3 to test same-file overlap.

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
    echo "Deferred #${FINDING_NUM}: $DEFER_REASON"
  else
    QUEUED_FINDINGS+=($FINDING_NUM)
  fi
done
```

**For queued (non-deferred) findings:**

1. **Add them to the remaining wave plan.** They are implementation issues — same as issues spawned by investigations in Phase 2.
2. **Respect source branch context.** Review-finding issues have `**Code branch**: \`{branch}\`` in their body — the `/work-on` agent will read this and branch from the right origin. No special handling needed from the orchestrator.
3. **Report to user:**
   ```
   Wave {N} review spawned {count} new finding issues: #{A}, #{B}
   Queued for execution: #{A}, #{B}
   Deferred (cascade control): #{C} (P3 same-file), #{D} (comment heuristic)
   Adding queued findings to Wave {N+1} (or new wave if no remaining waves).
   ```
4. **Re-run file-overlap detection** (Step 3C) on the expanded issue set — finding issues may conflict with planned issues that touch the same files.

**For deferred findings:**

They remain open in GitHub — they will be picked up by future `/orchestrate` or `/work-on` runs. Log them in the final batch summary under "deferred" so they are visible. Do NOT close or label them — leave them for the next pipeline pass.

**If no review-finding issues were spawned:** Continue to next wave normally.

### Step 4D: Milestone integration build gate (MANDATORY between waves)

**WHY THIS EXISTS**: Session Intelligence milestone shipped 116 PRs across multiple waves with zero integration testing. Each PR built in isolation — type errors from cross-PR interactions (wrong prop types, missing components, incompatible interfaces) were invisible until the milestone→staging merge broke the build with 4 distinct errors. This gate catches those failures early.

**When to run**: After each wave completes, IF the batch targets a milestone branch AND any `.tsx`/`.ts` files were changed by agents in the completed wave.

All tool commands are read from `forge.yaml → verification.commands`; each step logs `SKIPPED — not configured` when the corresponding key is absent rather than silently passing.

```bash
# Read toolchain commands from forge.yaml
TS_TYPECHECK=$(grep -A 20 'commands:' forge.yaml 2>/dev/null | grep -A 5 'typescript:' | grep 'typecheck:' | head -1 | sed "s/.*typecheck: *['\"]//;s/['\"].*//")
TS_BUILD=$(grep -A 20 'commands:' forge.yaml 2>/dev/null | grep -A 5 'typescript:' | grep 'build:' | head -1 | sed "s/.*build: *['\"]//;s/['\"].*//")
PYTHON_FORMAT=$(grep -A 20 'commands:' forge.yaml 2>/dev/null | grep -A 5 'python:' | grep 'format:' | head -1 | sed "s/.*format: *['\"]//;s/['\"].*//")

# Check if this is a milestone batch with TypeScript changes
MILESTONE_BRANCH="milestone/{milestone_slug}"
TS_CHANGED=$(git diff origin/{DEFAULT_BRANCH}...origin/${MILESTONE_BRANCH} --name-only | grep -E '\.(tsx?|jsx?)$' | head -1)

if [ -n "$TS_CHANGED" ]; then
    echo "=== Integration Build Gate (TypeScript): Wave {N} ==="
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
        echo "BLOCKING: TypeScript errors on ${MILESTONE_BRANCH} after Wave {N}."
        echo "Fix type errors before starting next wave."
    elif [ "${BUILD_EXIT:-0}" -ne 0 ]; then
        echo "BLOCKING: build failed on ${MILESTONE_BRANCH} after Wave {N}."
        echo "Build/prerender errors — fix before starting next wave."
    fi
fi

# Python format check
PY_CHANGED=$(git diff origin/{DEFAULT_BRANCH}...origin/${MILESTONE_BRANCH} --name-only | grep -E '\.py$' | head -1)
if [ -n "$PY_CHANGED" ]; then
    echo "=== Integration Build Gate (Python): Wave {N} ==="
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
        echo "WARNING: Python formatting issues on ${MILESTONE_BRANCH} after Wave {N}."
        echo "Not blocking but should be fixed before milestone→staging."
    fi
fi
```

**If the gate fails**: Report the errors to the user. Do NOT proceed to the next wave. The accumulated milestone branch has integration errors that will only get worse with more PRs on top. Build failures are BLOCKING — SSG/prerender crashes are invisible to typecheck alone — configure `typescript.build` in `verification.commands` to catch them.

### Step 4E: Advance to next wave

When wave results are processed, the integration gate passes (or is not applicable), and any new finding issues are folded in:

1. Check if any failures in the current wave block the next wave (dependency failures)
2. If a dependency failed, skip dependent issues in the next wave and report them as "skipped — dependency #{X} failed"
3. Launch the next wave (same process as Step 4A)

### Step 4F: Handle individual agent failures

If an agent reports failure or error:
- **Merge conflict**: Report to user, mark issue as needing human attention
- **Invalid issue**: Already handled by the agent (closed with comment) — just report it
- **Build/test failure**: Report the error, suggest manual intervention
- **Agent timeout**: Report which issue timed out, suggest re-running with `/work-on #{N}`

**Do NOT retry failed agents automatically.** Report the failure and let the user decide.

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

After ALL waves AND cleanup complete, present a final summary.

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

### Wave 0: Investigations
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

{IF review findings were created during any wave:}
| # | Finding | Source Issue | Source PR | Status |
|---|---------|-------------|-----------|--------|
| #{F1} | {title} | #{A} | PR #{PR} | ✓ Merged (wave {N}) / ⏳ Open (deferred) |

{ELSE: "No review findings created during this batch."}

### Summary
- **Investigations**: {N} completed, spawned {M} new issues
- **Review findings**: {N} spawned, {M} resolved in-batch, {K} deferred
- **Succeeded**: {N} issues resolved (implementation)
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

**Wave efficiency**: {avg_idle_pct}% idle time
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
- Same-domain merge conflicts in 2+ waves → domain sequencing too aggressive
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
7. **Dependency failures cascade** — if A fails and B depends on A, B is skipped (not attempted)
8. **Always run post-batch cleanup** — Phase 5 is mandatory. Never skip `/cleanup all` after orchestration.
9. **NEVER close/skip issues as duplicates** — only `/work-on` investigation agents can make that call after examining the actual code. The orchestrator delegates, it does not adjudicate.
10. **Post-wave verification** — after each wave, check that every completed issue has `workflow:*` labels and structured comments. If an agent bypassed `/work-on`, report it as a pipeline failure.

---

## Examples

### "orchestrate milestone api-expansion"
→ Fetches all open issues in "API Expansion v1" milestone
→ Analyzes deps (#1526 → #1527 → #1528 → #1529, #1530 independent)
→ Plans 3 waves, confirms with user, executes

### "orchestrate #1533 #1250"
→ Fetches those 2 issues, no deps between them
→ Single wave, both parallel, confirms, executes

### "orchestrate next 5"
→ Gets top 5 priority issues, checks deps
→ Plans waves, confirms, executes

### "orchestrate P0"
→ Gets all P0 issues, runs them all (presumably urgent)
→ Single wave if possible, confirms, executes

### "orchestrate fast-lane"
→ Gets all unmilestoned bugs/fixes
→ Groups by independence, runs in waves

### "orchestrate milestone cortex-recursive-loop"
→ Fetches all open issues in "Cortex Recursive Loop" milestone
→ Detects #2644 is an investigation issue (title: "Investigate: Complete the autonomous recursive loop...")
→ Wave 0: Runs `/work-on 2644` — investigation creates 5 new issues (#2650-#2654)
→ Re-fetches milestone issues, now includes #2650-#2654
→ Wave 1: #2633 (P0 orphaned queues), #2636 (invalidation), #2650, #2651 (all independent)
→ Wave 2: #2634 (enable daemon, after #2633), #2652 (depends on #2650)
→ Wave 3: remaining issues
→ Final report shows investigation spawned issues and their results
