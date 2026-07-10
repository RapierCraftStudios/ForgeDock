---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Phase 4: Streaming DAG Execution

## Phase 4: Streaming DAG Execution

### Step 4A-pre.0: Budget initialization (MANDATORY when --budget is set) <!-- Added: forge#1743 -->

Initialize budget tracking state before the first dispatch. Read `--budget N` from the orchestrator's argument list (passed from the top-level `/orchestrate` invocation). When `--budget` is not set, `BUDGET_LIMIT` is `Infinity` (uncapped — current default behavior preserved).

```bash
# --- Budget initialization ---
# Parse --budget N from ARGUMENTS (e.g. /orchestrate fast-lane --budget 5.00)
BUDGET_LIMIT=$(echo "${ARGUMENTS:-}" | grep -oP '(?<=--budget )\S+' | head -1 || echo "")
if [ -z "$BUDGET_LIMIT" ] || ! echo "$BUDGET_LIMIT" | grep -qP '^\d+(\.\d+)?$'; then
  BUDGET_LIMIT="Infinity"
fi

PROJECTED_SPEND="0"          # sum of ISSUE_COST_ESTIMATE[] for dispatched issues
ACTUAL_SPEND="0"             # sum of actual cost reported by completed agents (best-effort)
DEFERRED_BUDGET_ISSUES=()    # issues deferred because projected spend would exceed budget
EPSILON_DISPATCHED=false     # true once at least one ε-reserve issue has been dispatched

if [ "$BUDGET_LIMIT" != "Infinity" ]; then
  EPSILON_BUDGET=$(echo "scale=4; $BUDGET_LIMIT * 0.10" | bc 2>/dev/null || echo "0")
  echo "Budget initialized: BUDGET_LIMIT=\$${BUDGET_LIMIT} EPSILON_BUDGET=\$${EPSILON_BUDGET} (10% ε-reserve)"
  echo "Issues without cost priors (ε-reserve eligible): ${NO_PRIOR_ISSUES[*]:-none}"
else
  EPSILON_BUDGET="0"
  echo "Budget: uncapped (no --budget flag) — dispatching all ready issues by score order"
fi
# --- End budget initialization ---
```

**Budget halt condition** (checked in Step 4A before each dispatch):

Before dispatching issue `NUM`, check whether its estimated cost would exceed the remaining budget:

```bash
# Check budget before dispatching NUM
should_dispatch() {
  local NUM="$1"
  local COST="${ISSUE_COST_ESTIMATE[$NUM]:-0.35}"

  if [ "$BUDGET_LIMIT" = "Infinity" ]; then
    return 0  # uncapped — always dispatch
  fi

  NEW_PROJECTED=$(echo "scale=4; $PROJECTED_SPEND + $COST" | bc 2>/dev/null || echo "$PROJECTED_SPEND")
  MAIN_CEILING=$(echo "scale=4; $BUDGET_LIMIT - $EPSILON_BUDGET" | bc 2>/dev/null || echo "$BUDGET_LIMIT")

  # ε-reserve logic: if this is a no-prior issue AND ε-budget has not yet been
  # used AND the no-prior issue has NOT been dispatched yet, allow it even if
  # the main ceiling is hit (up to BUDGET_LIMIT total).
  if [ "${ISSUE_HAS_PRIOR[$NUM]:-false}" = "false" ] && [ "$EPSILON_DISPATCHED" = "false" ]; then
    if echo "$NEW_PROJECTED $BUDGET_LIMIT" | awk '{exit ($1 <= $2) ? 0 : 1}' 2>/dev/null; then
      EPSILON_DISPATCHED=true
      echo "ε-reserve: dispatching #${NUM} (no-prior issue) from exploration reserve"
      return 0
    fi
  fi

  # Main budget check: defer if projected would exceed main ceiling
  if echo "$NEW_PROJECTED $MAIN_CEILING" | awk '{exit ($1 <= $2) ? 0 : 1}' 2>/dev/null; then
    DEFERRED_BUDGET_ISSUES+=("$NUM")
    echo "BUDGET DEFER: #${NUM} (est. \$${COST}) would push projected spend to \$${NEW_PROJECTED} > main ceiling \$${MAIN_CEILING}"
    return 1
  fi

  return 0
}
```

**Budget deferred-issues report** (output when `BUDGET_LIMIT` is finite and `DEFERRED_BUDGET_ISSUES` is non-empty — print at end of Phase 4, before Phase 5):

```
## Budget Report

**Budget limit**: $${BUDGET_LIMIT}
**Projected spend (dispatched issues)**: $${PROJECTED_SPEND}
**ε-reserve used**: ${EPSILON_DISPATCHED} (10% = $${EPSILON_BUDGET})

### Deferred Issues (budget exhausted — never silently dropped)

| Issue | Title | Score | Est. Cost | Reason |
|-------|-------|-------|-----------|--------|
| #{N} | {title} | {score} | ${cost} | Budget ceiling reached |

**Action**: Re-run `/orchestrate {deferred_issue_numbers} [--budget N]` to process deferred issues, or increase `--budget`.
```

**When `BUDGET_LIMIT = Infinity`**: skip this check and report entirely — uncapped behavior.

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

# Batch-level accumulators for review-finding cascade control (Step 4C) and
# Completion Sweep (Step 4F). Declared here so they persist across ALL agent
# completions — Step 4C runs per-agent and must NOT re-initialize these.
DEFERRED_FINDINGS=()
QUEUED_FINDINGS=()
declare -A DEFERRED_REASONS
declare -A AGENT_ISSUE_MAP

# Human-gated idle/backpressure flag (Step 4B item 6.7, forge#1814). Starts false —
# recomputed every completion cycle over {all_batch_issue_numbers}. Declared at batch
# scope (not per-agent) so Step 4C can read the latest value on every iteration.
BATCH_FULLY_GATED=false

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

**Engine-first dispatch (default)**: When `forgedock` is in PATH, dispatch each ready issue via the durable engine rather than spawning prose Agent sub-agents. The engine's phase table enforces gate semantics in code — its fail-closed review gate and deterministic phase ordering are not subject to LLM interpretation.

```bash
# Engine-first dispatch: check CLI availability, then dispatch ready issues in score order
# Uses SORTED_READY_SET[] from Step 3E.5 (descending value/cost) and budget gate from Step 4A-pre.0
FORGEDOCK_AVAILABLE=$(command -v forgedock >/dev/null 2>&1 && echo "true" || echo "false")

if [ "$FORGEDOCK_AVAILABLE" = "true" ]; then
  for NUM in "${SORTED_READY_SET[@]:-{ready_issue_numbers}}"; do
    # Budget gate (forge#1743): skip dispatch if projected spend would exceed budget ceiling.
    # should_dispatch() also handles ε-reserve (no-prior issues get guaranteed slot).
    if ! should_dispatch "$NUM"; then
      continue  # Issue added to DEFERRED_BUDGET_ISSUES[] by should_dispatch()
    fi

    LANE="${ISSUE_LANE[$NUM]}"
    PR_BASE="${ISSUE_PR_BASE[$NUM]}"
    COST="${ISSUE_COST_ESTIMATE[$NUM]:-0.35}"

    # Advance PROJECTED_SPEND before forking so subsequent iterations see the updated total
    PROJECTED_SPEND=$(echo "scale=4; $PROJECTED_SPEND + $COST" | bc 2>/dev/null || echo "$PROJECTED_SPEND")

    echo "Dispatching #$NUM via forgedock run-issue --lane $PR_BASE (score=${ISSUE_SCORE[$NUM]:-?} est_cost=\$${COST} projected_total=\$${PROJECTED_SPEND})"
    forgedock run-issue "$NUM" --lane "$PR_BASE" &
  done
  wait
  echo "Engine dispatch complete — advancing to Step 4B (completion sweep)"
else
  echo "INFO: Using agent dispatch mode (forgedock CLI not in PATH — run \`npm install -g forgedock\` for engine-mode dispatch)"
  # Fall through to Agent-spawn template below. The SubagentStop hook (bin/hooks/interactive-engine.mjs)
  # bridges these runs to the engine run-log for state persistence even on the fallback path.
fi
```

**Agent-spawn path (fallback when forgedock CLI unavailable)**: When `FORGEDOCK_AVAILABLE=false`, spawn Agent sub-agents per issue using the template below. This preserves engine state via the SubagentStop hook even without the CLI.

**REMINDER: You MUST use the template below verbatim when on the Agent-spawn fallback path. Only fill in `{VARIABLES}`. Do NOT rewrite the agent prompt. Do NOT write custom implementation instructions. The agent MUST invoke `/work-on` via the Skill tool — this is the HARD RULE from the top of this file.**

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

**CRITICAL — DO NOT STOP EARLY**: /work-on runs as a multi-phase routing loop. Each phase (investigate, build, review, close) returns an intermediate result — these are NOT completion signals. You are NOT done until the issue reaches a terminal state: `workflow:merged`, `workflow:invalid`, `needs-human`, or `workflow:awaiting-merge`. If /work-on returns after only one phase (e.g., investigation), you MUST invoke it again immediately — it will re-read GitHub state and continue to the next phase. Keep invoking /work-on until it reaches a terminal state. Never output 'done' or stop after an intermediate result.

**HOW REVIEW FINDINGS WORK**: /review-pr may create GitHub issues (with `review-finding` label) for findings it discovers. These are NOT blockers — they are separate work items that will go through their own /work-on pipeline later. The original PR should ALWAYS merge after review. The only exception is build errors (code doesn't compile) — those must be fixed before merging.

**IMPORTANT RULES**:
- **MANDATORY**: You MUST use the Skill tool to invoke 'work-on' with args '{PROJECT_PREFIX}{NUMBER}'. Do NOT implement manually — /work-on handles the full pipeline including label state machine (workflow:investigating → workflow:building → workflow:in-review → workflow:merged), investigation reports, PR creation, and cleanup.
  - For default repo issues: `Skill(skill='work-on', args='{NUMBER} --under-orchestration')`
  - For satellite repo issues: `Skill(skill='work-on', args='{SATELLITE_PREFIX}:{NUMBER} --under-orchestration')` (prefix from forge.yaml → repos.satellites)
  - The `--under-orchestration` flag tells `/work-on` to post its phase-entry `FORGE:HEARTBEAT` comments (Phases 0/1/3/5) — this orchestrator's Step 4B.5 stall detector depends on those timestamps. A solo `/work-on` run omits the flag and skips those writes entirely (see `commands/work-on.md` → Orchestration Flag).
- NEVER bypass /work-on with manual git/gh commands — the label updates and structured comments are critical for tracking
- NEVER target `main` for PRs targeting the default repo. Use `{STAGING_BRANCH}` for fast-lane issues, or `milestone/{slug}` for milestone issues.
- Satellite repos (MCP, n8n) have no staging branch — fast-lane PRs go to `main` for those.
- If the issue is INVALID after investigation, close it with a comment explaining why
- If you hit merge conflicts or blockers, post a comment on the issue and STOP — do not force anything
- Do not interact with the user — you are running autonomously in the background
- **NEVER ask the user questions** — you are a background agent. If review finds issues, auto-fix simple ones and proceed. For complex findings on **low-risk domains**, merge anyway and create follow-up issues. For complex findings on **high-risk domains** (AUTH, BILLING, DATABASE, or any domain tagged as security-critical in Step 3B), add the `needs-human` label and stop — do NOT merge. High-risk `needs-human` halts are surfaced as `⚠ Blocked` in the Phase 5 completion report.

**LABEL-STATE LOOP CONTRACT — enforce after EVERY Skill return**:
After EVERY `Skill(skill='work-on', ...)` call returns, immediately check the issue's current workflow label:
```bash
gh issue view {NUMBER} -R {GH_REPO} --json labels --jq '[.labels[].name | select(startswith("workflow:"))]'
```
**Terminal labels** (only these allow you to stop): `workflow:merged`, `workflow:invalid`
**Terminal condition also**: `needs-human` label present, `workflow:awaiting-merge` label present, OR issue state is `closed`
`needs-human` and `workflow:awaiting-merge` are terminal-FOR-THIS-AGENT (this individual `/work-on` run stops here — a human decision or merge is now the blocking step) but are NOT "done" from the DAG's point of view; see Predecessor Classification in Step 4B for how the orchestrator's dependency logic treats them (`GATED`, not `DONE`).
If the label is NOT terminal (e.g., `workflow:investigating`, `workflow:ready-to-build`, `workflow:building`, `workflow:in-review`), invoke `Skill(skill='work-on', args='{NUMBER} --under-orchestration')` again immediately. The `/work-on` skill will re-read GitHub state and advance to the next phase. Do NOT output a summary, do NOT pause, do NOT ask for confirmation — just invoke it again.

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

**`{GIST_CONTEXT}` generation**: For each issue being dispatched, build the context block. **Prefer the deconflicted `FORGE:SYNTHESIS_BRIEF` (from Phase 2.5) when one exists** — it is a per-issue, already-reconciled brief that carries only the arbitration decisions and sibling investigation Gists relevant to *this* issue. Injecting it instead of the full aggregated milestone-index gist means the agent does not re-arbitrate the same contradictions (less token spend, less nondeterminism). Only when Phase 2.5 did not run (0/1 investigations — no brief exists) does this fall back to the raw parent-investigation + milestone-index gist behavior. <!-- Added: forge#1192 -->

```bash
# Build GIST_CONTEXT for an issue
GIST_CONTEXT=""

# Preferred path: a deconflicted per-issue synthesis brief from Phase 2.5.
SYNTHESIS_BRIEF=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("<!-- FORGE:SYNTHESIS_BRIEF -->"))] | last | .body // ""' 2>/dev/null)

if [ -n "$SYNTHESIS_BRIEF" ]; then
  # Phase 2.5 ran and reconciled competing recommendations for this issue.
  # Inject the deconflicted brief INSTEAD of the raw milestone-index gist dump.
  GIST_CONTEXT="
**RECONCILED CONTEXT (orchestrate Phase 2.5 synthesis brief)**: Competing investigation recommendations affecting this issue have already been reconciled. Use this deconflicted brief as your primary cross-investigation context — do NOT independently re-arbitrate the underlying investigations.
${SYNTHESIS_BRIEF}"
else
  # Fallback: Phase 2.5 did not run (0/1 investigations). Use the raw gist behavior.
  # Markdown emphasis markers (**bold**, __bold__, *italic*) are stripped before matching,
  # since sub-issue bodies commonly render the label as "**Parent**: #NNN" and the bare
  # label alternation below would otherwise fail to match past the emphasis characters.
  PARENT_INV=$(gh issue view {NUMBER} -R {GH_REPO} --json body --jq '.body' \
    | sed -E 's/[*_]+//g' \
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
fi
```

If `GIST_CONTEXT` is empty (no synthesis brief, no parent investigation, and no milestone index found), the variable resolves to a blank line in the template — no impact on the agent prompt. <!-- Updated: forge#341, forge#1192 -->

**Claims board context injection** <!-- Added: forge#1736 -->: When a coordination issue exists for this batch (`FORGE_COORD_ISSUE` is set), append the claims board URL and the active-claims check instruction to the agent's context. This enables each `/work-on` agent to post its `FORGE:CLAIM` on build start.

```bash
# Inject coordination issue URL if claims board was created in Step 3D.1
if [ -n "${FORGE_COORD_ISSUE:-}" ]; then
  GIST_CONTEXT="${GIST_CONTEXT}

**ORCHESTRATION CLAIMS BOARD**: This agent is running under an orchestration batch.
Claims board issue URL: ${FORGE_COORD_ISSUE}

On build start (Phase B2 / Phase 3C of /work-on), post a FORGE:CLAIM annotation on the
coordination issue above. Required fields:
  Holder: ##{NUMBER} / batch-$(date -u +%Y%m%dT%H%M%S)
  Files: (list of files from your FORGE:CONTRACT deliverables table, one per line)
  Interfaces: (public function/type signatures you will modify or that callers must preserve)
  TTL: terminal state of Holder issue ##{NUMBER}

On reaching terminal state (workflow:merged, workflow:invalid, needs-human, or workflow:awaiting-merge), post
<!-- FORGE:CLAIM_RELEASED --> on the coordination issue to release your claim.

Set FORGE_COORD_ISSUE=${FORGE_COORD_ISSUE} in your environment so /work-on phases can read it."
fi
```

**Hot-copy CONTRACT context** (extends `{GIST_CONTEXT}` for milestone-lane issues where the parent issue already carries a `FORGE:CONTRACT` annotation): <!-- Added: forge#1277 -->

When a DAG node issue was spawned from a decomposition (parent issue has `workflow:decomposed` label and the child issue body references `**Parent**: #NNN`), the parent issue may already have a `FORGE:CONTRACT` annotation that was posted before decomposition. Inject a scoped excerpt into the child's prompt so the child does not re-fetch it.

```bash
# Hot-copy: inject parent CONTRACT annotation excerpt into GIST_CONTEXT (milestone lane only)
PARENT_NUM=$(gh issue view {NUMBER} -R {GH_REPO} --json body --jq '.body' \
  | grep -oP '(?i)\*\*Parent\*\*[: ]*#\K\d+' | head -1)

if [ -n "$PARENT_NUM" ]; then
  PARENT_CONTRACT=$(gh api repos/{GH_REPO}/issues/${PARENT_NUM}/comments \
    --jq '[.[] | select(.body | contains("<!-- FORGE:CONTRACT -->"))] | last | .body // ""' 2>/dev/null \
    | head -40)  # Scope: first 40 lines — Proposed Approach + Deliverables table only

  if [ -n "$PARENT_CONTRACT" ]; then
    GIST_CONTEXT="${GIST_CONTEXT}

**HOT COPY — PARENT FORGE:CONTRACT** (from parent issue #${PARENT_NUM}; do not re-fetch — durable record is on that issue):
${PARENT_CONTRACT}"
  fi
fi
```

If the issue has no parent reference, or the parent has no `FORGE:CONTRACT` annotation, this block produces no output and `GIST_CONTEXT` is unchanged. The hot-copy is an optimization — the durable annotation on the parent issue remains the authoritative record for compaction recovery.

**Capture agent IDs after the batch spawn (MANDATORY)**: Each `Agent(...)` call returns an agent ID. Store each returned ID in `AGENT_ISSUE_MAP` keyed by issue number. This map is the only way to resume a stalled agent by ID in Steps 4B and 4B.5:

```
# After the single-message batch spawn, capture each returned ID:
AGENT_ISSUE_MAP[{NUMBER}] = <agent_id returned by Agent()>
```

`AGENT_ISSUE_MAP` starts empty and accumulates entries as agents are spawned. For parallel dispatch (all Agent() calls in one message), capture the returned IDs from the batch response — one entry per issue — before entering Step 4B's monitoring loop. Without this capture, `resume=` calls in Steps 4B and 4B.5 will have no agent ID to reference and the resume will fail. <!-- Added: forge#1083 -->

**Launch all ready agents simultaneously** by putting multiple Agent tool calls in a single message. Use `run_in_background=true` so they execute in parallel.

### Step 4B: Monitor completions and dispatch newly ready issues

You will be automatically notified when each background agent completes. **Do NOT use `sleep` loops to poll for completion.** Instead, wait for the automatic notification. When you receive a notification that an agent completed, immediately process it.

**Successor dispatch latency is measured from `agent_completed`, not from orchestrator polling.** The moment you receive an `agent_completed` notification for issue N, that is t=0 for dispatching N's successors. Any successor whose predecessors are all now terminal MUST be dispatched in the same response that processes the notification — not after a poll cycle, not after a sleep. This is the design property that makes streaming DAG execution faster than wave-based execution. <!-- Added: forge#1251 -->

**Predecessor Classification (DONE / GATED / FAILED)** <!-- Added: forge#1812 --> — every check in this file that asks "is predecessor X resolved enough for its dependents to proceed" MUST classify X into exactly one of three states below — never a single binary terminal/non-terminal grep. Earlier versions of this file independently patched `grep -qE 'workflow:merged|workflow:invalid|needs-human|CLOSED'` in multiple places, and the copies drifted: the readiness check (this step) treated `needs-human` as done-enough-to-dispatch-through, while the failure handler (item 6 below) treated the identical label as a hard failure that skips dependents. Both cannot be right at once — `needs-human` means the predecessor's code is paused pending a human decision and is NOT yet in the base branch, so dispatching a dependent against it is unsafe, but permanently skipping the dependent is also wrong once the human resolves the block. The fix is a third state:

```bash
classify_predecessor_state() {
  local PRED="$1"
  local PRED_INFO
  # NOTE: the `workflow` array below deliberately also keeps `needs-human` — that label has NO
  # `workflow:` prefix (see bin/labels.json), so a bare `select(startswith("workflow:"))` would
  # drop it and the GATED branch's `needs-human` case would be dead code (forge#1812 primary case).
  PRED_INFO=$(gh issue view "$PRED" -R {GH_REPO} --json labels,state \
    --jq '{state: .state, workflow: [.labels[].name | select(startswith("workflow:") or . == "needs-human")]}' 2>/dev/null || echo '{}')
  local PRED_STATE PRED_LABELS
  PRED_STATE=$(echo "$PRED_INFO" | jq -r '.state // "OPEN"')
  PRED_LABELS=$(echo "$PRED_INFO" | jq -r '.workflow[]?' 2>/dev/null)

  if echo "$PRED_LABELS" | grep -qx "workflow:invalid"; then
    echo "FAILED"
  elif echo "$PRED_LABELS" | grep -qx "workflow:merged"; then
    echo "DONE"
  elif echo "$PRED_LABELS" | grep -qxE "needs-human|workflow:awaiting-merge"; then
    echo "GATED"
  elif [ "$PRED_STATE" = "CLOSED" ]; then
    # Closed with no workflow:invalid/merged label (e.g. closed-not-planned) — treat as DONE,
    # not a new deadlock state; there is no pending code for dependents to wait on.
    echo "DONE"
  else
    echo "IN_PROGRESS"
  fi
}
```

- **DONE** — predecessor's code is in the base branch (`workflow:merged`), or the predecessor is closed with no pending code. Safe for dependents to dispatch.
- **GATED** — predecessor is paused pending a human decision (`needs-human`) or pending only a human merge click (`workflow:awaiting-merge`). Its code is NOT yet in the base branch. Dependents are neither dispatched nor skipped — they move to the `blocked-on-human-merge` tracked state (item 6.5 below).
- **FAILED** — predecessor was closed as `workflow:invalid`, or the agent explicitly reported a build/test error. Dependents are marked "skipped — dependency failed" (item 6 below) — unchanged from prior behavior.
- **IN_PROGRESS** — predecessor is still mid-pipeline (`investigating`/`ready-to-build`/`building`/`in-review`). Dependent simply continues waiting; no special tracking needed.

A GATED predecessor whose PR later merges reclassifies to DONE the next time `classify_predecessor_state` runs (its label flips to `workflow:merged`) — this is exactly what the merge-triggered wake check (item 6.6 below) relies on.

**Core streaming dispatch loop**: After processing each agent completion, check the DAG for newly unblocked issues. If any issue now has all predecessors classified `DONE`, dispatch it immediately (run Steps 4A.pre.0, 4A.pre, and 4A for the newly ready issues). This is the key difference from the wave model — issues dispatch as soon as their specific predecessors complete, not after an entire group finishes.

```bash
# After each agent completion, check for newly ready issues:
for BLOCKED_NUM in {all_blocked_issue_numbers}; do
  ALL_PREDS_DONE=true
  ANY_PRED_GATED=false
  GATING_PREDS=()
  for PRED in {predecessors_of_BLOCKED_NUM}; do
    PRED_STATE=$(classify_predecessor_state "$PRED")
    case "$PRED_STATE" in
      DONE) ;;  # satisfied — no action
      FAILED) ALL_PREDS_DONE=false ;;             # handled by item 6 (skip dependents)
      GATED)
        ALL_PREDS_DONE=false
        ANY_PRED_GATED=true
        GATING_PREDS+=("$PRED")
        ;;                                        # handled by item 6.5 (blocked-on-human-merge)
      IN_PROGRESS|*) ALL_PREDS_DONE=false ;;       # just keep waiting
    esac
  done
  if [ "$ALL_PREDS_DONE" = "true" ]; then
    echo "#{BLOCKED_NUM} is now READY — all predecessors DONE (merged/resolved). Dispatching."
    # Add to dispatch batch for this completion cycle
  elif [ "$ANY_PRED_GATED" = "true" ]; then
    echo "#{BLOCKED_NUM} is BLOCKED-ON-HUMAN-MERGE — gated by: ${GATING_PREDS[*]}. See item 6.5."
    # Do NOT dispatch. Do NOT mark skipped. Tracked via item 6.5.
  fi
done
# Run Steps 4A.pre.0 → 4A.pre → 4A for newly ready issues (batch them in a single message)
```

**CRITICAL — Stall detection and recovery**: Background agents sometimes stop mid-pipeline (`stop_reason=end_turn`) after completing a sub-phase (e.g., investigation completes but build never starts). This causes the agent to "complete" from the Agent tool's perspective even though the `/work-on` pipeline is only partially done. When you receive a completion notification:

1. **Check if the agent completed the FULL pipeline** — not just one phase:
   ```bash
   # Check final workflow state — workflow:merged, workflow:invalid, needs-human, and
   # workflow:awaiting-merge all mean this agent's own /work-on run has stopped (the last
   # two are human-gated pauses, not completions). See Predecessor Classification above for
   # how the DAG's readiness/failure logic treats these same labels differently from "this
   # agent is done running."
   FINAL_STATE=$(gh issue view $NUM -R {GH_REPO} --json labels,state --jq '{state: .state, workflow: [.labels[].name | select(startswith("workflow:"))]}')
   echo "#{NUM}: $FINAL_STATE"
   ```

2. **If the issue is NOT in a terminal-for-this-agent state** (`workflow:merged`, `workflow:invalid`, `needs-human`, or `workflow:awaiting-merge`), the agent stalled mid-pipeline. **Resume it immediately**:
   ```
   Agent(
     resume=AGENT_ISSUE_MAP[{NUMBER}],
     description="Resume #{NUMBER} pipeline",
     run_in_background=true,
     prompt="The previous /work-on invocation stopped before completing the full pipeline. The issue is currently at {CURRENT_WORKFLOW_STATE}. Continue — invoke Skill(skill='work-on', args='{NUMBER} --under-orchestration') to resume the routing loop from the current state. /work-on will re-read GitHub state and pick up where it left off."
   )
   ```
   **Resume ALL stalled agents in a single message** (parallel resume). Do not wait between resumes.

3. **Track resume cycles per agent.** If an agent has been resumed 2+ times and still hasn't reached a terminal state, report it as a failure — do not resume again.

4. **Post CLAIM_RELEASED on coordination issue** (when `FORGE_COORD_ISSUE` is set): <!-- Added: forge#1736 -->
   ```bash
   # After verifying terminal state for issue NUM, release its claim on the coordination issue
   if [ -n "${FORGE_COORD_ISSUE:-}" ]; then
     COORD_NUM=$(echo "$FORGE_COORD_ISSUE" | grep -oE '[0-9]+$')
     if [ -n "$COORD_NUM" ]; then
       gh issue comment "$COORD_NUM" -R {GH_REPO} --body "<!-- FORGE:CLAIM_RELEASED -->
**Holder**: #${NUM} — reached terminal state: ${FINAL_WORKFLOW_STATE}
**Released**: $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null || true
       echo "CLAIM_RELEASED posted for #${NUM} on coordination issue #${COORD_NUM}"
     fi
   fi
   ```

   **Claims-board relaxation sweep** (run after posting CLAIM_RELEASED): When a claim is released, check all remaining Layer-2/4-serialized issue pairs. If the now-released Holder's claimed files were the *only* conflict reason for a still-blocked issue, and that blocked issue already has an active `FORGE:CLAIM` with a disjoint file set, the blocking edge MAY be relaxed (blocked issue becomes ready). <!-- Added: forge#1736 -->

   ```bash
   # After CLAIM_RELEASED for issue NUM:
   # Read all active FORGE:CLAIM annotations from coordination issue
   if [ -n "${FORGE_COORD_ISSUE:-}" ] && [ -n "${COORD_NUM:-}" ]; then
     ACTIVE_CLAIMS=$(gh api repos/{GH_REPO}/issues/${COORD_NUM}/comments \
       --jq '[.[] | select(.body | contains("<!-- FORGE:CLAIM -->")) |
              select(.body | contains("<!-- FORGE:CLAIM_RELEASED -->") | not)] |
             map({holder: (.body | capture("\\*\\*Holder\\*\\*: (?P<h>[^\\n]+)").h),
                  files: (.body | capture("\\*\\*Files\\*\\*: (?P<f>[^\\n]+)").f)})' 2>/dev/null || echo '[]')
     # For each still-blocked issue in a Layer-2/4 pair: check if its claim's file set
     # is disjoint from all remaining active claims. If so, mark it ready.
     # (Layer-1 and Layer-3 edges are never relaxed — this check is Layer-2/4 only.)
     for BLOCKED_NUM in {layer_2_4_blocked_issues}; do
       BLOCKED_CLAIM_FILES=$(echo "$ACTIVE_CLAIMS" \
         | jq -r --arg h "#${BLOCKED_NUM}" '.[] | select(.holder | startswith($h)) | .files' 2>/dev/null || echo "")
       if [ -n "$BLOCKED_CLAIM_FILES" ]; then
         # Compare file set with all other active claims — if disjoint, downgrade to ready
         echo "Claims-board relaxation: checking if #${BLOCKED_NUM} can be unblocked based on disjoint claims"
         # (Implementer: build a set-intersection check here using sorted file lists)
       fi
     done
   fi
   ```

5. **Record completed results**: Success (PR merged), Invalid (issue closed), Blocked (needs human), Awaiting-merge (`workflow:awaiting-merge` — remediated + re-reviewed to APPROVED after an earlier `needs-human` escalation; needs only a human merge, not diagnosis — keep distinct from Blocked in any status output, see item 8), or Error

5. **Check for newly unblocked issues** — run the DAG readiness check above. If any issues are now ready, dispatch them immediately (Steps 4A.pre.0 → 4A.pre → 4A). Batch all newly ready issues into a single dispatch message.

6. **Handle predecessor failures** — if a completed agent's issue classifies as `FAILED` (`workflow:invalid`, or an explicit build/test error — see Predecessor Classification above; `needs-human` and `workflow:awaiting-merge` are GATED, not FAILED — see item 6.5), check for dependent issues in the DAG. Mark all transitive dependents as "skipped — dependency #{X} failed" and report them. Do NOT dispatch them.

6.5. **Handle predecessor gating** (`GATED` — `needs-human` or `workflow:awaiting-merge`) <!-- Added: forge#1812 --> — if a completed agent's issue classifies as `GATED`, its direct dependents are neither dispatched nor marked failed/skipped. For each direct dependent `DEP` of the gated predecessor `PRED`:
   ```bash
   # Resolve PRED's open PR, if any, using the anchored search (forge#1634/#1646 precedent —
   # do NOT fall back to a bare-number search here; a stale unrelated PR would misattribute gating).
   GATING_PR=$(gh pr list -R {GH_REPO} --state open --search "\"Closes #${PRED}\" in:body" \
     --json number --jq '.[0].number // empty' 2>/dev/null || echo "")
   PRED_LABEL=$(gh issue view "$PRED" -R {GH_REPO} --json labels \
     --jq '[.labels[].name | select(. == "needs-human" or . == "workflow:awaiting-merge")] | .[0] // "needs-human"' 2>/dev/null)

   # Self-heal the label if it hasn't been bootstrapped yet (same pattern as review-pr.md 6C —
   # colors match the canonical manifest bin/labels.json; --force makes this idempotent/cheap).
   gh label create "blocked-on-human-merge" --color "006B75" --description "Dependent of a gated (needs-human/awaiting-merge) predecessor. Managed by ForgeDock." --force -R {GH_REPO} 2>/dev/null

   # Idempotency: only post/label if not already tracked for this specific predecessor.
   # Anchor on the exact "**Gating predecessor**: #N" label with a word boundary —
   # a bare contains("#N") substring would false-match #50/#500 for predecessor #5. <!-- forge#1830 -->
   ALREADY_TRACKED=$(gh api repos/{GH_REPO}/issues/${DEP}/comments \
     --jq --arg prednum "${PRED}" '[.[] | select(.body | contains("FORGE:BLOCKED_ON_HUMAN_MERGE") and test("Gating predecessor\\*\\*: #" + $prednum + "\\b"))] | length' 2>/dev/null || echo "0")
   if [ "$ALREADY_TRACKED" -eq 0 ]; then
     gh issue comment "$DEP" -R {GH_REPO} --body "<!-- FORGE:BLOCKED_ON_HUMAN_MERGE -->
**Gating predecessor**: #${PRED} (state: \`${PRED_LABEL}\`${GATING_PR:+, open PR #${GATING_PR}})
**Status**: This issue is ready to dispatch as soon as #${PRED}'s gating PR merges. No action needed — the orchestrator (live session via item 6.6, or the next \`/orchestrate\` invocation via phase-3-dependency.md's wake reconstruction) will auto-dispatch it the moment #${PRED} reaches \`workflow:merged\`."
     gh issue edit "$DEP" -R {GH_REPO} --add-label "blocked-on-human-merge" 2>/dev/null || true
   fi
   ```
   Do NOT dispatch `DEP`. Do NOT mark it skipped — it remains visibly tracked as `blocked-on-human-merge` in the DAG, re-evaluated on the next completion event, stall-detection pass, or session wake.

6.6. **Merge-triggered wake for blocked-on-human-merge dependents** <!-- Added: forge#1812 --> — whenever a completed agent's issue classifies as `DONE` via `workflow:merged` (i.e. it just merged), check whether any other issue is tracked as blocked on it — this makes gated dependents dispatch the instant the gating PR merges, with no manual `/orchestrate` re-run required:
   ```bash
   WOKEN=$(gh issue list -R {GH_REPO} --state open --label "blocked-on-human-merge" --json number \
     --jq '.[].number' 2>/dev/null || echo "")
   for DEP in $WOKEN; do
     IS_GATED_BY_THIS=$(gh api repos/{GH_REPO}/issues/${DEP}/comments \
       --jq --arg prednum "${NUM}" '[.[] | select(.body | contains("FORGE:BLOCKED_ON_HUMAN_MERGE") and test("Gating predecessor\\*\\*: #" + $prednum + "\\b"))] | length' 2>/dev/null || echo "0")
     [ "$IS_GATED_BY_THIS" -gt 0 ] || continue
     # Idempotency: only dispatch if DEP hasn't already been dispatched by another path.
     DEP_ALREADY_DISPATCHED=$(gh issue view "$DEP" -R {GH_REPO} --json labels \
       --jq '[.labels[].name | select(startswith("workflow:"))] | length' 2>/dev/null || echo "0")
     if [ "$DEP_ALREADY_DISPATCHED" -eq 0 ]; then
       gh issue edit "$DEP" -R {GH_REPO} --remove-label "blocked-on-human-merge" 2>/dev/null || true
       gh issue comment "$DEP" -R {GH_REPO} --body "<!-- FORGE:UNBLOCKED -->
Gating predecessor #${NUM} reached \`workflow:merged\` — dispatching now. (Was tracked via a prior FORGE:BLOCKED_ON_HUMAN_MERGE comment.)"
       echo "#{DEP} unblocked by #{NUM} merge — dispatching immediately (Steps 4A.pre.0 → 4A.pre → 4A)."
       # Add DEP to the same-response dispatch batch
     fi
   done
   ```
   This satisfies the live-session case. For the case where the gating PR merges after the orchestrator session has already ended, the equivalent check runs in `phase-3-dependency.md`'s wake/compaction reconstruction on the next `/orchestrate` invocation — see that file's "Orchestrator state reconstruction on wake / after compaction" section.

6.7. **Human-gated idle/backpressure check** (`BATCH_FULLY_GATED`) <!-- Added: forge#1814 --> — run this after every completion cycle, once the per-issue classification above (items 5-6.6) has been applied for this cycle. It answers a different question than the paused-drain/blocked-on-human-merge tracking above: those items handle *individual* gated predecessors and their *direct* dependents; this check asks whether the **entire original batch** has now exhausted into human-gated states, which is the condition under which continuing to dispatch cascade-spawned review findings (Step 4C) produces net-negative churn — closing 1 issue while opening 2-4 more, with the real blockers (the GATED issues) unresolved:

   ```bash
   # BATCH_FULLY_GATED is computed over {all_batch_issue_numbers} — the ORIGINAL batch issues
   # this /orchestrate invocation was given, NOT cascade-spawned review-finding issues (those are
   # a separate, currently-unbounded-looking stream that this check exists to cap). Cascade
   # findings are excluded here because they are the SYMPTOM (Step 4C keeps producing them);
   # counting them as "still IN_PROGRESS" would make this check permanently false and defeat
   # its own purpose.
   ANY_ORIGINAL_IN_PROGRESS=false
   ANY_ORIGINAL_GATED=false
   for ORIG_NUM in {all_batch_issue_numbers}; do
     ORIG_STATE=$(classify_predecessor_state "$ORIG_NUM")
     case "$ORIG_STATE" in
       IN_PROGRESS) ANY_ORIGINAL_IN_PROGRESS=true ;;
       GATED) ANY_ORIGINAL_GATED=true ;;
       DONE|FAILED) ;;  # exhausted — no action
     esac
   done

   if [ "$ANY_ORIGINAL_IN_PROGRESS" = "false" ] && [ "$ANY_ORIGINAL_GATED" = "true" ]; then
     BATCH_FULLY_GATED=true
   else
     BATCH_FULLY_GATED=false
   fi
   ```

   - **`BATCH_FULLY_GATED=true`** requires BOTH: no original-batch issue is still `IN_PROGRESS` (i.e. nothing from the original scope will complete on its own without a human), AND at least one original-batch issue is `GATED` (`needs-human`/`workflow:awaiting-merge`, or a dependent already tracked `blocked-on-human-merge`). A batch that finishes entirely `DONE`/`FAILED` with zero `GATED` issues is NOT idle — it is simply complete; do not confuse the two.
   - **This is a live, recomputed flag, not a one-way latch.** Re-run it every completion cycle. If a gating PR merges (item 6.6 fires) and unblocks an original-batch dependent that becomes dispatchable again, `ANY_ORIGINAL_IN_PROGRESS` flips back to `true` on the next cycle and `BATCH_FULLY_GATED` flips back to `false` — normal dispatch resumes automatically. This is what prevents a permanent idle state and satisfies "no regression: when productive non-gated work remains, the orchestrator continues normally."
   - **Effect when true**: Step 4C's cascade-finding dispatch (the "For queued (non-deferred) findings" block) is suppressed — see the `BATCH_FULLY_GATED` check added there. The first time the flag flips from `false`/unset to `true` in a completion cycle, print the idle report below and stop actively dispatching new cascade work; the batch remains resumable exactly as item 6.6 and `phase-3-dependency.md`'s wake reconstruction already guarantee.

   **Idle report** (print once, the cycle `BATCH_FULLY_GATED` first becomes true):
   ```
   ⏸ Orchestrator Idle — Waiting on N Merge(s)

   The remaining batch is fully human-gated: every original issue is either merged/invalid, or
   blocked on a human decision/merge. No further autonomous progress is possible until one of the
   PRs below is merged. Newly-spawned review-finding issues are being deferred (not dispatched) so
   the open-issue count does not inflate while nothing productive can close.

   {reuse the Merge-Ready table computation from phase-6-report.md Step 6A.5 (MERGE_READY_PRS) and
    the Blocked-on-Merge table from Step 6A.6 (BLOCKED_ON_MERGE) — both already anchor their PR
    lookups on "Closes #N" in:body per forge#1634/#1646/#1822, so this reuses that logic verbatim
    rather than re-implementing a parallel PR-resolution path}

   Findings deferred (idle policy): {count of newly-queued findings deferred this cycle}
   ```

   This report is an interim, in-progress print — it does NOT replace the final consolidated report from Phase 6, which runs once the session actually ends or the next `/orchestrate` invocation picks the batch back up; see `phase-6-report.md` Step 6B for the corresponding "Orchestration Paused — Idle" header.

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
   ⏸ #{NUMBER} — {title} → PR #{PR} awaiting-merge (remediated + re-approved — human merge only, no diagnosis needed)
   🔗 #{NUMBER} — {title} → blocked-on-human-merge (gated by #{PRED}, will auto-dispatch on #{PRED} merge)
   ⏳ Progress: {completed}/{total} complete, {active} active, {blocked} blocked
   → Dispatched #{NEWLY_READY} (predecessor #{PRED} completed)
   ```

   `⏸` (awaiting-merge) is deliberately distinct from `⚠` (blocked/bypass) — do not collapse the
   two. `⚠` means the pipeline hit something it cannot resolve and a human must diagnose it;
   `⏸` means the PR already cleared re-review and only needs a merge click. `🔗` (blocked-on-human-merge,
   forge#1812) is distinct from both: it marks a DEPENDENT of a GATED predecessor (item 6.5) — the
   dependent itself has no problem at all, it is simply waiting on someone else's merge. See Phase 6's
   "Merge-Ready" report section (`phase-6-report.md` Step 6A.5/6B) for the batch-level rollup.

9. **Run staging integrity check** (from Step 4A-pre) if the completed agent merged a PR targeting staging.

**Termination condition**: All issues in the DAG have reached `DONE` or `FAILED` (merged, invalid, or skipped due to dependency failure) — OR are `blocked-on-human-merge` (item 6.5) with no further dispatchable work remaining in the batch. These two outcomes are reported differently: a batch where every issue is `DONE`/`FAILED` is a **clean drain**; a batch where one or more issues remain `blocked-on-human-merge` is a **paused drain** — the active dispatch loop stops (there is nothing left to do until a human merges a gating PR) but this MUST be reported as paused, not as fully complete (see `phase-6-report.md`'s `🔗 Blocked-on-Merge` section). `needs-human` predecessors with no open PR are neither — they remain GATED indefinitely until either a PR appears (dependent moves to blocked-on-human-merge) or the predecessor itself resolves; do not treat isolated `needs-human` issues with no dependents as blocking termination. When either drain condition is met, check whether deferred review-spawned findings exist (accumulated in `DEFERRED_FINDINGS` during Step 4C). If deferred findings exist → proceed to Step 4F (Completion Sweep). If no deferred findings → proceed to Phase 5.

**Relationship to `BATCH_FULLY_GATED` (item 6.7, forge#1814)**: A paused drain (above) describes the *original batch DAG* reaching a stable, non-progressing state. `BATCH_FULLY_GATED` is the mechanism that keeps that stable state from being masked by cascade churn — without it, Step 4C would keep dispatching new review-finding issues indefinitely (each with its own predecessors/dependents), so the DAG would never actually look "drained" even though the original batch's productive work stopped the moment the last non-gated issue completed. Once `BATCH_FULLY_GATED` is true, Step 4C stops adding new dispatchable work (rule 0 defers all newly-spawned findings), which lets the batch actually reach the paused-drain termination condition above instead of chasing an ever-growing cascade tail. Report this state using the idle report from item 6.7, not a plain "waiting for agents" message — the whole point is to make the pause visible and actionable (which PR(s) to merge), not silent.

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
  # Skip issues already in a terminal-for-this-agent state (merged/invalid/needs-human/awaiting-merge).
  # workflow:awaiting-merge MUST be included here (forge#1812) — otherwise the stall detector
  # re-escalates an already-remediated-and-re-approved PR back to needs-human after STALL_TIMEOUT,
  # silently collapsing the Awaiting-Merge/Blocked distinction forge#1811 introduced.
  TERMINAL=$(gh issue view $NUM -R {GH_REPO} --json labels \
    --jq '[.labels[].name | select(. == "workflow:merged" or . == "workflow:invalid" or . == "needs-human" or . == "workflow:awaiting-merge")] | length')
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
0. **Batch fully human-gated** (`BATCH_FULLY_GATED == true`, always defer, even for P1/P2) <!-- Added: forge#1814 -->: The original batch (see Step 4B item 6.7) has exhausted into DONE/FAILED/GATED with nothing left `IN_PROGRESS` — the real blockers are the GATED issues, not a lack of dispatchable findings. Dispatching a new review-finding here cannot produce net batch progress; it only inflates the open-issue count while the productive path waits on a human merge. Always defer, checked before generation and priority. Rationale: this is the idle/backpressure policy this issue adds — without it, rule 2 (below) unconditionally executes P1/P2 findings regardless of how gated the rest of the batch is, which is the root cause of the net-negative churn this policy exists to stop.
1. **Generation ≥ 2** (always defer, even for P1/P2): Finding was spawned by an issue that was itself a review-finding. Check the source issue's labels for `review-finding` — if the source has that label, the new finding is generation 2. Always defer. Rationale: gen-2+ cascade is theoretically unbounded — cap it here.
2. **Priority override** (P1 or P2 → always execute): If the finding is labeled P1 or P2, skip all remaining heuristics and execute. Rationale: high-priority findings must never be suppressed by keyword matching.
3. **Comment/typo heuristic** (P3 and below only): Finding title contains the word "comment" or "typo" (case-insensitive). These are 1-line cosmetic fixes that do not block other work.
4. **P3 + same-file overlap**: Finding is labeled `P3` AND the file it targets overlaps with ANY file already in the current batch (active or queued in the DAG). Rationale: same-file P3 findings add predecessor edges that serialize agents — one finding per original issue increases wall-clock time with no proportional value.

**Defer** (do NOT add to the DAG) if rules 0, 1, 3, or 4 match.

**Execute** (add to the DAG) if:
- Rule 2 matches (P1 or P2) — AND rule 0 did not already match (rule 0 is checked first and overrides rule 2)
- None of the defer rules matched (generation 1, P3 with no file overlap, not a keyword match, batch not fully gated)

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
# NOTE: DEFERRED_FINDINGS, QUEUED_FINDINGS, and DEFERRED_REASONS are declared at
# batch scope in Step 4A.pre — do NOT re-initialize them here (Step 4C runs per-agent).
for FINDING_NUM in {spawned_finding_numbers}; do
  FINDING_DATA=$(gh issue view $FINDING_NUM -R {GH_REPO} --json labels,title,body \
    --jq '{labels: [.labels[].name], title: .title, body: .body}')

  PRIORITY=$(echo "$FINDING_DATA" | jq -r '.labels[] | select(startswith("priority:P")) | ltrimstr("priority:")' | head -1)
  TITLE=$(echo "$FINDING_DATA" | jq -r '.title')

  # Rule 0: Batch fully human-gated — checked FIRST, overrides even the P1/P2 priority
  # override below. BATCH_FULLY_GATED is computed once per completion cycle in Step 4B
  # item 6.7; read it here, do not recompute. <!-- Added: forge#1814 -->
  if [ "${BATCH_FULLY_GATED:-false}" = "true" ]; then
    DEFER=true; DEFER_REASON="batch fully human-gated — idle policy"
  # Heuristic 1: Generation check — source issue has review-finding label (always defer, even for P1/P2)
  elif SOURCE_NUM=$(echo "$FINDING_DATA" | jq -r '.body' | grep -oP '(?i)spawned from issue #\K\d+|source issue[: #]+\K\d+' | head -1) && \
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

**Surface-area batching for queued P3 findings (MANDATORY check before dispatch):** <!-- Added: forge#1818 -->

Cascade-spawned findings collected within a single `/orchestrate` run never pass back through Phase 1's batching rule — Phase 1 only runs once, at the start. Without a check here, same-file P3 findings spawned mid-run always dispatch individually, defeating the batching policy for exactly the findings it exists to catch. Apply the same grouping rule from `commands/orchestrate/phase-1-resolve.md` ("P3 Review-Finding Batching") to `QUEUED_FINDINGS` before the dispatch step below:

```bash
# Group QUEUED_FINDINGS by exact affected file, reusing the SAME safety
# exclusions as phase-1-resolve.md. Both sites go through jq test() (Oniguruma)
# with identical patterns — NOT grep ERE — so the two batching checks cannot
# classify the same issue body differently. <!-- forge#1837 -->
declare -A SURFACE_FILE_MEMBERS
SURFACE_BATCHED_FINDINGS=()

# Defensive cap on gh issue view fan-out. QUEUED_FINDINGS is already bounded by
# upstream cascade control; this cap holds even if that bound is later loosened,
# so the loop can never scale API calls linearly with cascade-seeded findings. <!-- forge#1836 -->
MAX_BATCH_SCAN=50
SCANNED=0

for FINDING_NUM in "${QUEUED_FINDINGS[@]}"; do
  SCANNED=$((SCANNED + 1))
  if [ "$SCANNED" -gt "$MAX_BATCH_SCAN" ]; then
    echo "Surface-area batching: reached MAX_BATCH_SCAN=$MAX_BATCH_SCAN — remaining findings stay individually queued"
    break
  fi

  FINDING_DATA=$(gh issue view $FINDING_NUM -R {GH_REPO} --json title,body,labels \
    --jq '{title: .title, body: .body, labels: [.labels[].name]}')

  # Safety exclusions — never batch, at any priority. Same jq test() engine and
  # patterns as phase-1-resolve.md's batching rule (single shared mechanism).
  echo "$FINDING_DATA" | jq -e '
    (.title | test("security|billing|anti-bot|auth"; "i"))
    or (.body  | test("## Problem[\\s\\S]{0,500}(security|billing|anti-bot|auth)"; "i"))
    or ([.labels[]] | any(. == "security" or . == "billing" or . == "anti-bot" or . == "auth"))
  ' >/dev/null && continue

  # Only P3 findings are eligible (P1/P2 already dispatched individually above)
  echo "$FINDING_DATA" | jq -e '[.labels[]] | any(. == "priority:P3")' >/dev/null || continue

  FINDING_FILE=$(echo "$FINDING_DATA" | jq -r '.body' | grep -oE '`[^`]+\.(py|tsx?|jsx?|sql|json|ya?ml|sh|md)`' | head -1 | tr -d '`')
  [ -z "$FINDING_FILE" ] && continue

  SURFACE_FILE_MEMBERS["$FINDING_FILE"]="${SURFACE_FILE_MEMBERS[$FINDING_FILE]} $FINDING_NUM"
done

# For each same-file cluster of 2+, actually CREATE the batch issue (executable —
# mirrors phase-1-resolve.md's "Batch creation rule") and REPLACE the members with
# the batch issue in QUEUED_FINDINGS so the dispatch step below never double-dispatches
# them. This is what makes SURFACE_BATCHED_FINDINGS a live control, not dead wiring. <!-- forge#1832, forge#1834 -->
for FILE in "${!SURFACE_FILE_MEMBERS[@]}"; do
  MEMBERS=(${SURFACE_FILE_MEMBERS[$FILE]})
  [ "${#MEMBERS[@]}" -ge 2 ] || continue

  # Sanitize the affected-file path before interpolating it into the issue title/body.
  # Git filenames can legally carry shell metacharacters (`$()`, backticks, quotes);
  # restrict to a validated charset so the value cannot break the gh argument
  # boundary from an untrusted issue body. Shared guard with phase-1-resolve.md. <!-- forge#1833, forge#1835 -->
  SAFE_SURFACE_AREA=$(printf '%s' "$FILE" | tr -cd 'A-Za-z0-9._/-')

  echo "Same-run surface-area cluster: ${#MEMBERS[@]} P3 findings share $FILE — creating batch issue(s)"

  # Cap at 8 members per batch (phase-1-resolve.md limit); split into batches of <=8.
  for START in $(seq 0 8 $(( ${#MEMBERS[@]} - 1 ))); do
    CHUNK=("${MEMBERS[@]:$START:8}")
    [ "${#CHUNK[@]}" -ge 2 ] || continue

    MEMBER_LINES=""
    for M in "${CHUNK[@]}"; do
      MTITLE=$(gh issue view "$M" -R {GH_REPO} --json title --jq '.title' 2>/dev/null || echo "")
      MEMBER_LINES="${MEMBER_LINES}- [ ] #${M}: ${MTITLE}"$'\n'
    done

    BATCH_ISSUE_NUM=$(gh issue create {GH_FLAG} \
      --title "fix(batch): P3 review findings — ${SAFE_SURFACE_AREA} (same-run batch)" \
      --label "review-finding,priority:P3,batch" \
      --body "$(cat <<BATCH_EOF
## Problem

Batch of P3 review findings in **${SAFE_SURFACE_AREA}** (same file), clustered mid-run by phase-4-execution.md to reduce per-finding pipeline overhead.

## Member Findings

<!-- FORGE:BATCH_MEMBERS -->
${MEMBER_LINES}<!-- /FORGE:BATCH_MEMBERS -->

## Acceptance Criteria

- [ ] All member findings addressed or closed as false-positive
- [ ] Member issues auto-closed with reference to this batch PR on merge
- [ ] No security, billing, anti-bot, or auth paths touched (validated before batching)

<!-- FORGE:BATCHABLE -->
BATCH_EOF
)" --json number --jq '.number')

    # Consume the cluster: record members and REPLACE them in QUEUED_FINDINGS
    # with the single batch issue, so the dispatch step below operates on the
    # batch unit and skips the individual members.
    SURFACE_BATCHED_FINDINGS+=("${CHUNK[@]}")
    QUEUED_FINDINGS=($(printf '%s\n' "${QUEUED_FINDINGS[@]}" | grep -vxF -f <(printf '%s\n' "${CHUNK[@]}") || true))
    [ -n "$BATCH_ISSUE_NUM" ] && QUEUED_FINDINGS+=("$BATCH_ISSUE_NUM")
    echo "Batched ${#CHUNK[@]} findings into #${BATCH_ISSUE_NUM}; members removed from QUEUED_FINDINGS and the DAG."
  done
done
```

Findings clustered here are replaced by their batch issue in `QUEUED_FINDINGS` (and therefore the DAG, which is built from `QUEUED_FINDINGS` in the dispatch step below) — the individual member issues in `SURFACE_BATCHED_FINDINGS` are never dispatched. Findings that remain ungrouped (fewer than 2 sharing a file in this collection round) stay individually queued below; they retain default-batchable eligibility and will be picked up by the next `/orchestrate` invocation's Phase 1 resolve if a same-file or leaf-directory cluster later forms across runs.

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
- **Merge conflict**: Report to user, mark issue as needing human attention (`needs-human`). This classifies as **GATED**, not FAILED — see Predecessor Classification in Step 4B. Its dependents follow the Dependency cascade rule below, not a hard skip.
- **Invalid issue**: Already handled by the agent (closed with comment) — just report it. This classifies as **FAILED**.
- **Build/test failure**: Report the error, suggest manual intervention. This classifies as **FAILED**.
- **Agent timeout**: Report which issue timed out, suggest re-running with `/work-on #{N}`. Not yet terminal — leave dependents in `IN_PROGRESS` wait, no cascade action.
- **Dependency cascade** <!-- Updated: forge#1812 -->: Re-run `classify_predecessor_state` (Step 4B) for the failed/gated issue before cascading — do NOT assume every entry above is a hard failure:
  - If it classifies **FAILED** (invalid, or build/test failure): mark all transitive dependents in the DAG as "skipped — dependency #{X} failed" (same as Step 4B item 6).
  - If it classifies **GATED** (merge conflict → `needs-human`, or `workflow:awaiting-merge`): do NOT mark dependents skipped. Instead apply Step 4B item 6.5 — track each direct dependent as `blocked-on-human-merge` against this predecessor, so it auto-dispatches via item 6.6 the moment the predecessor reaches `workflow:merged`.

**Do NOT retry failed agents automatically.** Report the failure and let the user decide.

### Step 4F: Completion Sweep (deferred review-spawned findings) <!-- Added: forge#1105 -->

**When to run**: After all DAG issues reach terminal state AND `DEFERRED_FINDINGS` is non-empty. Skip if no findings were deferred during this batch.

**WHY THIS EXISTS**: Deferred findings accumulate during the batch because of file-overlap and cascade-control heuristics (Step 4C). But once the DAG drains, the conditions that caused deferral often no longer apply — completed issues no longer occupy files, so same-file overlap vanishes. Without this sweep, deferred findings silently pile up across runs and never get resolved.

**Step 4F.1: Classify deferred findings into permanent vs re-evaluable vs idle-gated**

```bash
PERMANENT_DEFERRED=()
SWEEP_CANDIDATES=()
IDLE_DEFERRED=()   # <!-- Added: forge#1814 -->

for FINDING_NUM in "${DEFERRED_FINDINGS[@]}"; do
  DEFER_REASON="${DEFERRED_REASONS[$FINDING_NUM]}"

  # Generation >= 2 deferrals are PERMANENT — unbounded cascade prevention
  if echo "$DEFER_REASON" | grep -qi "generation"; then
    PERMANENT_DEFERRED+=($FINDING_NUM)
  # "Batch fully human-gated" deferrals (forge#1814) are their OWN bucket — they must NOT be
  # re-evaluated by the file-overlap logic in Step 4F.2 below, because the reason they were
  # deferred has nothing to do with file overlap. Re-evaluating them the same way as
  # comment/typo or P3-same-file deferrals would silently undo the idle policy: a sweep can
  # run while the batch is still a "paused drain" (Step 4B's Termination condition explicitly
  # allows Step 4F to run in that state), and BATCH_FULLY_GATED would still be true at sweep
  # time unless a human has actually merged a gating PR in the meantime.
  elif echo "$DEFER_REASON" | grep -qi "batch fully human-gated"; then
    IDLE_DEFERRED+=($FINDING_NUM)
  else
    # All other deferrals (comment/typo, P3 same-file) are re-evaluable
    SWEEP_CANDIDATES+=($FINDING_NUM)
  fi
done

echo "Completion sweep: ${#SWEEP_CANDIDATES[@]} re-evaluable, ${#PERMANENT_DEFERRED[@]} permanent, ${#IDLE_DEFERRED[@]} idle-gated"
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

**Step 4F.2.5: Re-evaluate idle-gated deferrals** <!-- Added: forge#1814 -->

Recompute `BATCH_FULLY_GATED` fresh at sweep time (same check as Step 4B item 6.7, over `{all_batch_issue_numbers}`) — do NOT reuse a stale value captured when the finding was originally deferred. If a human has merged a gating PR since the finding was deferred, the original batch is no longer fully gated and the finding is safe to execute; otherwise it stays deferred.

```bash
# Skip the recompute entirely if nothing was idle-gated this run — no need to spend API
# calls re-classifying the original batch for a bucket with zero members.
if [ "${#IDLE_DEFERRED[@]}" -gt 0 ]; then
  ANY_ORIGINAL_IN_PROGRESS=false
  ANY_ORIGINAL_GATED=false
  for ORIG_NUM in {all_batch_issue_numbers}; do
    ORIG_STATE=$(classify_predecessor_state "$ORIG_NUM")
    case "$ORIG_STATE" in
      IN_PROGRESS) ANY_ORIGINAL_IN_PROGRESS=true ;;
      GATED) ANY_ORIGINAL_GATED=true ;;
      DONE|FAILED) ;;
    esac
  done
  if [ "$ANY_ORIGINAL_IN_PROGRESS" = "false" ] && [ "$ANY_ORIGINAL_GATED" = "true" ]; then
    BATCH_FULLY_GATED=true
  else
    BATCH_FULLY_GATED=false
  fi
fi

for FINDING_NUM in "${IDLE_DEFERRED[@]}"; do
  if [ "${BATCH_FULLY_GATED:-false}" = "true" ]; then
    SWEEP_STILL_DEFERRED+=($FINDING_NUM)
    echo "Sweep: #${FINDING_NUM} still deferred (batch still fully human-gated — idle policy)"
  else
    SWEEP_EXECUTE+=($FINDING_NUM)
    echo "Sweep: #${FINDING_NUM} cleared for execution (batch no longer fully gated — a gating PR merged)"
  fi
done
```

**Step 4F.3: Dispatch cleared findings**

For each finding in `SWEEP_EXECUTE`, add it to a fresh sweep DAG and dispatch using the same Steps 4A.pre.0, 4A.pre, and 4A logic. Run file-overlap detection between the swept findings themselves (they may conflict with each other).

**MANDATORY**: Use the full Step 4A agent template verbatim for each swept finding. Do NOT use a bare `prompt="Run /work-on N"` — that bypasses the label-state loop contract, source branch detection, and all pipeline enforcement rules. Swept findings are always `review-finding` issues that require source branch detection to route correctly.

**Step 4F.3.pre: Classify lane for each sweep finding (MANDATORY before dispatching)**

Run `classify-lane.sh` per finding — same pattern as Step 4A.pre:

```bash
declare -A SWEEP_LANE
declare -A SWEEP_PR_BASE

for FINDING_NUM in "${SWEEP_EXECUTE[@]}"; do
  SWEEP_BASE=$(bash ~/.claude/scripts/classify-lane.sh "$FINDING_NUM" -R {GH_REPO}) || {
    echo "ERROR: classify-lane.sh failed for #$FINDING_NUM — adding needs-human and skipping" >&2
    gh issue edit "$FINDING_NUM" -R {GH_REPO} --add-label "needs-human" 2>/dev/null || true
    continue
  }
  if [ "$SWEEP_BASE" = "staging" ]; then
    SWEEP_LANE[$FINDING_NUM]="fast-lane"
  else
    SWEEP_LANE[$FINDING_NUM]="feature-lane"
  fi
  SWEEP_PR_BASE[$FINDING_NUM]="$SWEEP_BASE"
  echo "#$FINDING_NUM → lane=${SWEEP_LANE[$FINDING_NUM]}, PR_BASE=$SWEEP_BASE"
done
```

**Step 4F.3.dispatch: Dispatch with full Step 4A template**

```bash
if [ ${#SWEEP_EXECUTE[@]} -gt 0 ]; then
  echo "Completion sweep: dispatching ${#SWEEP_EXECUTE[@]} cleared findings"

  # Build sweep DAG — same conflict detection as Step 3C Layers 1-4
  # but only among the swept findings (no original batch issues remain active)
  # Dispatch ready findings, monitor completions using the same Step 4B loop
  # This is a SINGLE pass — findings spawned during the sweep are NOT swept again
  # (they follow the standard Step 4C triage: queued or deferred for next run)

  # NOTE: Step 4A.pre.0 (milestone branch pre-creation) is intentionally skipped here.
  # Swept findings are always review-finding issues that target an already-existing branch
  # (staging or a milestone branch). The branch was created when the original batch ran —
  # it always exists by the time the sweep runs.

  for FINDING_NUM in "${SWEEP_EXECUTE[@]}"; do
    # Skip any finding whose classify-lane call failed (needs-human already set above)
    [ -z "${SWEEP_PR_BASE[$FINDING_NUM]:-}" ] && continue

    FINDING_TITLE=$(gh issue view "$FINDING_NUM" -R {GH_REPO} --json title --jq '.title' 2>/dev/null || echo "")

    # Build GIST_CONTEXT for sweep finding — same as Step 4A's *fallback* (raw-gist) path.
    # The Phase 2.5 FORGE:SYNTHESIS_BRIEF preference is intentionally NOT applied here:
    # sweep findings are freshly-created review-finding issues that never received a
    # synthesis brief (Phase 2.5 runs only over the original batch's investigations), so
    # there is nothing to prefer. Keep this block in sync with 4A's fallback branch only.
    GIST_CONTEXT=""
    # Markdown emphasis markers (**bold**, __bold__, *italic*) are stripped before matching —
    # kept in sync with 4A's fallback branch above.
    PARENT_INV=$(gh issue view "$FINDING_NUM" -R {GH_REPO} --json body --jq '.body' \
      | sed -E 's/[*_]+//g' \
      | grep -oP '(?i)parent[: ]*#\K\d+|spawned from[: ]*#\K\d+' | head -1)

    if [ -n "$PARENT_INV" ] && [ -n "${INVESTIGATION_GISTS[$PARENT_INV]:-}" ]; then
      GIST_CONTEXT="
**CONTEXT FROM PRIOR INVESTIGATION**: Investigation #${PARENT_INV} produced Knowledge Gist(s) with findings relevant to this issue:
$(echo "${INVESTIGATION_GISTS[$PARENT_INV]}" | while IFS= read -r url; do echo "- ${url}"; done)
Fetch the Gist content during the context-gathering phase for implementation guidance."
    fi

    if [ -n "$MILESTONE_INDEX_URL" ]; then
      GIST_CONTEXT="${GIST_CONTEXT}

**MILESTONE KNOWLEDGE INDEX**: All investigation findings for this milestone are aggregated in a single index Gist:
- ${MILESTONE_INDEX_URL}
The context-gathering phase can fetch this index to discover all investigation Gists for the milestone."
    fi

    # Use the full Step 4A template verbatim — copied here so sweep agents receive
    # the complete pipeline contract. Keep in sync with Step 4A when the template changes.
    Agent(
      subagent_type="general-purpose",
      model="sonnet",
      description="Work on {PROJECT_PREFIX}#${FINDING_NUM}",
      run_in_background=true,
      prompt="You are working on GitHub issue #${FINDING_NUM} for the {PROJECT_NAME} project.

**Project**: {PROJECT_NAME}
**Repository**: {GH_REPO}
**Repo path**: {REPO_PATH}

**YOUR MISSION**: Invoke \`/work-on\` via the Skill tool and let it run to completion. \`/work-on\` is a self-contained routing loop that handles the ENTIRE pipeline: investigate → build (context → architect → implement → validate) → review (push → PR → /review-pr --auto-merge) → close (project board → trajectory log → worktree cleanup). Do NOT intervene, compensate, or manually close issues — \`/work-on\` handles everything including issue closure and label updates in its close phase.

**CRITICAL — DO NOT STOP EARLY**: /work-on runs as a multi-phase routing loop. Each phase (investigate, build, review, close) returns an intermediate result — these are NOT completion signals. You are NOT done until the issue reaches a terminal state: \`workflow:merged\`, \`workflow:invalid\`, \`needs-human\`, or \`workflow:awaiting-merge\`. If /work-on returns after only one phase (e.g., investigation), you MUST invoke it again immediately — it will re-read GitHub state and continue to the next phase. Keep invoking /work-on until it reaches a terminal state. Never output 'done' or stop after an intermediate result.

**HOW REVIEW FINDINGS WORK**: /review-pr may create GitHub issues (with \`review-finding\` label) for findings it discovers. These are NOT blockers — they are separate work items that will go through their own /work-on pipeline later. The original PR should ALWAYS merge after review. The only exception is build errors (code doesn't compile) — those must be fixed before merging.

**IMPORTANT RULES**:
- **MANDATORY**: You MUST use the Skill tool to invoke 'work-on' with args '${FINDING_NUM}'. Do NOT implement manually — /work-on handles the full pipeline including label state machine (workflow:investigating → workflow:building → workflow:in-review → workflow:merged), investigation reports, PR creation, and cleanup.
  - For default repo issues: \`Skill(skill='work-on', args='${FINDING_NUM} --under-orchestration')\`
  - For satellite repo issues: \`Skill(skill='work-on', args='{SATELLITE_PREFIX}:${FINDING_NUM} --under-orchestration')\` (prefix from forge.yaml → repos.satellites)
- NEVER bypass /work-on with manual git/gh commands — the label updates and structured comments are critical for tracking
- NEVER target \`main\` for PRs targeting the default repo. Use \`{STAGING_BRANCH}\` for fast-lane issues, or \`milestone/{slug}\` for milestone issues.
- Satellite repos (MCP, n8n) have no staging branch — fast-lane PRs go to \`main\` for those.
- If the issue is INVALID after investigation, close it with a comment explaining why
- If you hit merge conflicts or blockers, post a comment on the issue and STOP — do not force anything
- Do not interact with the user — you are running autonomously in the background
- **NEVER ask the user questions** — you are a background agent. If review finds issues, auto-fix simple ones and proceed. For complex findings on **low-risk domains**, merge anyway and create follow-up issues. For complex findings on **high-risk domains** (AUTH, BILLING, DATABASE, or any domain tagged as security-critical in Step 3B), add the `needs-human` label and stop — do NOT merge. High-risk `needs-human` halts are surfaced as `⚠ Blocked` in the Phase 5 completion report.

**LABEL-STATE LOOP CONTRACT — enforce after EVERY Skill return**:
After EVERY \`Skill(skill='work-on', ...)\` call returns, immediately check the issue's current workflow label:
\`\`\`bash
gh issue view ${FINDING_NUM} -R {GH_REPO} --json labels --jq '[.labels[].name | select(startswith(\"workflow:\"))]'
\`\`\`
**Terminal labels** (only these allow you to stop): \`workflow:merged\`, \`workflow:invalid\`
**Terminal condition also**: \`needs-human\` label present, \`workflow:awaiting-merge\` label present, OR issue state is \`closed\`
If the label is NOT terminal (e.g., \`workflow:investigating\`, \`workflow:ready-to-build\`, \`workflow:building\`, \`workflow:in-review\`), invoke \`Skill(skill='work-on', args='${FINDING_NUM} --under-orchestration')\` again immediately. The \`/work-on\` skill will re-read GitHub state and advance to the next phase. Do NOT output a summary, do NOT pause, do NOT ask for confirmation — just invoke it again.

**CRITICAL — SOURCE BRANCH DETECTION**:
- If the issue has the \`review-finding\` label, read the issue body for \`**Code branch**: \\\`{branch}\\\`\`
- If found, that is the SOURCE_BRANCH — the code ONLY exists on that branch (e.g., \`staging\`), NOT on \`origin/main\`
- Investigation MUST use \`git show origin/{SOURCE_BRANCH}:{filepath}\` to verify the code exists
- Worktree MUST branch from \`origin/{SOURCE_BRANCH}\`, NOT \`origin/main\`
- PR target is \`{SOURCE_BRANCH}\` (the fix goes back to where the code lives)

**LANE**: ${SWEEP_LANE[$FINDING_NUM]} (PR target: ${SWEEP_PR_BASE[$FINDING_NUM]})
**Issue title**: ${FINDING_TITLE}
${GIST_CONTEXT}
"
    )
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
  Idle-gated — still deferred: #{E} (batch still fully human-gated — waiting on a merge)
  Idle-gated — cleared: #{F} (a gating PR merged since deferral — no longer idle)
```

**After sweep agents complete** (or if no findings were dispatched): output the budget deferred-issues report (if applicable), then proceed to Phase 5.

**Anti-patterns — DO NOT DO THIS:**
- Re-sweeping findings spawned during the sweep itself — this creates unbounded recursion. Sweep is a single pass.
- Overriding generation >= 2 deferrals — the cascade cap is absolute.
- Skipping the sweep because "there are only a few" deferred findings — even one deferred finding represents unresolved work.
- Clearing an idle-gated deferral (forge#1814) without recomputing `BATCH_FULLY_GATED` fresh at sweep time — a stale "not gated" read would re-introduce the exact net-negative churn this policy exists to stop.

### Step 4F.5: Budget Deferred-Issues Report (conditional) <!-- Added: forge#1743 -->

**Run only when `BUDGET_LIMIT != "Infinity"` AND `${#DEFERRED_BUDGET_ISSUES[@]} > 0`.**

Deferred issues are issues that were not dispatched because their estimated cost would have pushed projected spend past the budget ceiling (after reserving ε for no-prior issues). They are **never silently dropped** — this report makes them visible and actionable.

```bash
if [ "$BUDGET_LIMIT" != "Infinity" ] && [ "${#DEFERRED_BUDGET_ISSUES[@]}" -gt 0 ]; then
  echo ""
  echo "## Budget Report"
  echo ""
  echo "**Budget limit**: \$${BUDGET_LIMIT}"
  echo "**Projected spend (dispatched issues)**: \$${PROJECTED_SPEND}"
  echo "**Actual spend (completed issues, best-effort)**: \$${ACTUAL_SPEND}"
  echo "**ε-reserve used**: ${EPSILON_DISPATCHED} (10% = \$${EPSILON_BUDGET})"
  echo ""
  echo "### Deferred Issues (budget exhausted — never silently dropped)"
  echo ""
  echo "| Issue | Title | Score | Est. Cost | Reason |"
  echo "|-------|-------|-------|-----------|--------|"
  for DNUM in "${DEFERRED_BUDGET_ISSUES[@]}"; do
    DTITLE=$(gh issue view "$DNUM" -R {GH_REPO} --json title --jq '.title' 2>/dev/null || echo "(unknown)")
    DSCORE="${ISSUE_SCORE[$DNUM]:-?}"
    DCOST="${ISSUE_COST_ESTIMATE[$DNUM]:-?}"
    echo "| #${DNUM} | ${DTITLE} | ${DSCORE} | \$${DCOST} | Budget ceiling reached |"
  done
  echo ""
  DEFERRED_LIST=$(IFS=' '; echo "${DEFERRED_BUDGET_ISSUES[*]}")
  echo "**Action**: Re-run \`/orchestrate ${DEFERRED_LIST} [--budget N]\` to process deferred issues, or increase \`--budget\`."
fi
```

---

