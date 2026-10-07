---
user-invocable: false
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Phase 4: Streaming DAG Execution

## Phase 4: Streaming DAG Execution

**Entry requires `phase-3-dependency.md`'s Step 3D.6 completion gate to have passed.** <!-- Added: forge#1913 --> Every step below (budget init, dispatch, dependency resolution) reads `ISSUES[]`, `PREDECESSORS[]`, `ISSUE_DOMAIN[]`, `ISSUE_SCORE[]`, `ISSUE_COST_ESTIMATE[]`, and `ISSUE_HAS_PRIOR[]` as authoritative Phase 3 output — none of these are re-derived here. If Phase 4 is being entered without having actually run Phase 3's Steps 3A–3E.5 in this session (e.g. a fresh session resuming mid-batch), reconstruct from GitHub via the "Orchestrator state reconstruction on wake / after compaction" procedure in `phase-3-dependency.md` rather than assuming these variables are already populated.

### Step 4A-pre.-1: Lease gate (MANDATORY, before any dispatch) <!-- Added: forge#2627 -->

**WHY THIS EXISTS**: Nothing today checks whether another live `/orchestrate` instance already holds this batch before dispatching (see issue #2627). Two concurrent loops (a stale survivor plus a restart, or two independent invocations) then both re-derive a ready set from GitHub and both dispatch — duplicate/backlog dispatch, and a restarted instance's own bookkeeping can diverge from what the first loop already did. This step closes that gap at the single entry point every dispatch group (initial ready set + every subsequent newly-unblocked batch) passes through, by extending the Step 3D.1 coordination issue into a single-instance lease (see `phase-3-dependency.md` Step 3D.2 for `check_orchestrator_lease()` and the `FORGE:LEASE`/`FORGE:LEASE_RELEASED` comment format).

**Run this once, before the first dispatch of any group in this session** — not per-chunk, per-issue, or per-newly-ready-batch.

```bash
# --- Lease gate (uses check_orchestrator_lease() from phase-3-dependency.md Step 3D.2;
#     re-declare it here if this context hasn't sourced that file) ---
if [ -n "${FORGE_COORD_ISSUE:-}" ] && [ -n "${COORD_ISSUE_NUMBER:-}" ] && [ -n "${BATCH_ID:-}" ]; then
  LEASE_STATE=$(check_orchestrator_lease "$COORD_ISSUE_NUMBER" "$BATCH_ID")
  case "$LEASE_STATE" in
    held:*)
      HELD_BY="${LEASE_STATE#held:}"
      echo "REFUSING TO DISPATCH: coordination issue #${COORD_ISSUE_NUMBER} shows an unexpired lease held by batch ${HELD_BY}, not this session's batch ${BATCH_ID}."
      echo "Another live /orchestrate instance appears to be dispatching this batch already. Stop this invocation, or wait for the other lease to go stale."
      exit 1
      ;;
    free|self)
      HOSTNAME_ID=$(hostname 2>/dev/null || uname -n 2>/dev/null || true); HOSTNAME_ID="${HOSTNAME_ID:-unknown-host}"
      # GOVERNOR-exempt: intentional coordination side-effect (best-effort lease/board/finding post), DRY_RUN-safe — reviewed & accepted for the check-command-side-effects gate. Flagged only by the staging->main full-diff; passes on every feature PR. forge#2627
      gh issue comment "$COORD_ISSUE_NUMBER" -R {GH_REPO} --body "<!-- FORGE:LEASE -->
**Holder Batch ID**: ${BATCH_ID}
**Holder**: ${HOSTNAME_ID} (pid ${$})
**Acquired/refreshed**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
**TTL**: ${LEASE_TTL_SECONDS:-900}s (refreshed once per dispatch chunk in Step 4A)" 2>/dev/null || \
        echo "WARNING: failed to post FORGE:LEASE — continuing without a lease record (best-effort primitive)"
      ;;
    *)
      # Defensive default (MANDATORY — do not remove): see the matching comment at
      # phase-3-dependency.md Step 3D.2's acquisition case block. An unexpected LEASE_STATE
      # here must warn loudly, not silently fall through and let dispatch proceed as if the
      # lease gate had passed.
      echo "WARNING: check_orchestrator_lease() returned unexpected value '${LEASE_STATE}' — lease gate could not be evaluated. Proceeding without a confirmed lease; investigate rather than ignore." >&2
      ;;
  esac
else
  echo "INFO: no coordination issue / BATCH_ID available — lease enforcement disabled for this batch."
fi
# --- End lease gate ---
```

**Lease release**: `LEASE_RELEASED_THIS_SESSION` (declared just below, alongside `release_orchestrator_lease()`) guards against double-posting `FORGE:LEASE_RELEASED`. The release call is invoked from both the **Step 4A-pre.-0.5 "Stopping the orchestrator"** procedure (interrupted path) and the **Termination condition** at the end of Step 4B (normal clean/paused drain) — both exit paths route through the same idempotent function so the lease is never left dangling either way.

```bash
LEASE_RELEASED_THIS_SESSION=false

release_orchestrator_lease() {
  # Idempotent — safe to call from both the interrupted-stop procedure and normal
  # end-of-batch completion without double-posting FORGE:LEASE_RELEASED.
  if [ "$LEASE_RELEASED_THIS_SESSION" = "true" ]; then
    return
  fi
  if [ -n "${FORGE_COORD_ISSUE:-}" ] && [ -n "${COORD_ISSUE_NUMBER:-}" ]; then
    # GOVERNOR-exempt: intentional coordination side-effect (best-effort lease/board/finding post), DRY_RUN-safe — reviewed & accepted for the check-command-side-effects gate. Flagged only by the staging->main full-diff; passes on every feature PR. forge#2627
    gh issue comment "$COORD_ISSUE_NUMBER" -R {GH_REPO} --body "<!-- FORGE:LEASE_RELEASED -->
**Holder Batch ID**: ${BATCH_ID:-unknown}
**Released**: $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null || true
  fi
  LEASE_RELEASED_THIS_SESSION=true
}
```

### Step 4A-pre.-0.5: Backgrounded engine-child tracking + interruption handling ("Stopping the orchestrator") (MANDATORY) <!-- Added: forge#2627 -->

**WHY THIS EXISTS**: Step 4A's engine-first dispatch (fixed by forge#2466) already dispatches each `forgedock run-issue` invocation as its own `Bash(run_in_background=true, ...)` call and records the returned task id in `ENGINE_DISPATCH_MAP[{NUM}]` — this is a harness-managed background task, not a raw shell `&` job. **Because it is harness-managed, it cannot be reaped by a shell-level `trap`/`kill $PID`**: a bash `trap` only runs inside that one Bash tool invocation's own process and has no way to call back into the harness's own task-management surface (`TaskStop`). Reaping these tasks on interrupt is therefore something the orchestrating agent itself must do — as an explicit step in its own routing loop — not something a background shell script can do on its own behalf.

**Contract — the orchestrating agent (not a shell trap) is responsible for reaping**: Whenever the interactive `/orchestrate` session is being stopped (the operator sends an interrupt, or the harness delivers a stop signal to the top-level orchestrator agent) **before** all dispatched issues have reached a terminal `workflow:*` label, the orchestrator MUST, as part of handling that stop — not silently exit —:

1. Enumerate every task id still tracked in `ENGINE_DISPATCH_MAP` whose issue has not yet reached a terminal `workflow:*` label (per Step 4B's `classify_predecessor_state()`).
2. Call `TaskStop(task_id)` (the harness tool) for each one, in the same turn, before ending the session.
3. Call `cleanup_trail_cache` (Step 4B) and `release_orchestrator_lease()` (Step 4A-pre.-1) so a future resume or a different operator is not blocked by a stale lease from this now-stopped session.
4. Report which issues had in-flight dispatch stopped mid-pipeline (their `workflow:*` label will reflect whatever phase they reached — a future `/work-on {NUMBER}` or orchestrator resume picks them back up from GitHub state, per the Universal Phase Dispatcher in `commands/work-on.md`).

**This is a documentation/behavioral contract, not a bash block**: unlike the lease gate above, there is no shell construct that reliably intercepts "the orchestrator's own session is being stopped" — that is a harness-level event the orchestrating agent must handle in its own turn when it observes an interrupt, using its own tools (`TaskStop`), exactly the way `commands/orchestrate/phase-5-cleanup.md` already documents cleanup as an agent-driven procedure rather than a background script.

**Known limitation — Windows Git Bash (documented, not silently overclaimed)**: Even a harness-issued `TaskStop` against the tracked background task is not guaranteed to terminate the underlying `forgedock run-issue` Win32 process tree on Windows Git Bash — MSYS-launched child processes are not always attached to the parent's job object in a way that a stop signal reliably cascades through. `TaskStop` is the correct in-spec, harness-native mitigation and closes the common case (an operator deliberately stopping a live, still-running orchestrator session). It does **not** guarantee full termination in every case — per the issue's own report, an operator may still need to fall back to a manual, command-line-matched kill as a belt-and-suspenders measure:

```powershell
# Windows fallback — only if a forgedock run-issue process is confirmed still running
# after TaskStop (e.g. `docker ps` / dispatch-state still show activity post-stop):
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'forgedock run-issue' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
}
```

Do not claim `TaskStop` eliminates every zombie-process scenario on Windows; it eliminates the scenario this issue's fix is scoped to (an operator or harness cleanly stopping a live orchestrator session that is still tracking its own dispatched tasks) — the PowerShell fallback above remains documented for the narrower case where the underlying process tree survives regardless.

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

### Step 4A-pre.0.2: Concurrency gate initialization (MANDATORY) <!-- Added: forge#1912 -->

**WHY THIS EXISTS** <!-- Added: forge#1912 -->: Phase 4's dispatch loops previously launched every DAG-ready issue in one shot — the engine-first bash loop backgrounded every `should_dispatch()`-passing issue with no count limit, and the Agent-spawn-fallback path was explicitly instructed to "launch all ready agents simultaneously." On a large ready set this saturates the Anthropic API rate limit in one burst, causing cascading failures across most of the batch. This is a distinct, count-denominated gate from the dollar-denominated `--budget` gate above (Step 4A-pre.0) — an issue can be deferred for budget reasons, concurrency reasons, or both; each gate accumulates its own deferred list independently.

`MAX_CONCURRENT` caps top-level `/work-on` dispatches, not the total number of harness subagents. A normal worker can spawn context, architect, implement, validate, quality-gate, and review children. Budget **8 total subagent spawns per worker** when choosing this value: `max_concurrent <= session_subagent_budget / 8`. This is a conservative planning multiplier, not a second runtime semaphore; the harness does not expose a reliable cross-agent spawn counter to this shell-level dispatcher.

Initialize the concurrency cap and its batch-scope tracking state before the first dispatch:

```bash
# --- Concurrency gate initialization ---
MAX_CONCURRENT=$(yq '.orchestration.max_concurrent // 12' forge.yaml 2>/dev/null || echo 12)

# Validate MAX_CONCURRENT is a bare positive integer before it is ever used in arithmetic
# expansion or array-slice-length position below. Bash's `$(( ))` and `${arr[@]:off:len}`
# both re-evaluate an unquoted variable's contents as an expression — an unvalidated value
# (e.g. a malicious or malformed forge.yaml, or a stray non-numeric string) can inject
# arbitrary command substitution into the arithmetic context, and 0/negative values make
# the chunked dispatch loop below (Step 4A) never advance its index, spinning forever.
# Same validation convention as BUDGET_LIMIT in Step 4A-pre.0 above. <!-- Added: forge#1912 -->
if [ "$MAX_CONCURRENT" = "null" ] || ! echo "$MAX_CONCURRENT" | grep -qP '^[1-9][0-9]*$'; then
  echo "WARNING: forge.yaml → orchestration.max_concurrent is not a positive integer (\"${MAX_CONCURRENT}\") — falling back to default 12"
  MAX_CONCURRENT=12
fi

ACTIVE_DISPATCH_COUNT=0             # in-flight dispatched-but-not-yet-completed agents, this batch
DEFERRED_CONCURRENCY_ISSUES=()      # ready issues held back because no headroom was available
SUBAGENT_SPAWN_BUDGET_PER_WORKER=8  # /work-on + build/review fan-out planning estimate
TOP_LEVEL_DISPATCH_TOTAL=0
PLANNED_SUBAGENT_SPAWNS=0
OBSERVED_SUBAGENT_SPAWNS="unavailable" # replace only with harness telemetry; never infer

echo "Concurrency gate initialized: MAX_CONCURRENT=${MAX_CONCURRENT}; plan for up to $((MAX_CONCURRENT * SUBAGENT_SPAWN_BUDGET_PER_WORKER)) subagent spawns in flight (8 per worker)"
# --- End concurrency gate initialization ---
```

**Headroom helper** (used by every dispatch site below — Step 4A's engine-first loop, Step 4A's Agent-spawn-fallback path, and Step 4B's newly-ready dispatch):

```bash
dispatch_headroom() {
  local HEADROOM=$((MAX_CONCURRENT - ACTIVE_DISPATCH_COUNT))
  [ "$HEADROOM" -lt 0 ] && HEADROOM=0
  echo "$HEADROOM"
}
```

**This is a hard cap, not a suggestion.** No dispatch site in Phase 4 may background/spawn more than `dispatch_headroom` new agents without first waiting for in-flight agents to complete. Issues that cannot be dispatched due to the cap go into `DEFERRED_CONCURRENCY_ISSUES[]` and are released — in the order they were deferred — as running agents complete (Step 4B), the same event-driven model (no sleep/poll loops) the file already uses for DAG-readiness and budget gating.

**Dispatch accounting**: Immediately after each successful top-level dispatch, increment `TOP_LEVEL_DISPATCH_TOTAL` and add `SUBAGENT_SPAWN_BUDGET_PER_WORKER` to `PLANNED_SUBAGENT_SPAWNS`. When the runtime reports child-spawn telemetry, replace `OBSERVED_SUBAGENT_SPAWNS` with that measured total; otherwise leave it `unavailable` rather than fabricating a measured value.

### Step 4A-pre.0.3: Secondary content-creation backpressure (MANDATORY)

GitHub's `resources.core` quota does not report secondary content-creation throttles. Treat any GitHub API response with HTTP `403` whose body contains `secondary rate limit` as a batch-wide backpressure signal.

```bash
# Call from every dispatcher-owned gh write/create wrapper and from a child completion
# report that includes its final GitHub API error. Do not retry the failed request here.
SECONDARY_RATE_LIMITED=false
SECONDARY_RATE_LIMIT_MESSAGE=""

record_secondary_rate_limit() {
  local STATUS="$1"
  local BODY="$2"
  if [ "$STATUS" = "403" ] && echo "$BODY" | grep -qi 'secondary rate limit'; then
    SECONDARY_RATE_LIMITED=true
    SECONDARY_RATE_LIMIT_MESSAGE="$BODY"
    echo "SECONDARY RATE LIMIT: pausing all new dispatch. Do not retry GitHub content creation until an operator resumes the batch." >&2
  fi
}
```

Before every dispatch site computes headroom or launches a worker, check `SECONDARY_RATE_LIMITED`. When true, preserve the ready/deferred queues, launch no more workers, and end the active dispatch cycle. Do not poll or retry GitHub calls to discover recovery: an operator resumes the batch after the throttle clears. In-flight agents receive this contract in the dispatch prompt: on a secondary-limit 403, they must stop their GitHub write/create retry loop, report the response to the orchestrator, and exit their current phase without creating replacement work.

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
# Resolve the helper once and reuse it for the initial dispatch and all finding
# classification loops. Claude keeps its installed path as the default, while
# OpenCode and Codex can use ForgeDock's repository-local scripts.
resolve_classify_lane() {
  local candidates=()
  if [ "${FORGE_RUNTIME:-}" = "opencode" ] ||
     [ -n "${OPENCODE_SESSION_ID:-}" ] ||
     [ -n "${OPENCODE_PID:-}" ] ||
     [ -n "${OPENCODE:-}" ]; then
    case '${CLAUDE_PLUGIN_ROOT}' in /*) candidates+=('${CLAUDE_PLUGIN_ROOT}/scripts/classify-lane.sh') ;; esac  # running plugin first
    [ -n "${FORGE_HOME:-}" ] && candidates+=("$FORGE_HOME/scripts/classify-lane.sh")
    [ -n "${REPO_PATH:-}" ] && candidates+=("$REPO_PATH/scripts/classify-lane.sh")
    candidates+=("$HOME/.opencode/scripts/classify-lane.sh")
  else
    case '${CLAUDE_PLUGIN_ROOT}' in /*) candidates+=('${CLAUDE_PLUGIN_ROOT}/scripts/classify-lane.sh') ;; esac  # running plugin first
    [ -n "${FORGE_HOME:-}" ] && candidates+=("$FORGE_HOME/scripts/classify-lane.sh")
    candidates+=("$HOME/.claude/scripts/classify-lane.sh")
    [ -n "${REPO_PATH:-}" ] && candidates+=("$REPO_PATH/scripts/classify-lane.sh")
  fi

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "ERROR: classify-lane.sh is not installed in any configured runtime path." >&2
  return 1
}

CLASSIFY_LANE_SCRIPT=$(resolve_classify_lane) || {
  echo "ERROR: cannot classify lanes without classify-lane.sh" >&2
  exit 1
}

declare -A ISSUE_LANE
declare -A ISSUE_PR_BASE

# Batch-start T0 (forge#2628) — reuse the value phase-1-resolve.md captured at the very
# start of Phase 1 and persisted per "Predicate Persistence." Step 4C's run-spawned cascade
# time filter (Method 2 below) anchors to this, NOT to a rolling "N hours ago" window — a
# rolling window can still admit pre-existing backlog issues that happen to have been
# created recently for unrelated reasons. Degraded fallback only: if BATCH_T0 is not in
# context (e.g. a session resumed mid-run after compaction and Phase 1's capture was lost),
# capture one here — this is later than true batch start and will admit a narrower window
# than the real run, never wider, so it fails safe.
if [ -z "${BATCH_T0:-}" ]; then
  echo "WARNING: BATCH_T0 not found in context — Phase 1 should have captured it. Falling back to capturing it now (narrower window than the true batch start, but never wider)."
  BATCH_T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fi
echo "Step 4A.pre: using BATCH_T0=${BATCH_T0} for Step 4C's run-spawned cascade time filter"

# Batch-level accumulators for review-finding cascade control (Step 4C) and
# Completion Sweep (Step 4F). Declared here so they persist across ALL agent
# completions — Step 4C runs per-agent and must NOT re-initialize these.
DEFERRED_FINDINGS=()
QUEUED_FINDINGS=()
declare -A DEFERRED_REASONS
# Count every finding regardless of admission, so a deferred refinement never
# makes the reported amplification ratio look better than it was.
FINDINGS_SPAWNED=0
MERGED_UNITS=0
UNIT_MERGED_THIS_CYCLE=false   # set per completed unit by the Step 4C accounting block (forge#3060)
AMPLIFICATION_RATIO_HISTORY=()
AMPLIFICATION_DEFERRED=()
AMPLIFICATION_BREAKER_DEFERRED=()   # findings paused by the on-by-default breaker (forge#3060)
BREAKER_DEFER_TAG="amplification breaker"   # single source for the defer-reason text matched in Step 4F
declare -A FINDINGS_BY_SOURCE_PR
declare -A REFINEMENT_FINDINGS
declare -A NEW_SURFACE_FINDINGS
declare -A AMPLIFICATION_FINDING_SEEN
declare -A AGENT_ISSUE_MAP
# Engine-first dispatch equivalent of AGENT_ISSUE_MAP (fixed forge#2466): keyed by issue
# number, holds the task id returned by each backgrounded `Bash(run_in_background=true,
# command="forgedock run-issue ...")` call from Step 4A's engine-first path. Step 4B reads
# this map to identify which issue a background-Bash completion notification belongs to,
# the same role AGENT_ISSUE_MAP plays for Agent-tool `agent_completed` notifications.
declare -A ENGINE_DISPATCH_MAP
# OpenCode native task equivalent of ENGINE_DISPATCH_MAP. Keys are issue numbers;
# values are the session ids returned by task(background=true). This is a live
# cache only; every entry must also be persisted as a FORGE:DISPATCH comment.
declare -A OPENCODE_DISPATCH_MAP

# Reconstruct the live map after compaction/restart from the durable dispatch
# records. The issue association is the map key; only the latest running record
# is restored, because a later completed/error record has already released it.
for NUM in "${ISSUES[@]}"; do
  DISPATCH_BODY=$(gh api repos/{GH_REPO}/issues/"$NUM"/comments \
    --jq '[.[] | select(.body | contains("FORGE:DISPATCH")) | .body] | last // ""' 2>/dev/null || true)
  TASK_ID=$(printf '%s' "$DISPATCH_BODY" | jq -Rr 'try capture("\\\"runtime\\\":\\\"opencode\\\",\\\"child_session_id\\\":\\\"(?<id>[^\\\"]+)\\\".*\\\"state\\\":\\\"running\\\"").id catch ""')
  if [ -n "$TASK_ID" ]; then
    OPENCODE_DISPATCH_MAP["$NUM"]="$TASK_ID"
  fi
done

# Full-repository intake is intentionally separate from Step 4C's T0-scoped
# review-finding cascade. It is enabled only for an operator-authorised
# policy: all run; records every open issue already observed so CI-created
# actionable work is admitted once rather than rediscovered every cycle.
declare -A SEEN_OPEN_ISSUES
FULL_REPO_SWEEP_COUNT=0

# Same-file current-state brief forwarding (forge#1860). Populated by the core streaming
# dispatch loop below (Step 4B) whenever a Layer 1/2/3 structural predecessor edge (see
# EDGE_KIND/EDGE_FILES from phase-3-dependency.md Step 3C) resolves; consumed by Step 4A's
# {GIST_CONTEXT} generation. EDGE_BRIEFED guards against re-appending the same predecessor's
# brief on every completion cycle this loop re-runs before BLOCKED_NUM actually dispatches.
declare -A SAME_FILE_BRIEF
declare -A EDGE_BRIEFED

# DONE-path edge re-verification memo (forge#2848). A conclusive re-derivation is
# memoized in EDGE_REDERIVED; inconclusive results get one retry, capped by
# EDGE_REDERIVE_ATTEMPTS. This avoids caching a transient failure while bounding
# extraction to two attempts per descendant per batch.
declare -A EDGE_REDERIVED
declare -A EDGE_REDERIVE_ATTEMPTS

# Affected-file extraction helper, resolved for the DONE-path cohort re-derivation
# (forge#2848). Same resolver precedence as phase-3-dependency.md Step 3C Layer 1 —
# ForgeDock's runtime installation before the target repository — because the
# orchestrator runs inside the project being worked on, where a bare
# `bash scripts/extract-affected-files.sh` silently fails when that project has not
# copied ForgeDock's helper scripts into its own repository (#2794/#2791).
resolve_extract_affected_files() {
  local candidates=()
  case '${CLAUDE_PLUGIN_ROOT}' in /*) candidates+=('${CLAUDE_PLUGIN_ROOT}/scripts/extract-affected-files.sh') ;; esac  # running plugin first
  [ -n "${FORGE_HOME:-}" ] && candidates+=("$FORGE_HOME/scripts/extract-affected-files.sh")
  [ -n "${REPO_PATH:-}" ] && candidates+=("$REPO_PATH/scripts/extract-affected-files.sh")
  candidates+=("$PWD/scripts/extract-affected-files.sh")

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "ERROR: extract-affected-files.sh is not installed in any configured runtime path." >&2
  return 1
}

# Non-fatal here, unlike Phase 3's hard exit: Phase 3 cannot build a DAG at all without
# this helper, whereas Phase 4 only needs it for the OPTIONAL re-derivation optimization.
# If it is missing, re-derivation is skipped and edges stay as planned — the conservative
# direction, and identical to this file's pre-forge#2848 behavior.
AFFECTED_FILES_SCRIPT=$(resolve_extract_affected_files) || AFFECTED_FILES_SCRIPT=""

# Human-gated idle/backpressure flag (Step 4B item 6.7, forge#1814). Starts false —
# recomputed every completion cycle over {all_batch_issue_numbers}. Declared at batch
# scope (not per-agent) so Step 4C can read the latest value on every iteration.
BATCH_FULLY_GATED=false

# Per-batch token budget for Step 4C's review-finding cascade control (forge#1858).
# Distinct from the $-denominated `--budget N` flag (economic scheduling, forge#1743,
# Step 4A-pre.0 above) — that mechanism is opt-in and gates the *original* issue
# dispatch order; this ceiling is always-on, token-denominated, and scopes ONLY to
# Step 4C's cascade dispatch of review-finding issues. Declared once here (batch scope,
# not per-agent) so BATCH_TOKEN_SPEND accumulates correctly across every Step 4C run
# this session performs.

# --- Cascade admission policy resolution (forge#2234) ---
# `orchestration.cascade` gives the admission rules below (rules 0/3/4/5) an
# independently-settable config surface, on top of a named preset. Absent
# section => `balanced`, which reproduces today's hardcoded behavior exactly
# (no-op for existing configs). See `bin/engine/admission.mjs` for the typed,
# unit-tested reference implementation of this same preset table.
CASCADE_POLICY_NAME=$(yq '.orchestration.cascade.policy // "balanced"' forge.yaml 2>/dev/null || echo "balanced")
[ "$CASCADE_POLICY_NAME" = "null" ] && CASCADE_POLICY_NAME="balanced"

case "$CASCADE_POLICY_NAME" in
  all)
    PRESET_MAX_GEN="unlimited"; PRESET_BATCH_MAX_GEN=2; PRESET_TOKEN_BUDGET="unlimited"; PRESET_DEFER_GATED="false"; PRESET_KEYWORD="false"; PRESET_P3_SAME_FILE="false" ;;
  conservative)
    PRESET_MAX_GEN=1; PRESET_BATCH_MAX_GEN=2; PRESET_TOKEN_BUDGET=450000; PRESET_DEFER_GATED="true"; PRESET_KEYWORD="true"; PRESET_P3_SAME_FILE="true" ;;
  balanced)
    PRESET_MAX_GEN=1; PRESET_BATCH_MAX_GEN=2; PRESET_TOKEN_BUDGET=900000; PRESET_DEFER_GATED="true"; PRESET_KEYWORD="true"; PRESET_P3_SAME_FILE="true" ;;
  *)
    echo "WARNING: forge.yaml → orchestration.cascade.policy \"${CASCADE_POLICY_NAME}\" is not one of: all, balanced, conservative — falling back to \"balanced\""
    CASCADE_POLICY_NAME="balanced"
    PRESET_MAX_GEN=1; PRESET_BATCH_MAX_GEN=2; PRESET_TOKEN_BUDGET=900000; PRESET_DEFER_GATED="true"; PRESET_KEYWORD="true"; PRESET_P3_SAME_FILE="true" ;;
esac

# max_generation is authoritatively resolved in phase-1-resolve.md (it only governs
# Phase 1 resolve-time cascade admission, never Step 4C's autonomous defer — see rule 1
# above). It is re-read here, read-only, ONLY to support the both-uncapped notice below —
# Step 4C does not otherwise consume MAX_GENERATION_FOR_NOTICE.
MAX_GENERATION_FOR_NOTICE=$(yq ".orchestration.cascade.max_generation // \"${PRESET_MAX_GEN}\"" forge.yaml 2>/dev/null || echo "$PRESET_MAX_GEN")
[ "$MAX_GENERATION_FOR_NOTICE" = "null" ] && MAX_GENERATION_FOR_NOTICE="$PRESET_MAX_GEN"
if [ "$MAX_GENERATION_FOR_NOTICE" != "unlimited" ] && ! echo "$MAX_GENERATION_FOR_NOTICE" | grep -qE '^[1-9][0-9]*$'; then
  MAX_GENERATION_FOR_NOTICE="$PRESET_MAX_GEN"
fi

# P3 batching is a distinct, bounded aggregation exception to autonomous cascade
# admission. Unlike max_generation, it must always be finite, including policy: all.
BATCH_MAX_GENERATION=$(yq ".orchestration.cascade.batch_max_generation // ${PRESET_BATCH_MAX_GEN}" forge.yaml 2>/dev/null || echo "$PRESET_BATCH_MAX_GEN")
if ! echo "$BATCH_MAX_GENERATION" | grep -qE '^[1-9][0-9]*$'; then
  echo "WARNING: forge.yaml → orchestration.cascade.batch_max_generation is not a positive integer (\"${BATCH_MAX_GENERATION}\") — falling back to default ${PRESET_BATCH_MAX_GEN}"
  BATCH_MAX_GENERATION="$PRESET_BATCH_MAX_GEN"
fi

# token_budget precedence: orchestration.cascade.token_budget (new home) >
# pipeline.token_budget_per_batch (deprecated alias, forge#1858, kept working
# unchanged) > the resolved preset default. Accepts the "unlimited" sentinel —
# unlike a bare `// 900000` yq default, an explicit "unlimited" string must
# NOT be coerced back to the numeric default (see forge#2234 "Known Pitfalls":
# threading the sentinel through before wiring the levers, not after).
LEGACY_TOKEN_BUDGET=$(yq '.pipeline.token_budget_per_batch // ""' forge.yaml 2>/dev/null || echo "")
[ "$LEGACY_TOKEN_BUDGET" = "null" ] && LEGACY_TOKEN_BUDGET=""
TOKEN_BUDGET_FALLBACK="${LEGACY_TOKEN_BUDGET:-$PRESET_TOKEN_BUDGET}"
TOKEN_BUDGET=$(yq ".orchestration.cascade.token_budget // \"${TOKEN_BUDGET_FALLBACK}\"" forge.yaml 2>/dev/null || echo "$TOKEN_BUDGET_FALLBACK")
[ "$TOKEN_BUDGET" = "null" ] && TOKEN_BUDGET="$TOKEN_BUDGET_FALLBACK"
if [ "$TOKEN_BUDGET" != "unlimited" ] && ! echo "$TOKEN_BUDGET" | grep -qE '^[1-9][0-9]*$'; then
  echo "WARNING: forge.yaml → orchestration.cascade.token_budget is not a positive integer or \"unlimited\" (\"${TOKEN_BUDGET}\") — falling back to default ${PRESET_TOKEN_BUDGET}"
  TOKEN_BUDGET="$PRESET_TOKEN_BUDGET"
fi

TOKEN_ESTIMATE_PER_FINDING=$(yq '.pipeline.token_estimate_per_finding // 150000' forge.yaml 2>/dev/null || echo 150000)

# Amplification is observational by default for the same-lineage ceiling (the breaker below is not). The optional ceiling is evaluated
# only against same-lineage refinements in Step 4C, never against new surface.
CASCADE_MAX_AMPLIFICATION=$(yq '.orchestration.cascade.max_amplification // "off"' forge.yaml 2>/dev/null || echo "off")
if [ "$CASCADE_MAX_AMPLIFICATION" != "off" ]; then
  if ! echo "$CASCADE_MAX_AMPLIFICATION" | grep -qE '^[0-9]+(\.[0-9]+)?$' || \
     ! awk "BEGIN { exit !($CASCADE_MAX_AMPLIFICATION > 0) }"; then
    echo "WARNING: forge.yaml → orchestration.cascade.max_amplification must be a positive number or off — disabling the bound"
    CASCADE_MAX_AMPLIFICATION="off"
  fi
fi
CONVERGENCE_WINDOW=$(yq '.orchestration.cascade.convergence_window // 3' forge.yaml 2>/dev/null || echo 3)
if ! echo "$CONVERGENCE_WINDOW" | grep -qE '^[1-9][0-9]*$'; then
  echo "WARNING: forge.yaml → orchestration.cascade.convergence_window must be a positive integer — falling back to 3"
  CONVERGENCE_WINDOW=3
fi
# On-by-default amplification circuit breaker (forge#3060). Unlike max_amplification (opt-in,
# same-lineage refinements only), this counts ALL cascade findings and pauses P3-and-below
# admission when the ratio stays >= 1.0 for CONVERGENCE_WINDOW merged units. P1/P2 are never
# affected. It is independent of orchestration.cascade.policy, so `policy: all` and the
# --max-generation/--token-budget unlimited CLI overrides do NOT disable it. Opt out only
# with an explicit `orchestration.cascade.amplification_breaker: off`.
# NOTE: do NOT use yq's `// "on"` here — the alternative operator treats boolean `false` as falsy and
# would turn `amplification_breaker: false` into "on". Read the raw value and default null/empty to "on".
AMPLIFICATION_BREAKER=$(yq '.orchestration.cascade.amplification_breaker' forge.yaml 2>/dev/null || echo "on")
case "$AMPLIFICATION_BREAKER" in ""|null) AMPLIFICATION_BREAKER="on" ;; esac
case "$(echo "$AMPLIFICATION_BREAKER" | tr '[:upper:]' '[:lower:]')" in
  on|true) AMPLIFICATION_BREAKER="on" ;;
  off|false) AMPLIFICATION_BREAKER="off" ;;
  *) echo "WARNING: forge.yaml → orchestration.cascade.amplification_breaker must be on or off (\"${AMPLIFICATION_BREAKER}\") — keeping the breaker on"; AMPLIFICATION_BREAKER="on" ;;
esac
AMPLIFICATION_BREAKER_TRIPPED=false
echo "Cascade amplification: max_amplification=${CASCADE_MAX_AMPLIFICATION} convergence_window=${CONVERGENCE_WINDOW} amplification_breaker=${AMPLIFICATION_BREAKER} (breaker is on by default; max_amplification off preserves same-lineage behavior)"

# Independent boolean levers — each accepts an explicit granular override on
# top of the resolved preset (preset supplies the default, not a hard value).
CASCADE_DEFER_ON_BATCH_GATED=$(yq ".orchestration.cascade.defer_on_batch_gated // ${PRESET_DEFER_GATED}" forge.yaml 2>/dev/null || echo "$PRESET_DEFER_GATED")
CASCADE_KEYWORD_HEURISTIC=$(yq ".orchestration.cascade.keyword_heuristic // ${PRESET_KEYWORD}" forge.yaml 2>/dev/null || echo "$PRESET_KEYWORD")
CASCADE_P3_SAME_FILE_DEFER=$(yq ".orchestration.cascade.p3_same_file_defer // ${PRESET_P3_SAME_FILE}" forge.yaml 2>/dev/null || echo "$PRESET_P3_SAME_FILE")

echo "Cascade admission policy resolved: policy=${CASCADE_POLICY_NAME} token_budget=${TOKEN_BUDGET} batch_max_generation=${BATCH_MAX_GENERATION} defer_on_batch_gated=${CASCADE_DEFER_ON_BATCH_GATED} keyword_heuristic=${CASCADE_KEYWORD_HEURISTIC} p3_same_file_defer=${CASCADE_P3_SAME_FILE_DEFER} (forge.yaml → orchestration.cascade; see docs/CONFIG.md)"

# Both-uncapped notice (loud, one-time, printed once per orchestrate invocation since
# this resolution block itself runs once at Step 4A.pre) — never a preset default except
# "all", which sets it deliberately. Surfacing this explicitly means an operator running
# an uncapped policy sees the tradeoff up front rather than discovering it from an
# unexpectedly long cascade tail (the exact gen-2→3→4 drift this config surface exists to
# make controllable — see forge#2234 issue body evidence).
if [ "$MAX_GENERATION_FOR_NOTICE" = "unlimited" ] && [ "$TOKEN_BUDGET" = "unlimited" ]; then
  echo "⚠ WARNING: orchestration.cascade — both max_generation and token_budget are unlimited. Cascade admission has NO upper bound on generation depth or token spend this run (policy=${CASCADE_POLICY_NAME})."
fi
# --- End cascade admission policy resolution ---

BATCH_TOKEN_SPEND=0
TOKEN_DEFERRED=()   # findings deferred by the token-budget rule this run (re-evaluable in Step 4F.2.6)

# Surface-area batching accumulators (forge#1818), promoted to batch scope here so the
# Step 6B report (forge#1858) sees the full-run total instead of only the last Step 4C
# completion cycle to touch them. SURFACE_FILE_MEMBERS (the per-cycle file->members grouping
# map used inside Step 4C) is rebuilt from the current QUEUED_FINDINGS every cycle and must
# carry no cross-cycle state of its own — but `declare -A` alone does NOT guarantee this: on
# an already-declared associative array it is a no-op on existing contents. Step 4C enforces
# the freshness guarantee explicitly via `unset SURFACE_FILE_MEMBERS` immediately before its
# `declare -A SURFACE_FILE_MEMBERS` each cycle (see below) — do not rely on re-declaration
# alone. <!-- Added: forge#1909 -->
SURFACE_BATCHED_FINDINGS=()   # all member issue numbers absorbed into a batch across the run
SURFACE_BATCH_COUNT=0         # count of batch issues created across the run
BATCHABLE_DEFERRED_P3=()      # gen-2+ P3s eligible only for bounded P3 aggregation (forge#2849)
declare -A FINDING_GENERATIONS

for NUM in {ready_issue_numbers}; do
  PR_BASE=$(bash "$CLASSIFY_LANE_SCRIPT" "$NUM" -R {GH_REPO}) || {
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

### Step 4A.0: Probe Knowledge Gist capability once

Probe the authenticated identity once for this orchestration run before any engine, Agent, or
OpenCode worker is dispatched. A GitHub App installation token cannot use the Gists API (and cannot even read `/user`); cache
that fact rather than letting every worker rediscover it by attempting a write. The probe fails
closed: Gists stay enabled only when `/user` positively reports a `User` account.

```bash
if [ -z "${FORGE_GIST_CAPABLE+x}" ]; then
  # Fail closed: only a positively identified user account can use the Gists API. A GitHub App
  # installation token cannot read /user at all (HTTP 403, empty type), so "not Bot" is NOT
  # evidence of capability; an unavailable probe disables Gists rather than letting every
  # worker fail on its first Gist write.
  GIST_AUTH_TYPE=$(gh api user --jq '.type' 2>/dev/null || true)
  if [ "$GIST_AUTH_TYPE" = "User" ]; then
    FORGE_GIST_CAPABLE=true
  else
    FORGE_GIST_CAPABLE=false
  fi
  export FORGE_GIST_CAPABLE
fi

if [ "$FORGE_GIST_CAPABLE" = "true" ]; then
  echo "Knowledge Gist capability available"
else
  echo "INFO: Knowledge Gist subsystem unavailable for this authentication; workers will skip it"
fi
```

Carry `FORGE_GIST_CAPABLE` unchanged through every dispatch path. Do not probe it in individual
workers dispatched by this run. Phase 6 reports a false value once at batch level.

**Claims-board dispatch gate (MANDATORY, before every individual dispatch)** <!-- Added: forge#2844 -->: The coordination issue is the durable authority for file ownership. Do not use `EDGE_FILES`, `ISSUE_FILES`, or a remembered prior read as evidence that a claim is free. Immediately before dispatching each issue, re-read the full claims board and refuse that dispatch when the issue's declared file set intersects a live claim held by another issue. This applies equally to engine, Claude Agent, and OpenCode task dispatches, including newly-ready issues and wake reconstruction.

```bash
# Returns unreleased claims as [{holder: "123", files: "..."}]. A release is a separate,
# later comment, so it must be paired with its claim by holder rather than searched for in the
# claim comment itself. Terminal holder states also self-heal claims left behind by dead agents.
read_active_claims() {
  local COORD_NUM="$1"
  local CLAIMS HOLDER TERMINAL
  CLAIMS=$(gh api --paginate --slurp "repos/{GH_REPO}/issues/${COORD_NUM}/comments" 2>/dev/null \
    | jq -c '
        flatten as $comments |
        [$comments[]
         | select(.body | contains("<!-- FORGE:CLAIM -->"))
         | . as $claim
         | ($claim.body | capture("\\*\\*Holder\\*\\*: #(?<holder>[0-9]+)").holder) as $holder
         | select([$comments[]
                   | select(.body | contains("<!-- FORGE:CLAIM_RELEASED -->"))
                   | select((.body | capture("\\*\\*Holder\\*\\*: #(?<holder>[0-9]+)").holder) == $holder)
                   | select(.created_at > $claim.created_at)] | length == 0)
         | {holder: $holder,
            files: ($claim.body | capture("\\*\\*Files\\*\\*: (?<files>[\\s\\S]*?)(?:\\n\\*\\*Interfaces\\*\\*:|$)").files)}]') || return 1

  for HOLDER in $(echo "$CLAIMS" | jq -r '.[].holder'); do
    TERMINAL=$(gh issue view "$HOLDER" -R {GH_REPO} --json labels --jq \
      '[.labels[].name | select(. == "workflow:merged" or . == "workflow:invalid" or . == "workflow:awaiting-merge" or . == "needs-human")] | length > 0' 2>/dev/null)
    [ "$TERMINAL" = "true" ] && CLAIMS=$(echo "$CLAIMS" | jq --arg holder "$HOLDER" '[.[] | select(.holder != $holder)]')
  done
  echo "$CLAIMS"
}

claim_conflicts_with_live_holder() {
  local NUM="$1" TARGET_FILES CLAIM HOLDER CLAIM_FILES OVERLAP
  TARGET_FILES=$(printf '%s\n' "${ISSUE_FILES[$NUM]:-}" | sed -E '/^[[:space:]]*$/d; s/^[[:space:]]*[-*][[:space:]]*//; s/`//g' | sort -u)
  [ -z "$TARGET_FILES" ] && return 1  # No declared paths: normal conservative DAG rules still apply.

  ACTIVE_CLAIMS=$(read_active_claims "$COORD_ISSUE_NUMBER") || {
    echo "REFUSING TO DISPATCH #${NUM}: could not read the durable claims board." >&2
    return 0
  }
  while IFS= read -r CLAIM; do
    HOLDER=$(echo "$CLAIM" | jq -r '.holder')
    [ "$HOLDER" = "$NUM" ] && continue
    CLAIM_FILES=$(echo "$CLAIM" | jq -r '.files' | sed -E '/^[[:space:]]*$/d; s/^[[:space:]]*[-*][[:space:]]*//; s/`//g' | sort -u)
    OVERLAP=$(comm -12 <(printf '%s\n' "$TARGET_FILES") <(printf '%s\n' "$CLAIM_FILES"))
    if [ -n "$OVERLAP" ]; then
      echo "DEFERRING #${NUM}: declared files overlap live claim held by #${HOLDER}: ${OVERLAP//$'\n'/, }"
      return 0
    fi
  done < <(echo "$ACTIVE_CLAIMS" | jq -c '.[]')
  return 1
}

# Run this immediately before each engine Bash, Agent(), or OpenCode task call. Do not batch the
# board read: another worker can claim a file between two dispatches in the same ready set.
if [ -n "${FORGE_COORD_ISSUE:-}" ] && [ -n "${COORD_ISSUE_NUMBER:-}" ]; then
  if claim_conflicts_with_live_holder "$NUM"; then
    DEFERRED_CLAIM_ISSUES+=("$NUM")
    continue
  fi
fi
```

**Recovery-claim dispatch gate (MANDATORY, before every individual dispatch)** <!-- Added: forge#3172 -->: a `/recover-orphans` sweep that is resuming an issue inline holds an issue-scoped `<!-- FORGE:RECOVERY_CLAIM -->` comment. Dispatching a worker underneath a live claim double-runs the issue. This gate is independent of the claims board above (it applies even when `FORGE_COORD_ISSUE` is unset) and uses the shared predicate `scripts/recovery-claim-live.sh` (unreleased claim, within `RECOVERY_CLAIM_TTL_MIN`, no `FORGE:RECOVERY_CLAIM_RELEASED` for its sweep id). It fails closed: `CLAIM: LIVE` and `CLAIM: ERROR` (exit 1 or 2, or an unresolvable script) both defer. A deferral writes nothing to GitHub (no `needs-human`, no label), the claim being transient. The issue goes into `DEFERRED_CONCURRENCY_ISSUES[]`, so it re-enters the candidate set on the next dispatch computation and is never dropped; report each deferral as `RECOVERY CLAIM DEFER` in the status update. Shell state does not persist between Bash calls, so the canonical `FORGE_ROOT` bootstrap is repeated in the block; if it resolves empty, every issue defers.

```bash
# FORGE_ROOT bootstrap (canonical; keep byte-identical across specs, guarded by scripts/forge-root.test.sh)
FORGE_ROOT=""
if [ -n "${FORGEDOCK_HOME:-}" ]; then case "$FORGEDOCK_HOME" in /*) FORGE_ROOT="$FORGEDOCK_HOME" ;; esac; else
  # Portable to bash 3.2 (macOS), BSD/GNU coreutils and zsh: no mapfile, no sort -V, no bare globs (zsh aborts on no match).
  _l="$HOME/.claude/commands/work-on.md"; _l="$(readlink -f "$_l" 2>/dev/null || readlink "$_l" 2>/dev/null)"; [ -n "$_l" ] && _l="$(dirname "$(dirname "$_l")")"
  # newest cached version first: numeric major.minor.patch of the version dir name only; a release outranks its pre-release (1.10.0 > 1.9.0 > 1.9.0-rc1)
  _v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ '$(NF-1)=="forgedock"{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$0}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5-)"
  _m="$(find -L "$HOME/.claude/plugins/marketplaces" -mindepth 1 -maxdepth 1 -type d -iname '*forgedock*' 2>/dev/null)"
  # '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
  _k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_v" "$_m")"
  while IFS= read -r _c; do
    case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
  done <<< "$_k"
fi
recovery_claim_blocks() {
  local NUM="$1" OUT RC
  if [ -z "${FORGE_ROOT:-}" ] || [ ! -f "$FORGE_ROOT/scripts/recovery-claim-live.sh" ]; then
    echo "RECOVERY CLAIM DEFER: #${NUM} (recovery-claim-live.sh unresolved — failing closed)" >&2
    return 0
  fi
  OUT=$(bash "$FORGE_ROOT/scripts/recovery-claim-live.sh" "$NUM" -R {GH_REPO}); RC=$?
  [ "$RC" -eq 0 ] && return 1
  echo "RECOVERY CLAIM DEFER: #${NUM} (${OUT}) — retried on the next dispatch computation"
  return 0
}

# Same sites as claim_conflicts_with_live_holder: engine-first loop, Agent/task launch, Step 4B newly-ready (via Step 4A).
if recovery_claim_blocks "$NUM"; then
  DEFERRED_CONCURRENCY_ISSUES+=("$NUM")
  continue
fi
```

**Engine-first dispatch (default)**: When `forgedock` is in PATH, dispatch each ready issue via the durable engine rather than spawning prose Agent sub-agents. The engine's phase table enforces gate semantics in code — its fail-closed review gate and deterministic phase ordering are not subject to LLM interpretation.

**OpenCode dispatch (runtime-neutral adapter)**: When `FORGE_RUNTIME=opencode` or
an OpenCode runtime marker is present, do not invoke the engine's Claude-backed
runner and do not use the Claude `Agent(...)` fallback. Dispatch each ready
issue through OpenCode's native `task` tool, loading the nested
`commands/work-on.md` pipeline. Use GitHub labels and `FORGE:*` comments as the
resume state. After each task continuation, re-read the issue workflow label
and continue until it reaches
`workflow:merged`, `workflow:invalid`, `needs-human`, or
`workflow:awaiting-merge`.

The native call is asynchronous and must be issued once per issue in
`DISPATCH_NOW`, in the same assistant message where the batch is dispatched:

```
task(
  description="Work on {PROJECT_PREFIX}#{NUMBER}",
  subagent_type="general",
  background=true,
  prompt="Use the same Phase 4A work-on template below. Before invoking it, run `export FORGE_GIST_CAPABLE={FORGE_GIST_CAPABLE}` so the cached orchestration capability is preserved. Invoke Skill(skill='{FORGE_SKILL_PREFIX}work-on', args='{PROJECT_PREFIX}{NUMBER} --under-orchestration') and continue until a terminal workflow state."
)
```

Capture the returned `<task id="..." state="running">` id in
`OPENCODE_DISPATCH_MAP[{NUMBER}]` and immediately persist it to the issue:

```bash
ATTEMPT=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:DISPATCH") and contains("\"state\":\"running\""))] | length + 1')
if [ "${DRY_RUN:-false}" = "false" ]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:DISPATCH -->
\`\`\`json
{\"runtime\":\"opencode\",\"child_session_id\":\"{TASK_ID}\",\"attempt\":${ATTEMPT},\"state\":\"running\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}
\`\`\`"
fi
```

`background=true` is required for streaming DAG behavior; a foreground task
makes the orchestrator wait for that issue and reintroduces a wave barrier. The ForgeDock OpenCode plugin opts into
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` by default. An explicit
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false` is a supported degraded mode,
but it must be reported as non-streaming rather than treated as equivalent to
Claude background dispatch. Do not wait for the slowest sibling before handling
an earlier task-result event.

```bash
if [ "${FORGE_RUNTIME:-}" = "opencode" ]; then
  echo "OpenCode native task dispatch selected — load commands/work-on.md for each ready issue."
  echo "Do not call forgedock run-issue or the Claude Agent(...) fallback in this branch."
  echo "Use task(subagent_type=general, background=true) once per ready issue and process each task-result event immediately."
  echo "If native task dispatch cannot run, post FORGE:OPENCODE_BLOCKED with the missing capability and add needs-human."
fi
```

This branch is additive. When OpenCode is not selected, continue through the
existing engine-first and Claude Agent-spawn paths below without modification.

The generated OpenCode plugin is an executable boundary, not just prompt
guidance: its `tool.execute.before` hook rejects `claude`, `forgedock
run-issue`, `npx forgedock run-issue`, and recursive `opencode run` shell
commands with `FORGE_OPENCODE_CAPABILITY_ERROR`. If a native Skill or Task is
unavailable, stop with that bounded error and preserve the GitHub label state;
never compensate by starting a second controller or the Claude-backed engine.

**CRITICAL — never background via shell `&`/`wait`** (fixed forge#2466): A single `forgedock run-issue` invocation drives an issue through investigate → build → review → close and routinely runs 30+ minutes. Backgrounding the process at the *shell* level (`cmd &` … `wait`) does not escape the Bash tool's own per-invocation ceiling — `wait` is itself the foreground command the tool watches, and it blocks for the combined duration of every process in the chunk. This made engine-first dispatch effectively dead code: any chunk running longer than the ceiling was always killed, so every run silently fell through to the Agent-spawn fallback below. The fix: dispatch each `forgedock run-issue` invocation as its **own `Bash` tool call with `run_in_background=true`** — the harness's native "start it, don't wait, notify me on completion" primitive — never with shell-level `&`/`wait`. This is exactly the same async model the Agent-spawn-fallback path already uses (and Step 4B's notification-driven completion loop already expects), so one monitoring loop now covers both dispatch styles.

```bash
if [ "${FORGE_RUNTIME:-}" != "opencode" ] &&
   [ -z "${OPENCODE_SESSION_ID:-}" ] &&
   [ -z "${OPENCODE_PID:-}" ] &&
   [ -z "${OPENCODE:-}" ]; then
# Engine-first dispatch: check CLI availability, then dispatch ready issues in score order
# Uses SORTED_READY_SET[] from Step 3E.5 (descending value/cost) and budget gate from Step 4A-pre.0
FORGEDOCK_AVAILABLE=$(command -v forgedock >/dev/null 2>&1 && echo "true" || echo "false")

# Backend preflight canary (forge#2743): `command -v forgedock` only proves the orchestrator CLI
# binary is on PATH — it says nothing about whether the engine's execution backend (the `claude`
# CLI spawn, or a working `ANTHROPIC_API_KEY`) can actually run a phase. Without this probe, an
# environmental failure (e.g. forge#2741 — `spawnSync claude` ENOENT despite a shell `command -v`
# probe reporting the binary present) commits the ENTIRE ready set to engine-first dispatch, every
# `forgedock run-issue` call fails within seconds, and nothing re-routes the batch — a human has
# to notice and manually re-dispatch via the Agent-spawn path below.
#
# Use the runner's tested backend policy rather than duplicating it as shell/Node prose. This
# reuses the production resolved-CLI path check (including transient-shim refresh), honors an
# explicit FORGEDOCK_BACKEND, and accepts API fallback only when ANTHROPIC_API_KEY is configured.
# It performs no paid model request.
if [ "$FORGEDOCK_AVAILABLE" = "true" ]; then
  if ! forgedock backend-check --quiet; then
    echo "WARNING: forgedock CLI is on PATH, but no configured execution backend is locally usable. Downgrading to the Agent-spawn fallback path for this entire run — see forge#2743."
    FORGEDOCK_AVAILABLE="false"
  fi
fi

if [ "$FORGEDOCK_AVAILABLE" = "true" ]; then
  # Build the budget-gated dispatch queue first (forge#1743's should_dispatch() still applies
  # per-issue, independent of the concurrency cap below).
  DISPATCH_QUEUE=()
  for NUM in "${SORTED_READY_SET[@]:-{ready_issue_numbers}}"; do
    if should_dispatch "$NUM"; then
      DISPATCH_QUEUE+=("$NUM")
    fi  # else: added to DEFERRED_BUDGET_ISSUES[] by should_dispatch()
  done

  # Concurrency gate (forge#1912, mechanism fixed forge#2466): compute this dispatch batch the
  # SAME way the Agent-spawn-fallback path below does — via dispatch_headroom()/
  # DEFERRED_CONCURRENCY_ISSUES (Step 4A-pre.0.2) — NOT a shell `&`/`wait` chunk loop.
  #
  # MUST merge previously-deferred issues back in before recomputing, exactly like the
  # Agent-spawn path's own batch computation does (CANDIDATES=("${DEFERRED_CONCURRENCY_ISSUES[@]}"
  # ...); DEFERRED_CONCURRENCY_ISSUES=()). Without this merge-and-reset, an issue that lands in
  # DEFERRED_CONCURRENCY_ISSUES on THIS path has no way back into a future DISPATCH_QUEUE — Step
  # 4B item 5 only re-runs Step 4A for issues that just became DAG-unblocked, not for issues that
  # were already ready but held back purely by the concurrency cap. DEFERRED_CONCURRENCY_ISSUES
  # would become a write-only sink on the engine-first path, silently starving deferred work —
  # the same class of bug this PR exists to fix, just relocated.
  HEADROOM=$(dispatch_headroom)
  CANDIDATES=("${DEFERRED_CONCURRENCY_ISSUES[@]}" "${DISPATCH_QUEUE[@]}")
  DEFERRED_CONCURRENCY_ISSUES=()
  DISPATCH_NOW=()
  for NUM in "${CANDIDATES[@]}"; do
    if [ "${#DISPATCH_NOW[@]}" -lt "$HEADROOM" ]; then
      DISPATCH_NOW+=("$NUM")
    else
      DEFERRED_CONCURRENCY_ISSUES+=("$NUM")
    fi
  done

  if [ "${#DEFERRED_CONCURRENCY_ISSUES[@]}" -gt 0 ]; then
    echo "CONCURRENCY DEFER: ${#DEFERRED_CONCURRENCY_ISSUES[@]} ready issue(s) held back — ${ACTIVE_DISPATCH_COUNT}/${MAX_CONCURRENT} already in flight. Will dispatch as slots free up: ${DEFERRED_CONCURRENCY_ISSUES[*]}"
  fi
  # Filter against the durable board once while forming this engine batch. The tool-call
  # instruction below re-checks immediately before each launch to close the remaining TOCTOU gap.
  CLAIM_SAFE_DISPATCH=()
  for NUM in "${DISPATCH_NOW[@]}"; do
    if recovery_claim_blocks "$NUM"; then   # forge#3172: live FORGE:RECOVERY_CLAIM (fails closed)
      DEFERRED_CONCURRENCY_ISSUES+=("$NUM")
      continue
    fi
    if [ -n "${FORGE_COORD_ISSUE:-}" ] && [ -n "${COORD_ISSUE_NUMBER:-}" ] && claim_conflicts_with_live_holder "$NUM"; then
      DEFERRED_CLAIM_ISSUES+=("$NUM")
      continue
    fi
    CLAIM_SAFE_DISPATCH+=("$NUM")
  done
  DISPATCH_NOW=("${CLAIM_SAFE_DISPATCH[@]}")

  echo "Dispatching ${#DISPATCH_NOW[@]} issue(s) this message via forgedock run-issue (headroom was ${HEADROOM})"

  for NUM in "${DISPATCH_NOW[@]}"; do
    LANE="${ISSUE_LANE[$NUM]}"
    PR_BASE="${ISSUE_PR_BASE[$NUM]}"
    COST="${ISSUE_COST_ESTIMATE[$NUM]:-0.35}"

    # Advance PROJECTED_SPEND before dispatching so subsequent iterations see the updated total
    PROJECTED_SPEND=$(echo "scale=4; $PROJECTED_SPEND + $COST" | bc 2>/dev/null || echo "$PROJECTED_SPEND")

    echo "Dispatching #$NUM via forgedock run-issue --lane $PR_BASE (score=${ISSUE_SCORE[$NUM]:-?} est_cost=\$${COST} projected_total=\$${PROJECTED_SPEND})"
  done

  # Lease heartbeat refresh (forge#2627) — once per dispatch chunk, so a long-running batch's
  # lease never goes stale purely from elapsed wall-clock time while dispatch is still active.
  if [ "${#DISPATCH_NOW[@]}" -gt 0 ] && [ -n "${FORGE_COORD_ISSUE:-}" ] && [ -n "${COORD_ISSUE_NUMBER:-}" ] && [ -n "${BATCH_ID:-}" ]; then
    HOSTNAME_ID=$(hostname 2>/dev/null || uname -n 2>/dev/null || true); HOSTNAME_ID="${HOSTNAME_ID:-unknown-host}"
    # GOVERNOR-exempt: intentional coordination side-effect (best-effort lease/board/finding post), DRY_RUN-safe — reviewed & accepted for the check-command-side-effects gate. Flagged only by the staging->main full-diff; passes on every feature PR. forge#2627
    gh issue comment "$COORD_ISSUE_NUMBER" -R {GH_REPO} --body "<!-- FORGE:LEASE -->
**Holder Batch ID**: ${BATCH_ID}
**Holder**: ${HOSTNAME_ID} (pid ${$})
**Acquired/refreshed**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
**TTL**: ${LEASE_TTL_SECONDS:-900}s (refreshed once per dispatch chunk in Step 4A)" 2>/dev/null || true
  fi

  if [ "${#DISPATCH_NOW[@]}" -eq 0 ]; then
    echo "Engine dispatch: no headroom this cycle — waiting for the next completion notification (Step 4B) before dispatching more."
  fi
else
  echo "INFO: Using agent dispatch mode (forgedock CLI not in PATH — run \`npm install -g forgedock\` for engine-mode dispatch)"
  # Fall through to Agent-spawn template below. The SubagentStop hook (bin/hooks/interactive-engine.mjs)
  # bridges these runs to the engine run-log for state persistence even on the fallback path.
fi
fi
```

**Dispatch each issue in `DISPATCH_NOW` via its own backgrounded `Bash` call (MANDATORY when `FORGEDOCK_AVAILABLE=true`) — never shell `&`/`wait`.** Immediately before each call, run `recovery_claim_blocks "{NUM}"` and `claim_conflicts_with_live_holder "{NUM}"`; if either returns success, defer that issue rather than dispatching it. Issue one `Bash(...)` call per remaining issue in `DISPATCH_NOW`, all in the same message, so they run concurrently within the headroom already computed above:

```
Bash(command="FORGE_GIST_CAPABLE=${FORGE_GIST_CAPABLE} forgedock run-issue {NUM} --lane {PR_BASE}", run_in_background=true, description="Engine-drive issue #{NUM}")
```

Capture the task id each call returns into `ENGINE_DISPATCH_MAP[{NUM}]` (declared alongside `AGENT_ISSUE_MAP` below — Step 4B's completion handler uses this map to identify which issue a backgrounded engine-mode `Bash` completion notification belongs to, the same role `AGENT_ISSUE_MAP` plays for `agent_completed` notifications):

```
# After the batch of Bash(run_in_background=true, ...) calls, capture each returned task id:
ENGINE_DISPATCH_MAP[{NUM}] = <task_id returned by Bash(run_in_background=true, ...)>
```

`ENGINE_DISPATCH_MAP` starts empty and accumulates one entry per dispatched issue, exactly like `AGENT_ISSUE_MAP` below. After the batch, increment `ACTIVE_DISPATCH_COUNT` by `${#DISPATCH_NOW[@]}` — identical accounting to the Agent-spawn path's own post-batch increment.

If `DISPATCH_NOW` is empty (headroom is 0), do not dispatch any issues this cycle — wait for the next completion notification, exactly like the Agent-spawn path.

**Agent-spawn path (Claude fallback when forgedock CLI unavailable)**: When `FORGEDOCK_AVAILABLE=false` and the runtime is not OpenCode, spawn Agent sub-agents per issue using the template below. This preserves engine state via the SubagentStop hook even without the CLI.

When the runtime is OpenCode, skip this Claude-only `Agent(...)` path entirely.
Use the native `task` call above for initial and newly-ready issue dispatches.
Translate only those OpenCode orchestration dispatches to `task(...)` with
`subagent_type="general"` and `background=true`. Review and remediation are
load-bearing child operations and must run foreground. Do not claim task-id
resume support: after a restart, reconcile the latest `FORGE:DISPATCH` record
with durable GitHub workflow state, then dispatch a fresh work-on continuation
only when the issue is still non-terminal.

**REMINDER: You MUST use the template below verbatim when on the Agent-spawn fallback path. Only fill in `{VARIABLES}`. Do NOT rewrite the agent prompt. Do NOT write custom implementation instructions. The agent MUST invoke `/work-on` via the Skill tool — this is the HARD RULE from the top of this file.**

For each **ready** issue (all predecessors resolved or no predecessors), spawn an Agent sub-agent that runs the full `/work-on` pipeline. On the initial dispatch, this is every issue with an empty predecessor set. On subsequent dispatches (triggered by agent completions in Step 4B), this is every newly-unblocked issue.

**One agent per issue.** Do NOT group multiple issues into a single agent. `/work-on` handles branching, labels, and PRs per-issue.

**Resolve `{FORGE_SKILL_PREFIX}` once before dispatching** (`forgedock:` for the plugin install, empty for `install.sh`; rule in `commands/work-on.md` § Skill Name Resolution) and substitute it literally into every copy of the template below (4A, 4B, 4F, remediation and finding dispatches). Subagents cannot see this resolution, so never leave the placeholder unfilled.

**Copy this template. Fill in variables. Do not modify the structure:**

```
Agent(
  subagent_type="general-purpose",
  model="{SUBAGENT_MODEL}",
  description="Work on {PROJECT_PREFIX}#{NUMBER}",
  run_in_background=true,
  prompt="You are working on GitHub issue #{NUMBER} for the {PROJECT_NAME} project.

**Project**: {PROJECT_NAME}
**Repository**: {GH_REPO}
**Repo path**: {REPO_PATH}

**KNOWLEDGE GIST CAPABILITY**: This orchestration already probed it: `{FORGE_GIST_CAPABLE}`. Before invoking `/work-on`, run `export FORGE_GIST_CAPABLE={FORGE_GIST_CAPABLE}`. Do not re-probe or attempt Gist creation when it is `false`.

**YOUR MISSION**: Invoke `/work-on` via the Skill tool and let it run to completion. `/work-on` is a self-contained routing loop that handles the ENTIRE pipeline: investigate → build (context → architect → implement → validate) → review (push → PR → /review-pr --auto-merge) → close (project board → trajectory log → worktree cleanup). Do NOT intervene, compensate, or manually close issues — `/work-on` handles everything including issue closure and label updates in its close phase.

**CRITICAL — DO NOT STOP EARLY**: /work-on runs as a multi-phase routing loop. Each phase (investigate, build, review, close) returns an intermediate result — these are NOT completion signals. You are NOT done until the issue reaches a terminal state: `workflow:merged`, `workflow:invalid`, `needs-human`, or `workflow:awaiting-merge`. If /work-on returns after only one phase (e.g., investigation), you MUST invoke it again immediately — it will re-read GitHub state and continue to the next phase. Keep invoking /work-on until it reaches a terminal state. Never output 'done' or stop after an intermediate result.

**HOW REVIEW FINDINGS WORK**: /review-pr may create GitHub issues (with `review-finding` label) for findings it discovers. These are NOT blockers — they are separate work items that will go through their own /work-on pipeline later. The original PR should ALWAYS merge after review. The only exception is build errors (code doesn't compile) — those must be fixed before merging.

**IMPORTANT RULES**:
- **MANDATORY**: You MUST use the Skill tool to invoke '{FORGE_SKILL_PREFIX}work-on' with args '{PROJECT_PREFIX}{NUMBER}'. Do NOT implement manually — /work-on handles the full pipeline including label state machine (workflow:investigating → workflow:building → workflow:in-review → workflow:merged), investigation reports, PR creation, and cleanup.
  - For default repo issues: `Skill(skill='{FORGE_SKILL_PREFIX}work-on', args='{NUMBER} --under-orchestration')`
  - For satellite repo issues: `Skill(skill='{FORGE_SKILL_PREFIX}work-on', args='<satellite-prefix>:{NUMBER} --under-orchestration')` (`<satellite-prefix>` from forge.yaml → repos.satellites)
  - **If `{FORGE_SKILL_PREFIX}work-on` is reported unknown or not found, this is a HARD ERROR: STOP and report 'skill not found: {FORGE_SKILL_PREFIX}work-on' as your final result. Do NOT run the pipeline phases inline or with the Agent tool — an inline run bypasses the phase trail.**
  - The `--under-orchestration` flag tells `/work-on` to post its phase-entry `FORGE:HEARTBEAT` comments (Phases 0/1/3/5) — this orchestrator's Step 4B.5 stall detector depends on those timestamps. A solo `/work-on` run omits the flag and skips those writes entirely (see `commands/work-on.md` → Orchestration Flag).
- NEVER bypass /work-on with manual git/gh commands — the label updates and structured comments are critical for tracking
- **File-backed GitHub bodies — entity scope plus read-back is mandatory**: Never stage a `gh --body-file` body at a generic shared `/tmp` path, including one made by bare `mktemp`, and never hand-roll a root-level path such as `/tmp_invbody_31076.txt`, which can hang unattended cleanup. Prefer the session scratchpad or a repo-relative scratch directory on Windows: a native Windows `gh` may not resolve Git Bash `/tmp` reliably. Create a filename that contains the target issue/PR number and an agent-unique token, then use `mktemp` for its random suffix. Put one caller-chosen marker such as `<!-- FORGE:BODY-INTEGRITY:<issue-number>_investigator_<agent-token> -->` in the body. After every `gh issue create|edit` or `gh pr create|comment` using `--body-file`, re-read the target object and assert the exact marker is present; a mismatch is a hard error. Unique names reduce collisions, but only read-back detects a collision that substitutes plausible-looking content from another agent. Do not rely on eyeballing. (forge#2843, forge#2855) <!-- allowlist:check-command-side-effects -->
- **GitHub secondary rate limit**: If a GitHub API call returns HTTP 403 with `secondary rate limit` in its response, do NOT retry it or start a polling loop. Stop GitHub content creation for this phase, report the status and response body to the orchestrator in your final result, and wait for a later batch resume. Retrying extends the throttle for every sibling.
- **Temp files — ALWAYS use `mktemp`, NEVER hand-roll a path**: You are one of several agents running concurrently on this host and you share its `/tmp` with all of them. Any time you stage content in a temp file before passing it to `gh` (e.g. `--body-file`), create that path with `mktemp` (e.g. `BODY_FILE="$(mktemp)"`). Never write a temp file to a single-segment root path such as `/tmp_invbody_31076.txt`: Claude Code treats removing it as dangerous and requires an explicit approval that bypass mode cannot clear, hanging unattended runs. Also never use a fixed literal such as `/tmp/body.md` or `/tmp/issue.json`: a fixed path collides with another concurrently-running agent and can silently overwrite the content you staged (or you can silently overwrite theirs) before either of you reads it back. Safe: `BODY_FILE="$(mktemp)"`. Unsafe: `/tmp_invbody_31076.txt` (a missing slash that creates a root-level path) and `/tmp/body.md` (a fixed path). `mktemp` costs nothing and prevents both failures. (forge#2198, forge#2855)
- **`docker cp` — NEVER write into a bind-mounted shared container**: If the project you're working on runs its dev/test containers with a bind mount to the main (non-worktree) checkout, `docker cp` into that container writes through the mount into the main checkout — not your isolated per-issue worktree. Before running `docker cp` into any container, confirm its mount source is your own worktree, not a shared/main one; if you can't confirm that, don't assume an in-container test run reflects your feature branch. (forge#2198)
- NEVER target `main` for PRs targeting the default repo. Use `{STAGING_BRANCH}` for fast-lane issues, or `milestone/{slug}` for milestone issues.
- Satellite repos (MCP, n8n) have no staging branch — fast-lane PRs go to `main` for those.
- If the issue is INVALID after investigation, close it with a comment explaining why
- If you hit merge conflicts or blockers, post a comment on the issue and STOP — do not force anything
- Do not interact with the user — you are running autonomously in the background
- **NEVER ask the user questions** — you are a background agent. If review finds issues, auto-fix simple ones and proceed, then let `/review-pr`'s own verdict decide: APPROVED (no unresolved CONFIRMED HIGH/CRITICAL finding) → merge to `staging` and create follow-up issues for the rest, **regardless of domain**. Domain alone (AUTH, BILLING, DATABASE, or any domain tagged as security-critical in Step 3B) is NOT a reason to add `needs-human` and stop — `staging` is reversible; the real human deploy gate is `staging → main`, not this merge. <!-- Added: forge#1815 --> `needs-human` is reserved for what the pipeline genuinely cannot do itself: spend/procurement decisions, real-environment validation it has no access to, product/architecture judgment calls a human must make, or `/review-pr`'s existing evidence-based escalations (spec-evolution guard, novel task-type/module-combo trust escalation, calibration-based overconfidence routing). An unresolved CONFIRMED HIGH/CRITICAL finding is `/review-pr`'s own withheld-APPROVED case, not a domain-driven `needs-human` halt — `/review-pr` already refuses to return APPROVED when that's true, so there is no separate domain check to perform here.

**LABEL-STATE LOOP CONTRACT — enforce after EVERY Skill return**:
After EVERY `Skill(skill='{FORGE_SKILL_PREFIX}work-on', ...)` call returns, immediately check the issue's current workflow label:
```bash
gh issue view {NUMBER} -R {GH_REPO} --json labels --jq '[.labels[].name | select(startswith("workflow:"))]'
```
**Terminal labels** (only these allow you to stop): `workflow:merged`, `workflow:invalid`
**Terminal condition also**: `needs-human` label present, `workflow:awaiting-merge` label present, OR issue state is `closed`
`needs-human` and `workflow:awaiting-merge` are terminal-FOR-THIS-AGENT (this individual `/work-on` run stops here — a human decision or merge is now the blocking step) but are NOT "done" from the DAG's point of view; see Predecessor Classification in Step 4B for how the orchestrator's dependency logic treats them (`GATED`, not `DONE`).
If the label is NOT terminal (e.g., `workflow:investigating`, `workflow:ready-to-build`, `workflow:building`, `workflow:in-review`), invoke `Skill(skill='{FORGE_SKILL_PREFIX}work-on', args='{NUMBER} --under-orchestration')` again immediately. The `/work-on` skill will re-read GitHub state and advance to the next phase. Do NOT output a summary, do NOT pause, do NOT ask for confirmation — just invoke it again.

**CRITICAL — SOURCE BRANCH DETECTION**:
- If the issue has the `review-finding` label, read the issue body for `**Code branch**: \`{branch}\``
- If found, that branch is the source branch (`<source-branch>` below) — the code ONLY exists on that branch (e.g., `staging`), NOT on `origin/main`
- Investigation MUST use `git show origin/<source-branch>:<filepath>` to verify the code exists
- Worktree MUST branch from `origin/<source-branch>`, NOT `origin/main`
- PR target is `<source-branch>` (the fix goes back to where the code lives)

**LANE**: {LANE} (PR target: {PR_BASE})
**Issue title**: {ISSUE_TITLE}
<!-- DISPATCH_CONTEXT:BEGIN -->
{GIST_CONTEXT}
{SOURCE_PR_HINT_CONTEXT}
<!-- DISPATCH_CONTEXT:END -->
"
)
```

**Prompt lint (MANDATORY before every dispatch — a best-effort, self-run guard for Hard Rule 1; no hook gates `Agent(...)`, so it is orchestrator-policed, not tamper-proof)** <!-- Added: forge#3062 -->: the only variable text allowed in the rendered prompt is the `{GIST_CONTEXT}`/`{SOURCE_PR_HINT_CONTEXT}` blocks between the `DISPATCH_CONTEXT` markers (which already carry the claims-board URL and the same-file "what changed" brief). Before every `Agent(...)`/`task(...)` launch built from the Step 4A template — initial dispatch, Step 4B resume/relaunch, Step 4F sweep — write the fully rendered prompt to a `mktemp` file and run the lint. A non-zero exit means the dispatch is REFUSED (the snippet below sets the refusal by appending to `LINT_REFUSED_ISSUES[]` and skipping that issue with `continue`): do not launch, do not "fix" the prompt by adding text — re-render from the unmodified template, drop the offending context block, and report every `LINT_REFUSED_ISSUES[]` entry in the operator status update (`DISPATCH REFUSED: #{NUMBER} — {reason}`). A missing/unreadable `scripts/lint-dispatch-prompt.sh` is a distinct `lint-script-not-found` refusal (fail closed, never a silent pass); do not conflate it with a lint verdict. **Exempt (not Step 4A-template prompts, no free-text variable slot, so the template-anchor lint does not apply)**: the Codex/OpenCode `task()` wrapper prompt in the engine-fallback section and the remediation `Agent()` prompt in Step 4B item 6.4 — both are fixed one-purpose wrappers that only invoke `Skill(...work-on...)` with substituted identifiers; never add free text to them.

```bash
# Bind the lint inputs FIRST (forge#3149). Every value is the SAME one substituted into the Step 4A template for this
# issue (config.md / Step 4A resolve them) - substitute the literal values, never re-derive them. The rendered
# prompt goes in through a quoted heredoc so no shell expansion touches it. A value containing a single quote is
# written as '\'' . PROJECT_PREFIX, SATELLITE_PREFIX, FORGE_SKILL_PREFIX and SOURCE_BRANCH may be empty.
PROJECT_NAME='{PROJECT_NAME}';   GH_REPO='{GH_REPO}';             REPO_PATH='{REPO_PATH}'
LANE='{LANE}';                   PR_BASE='{PR_BASE}';             STAGING_BRANCH='{STAGING_BRANCH}'
SOURCE_BRANCH='{SOURCE_BRANCH}'; FORGE_GIST_CAPABLE='{FORGE_GIST_CAPABLE}'; SUBAGENT_MODEL='{SUBAGENT_MODEL}'
PROJECT_PREFIX='{PROJECT_PREFIX}'; SATELLITE_PREFIX='{SATELLITE_PREFIX}'; FORGE_SKILL_PREFIX='{FORGE_SKILL_PREFIX}'
# Heredoc into a file, then read it back: a heredoc body inside $( ) is parsed for quote balance by bash 3.2 (macOS),
# and the rendered prompt contains apostrophes and parentheses.
# The delimiter MUST be a string that occurs nowhere in the rendered prompt (the GIST/SOURCE_PR_HINT context blocks carry
# untrusted text): replace RENDERED_PROMPT_EOF below with RENDERED_PROMPT_EOF_ plus 16 random hex chars, in BOTH places.
RENDERED_PROMPT_SRC="$(mktemp)"
cat > "$RENDERED_PROMPT_SRC" <<'RENDERED_PROMPT_EOF'
{the fully rendered Step 4A prompt text for this issue, exactly as passed to Agent(prompt=...)}
RENDERED_PROMPT_EOF
RENDERED_PROMPT=$(cat "$RENDERED_PROMPT_SRC"); rm -f "$RENDERED_PROMPT_SRC"
```

```bash
# Runs inside the per-issue dispatch loop (same loop as claim_conflicts_with_live_holder above),
# immediately before that issue's Agent()/task() call. LINT_REFUSED_ISSUES is initialised once, empty.
# FORGE_ROOT bootstrap (canonical; keep byte-identical across specs, guarded by scripts/forge-root.test.sh)
FORGE_ROOT=""
if [ -n "${FORGEDOCK_HOME:-}" ]; then case "$FORGEDOCK_HOME" in /*) FORGE_ROOT="$FORGEDOCK_HOME" ;; esac; else
  # Portable to bash 3.2 (macOS), BSD/GNU coreutils and zsh: no mapfile, no sort -V, no bare globs (zsh aborts on no match).
  _l="$HOME/.claude/commands/work-on.md"; _l="$(readlink -f "$_l" 2>/dev/null || readlink "$_l" 2>/dev/null)"; [ -n "$_l" ] && _l="$(dirname "$(dirname "$_l")")"
  # newest cached version first: numeric major.minor.patch of the version dir name only; a release outranks its pre-release (1.10.0 > 1.9.0 > 1.9.0-rc1)
  _v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ '$(NF-1)=="forgedock"{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$0}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5-)"
  _m="$(find -L "$HOME/.claude/plugins/marketplaces" -mindepth 1 -maxdepth 1 -type d -iname '*forgedock*' 2>/dev/null)"
  # '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
  _k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_v" "$_m")"
  while IFS= read -r _c; do
    case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
  done <<< "$_k"
fi
# Fail closed on unbound inputs (forge#3149): an empty rendered prompt or a missing resolved value would lint an empty file
# (rc=2) or compare against nothing; refuse with a distinct reason instead of a misleading lint verdict.
if [ -z "$RENDERED_PROMPT" ] || [ -z "$PROJECT_NAME" ] || [ -z "$GH_REPO" ] || [ -z "$REPO_PATH" ] || [ -z "$LANE" ] \
   || [ -z "$PR_BASE" ] || [ -z "$STAGING_BRANCH" ] || [ -z "$FORGE_GIST_CAPABLE" ] || [ -z "$SUBAGENT_MODEL" ]; then
  echo "DISPATCH REFUSED for #{NUMBER}: lint inputs unbound (RENDERED_PROMPT/PROJECT_NAME/GH_REPO/REPO_PATH/LANE/PR_BASE/STAGING_BRANCH/FORGE_GIST_CAPABLE/SUBAGENT_MODEL must be set by the binding block above)" >&2
  LINT_REFUSED_ISSUES+=("{NUMBER}:lint-inputs-unbound")
  continue
fi
LINT_SCRIPT="$FORGE_ROOT/scripts/lint-dispatch-prompt.sh"
if [ -z "$FORGE_ROOT" ] || [ ! -r "$LINT_SCRIPT" ]; then
  # Fail closed: a missing lint script is NOT a pass and NOT a lint verdict.
  echo "DISPATCH REFUSED for #{NUMBER}: lint script not found at $LINT_SCRIPT (set FORGEDOCK_HOME/FORGE_HOME) — cannot verify Hard Rule 1 (ForgeDock install root unresolved: set FORGEDOCK_HOME)" >&2
  LINT_REFUSED_ISSUES+=("{NUMBER}:lint-script-not-found")
  continue
fi
PROMPT_FILE="$(mktemp)"
printf '%s' "$RENDERED_PROMPT" > "$PROMPT_FILE"
# Exact-match expectations: every slot the orchestrator resolved itself must equal, byte for byte, the
# value it substituted into the template (the SAME variables, never re-derived). One quoted argument per
# slot, so spaces, parentheses, backslashes and non-ASCII are safe. A slot present in the prompt with no
# --expect is refused (fail closed). PROJECT_PREFIX / FORGE_SKILL_PREFIX may legitimately be empty.
LINT_EXPECT=(
  --expect "PROJECT_NAME=$PROJECT_NAME"       --expect "GH_REPO=$GH_REPO"
  --expect "REPO_PATH=$REPO_PATH"             --expect "LANE=$LANE"
  --expect "PR_BASE=$PR_BASE"                 --expect "STAGING_BRANCH=$STAGING_BRANCH"
  --expect "SOURCE_BRANCH=$SOURCE_BRANCH"     --expect "NUMBER={NUMBER}"
  --expect "FORGE_GIST_CAPABLE=$FORGE_GIST_CAPABLE" --expect "SUBAGENT_MODEL=$SUBAGENT_MODEL"
  --expect "PROJECT_PREFIX=$PROJECT_PREFIX"   --expect "SATELLITE_PREFIX=$SATELLITE_PREFIX"
  --expect "FORGE_SKILL_PREFIX=$FORGE_SKILL_PREFIX"
)
bash "$LINT_SCRIPT" "${LINT_EXPECT[@]}" "$PROMPT_FILE"; LINT_RC=$?
rm -f "$PROMPT_FILE"
if [ "$LINT_RC" -ne 0 ]; then
  # rc 1 = template deviation (violations printed above); rc 2 = unreadable/empty prompt; any other rc = lint crashed.
  echo "DISPATCH REFUSED for #{NUMBER}: prompt lint rc=$LINT_RC (Hard Rule 1)" >&2
  LINT_REFUSED_ISSUES+=("{NUMBER}:lint-rc-$LINT_RC")
  continue   # skip this issue's Agent()/task() call; never launch the failing prompt
fi
```

**Exact-match placeholders**: the lint does not guess whether a slot "looks like" a project name, path or branch (every charset/stopword heuristic was bypassed within a round). Each orchestrator-resolved slot (`{PROJECT_NAME}`, `{GH_REPO}`, `{REPO_PATH}`, `{LANE}`, `{PR_BASE}`, `{STAGING_BRANCH}`, `{SOURCE_BRANCH}`, `{NUMBER}`, `{FORGE_GIST_CAPABLE}`, `{SUBAGENT_MODEL}`, `{PROJECT_PREFIX}`, `{SATELLITE_PREFIX}`, `{FORGE_SKILL_PREFIX}`) must equal the `--expect KEY=VALUE` passed for it, and a slot with no `--expect` is refused. Only the free-text slots (issue title line, `DISPATCH_CONTEXT` block) are scanned for directive phrases. When you add a new resolved placeholder to the 4A template, add its `--expect` here and its key to `scripts/lint-dispatch-prompt.test.sh`.

The lint rejects: template deviations, any resolved placeholder that differs from its expected value, any text outside the context block after the issue title, and prompts that pre-decide a verdict or fix ("likely already resolved — verify and close", "the fix is ...", "make X terminal", "finish what the previous agent left"). The orchestrator never diagnoses, designs fixes, or summarizes what an issue "probably" needs — investigation is the agent's job via `work-on/investigate`.

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

**`{SOURCE_PR_HINT_CONTEXT}` generation** <!-- Added: forge#2351 -->: For each issue being dispatched, thread the source-PR `likely-moot` triage hint computed by `phase-1-resolve.md`'s "Source-PR Triage Hint" step (`ISSUE_LIKELY_MOOT[$NUM]`, `ISSUE_SOURCE_PR[$NUM]`, `ISSUE_SOURCE_PR_STATE[$NUM]` — Phase 1 output, not re-derived here) into the dispatched agent's initial context, framed explicitly as a starting point to verify, never as a conclusion:

```bash
# Build SOURCE_PR_HINT_CONTEXT for an issue — reads Phase 1's ISSUE_LIKELY_MOOT[]/ISSUE_SOURCE_PR[]/
# ISSUE_SOURCE_PR_STATE[] arrays (populated once in phase-1-resolve.md's pre-flight step).
SOURCE_PR_HINT_CONTEXT=""
if [ "${ISSUE_LIKELY_MOOT[{NUMBER}]:-unknown}" = "yes" ]; then
  SOURCE_PR_HINT_CONTEXT="
**SOURCE-PR TRIAGE HINT (non-binding — verify, do not assume)**: This finding cites source PR #${ISSUE_SOURCE_PR[{NUMBER}]}, which closed WITHOUT merging (state: ${ISSUE_SOURCE_PR_STATE[{NUMBER}]}). This is a hint to check FIRST during investigation, not a verdict — do NOT conclude INVALID on this basis alone. Two outcomes are both possible and have both occurred in production: (a) the flagged change genuinely never landed by any route (verify with \`git log -S\`/\`git merge-base --is-ancestor\` against the target branch) — if so, this supports an INVALID verdict with evidence; (b) the flagged change reached the target branch anyway via a DIFFERENT, independently-merged PR — if so, this finding is still valid and must be investigated and resolved normally, exactly like #2346 (source PR #2337 closed unmerged, but the code landed via independently-merged PR #2261, commit 90376f5 — #2346 correctly ended at needs-human, not invalid). Reach your own evidence-based verdict; this hint only tells you where to look first."
fi
```

If `ISSUE_LIKELY_MOOT[{NUMBER}]` is `unknown` or absent (no `**Source**: PR #{N}` citation found, source PR still open, source PR merged, or the lookup failed), `SOURCE_PR_HINT_CONTEXT` stays empty and resolves to a blank line in the template — no impact on the agent prompt, identical to the `GIST_CONTEXT` empty-case behavior above.

**Claims board context injection** <!-- Added: forge#1736 -->: When a coordination issue exists for this batch (`FORGE_COORD_ISSUE` is set), append the claims board URL and the active-claims check instruction to the agent's context. This enables each `/work-on` agent to post its `FORGE:CLAIM` on build start.

```bash
# Inject coordination issue URL if claims board was created in Step 3D.1
if [ -n "${FORGE_COORD_ISSUE:-}" ]; then
  GIST_CONTEXT="${GIST_CONTEXT}

**ORCHESTRATION CLAIMS BOARD**: This agent is running under an orchestration batch.
Claims board issue URL: ${FORGE_COORD_ISSUE}

On build start (Phase B2 / Phase 3C of /work-on), post a FORGE:CLAIM annotation on the
coordination issue above. Required fields:
  **Holder**: #{NUMBER} / batch-$(date -u +%Y%m%dT%H%M%S)   (exact form — read_active_claims parses `**Holder**: #N`)
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

**Same-file current-state brief injection** <!-- Added: forge#1860 --> — a separate, parallel mechanism to the `FORGE:SYNTHESIS_BRIEF` handling above: it does not replace or interact with Phase 2.5 investigation→implementation forwarding. When this issue was dispatched because a Layer 1/2/3 structural predecessor edge just resolved, Step 4B's core streaming dispatch loop has already populated `SAME_FILE_BRIEF[{NUMBER}]` with a short excerpt of what each such predecessor changed in the shared file/directory/module. Append it here:

```bash
# Append same-file/directory/shared-module briefs from resolved structural-edge predecessors.
if [ -n "${SAME_FILE_BRIEF[{NUMBER}]:-}" ]; then
  GIST_CONTEXT="${GIST_CONTEXT}

**SAME-FILE STATE BRIEF (structural DAG predecessor)**: One or more predecessors in this batch were serialized against you because they touch the same file/directory/module (Step 3C Layer 1/2/3 — not an explicit \`Depends on\`). Here is what they just changed — use this as your starting understanding of the file's current state; do not re-investigate it cold:
${SAME_FILE_BRIEF[{NUMBER}]}"
fi
```

This block is a no-op — `GIST_CONTEXT` resolves exactly as before — whenever `SAME_FILE_BRIEF[{NUMBER}]` is unset: the issue had no predecessors, its only predecessors were explicit-dependency/DATABASE-chain/Layer 4/Layer 5 edges (none of which populate `SAME_FILE_BRIEF`), or the orchestrator session was compacted and restarted between Phase 3 and this dispatch (in which case `EDGE_KIND`/`EDGE_FILES`/`SAME_FILE_BRIEF` are in-memory-only and are not reconstructed by the wake/compaction recovery in `phase-3-dependency.md` — the dispatched agent simply proceeds without the brief, exactly as it would have before this mechanism existed).

**Capture agent IDs after the batch spawn (MANDATORY)**: Each `Agent(...)` call returns an agent ID. Store each returned ID in `AGENT_ISSUE_MAP` keyed by issue number. This map is the only way to resume a stalled agent by ID in Steps 4B and 4B.5:

```
# After the single-message batch spawn, capture each returned ID:
AGENT_ISSUE_MAP[{NUMBER}] = <agent_id returned by Agent()>
```

`AGENT_ISSUE_MAP` starts empty and accumulates entries as agents are spawned. For parallel dispatch (all Agent() calls in one message), capture the returned IDs from the batch response — one entry per issue — before entering Step 4B's monitoring loop. Without this capture, `resume=` calls in Steps 4B and 4B.5 will have no agent ID to reference and the resume will fail. <!-- Added: forge#1083 -->

**Launch only up to the concurrency cap** (forge#1912) — never put more than `dispatch_headroom` (`MAX_CONCURRENT - ACTIVE_DISPATCH_COUNT`, from Step 4A-pre.0.2) Agent tool calls into a single message. Use `run_in_background=true` so the dispatched agents execute in parallel with each other, within the cap.

```bash
# Compute this dispatch batch (forge#1912): merge any previously-deferred concurrency
# issues (oldest first, for fairness) with the current ready set, then take only as many
# as headroom allows. The remainder is re-queued, not dropped.
HEADROOM=$(dispatch_headroom)
CANDIDATES=("${DEFERRED_CONCURRENCY_ISSUES[@]}" {ready_issue_numbers})
DEFERRED_CONCURRENCY_ISSUES=()

DISPATCH_NOW=()
for NUM in "${CANDIDATES[@]}"; do
  if [ "${#DISPATCH_NOW[@]}" -lt "$HEADROOM" ]; then
    DISPATCH_NOW+=("$NUM")
  else
    DEFERRED_CONCURRENCY_ISSUES+=("$NUM")
  fi
done

if [ "${#DEFERRED_CONCURRENCY_ISSUES[@]}" -gt 0 ]; then
  echo "CONCURRENCY DEFER: ${#DEFERRED_CONCURRENCY_ISSUES[@]} ready issue(s) held back — ${ACTIVE_DISPATCH_COUNT}/${MAX_CONCURRENT} already in flight. Will dispatch as slots free up: ${DEFERRED_CONCURRENCY_ISSUES[*]}"
fi
echo "Dispatching ${#DISPATCH_NOW[@]} issue(s) this message (headroom was ${HEADROOM})"
```

Immediately before every Claude `Agent()` or OpenCode `task()` call, run `recovery_claim_blocks "{NUM}"` (success: append to `DEFERRED_CONCURRENCY_ISSUES[]`, forge#3172) and `claim_conflicts_with_live_holder "{NUM}"` (success: append the issue to `DEFERRED_CLAIM_ISSUES[]`); on either, do not make that call. Spawn `Agent()` for every remaining issue in `DISPATCH_NOW` (not the raw ready set) using the template above. After the batch spawn, increment `ACTIVE_DISPATCH_COUNT` by the number actually dispatched — this happens in addition to, not instead of, capturing each returned agent ID into `AGENT_ISSUE_MAP` above.

If `DISPATCH_NOW` is empty (headroom is 0), do not spawn any agents this cycle — wait for the next `agent_completed` notification, which frees a slot and re-triggers this dispatch computation (Step 4B).

### Step 4B: Monitor completions and dispatch newly ready issues

You will be automatically notified when each background agent completes — or, for an engine-first dispatch (Step 4A, `FORGEDOCK_AVAILABLE=true`), when a backgrounded `Bash(run_in_background=true, command="forgedock run-issue ...")` call completes. In OpenCode, a native background `task` first returns a `state="running"` result and later injects a synthetic `<task id="..." state="completed">` or `state="error"` result into this same parent session. The later result is the completion event; the initial running result is not completion. Both Claude notifications and OpenCode task-result events must trigger the same per-issue handling immediately. **Do NOT use `sleep` loops, wait for the slowest sibling, or poll before processing an event.** When one arrives, look up which issue it belongs to — `AGENT_ISSUE_MAP` for a Claude `agent_completed` notification, `ENGINE_DISPATCH_MAP` for a background-Bash notification, or `OPENCODE_DISPATCH_MAP` for an OpenCode task result — and immediately process it exactly the same way regardless of which map resolved it; every check below (`classify_predecessor_state()`, dependent dispatch, stall/staging checks) keys off GitHub labels/state, not which dispatch mechanism produced them. For an OpenCode completion, append this terminal record before releasing capacity:

```bash
if [ "${DRY_RUN:-false}" = "false" ]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:DISPATCH -->
\`\`\`json
{\"runtime\":\"opencode\",\"child_session_id\":\"{TASK_ID}\",\"attempt\":${ATTEMPT},\"state\":\"{completed|error}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}
\`\`\`"
fi
```

**Fallback**: if a runtime ever fails to deliver a background completion notification, read the latest `FORGE:DISPATCH` record and use the documented label-state recovery path, but do not convert the normal OpenCode path to foreground tasks or a wave barrier.

For an OpenCode completion, retain `OPENCODE_DISPATCH_MAP[{NUMBER}]` until the terminal `FORGE:DISPATCH` record above has been posted successfully. Then remove that map entry and release capacity. This makes a restart deterministic: a latest `running` record restores the task-to-issue association, while a latest `completed` or `error` record cannot release the same slot twice.

**Concurrency slot release (MANDATORY — first action on every completion)** <!-- Added: forge#1912 -->: The instant a completion notification arrives — `agent_completed`, a background-Bash completion, or an OpenCode `task` result with `state="completed"`/`state="error"` — decrement `ACTIVE_DISPATCH_COUNT` by 1 — a worker slot has just freed, regardless of what terminal state the issue ended up in. Do this before any stall-recovery/resume logic below. If that agent is then resumed or fallback-dispatched (item 2 below, or Step 4B.5's stall recovery) because it stalled mid-pipeline rather than truly finishing, re-increment `ACTIVE_DISPATCH_COUNT` when the `Agent(resume=...)` or a fresh OpenCode `task(background=true)` continuation is issued — either re-occupies a worker slot exactly like a fresh dispatch does. (Step 4B.5's TIME-BASED hang detector — an agent that never completes at all, as opposed to one that completes at `workflow:engine-error` — remains resume-specific and out of scope for this fix: an engine-dispatched issue that silently hangs still surfaces only via the standard stall-detection alert, and `forgedock resume-stalled` remains available as a separate manual/scripted recovery path for that case. The completion-triggered case — an engine-dispatched issue that DOES complete at `workflow:engine-error` with empty committed state — is still auto-fallen-back by item 2b below, fixed forge#2743.)

**Ordering requirement (MANDATORY — prevents transient over-cap)**: For every agent that completed in this notification batch, finish its terminal-state check and, if applicable, its resume re-increment (items 1-2 below) BEFORE computing `dispatch_headroom` for item 5's newly-ready-issue dispatch. Computing headroom before a to-be-resumed agent's re-increment would let a genuinely-still-running agent's freed slot be double-booked — once by a fresh dispatch, once by the resume itself — transiently exceeding `MAX_CONCURRENT`. Process every completed agent's items 1-2 to a decision (terminal vs. resumed) first; only then compute headroom once for the batch's item 5 dispatch.

**Successor dispatch latency is measured from `agent_completed`, not from orchestrator polling.** The moment you receive an `agent_completed` notification for issue N, that is t=0 for dispatching N's successors. Any successor whose predecessors are all now terminal MUST be dispatched in the same response that processes the notification — not after a poll cycle, not after a sleep. This is the design property that makes streaming DAG execution faster than wave-based execution. <!-- Added: forge#1251 -->

**Cycle-start cache reset (MANDATORY — before item 5 and before Step 4B.5 stall detection)** <!-- Added: forge#3182 -->: at the very start of every monitoring cycle, call `init_trail_cache` once so no `classify_predecessor_state` call in this cycle (item 5/6 readiness checks, stall detection, item 6.6) reads the previous cycle's cached trail state. Re-declare `trail_cache_dir` / `init_trail_cache` in the same Bash block (same-shell rule as `classify_predecessor_state`) and run it before the first classify call. Item 6.6 does not reset the cache itself. `cleanup_trail_cache` removes the directory on every exit path (Termination condition, Step 4F, "Stopping the orchestrator").

**Predecessor Classification (DONE / GATED / FAILED)** <!-- Added: forge#1812 --> — every check in this file that asks "is predecessor X resolved enough for its dependents to proceed" MUST classify X into exactly one of three states below — never a single binary terminal/non-terminal grep. Earlier versions of this file independently patched `grep -qE 'workflow:merged|workflow:invalid|needs-human|CLOSED'` in multiple places, and the copies drifted: the readiness check (this step) treated `needs-human` as done-enough-to-dispatch-through, while the failure handler (item 6 below) treated the identical label as a hard failure that skips dependents. Both cannot be right at once — `needs-human` means the predecessor's code is paused pending a human decision and is NOT yet in the base branch, so dispatching a dependent against it is unsafe, but permanently skipping the dependent is also wrong once the human resolves the block. The fix is a third state:

```bash
# Trail cache lifecycle (forge#3182). Each Bash tool call is a fresh shell, so a persisted TRAIL_CACHE_DIR, a `$$`-keyed
# path and a bare `rm -rf "$TRAIL_CACHE_DIR"` all differ or no-op per call (and a per-call `mktemp -d` leaks a directory every
# cycle). The path is therefore derived from a STABLE key that every block can recompute without shell state: the numeric uid
# plus the target repo (never `$$`; a pre-set TRAIL_CACHE_DIR / env value is deliberately ignored so `rm -rf` can never be
# pointed at an arbitrary path). The dir is private (mode 700, owned by us, not a symlink) under a per-user base.
# init_trail_cache resets it (call once at the TOP of each monitoring cycle, see "Cycle-start cache reset");
# cleanup_trail_cache removes it on every orchestrator exit path. The cache holds only ABSENT/ACTIVE/RELEASED words.
trail_cache_dir() {
  printf '%s' "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/forge-trail-$(id -u)-$(printf '%s' "{GH_REPO}" | tr -c 'A-Za-z0-9._-' '_')"
}
init_trail_cache() {
  local D; D="$(trail_cache_dir)"
  case "$D" in */forge-trail-*) ;; *) echo "init_trail_cache: refusing unexpected path" >&2; return 1 ;; esac
  case "$D" in *..*) echo "init_trail_cache: refusing unexpected path" >&2; return 1 ;; esac
  rm -rf -- "$D"
  mkdir -m 700 -p -- "$D" && [ -O "$D" ] && [ ! -L "$D" ] || { echo "init_trail_cache: could not create a private cache dir" >&2; return 1; }
  TRAIL_CACHE_DIR="$D"
}
cleanup_trail_cache() {
  local D; D="$(trail_cache_dir)"
  case "$D" in */forge-trail-*) ;; *) return 0 ;; esac
  case "$D" in *..*) return 0 ;; esac
  rm -rf -- "$D"; unset TRAIL_CACHE_DIR; return 0
}

# hold_merged_trail <issue> <trail-text> (forge#3156): the single escalation path for a merged issue whose phase
# trail failed or could not be verified. Used by Step 4B item 0 and by the classifier's wake re-verification.
# Order matters (forge#3169): the escalation COMMENT is posted FIRST (re-read immediately before each post, skipped when
# an ACTIVE escalation already exists, verified ACTIVE by re-read after), then the `needs-human` label is written
# (read-back verified, 3 tries). The comment is the durable audit record, independent of the verifier, so a label-only
# hold is not the normal state and a human release always has an anchor to be recorded against. Returns 0 only when both
# halves are verified; otherwise returns 1 and stderr names which half failed (the label is still attempted after a
# comment failure, because holding dependents is the safe side).
hold_merged_trail() {
  local N="$1" TXT="$2" TRY COMMENTED=1 HELD=1
  for TRY in 1 2; do
    # forge#3157: dedupe only against an ACTIVE escalation, so a re-escalation after a recorded release posts a new one.
    # forge#3169: re-read right before each post (cache entry removed) to narrow the concurrent-classifier duplicate window.
    rm -f "$(trail_cache_dir)/trail-$N"
    if [ "$(trail_escalation_state "$N")" = "ACTIVE" ]; then COMMENTED=0; break; fi
    gh issue comment "$N" -R {GH_REPO} --body "<!-- FORGE:PHASE_TRAIL_FAILED -->
#${N} merged with an incomplete phase trail (or one that could not be verified), detected by /orchestrate.

\`\`\`
${TXT}
\`\`\`

The PR is already merged, so \`/work-on\` cannot re-run the missing phases. Review the merged change, then remove \`needs-human\` to release dependents held as \`blocked-on-human-merge\`." >/dev/null 2>&1 || true # <!-- allowlist:check-command-side-effects -->
    rm -f "$(trail_cache_dir)/trail-$N"
    if [ "$(trail_escalation_state "$N")" = "ACTIVE" ]; then COMMENTED=0; break; fi
  done
  for TRY in 1 2 3; do
    gh issue edit "$N" -R {GH_REPO} --add-label "needs-human" >/dev/null 2>&1 || true # <!-- allowlist:check-command-side-effects -->
    if gh issue view "$N" -R {GH_REPO} --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null \
         | grep -qE '(^|,)needs-human(,|$)'; then HELD=0; break; fi
  done
  rm -f "$(trail_cache_dir)/trail-$N"
  [ "$COMMENTED" -ne 0 ] && echo "PHASE TRAIL HOLD FAILED: #${N} — escalation comment could not be verified (audit record missing); hold dependents manually." >&2
  [ "$HELD" -ne 0 ] && echo "PHASE TRAIL HOLD FAILED: #${N} — needs-human label could not be verified; dependents are NOT held. Hold them manually." >&2
  [ "$COMMENTED" -eq 0 ] && [ "$HELD" -eq 0 ]
}

# resolve_orch_login (forge#3168): prints the login of the identity that authors the orchestrator's own FAILED/RELEASED
# marker comments, so trail_escalation_state can trust them even when the bot reports author_association NONE or
# CONTRIBUTOR. Resolution order: FORGE_BOT_LOGIN env override, then the git identity (`git config user.name`, which for a
# GitHub App is its `<app>[bot]` login). Never calls `/user` (403s for App tokens). An unresolved value prints nothing and
# the caller fails closed: only the author_association set below is trusted, never "trust every author".
resolve_orch_login() {
  local L="${FORGE_BOT_LOGIN:-}"
  [ -n "$L" ] || L=$(git config user.name 2>/dev/null || true)
  printf '%s' "$L"
}

# trail_escalation_state <issue> (forge#3157): prints ABSENT (no merged-trail escalation comment), ACTIVE (newest
# FORGE:PHASE_TRAIL_FAILED comment id is greater than the newest FORGE:PHASE_TRAIL_RELEASED id), RELEASED (a human
# release was recorded after the last escalation, so a later unrelated `needs-human` no longer gates), or UNREADABLE.
# forge#3168: only TRUSTED comments count, for BOTH markers. Trusted = author_association OWNER/MEMBER/COLLABORATOR, or
# `.user.login` equal to the orchestrator identity (resolve_orch_login, used only when non-empty). A marker string posted
# by anyone else is ignored (treated as absent), so an outside commenter can neither forge a release nor a failure.
# forge#3181: both markers must also START the comment body (startswith, not contains), so a trusted comment that merely
# quotes the marker text is not counted. hold_merged_trail / release_merged_trail emit the marker as the first line.
# The comment read is cached per issue for the current monitoring cycle: the cache is a directory of files
# (`$(...)` subshells lose shell arrays) at the stable per-user/per-repo path from `trail_cache_dir` (created only by `init_trail_cache`; reads/writes skip it if it is absent or not owned by us), and is reset by
# `init_trail_cache` at the TOP of every monitoring cycle (Step 4B "Cycle-start cache reset", before item 5 and stall
# detection), so a human edit made between cycles is always seen. Only successful reads are cached.
trail_escalation_state() {
  local N="$1" F="$(trail_cache_dir)/trail-$1" RAW OUT FAILED_ID RELEASED_ID RES
  if [ -s "$F" ] && [ -O "$F" ]; then cat "$F"; return; fi
  if ! RAW=$(gh api --paginate "repos/{GH_REPO}/issues/${N}/comments" --jq '.[] | {id: .id, body: (.body // ""), login: (.user.login // ""), assoc: (.author_association // "")}' 2>/dev/null); then
    echo "UNREADABLE"; return
  fi
  if ! OUT=$(printf '%s\n' "$RAW" | jq -r --arg L "$(resolve_orch_login)" 'select((.assoc | IN("OWNER","MEMBER","COLLABORATOR")) or ($L != "" and .login == $L)) | if (.body | startswith("<!-- FORGE:PHASE_TRAIL_FAILED -->") and contains("merged with an incomplete phase trail")) then "F \(.id)" elif (.body | startswith("<!-- FORGE:PHASE_TRAIL_RELEASED -->")) then "R \(.id)" else empty end' 2>/dev/null); then
    echo "UNREADABLE"; return
  fi
  FAILED_ID=$(printf '%s\n' "$OUT" | awk '$1=="F"&&$2+0>m{m=$2+0}END{print m+0}')
  RELEASED_ID=$(printf '%s\n' "$OUT" | awk '$1=="R"&&$2+0>m{m=$2+0}END{print m+0}')
  if [ "$FAILED_ID" -eq 0 ]; then RES="ABSENT"
  elif [ "$RELEASED_ID" -gt "$FAILED_ID" ]; then RES="RELEASED"
  else RES="ACTIVE"; fi
  [ -d "$(trail_cache_dir)" ] && [ -O "$(trail_cache_dir)" ] && printf '%s\n' "$RES" > "$F"
  echo "$RES"
}

# release_merged_trail <issue> (forge#3157): record that a human cleared a merged-trail hold, so the escalation
# stops gating. Call only after classify_predecessor_state reported DONE for a merged issue whose escalation is ACTIVE.
# Only an ACTIVE escalation is released here: hold_merged_trail posts the comment before the label (forge#3169), so a
# human release of a label-only (ABSENT) hold is not expected and is not recorded (avoids a stray RELEASED marker).
# Idempotent (no-op unless ACTIVE) and never run in dry-run. The comment must not contain the escalation marker text.
release_merged_trail() {
  local N="$1"
  [ "${DRY_RUN:-false}" = "true" ] && return 0
  [ "$(trail_escalation_state "$N")" = "ACTIVE" ] || return 0
  gh issue comment "$N" -R {GH_REPO} --body "<!-- FORGE:PHASE_TRAIL_RELEASED -->
The merged-trail hold on #${N} was released by a human (needs-human cleared or trail re-verified). Dependents held as \`blocked-on-human-merge\` are released. A later, unrelated \`needs-human\` on this merged issue no longer gates them." >/dev/null 2>&1 || true # <!-- allowlist:check-command-side-effects -->
  rm -f "$(trail_cache_dir)/trail-$N"
  return 0
}

# classify_predecessor_state <issue> (forge#3168): the helpers hold_merged_trail, resolve_orch_login,
# trail_escalation_state and release_merged_trail above MUST be declared in the SAME shell before this function runs
# (reverify_merged_trail is nested below). It has exactly ONE guarded write (the DRY_RUN-guarded hold_merged_trail
# call in the unverified-merged branch); every other path is read-only.
classify_predecessor_state() {
  local PRED="$1"
  local PRED_INFO H
  for H in hold_merged_trail resolve_orch_login trail_escalation_state release_merged_trail; do
    # Fail loudly (stderr) but closed: a missing helper must never read as DONE.
    type "$H" >/dev/null 2>&1 || { echo "classify_predecessor_state: helper $H is not declared in this shell; classifying #${PRED} GATED" >&2; echo "GATED"; return; }
  done
  # NOTE: the `workflow` array below deliberately also keeps `needs-human` — that label has NO
  # `workflow:` prefix (see bin/labels.json), so a bare `select(startswith("workflow:"))` would
  # drop it and the GATED branch's `needs-human` case would be dead code (forge#1812 primary case).
  PRED_INFO=$(gh issue view "$PRED" -R {GH_REPO} --json labels,state \
    --jq '{state: .state, workflow: [.labels[].name | select(startswith("workflow:") or . == "needs-human")]}' 2>/dev/null || echo '{}')
  local PRED_STATE PRED_LABELS
  PRED_STATE=$(echo "$PRED_INFO" | jq -r '.state // "OPEN"')
  PRED_LABELS=$(echo "$PRED_INFO" | jq -r '.workflow[]?' 2>/dev/null)

  # forge#3156: an empty/failed label read must never fall through to IN_PROGRESS/DONE for a merged issue. PRED_INFO
  # is '{}' on a failed read; re-read once, then fail closed (GATED) rather than guessing from absent labels.
  if [ "$PRED_INFO" = '{}' ]; then
    PRED_INFO=$(gh issue view "$PRED" -R {GH_REPO} --json labels,state \
      --jq '{state: .state, workflow: [.labels[].name | select(startswith("workflow:") or . == "needs-human")]}' 2>/dev/null || echo '{}')
    if [ "$PRED_INFO" = '{}' ]; then echo "GATED"; return; fi
    PRED_STATE=$(echo "$PRED_INFO" | jq -r '.state // "OPEN"')
    PRED_LABELS=$(echo "$PRED_INFO" | jq -r '.workflow[]?' 2>/dev/null)
  fi

  # reverify_merged_trail: re-run the phase-trail verifier for a merged predecessor that has NO escalation
  # record (forge#3156), so wake reconstruction does not trust the `workflow:merged` label alone. Prints OK
  # when the trail verifies, UNVERIFIED otherwise. Fails closed: a wake runs in a fresh shell where FORGE_ROOT is
  # unset, so the helper resolves it itself (canonical bootstrap, only when unset); if it is still unresolved or
  # the verifier is missing, the result is UNVERIFIED for every predecessor, never OK.
  reverify_merged_trail() {
    local P="$1" RC
    if [ -z "${FORGE_ROOT:-}" ]; then
      # FORGE_ROOT bootstrap (canonical; keep byte-identical across specs, guarded by scripts/forge-root.test.sh)
      FORGE_ROOT=""
      if [ -n "${FORGEDOCK_HOME:-}" ]; then case "$FORGEDOCK_HOME" in /*) FORGE_ROOT="$FORGEDOCK_HOME" ;; esac; else
        # Portable to bash 3.2 (macOS), BSD/GNU coreutils and zsh: no mapfile, no sort -V, no bare globs (zsh aborts on no match).
        _l="$HOME/.claude/commands/work-on.md"; _l="$(readlink -f "$_l" 2>/dev/null || readlink "$_l" 2>/dev/null)"; [ -n "$_l" ] && _l="$(dirname "$(dirname "$_l")")"
        # newest cached version first: numeric major.minor.patch of the version dir name only; a release outranks its pre-release (1.10.0 > 1.9.0 > 1.9.0-rc1)
        _v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ '$(NF-1)=="forgedock"{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$0}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5-)"
        _m="$(find -L "$HOME/.claude/plugins/marketplaces" -mindepth 1 -maxdepth 1 -type d -iname '*forgedock*' 2>/dev/null)"
        # '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
        _k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_v" "$_m")"
        while IFS= read -r _c; do
          case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
        done <<< "$_k"
      fi
    fi
    if [ -z "${FORGE_ROOT:-}" ] || [ ! -f "$FORGE_ROOT/scripts/verify-phase-trail.sh" ]; then
      echo "UNVERIFIED"; return
    fi
    bash "$FORGE_ROOT/scripts/verify-phase-trail.sh" "$P" -R {GH_REPO} --code-diff >/dev/null 2>&1; RC=$?
    [ "$RC" -eq 0 ] && echo "OK" || echo "UNVERIFIED"
  }

  if echo "$PRED_LABELS" | grep -qx "workflow:invalid"; then
    echo "FAILED"
  elif echo "$PRED_LABELS" | grep -qx "workflow:merged" && echo "$PRED_LABELS" | grep -qx "needs-human"; then
    # forge#3148: GATED when Step 4B item 0 escalated a merged issue with an incomplete phase trail
    # (the code is in the base branch, but /work-on cannot repair a merged issue, so a human must review it;
    # dependents wait until a human clears needs-human). forge#3169: the hold is NOT keyed on the verifier. A passing
    # verifier does not mean "not held" (an agent-reported bypass verifies clean), and hold_merged_trail posts the
    # comment before the label, so merged + needs-human with no record is a failed/partial hold: fail closed (GATED).
    # A human release is the removal of needs-human, recorded by the release sweep via release_merged_trail.
    local TRAIL_ESC
    TRAIL_ESC=$(trail_escalation_state "$PRED")
    case "$TRAIL_ESC" in
      ABSENT)   echo "GATED" ;;    # forge#3169: no record yet; never trust the verifier to release a labelled hold
      RELEASED) echo "DONE" ;;   # forge#3157: a human release was recorded after the last escalation; this needs-human is unrelated
      *)        echo "GATED" ;;  # ACTIVE or UNREADABLE: fail closed
    esac
  elif echo "$PRED_LABELS" | grep -qx "workflow:merged"; then
    # forge#3156: no needs-human. A recorded escalation (ACTIVE or RELEASED) means a human already released the hold
    # (DONE, forge#3157: the sweep records it via release_merged_trail); otherwise re-verify the trail so a merged
    # predecessor that item 0 never got to escalate (orchestrator died mid-hold, wake reconstruction) is not trusted
    # on the label alone. forge#3169: hold only when the record re-reads exactly ABSENT immediately before (an
    # UNREADABLE read classifies GATED without writing), so a concurrent classifier or a recorded release is not
    # overridden and at most one escalation comment is posted in the common case.
    case "$(trail_escalation_state "$PRED")" in
      ACTIVE|RELEASED) echo "DONE" ;;
      UNREADABLE) echo "GATED" ;;
      *)
        if [ "$(reverify_merged_trail "$PRED")" = "OK" ]; then
          echo "DONE"
        else
          # Unverified trail with no hold on record: establish it now so a human can release it.
          # Output is discarded (stdout is the classification), but a failed hold is reported on stderr, not swallowed.
          rm -f "$(trail_cache_dir)/trail-$PRED"
          [ "${DRY_RUN:-false}" = "true" ] || [ "$(trail_escalation_state "$PRED")" != "ABSENT" ] || hold_merged_trail "$PRED" "PHASE_TRAIL: FAIL (re-verified at wake classification)" >/dev/null || echo "classify_predecessor_state: hold on #${PRED} could not be verified" >&2
          echo "GATED"
        fi ;;
    esac
  elif echo "$PRED_LABELS" | grep -qxE "needs-human|workflow:awaiting-merge"; then
    echo "GATED"
  elif echo "$PRED_LABELS" | grep -qx "workflow:engine-error"; then
    # forge#2261: the engine/tool itself broke on this run (e.g. a fail-fast
    # CLI_BACKEND_FAILED, or an exhausted retry loop where the runner never
    # once succeeded) — this is NOT a human-judgment block, so it must NOT
    # classify GATED (that would wrongly track dependents as
    # blocked-on-human-merge, waiting on a merge decision nobody needs to
    # make). It is also not FAILED — the predecessor's content was never
    # actually judged bad, the tool just needs to be re-run. Classifying it
    # IN_PROGRESS means dependents simply keep waiting, exactly as if the
    # predecessor were still mid-pipeline — which is accurate, since the
    # stall-detection step below (item 2) auto-resumes/retries a completed
    # agent run that ends in workflow:engine-error, same as any other stall.
    # Fixed forge#2743: item 2's sub-case 2b is what actually fulfills this for
    # ENGINE_DISPATCH_MAP-tracked issues (fresh Agent-spawn fallback on empty
    # committed state) — 2a's Agent(resume=...) alone cannot reach them, since
    # they were never in AGENT_ISSUE_MAP.
    echo "IN_PROGRESS"
  elif [ "$PRED_STATE" = "CLOSED" ]; then
    # Closed with no workflow:invalid/merged label (e.g. closed-not-planned) — treat as DONE,
    # not a new deadlock state; there is no pending code for dependents to wait on.
    echo "DONE"
  else
    echo "IN_PROGRESS"
  fi
}
```

- **DONE** — predecessor's code is in the base branch (`workflow:merged`, unless gated by a Step 4B item 0 trail escalation), or the predecessor is closed with no pending code. Safe for dependents to dispatch.
- **GATED** — predecessor is paused pending a human decision (`needs-human`) or pending only a human merge click (`workflow:awaiting-merge`). Its code is NOT yet in the base branch — except for a `workflow:merged` issue that also carries `needs-human` and the Step 4B item 0 trail-escalation comment (merged with an incomplete phase trail), whose code is merged but whose trail needs human review. Dependents are neither dispatched nor skipped — they move to the `blocked-on-human-merge` tracked state (item 6.5 below).
- **FAILED** — predecessor was closed as `workflow:invalid`, or the agent explicitly reported a build/test error. Dependents are marked "skipped — dependency failed" (item 6 below) — unchanged from prior behavior.
- **IN_PROGRESS** — predecessor is still mid-pipeline (`investigating`/`ready-to-build`/`building`/`in-review`), or terminated `workflow:engine-error` (forge#2261 — an engine/tool failure, not a human-judgment block or a genuine content failure; treated as still-in-flight since stall-detection auto-resumes it). Dependent simply continues waiting; no special tracking needed.

A GATED predecessor whose PR later merges reclassifies to DONE the next time `classify_predecessor_state` runs (its label flips to `workflow:merged`; a merged predecessor gated on its phase trail reclassifies to DONE once a human removes `needs-human`) — this is exactly what the merge-triggered wake check (item 6.6 below) relies on.

**File-overlap edge re-verification** <!-- Added: forge#1904 --> — `classify_predecessor_state()` answers "is the predecessor resolved enough to proceed," but it says nothing about whether a specific Layer 1/2/3 file-overlap edge (`EDGE_KIND`/`EDGE_FILES`, tagged in `phase-3-dependency.md` Step 3C/3D) was ever real. Both were built from a **pre-build guess** — the predecessor's `FORGE:INVESTIGATOR` "Affected Files" list, or a raw issue-body parse if no investigation existed yet. Once a predecessor reaches FAILED, GATED, **or DONE**, that guess must be checked against ground truth (the predecessor's actual PR diff, or the absence of any PR) before the edge is allowed to keep blocking a dependent or to inject a same-file brief. Without this, a predecessor that reaches `needs-human` or `workflow:invalid` having never touched the guessed shared file (or never opened a PR at all) leaves its dependents gated/skipped on a conflict that never existed — and on the happy path, an over-serialized chain is never reconciled at all and stays serialized for its entire life (forge#2848).

```bash
verify_file_overlap_edge() {
  local PRED="$1"
  local DEP="$2"
  local EDGE_TYPE="${EDGE_KIND["${PRED}:${DEP}"]:-}"

  # Only Layer 1/2/3 structural edges (same-file / directory / shared-module, tagged in
  # phase-3-dependency.md Step 3C) are eligible for this check. Explicit `Depends on`, the
  # DATABASE domain chain, Layer 4 conservative-fallback edges, and Layer 5 co-change edges
  # never populate EDGE_KIND for a pair — they encode a declared or historical dependency,
  # not a guessed file list, and are NEVER dropped here.
  if [ -z "$EDGE_TYPE" ]; then
    echo "KEEP"
    return
  fi

  # Resolve PRED's PR using the same anchored search already used elsewhere in this file
  # (forge#1634/#1646/#1830 precedent — a bare "#${PRED}" substring grep would false-match
  # #50/#500 for predecessor #5, so this always goes through gh's search query, never a
  # hand-rolled grep against comment/PR body text).
  #
  # Exclude CLOSED-unmerged PRs (same precedent as the milestone-base-consistency check
  # elsewhere in this file: "a closed-but-not-merged PR is a superseded/abandoned routing
  # attempt and does NOT reflect the live lane"). For a FAILED (workflow:invalid) or GATED
  # (needs-human/workflow:awaiting-merge) predecessor this can only ever surface an OPEN PR —
  # a MERGED PR would already classify the predecessor DONE, not FAILED/GATED — so this filter
  # also guarantees `gh pr diff` below targets a live, still-open branch rather than an
  # abandoned PR whose branch may since have been force-deleted (e.g. by /cleanup).
  #
  # forge#2848 — the DONE call site widens what this can surface: for a DONE predecessor
  # the live PR is MERGED, not OPEN. That is the *better* case, not a problem — a merged
  # PR's diff is ground truth rather than a still-moving branch, and `gh pr diff` serves it
  # from the API, so it keeps working after the head branch is deleted on merge. The
  # CLOSED-unmerged exclusion is unchanged and still correct for all three call sites.
  local PRED_PR
  local PRED_PR_EXIT
  PRED_PR=$(gh pr list -R {GH_REPO} --state all --search "\"Closes #${PRED}\" in:body" \
    --json number,state --jq '[.[] | select(.state != "CLOSED")][0].number // empty' 2>/dev/null)
  PRED_PR_EXIT=$?

  if [ "$PRED_PR_EXIT" -ne 0 ]; then
    # Fail-safe: could not determine whether a live predecessor PR exists (transient API
    # error, rate limit, or search-index lag). Keep the edge rather than conflating a failed
    # lookup with confirmed absence of a PR and dropping a real conflict.
    echo "KEEP"
    return
  fi

  if [ -z "$PRED_PR" ]; then
    # Predecessor reached a terminal/gated state having never opened a PR (or only ever had
    # an abandoned/closed-unmerged one) — there is no live code that could possibly conflict
    # with DEP's files. The edge was based purely on the pre-build guess and never materialized.
    echo "DROP"
    return
  fi

  # A PR exists — compare the file(s) that actually triggered this edge (EDGE_FILES, set at
  # Layer 1/2/3 in phase-3-dependency.md) against the PR's real changed-file list.
  local ACTUAL_FILES
  local DIFF_EXIT
  ACTUAL_FILES=$(gh pr diff "$PRED_PR" -R {GH_REPO} --name-only 2>/dev/null)
  DIFF_EXIT=$?
  if [ "$DIFF_EXIT" -ne 0 ]; then
    # Fail-safe: could not fetch the actual diff (transient API error, rate limit, etc.) —
    # an empty result here must NOT be conflated with "confirmed no overlap." Keep the edge
    # blocking rather than risk dropping a real conflict on a fetch failure.
    echo "KEEP"
    return
  fi
  local EDGE_FILE_LIST="${EDGE_FILES["${PRED}:${DEP}"]:-}"

  local OVERLAP_FOUND=false
  for EF in $EDGE_FILE_LIST; do
    [ -z "$EF" ] && continue
    # Strip a trailing slash (Layer 2 directory-type edges store a bare directory path) and
    # escape regex metacharacters, then anchor the match to a path-component boundary. A raw
    # `grep -qF` substring test would let a short directory name like "utils" false-match an
    # unrelated path such as "some_utils_helper.py" or "shared_utils/" — anchoring on `/`
    # boundaries requires the shared file/directory to appear as a whole path segment.
    EF_CLEAN="${EF%/}"
    EF_ESCAPED=$(printf '%s' "$EF_CLEAN" | sed 's/[.[\*^$()+?{|]/\\&/g')
    if echo "$ACTUAL_FILES" | grep -qE "(^|/)${EF_ESCAPED}(/|$)"; then
      OVERLAP_FOUND=true
      break
    fi
  done

  if [ "$OVERLAP_FOUND" = "true" ]; then
    echo "KEEP"   # PR's actual diff confirms the shared file was really touched — real conflict
  else
    echo "DROP"   # PR exists but its actual diff never touched the guessed shared file(s) —
                  # the Layer 1/2/3 guess was wrong for this predecessor; the edge is spurious
  fi
}
```

**Call sites**: item 6 (FAILED handling, below), item 6.5 (GATED handling, below), and the DONE arm of the core streaming dispatch loop (below — see "DONE-path edge re-verification") all call this helper — once per `EDGE_KIND`-tagged predecessor edge — before cascading a skip or tracking `blocked-on-human-merge`. `phase-3-dependency.md`'s wake/compaction reconstruction block calls the identical logic (mirrored verbatim, not re-derived) for the case where the predecessor resolves after the orchestrator session has already ended — see that file's "Orchestrator state reconstruction on wake / after compaction" section. This mirroring is deliberate: keeping the check in exactly one function definition, called (not reimplemented) from both files, avoids the same drift class forge#1812 had to fix once already for DONE/GATED/FAILED classification itself.

**Recursive cascade note (item 6 only)**: when a dependent `DEP` is itself marked "skipped — dependency failed" (edge confirmed `KEEP`, not dropped), `DEP` becomes the new FAILED anchor for its own direct dependents — re-run this same `verify_file_overlap_edge` check at that next hop too, rather than assuming every transitive descendant is unconditionally skipped. A grandchild dependent whose only path to the failure runs through a spurious (droppable) edge one hop down must not be skipped just because its parent was.

**Never called from**: the `IN_PROGRESS` branch (nothing to re-verify yet — the predecessor hasn't concluded).

**DONE-path edge re-verification** <!-- Added: forge#2848 --> — the DONE branch *does* call this helper, and it is the only call site that fires on the happy path. Be precise about what it buys, because the obvious reading is wrong:

**It does NOT release the dependent.** A DONE predecessor already satisfies its own edge — see the `;; # satisfied` arm and the `ALL_PREDS_DONE` gate below. Dropping an edge whose predecessor is already DONE releases nobody, so re-verification alone cannot re-parallelize anything. What it actually buys is two things:

1. **Suppressing a spurious same-file brief.** The DONE arm spends up to three `gh api` comment fetches per edge and then injects a `SAME_FILE_BRIEF` excerpt into the dependent's dispatch context. When the predecessor's real diff never touched the guessed file, that brief is not merely wasted tokens — it actively misleads the agent into coordinating on a file the predecessor never wrote. Verifying **before** those fetches skips all three calls and the brief.
2. **Producing the disproof signal that enables re-derivation.** This is the part that actually re-parallelizes. A `DROP` on a `body-fallback`-provenance edge is evidence that the whole cohort's extraction is suspect: the first real diff has just contradicted the guess the chain was built on. By that point the still-blocked descendants have been investigated and possibly contracted, so re-running Layer 1 extraction against those now-higher-provenance sources and dropping edges that no longer hold is what collapses the chain. This is the step an operator performed by hand in the batch that motivated forge#2848; wiring it here makes it automatic.

**Core streaming dispatch loop**: After processing each agent completion, check the DAG for newly unblocked issues. If any issue now has all predecessors classified `DONE`, dispatch it immediately (run Steps 4A.pre.0, 4A.pre, and 4A for the newly ready issues). This is the key difference from the wave model — issues dispatch as soon as their specific predecessors complete, not after an entire group finishes.

```bash
# After each agent completion, check for newly ready issues:
READINESS_RESCAN=true
while [ "$READINESS_RESCAN" = "true" ]; do
  # Re-derivation can remove an unresolved predecessor from an issue that this
  # pass has already visited. Repeat the scan so it can dispatch this cycle.
  READINESS_RESCAN=false
for BLOCKED_NUM in {all_blocked_issue_numbers}; do
  ALL_PREDS_DONE=true
  ANY_PRED_GATED=false
  GATING_PREDS=()
  for PRED in {predecessors_of_BLOCKED_NUM}; do
    PRED_STATE=$(classify_predecessor_state "$PRED")
    case "$PRED_STATE" in
      DONE)
        # Same-file current-state brief forwarding (forge#1860): only fires when the
        # RESOLVED edge from this specific PRED to this specific BLOCKED_NUM is a
        # Layer 1/2/3 structural edge (EDGE_KIND set to same-file/directory/shared-module
        # in phase-3-dependency.md Step 3C) — never for explicit `Depends on`, the
        # DATABASE domain chain, Layer 4 conservative-fallback, or Layer 5 co-change edges,
        # since those never populate EDGE_KIND for this pair.
        EDGE_TYPE="${EDGE_KIND["${PRED}:${BLOCKED_NUM}"]:-}"
        if [ -n "$EDGE_TYPE" ] && [ -z "${EDGE_BRIEFED["${PRED}:${BLOCKED_NUM}"]:-}" ]; then
          EDGE_BRIEFED["${PRED}:${BLOCKED_NUM}"]=1

          # DONE-path edge re-verification (forge#2848). Runs FIRST — before the three
          # `gh api` brief fetches below — so a disproven edge costs zero extra API calls
          # and injects no brief. EDGE_BRIEFED is already set above, so a DROP is not
          # retried on the next completion cycle.
          #
          # Fail-safe direction is unchanged: verify_file_overlap_edge returns KEEP on any
          # fetch failure, so a transient API error can only ever preserve the brief, never
          # silently suppress a real one.
          EDGE_VERDICT=$(verify_file_overlap_edge "$PRED" "$BLOCKED_NUM")
          if [ "$EDGE_VERDICT" = "DROP" ]; then
            echo "DONE-path re-verification: edge #${PRED} → #${BLOCKED_NUM} (${EDGE_TYPE}, files: ${EDGE_FILES["${PRED}:${BLOCKED_NUM}"]:-?}) DROPPED — #${PRED}'s merged diff never touched the guessed file. Skipping same-file brief."

            # Leave SAME_FILE_BRIEF[$BLOCKED_NUM] UNSET rather than setting it empty —
            # the dispatch-context builder treats unset as the no-op case, and an empty
            # string would render an orphaned "shared file context" heading with nothing
            # under it.

            # Cohort re-derivation (forge#2848) — the step that actually releases
            # dependents. Gated on `body-fallback` provenance only: a DROP against a
            # contract- or investigation-derived list is a one-off miss, but a DROP
            # against a raw-issue-body scrape is evidence the whole cohort's extraction
            # is suspect (see phase-3-dependency.md Layer 4's cohort-confidence guidance).
            if [ "${FILE_SOURCE[$PRED]:-}" = "body-fallback" ] && [ -n "$AFFECTED_FILES_SCRIPT" ]; then
              # Re-derive only direct descendants of this DONE predecessor that
              # are still blocked now. This intentionally excludes unrelated
              # blocked issues and descendants whose PRED edge was already removed.
              STILL_BLOCKED_DESCENDANTS=()
              for CANDIDATE in {all_blocked_issue_numbers}; do
                case " ${PREDECESSORS[$CANDIDATE]:-} " in
                  *" $PRED "*) STILL_BLOCKED_DESCENDANTS+=("$CANDIDATE") ;;
                esac
              done
              for DESC in "${STILL_BLOCKED_DESCENDANTS[@]}"; do
                # Memoize conclusive results per descendant per batch. An inconclusive
                # extraction gets one retry so a transient failure or pre-contract
                # attempt does not permanently foreclose re-derivation. The two-attempt
                # cap preserves an O(descendants) API budget for the hot dispatch loop.
                [ -n "${EDGE_REDERIVED[$DESC]:-}" ] && continue
                REDERIVE_ATTEMPTS=${EDGE_REDERIVE_ATTEMPTS[$DESC]:-0}
                [ "$REDERIVE_ATTEMPTS" -ge 2 ] && continue
                EDGE_REDERIVE_ATTEMPTS[$DESC]=$((REDERIVE_ATTEMPTS + 1))

                # Re-run Layer 1 extraction. By now DESC has been investigated and
                # possibly contracted, so this typically returns a higher-provenance
                # list than the body scrape the original edge was built from. Resolve
                # the helper through the runtime path, never a bare `bash scripts/...`
                # (#2794) — same resolver precedence as phase-3-dependency.md Layer 1.
                REDERIVE_OUT=$(bash "$AFFECTED_FILES_SCRIPT" "$DESC" -R {GH_REPO})
                REDERIVE_PROV=$(echo "$REDERIVE_OUT" | head -1 | sed 's/^PROVENANCE=//')
                REDERIVE_FILES=$(echo "$REDERIVE_OUT" | tail -n +2)

                # Fail-safe: only act on a CONFIRMED-empty overlap. `error` means the
                # extraction was inconclusive (a `gh` call failed — forge#2504), and
                # `none`/`body-fallback` mean we learned nothing better than what we
                # already had. In all three cases keep every edge untouched.
                case "$REDERIVE_PROV" in
                  contract-deliverables|affected-files-section) EDGE_REDERIVED[$DESC]=1 ;;
                  *) echo "  re-derivation for #${DESC} inconclusive (provenance: ${REDERIVE_PROV}) — keeping all edges"; continue ;;
                esac

                # Re-derive only PRED's edge into DESC. PRED is the DONE predecessor
                # whose merged diff just disproved this edge; other predecessors may
                # still be building and must retain their serialization edges.
                for DESC_PRED in "$PRED"; do
                  [ -z "${EDGE_KIND["${DESC_PRED}:${DESC}"]:-}" ] && continue
                  STILL_OVERLAPS=false
                  for EF in ${EDGE_FILES["${DESC_PRED}:${DESC}"]:-}; do
                    [ -z "$EF" ] && continue
                    EF_CLEAN="${EF%/}"
                    EF_ESCAPED=$(printf '%s' "$EF_CLEAN" | sed 's/[.[\*^$()+?{|]/\\&/g')
                    if echo "$REDERIVE_FILES" | grep -qE "(^|/)${EF_ESCAPED}(/|$)"; then
                      STILL_OVERLAPS=true
                      break
                    fi
                  done
                  if [ "$STILL_OVERLAPS" = "false" ]; then
                    echo "  re-derived edge #${DESC_PRED} → #${DESC}: DROPPED — '${EDGE_FILES["${DESC_PRED}:${DESC}"]}' absent from #${DESC}'s refreshed ${REDERIVE_PROV} file list"
                    unset 'EDGE_KIND['"${DESC_PRED}:${DESC}"']'
                    unset 'EDGE_FILES['"${DESC_PRED}:${DESC}"']'
                    # Remove DESC_PRED from PREDECESSORS[$DESC] so the ALL_PREDS_DONE
                    # gate below stops waiting on it. DESC becomes dispatch-eligible on
                    # this same cycle if that was its last outstanding predecessor.
                    PREDECESSORS[$DESC]=$(echo "${PREDECESSORS[$DESC]}" | tr ' ' '\n' | grep -vx "$DESC_PRED" | tr '\n' ' ')
                    READINESS_RESCAN=true
                  fi
                done
              done
            fi

            # Edge disproven — nothing further to do for this (PRED, BLOCKED_NUM) pair.
            continue
          fi

          SHARED_FILE="${EDGE_FILES["${PRED}:${BLOCKED_NUM}"]:-}"

          # Prefer FORGE:BUILDER (the concrete "what changed" record). Fall back to
          # FORGE:ARCHITECT, then FORGE:INVESTIGATOR, for predecessors that never reached
          # implementation (e.g. closed workflow:invalid, or resolved via Phase 2 decomposition).
          BRIEF_SRC=$(gh api repos/{GH_REPO}/issues/${PRED}/comments \
            --jq '[.[] | select(.body | contains("FORGE:BUILDER"))] | last | .body // ""' 2>/dev/null)
          BRIEF_SRC_LABEL="FORGE:BUILDER"
          if [ -z "$BRIEF_SRC" ]; then
            BRIEF_SRC=$(gh api repos/{GH_REPO}/issues/${PRED}/comments \
              --jq '[.[] | select(.body | contains("FORGE:ARCHITECT"))] | last | .body // ""' 2>/dev/null)
            BRIEF_SRC_LABEL="FORGE:ARCHITECT"
          fi
          if [ -z "$BRIEF_SRC" ]; then
            BRIEF_SRC=$(gh api repos/{GH_REPO}/issues/${PRED}/comments \
              --jq '[.[] | select(.body | contains("FORGE:INVESTIGATOR"))] | last | .body // ""' 2>/dev/null)
            BRIEF_SRC_LABEL="FORGE:INVESTIGATOR"
          fi

          if [ -n "$BRIEF_SRC" ]; then
            # Scope the excerpt to the shared file — a few lines, never a raw diff or
            # full comment dump. Fall back to the comment's Approach/Changes section if
            # the file's basename doesn't literally appear (e.g. a directory-level edge).
            FIRST_SHARED_FILE=$(echo "$SHARED_FILE" | awk '{print $1}')
            EXCERPT=""
            if [ -n "$FIRST_SHARED_FILE" ]; then
              EXCERPT=$(echo "$BRIEF_SRC" | grep -iF "$(basename "$FIRST_SHARED_FILE" 2>/dev/null)" | head -3)
            fi
            [ -z "$EXCERPT" ] && EXCERPT=$(echo "$BRIEF_SRC" | sed -n '/### Approach/,/^### /p' | head -6)
            SAME_FILE_BRIEF["$BLOCKED_NUM"]="${SAME_FILE_BRIEF["$BLOCKED_NUM"]:-}
- **#${PRED}** (${EDGE_TYPE} edge, from its ${BRIEF_SRC_LABEL} comment, \`${SHARED_FILE:-shared file}\`): ${EXCERPT:-see #${PRED}'s ${BRIEF_SRC_LABEL} comment for details}"
          fi
        fi
        ;;  # satisfied — no dispatch-readiness action beyond the brief above
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
done
# Run Steps 4A.pre.0 → 4A.pre → 4A for newly ready issues. Step 4A's own dispatch-batch
# computation (the HEADROOM/DISPATCH_NOW logic, forge#1912) is what actually caps this —
# "newly ready" here just means "eligible," not "guaranteed to dispatch this cycle." Any
# issue that doesn't fit current headroom lands in DEFERRED_CONCURRENCY_ISSUES and is
# retried automatically on the next completion, same as every other concurrency-deferred issue.
```

**CRITICAL — Stall detection and recovery**: Background agents sometimes stop mid-pipeline (`stop_reason=end_turn`) after completing a sub-phase (e.g., investigation completes but build never starts). This causes the agent to "complete" from the Agent tool's perspective even though the `/work-on` pipeline is only partially done. When you receive a completion notification:

0. **Phase-trail verification (MANDATORY on EVERY merge completion, before classifying DONE)** <!-- Added: forge#3062 --> — a `workflow:merged` label alone is not proof the pipeline ran. **Scope (forge#3102)**: run it only when the issue carries `workflow:merged` (a failed label read fails closed). Issues in other terminal-for-this-agent states (`workflow:invalid`, `workflow:decomposed`, `needs-human`, `workflow:awaiting-merge`, paused) legitimately lack a full trail; classify them by label per Predecessor Classification, skip this verifier, and do NOT flag them as bypass or re-dispatch them. Run the deterministic verifier (add `--docs-only` for docs-only diffs):
   ```bash
   # FORGE_ROOT bootstrap (canonical; keep byte-identical across specs, guarded by scripts/forge-root.test.sh)
   FORGE_ROOT=""
   if [ -n "${FORGEDOCK_HOME:-}" ]; then case "$FORGEDOCK_HOME" in /*) FORGE_ROOT="$FORGEDOCK_HOME" ;; esac; else
     # Portable to bash 3.2 (macOS), BSD/GNU coreutils and zsh: no mapfile, no sort -V, no bare globs (zsh aborts on no match).
     _l="$HOME/.claude/commands/work-on.md"; _l="$(readlink -f "$_l" 2>/dev/null || readlink "$_l" 2>/dev/null)"; [ -n "$_l" ] && _l="$(dirname "$(dirname "$_l")")"
     # newest cached version first: numeric major.minor.patch of the version dir name only; a release outranks its pre-release (1.10.0 > 1.9.0 > 1.9.0-rc1)
     _v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ '$(NF-1)=="forgedock"{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$0}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5-)"
     _m="$(find -L "$HOME/.claude/plugins/marketplaces" -mindepth 1 -maxdepth 1 -type d -iname '*forgedock*' 2>/dev/null)"
     # '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
     _k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_v" "$_m")"
     while IFS= read -r _c; do
       case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
     done <<< "$_k"
   fi
   # forge#3102: only merged completions carry a full trail; invalid/decomposed/needs-human/awaiting-merge/paused do not.
   # Fail closed: a failed label read is an ERROR, never a skip.
   TRAIL_LABELS_READ_OK=0   # forge#3168: 1 only after a successful label read, so a failed read is distinct from an empty label set
   if ! TRAIL_LABELS=$(gh issue view {NUMBER} -R {GH_REPO} --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null); then
     TRAIL="PHASE_TRAIL: ERROR (could not read issue labels)"; TRAIL_RC=2   # infrastructure error, not a bypass (forge#3147)
   elif TRAIL_LABELS_READ_OK=1; ! echo ",$TRAIL_LABELS," | grep -q ',workflow:merged,'; then
     TRAIL="PHASE_TRAIL: SKIPPED (issue not workflow:merged — classified by label)"; TRAIL_RC=0
   elif [ -z "$FORGE_ROOT" ] || [ ! -f "$FORGE_ROOT/scripts/verify-phase-trail.sh" ]; then
     TRAIL="PHASE_TRAIL: ERROR (verify-phase-trail.sh not resolvable; set FORGEDOCK_HOME)"; TRAIL_RC=127   # fail closed
   else
     # forge#3123: a docs-only merged diff legitimately has no FORGE:QUALITY_GATE marker. Derive --docs-only from the
     # merged PR's diff with the SAME shared predicate as review-pr.md Phase 8 / work-on/review.md R1.5 (scripts/is-docs-only.sh, forge#3134). Fail closed: no PR / unreadable diff -> no flag.
     TRAIL_DOCS_FLAG="--code-diff"   # forge#3149: fail closed - no matched PR / unreadable or empty diff means NO docs-only waiver and no usable INVESTIGATION band
     # forge#3133: the text search is fuzzy and unordered, so `.[0]` can be an unrelated docs-only PR. Evaluate EVERY
     # matching merged PR and set the flag only if at least one matched AND all matched diffs are non-empty and docs-only.
     # forge#3149: the search is a fuzzy prefilter; the jq test below keeps only PRs whose body has the exact token
     # "Closes #{NUMBER}" NOT followed by another digit (so #31490 never matches #3149). --limit 100 is a generous cap on
     # merged PRs mentioning one issue (a pipeline issue normally has one closing PR).
     TRAIL_PRS=$(gh pr list -R {GH_REPO} --state merged --limit 100 --search "\"Closes #{NUMBER}\" in:body" --json number,body --jq '.[] | select(.body | test("Closes #{NUMBER}([^0-9]|$)"; "i")) | .number' 2>/dev/null)
     if [ -n "$TRAIL_PRS" ]; then
       TRAIL_ALL_DOCS=1
       for TRAIL_PR in $TRAIL_PRS; do
         # forge#3145: both sides of a rename (filename + previous_filename); `gh pr diff --name-only` collapses a rename to its destination.
         TRAIL_FILES=$(gh api --paginate "repos/{GH_REPO}/pulls/${TRAIL_PR}/files" --jq '.[] | .filename, (.previous_filename // empty)' 2>/dev/null) || TRAIL_FILES=""
         # Fail closed on truncation: files API caps at 3000 files; at/over the cap or an unreadable count -> not docs-only.
         TRAIL_CHANGED_N=$(gh api "repos/{GH_REPO}/pulls/${TRAIL_PR}" --jq .changed_files 2>/dev/null) || TRAIL_CHANGED_N=""
         case "$TRAIL_CHANGED_N" in ''|*[!0-9]*) TRAIL_FILES="" ;; *) [ "$TRAIL_CHANGED_N" -ge 3000 ] && TRAIL_FILES="" ;; esac
         if [ -z "$TRAIL_FILES" ] || [ ! -f "$FORGE_ROOT/scripts/is-docs-only.sh" ] || ! echo "$TRAIL_FILES" | bash "$FORGE_ROOT/scripts/is-docs-only.sh"; then TRAIL_ALL_DOCS=0; break; fi
       done
       [ "$TRAIL_ALL_DOCS" = "1" ] && TRAIL_DOCS_FLAG="--docs-only"
     fi
     TRAIL=$(bash "$FORGE_ROOT/scripts/verify-phase-trail.sh" {NUMBER} -R {GH_REPO} $TRAIL_DOCS_FLAG 2>&1); TRAIL_RC=$?
   fi
   echo "$TRAIL"
   ```
   Route on `TRAIL_RC` (forge#3147). Both non-zero cases fail closed: never `DONE`, never cascaded as a satisfied predecessor.
   - `TRAIL_RC -ge 2` (`PHASE_TRAIL: ERROR`: unreadable trail, unreadable labels, or 127 when the verifier is unresolvable) → classify as **BLOCKED (infrastructure)**, NOT a bypass. A re-dispatched `/work-on` would hit the same unreadable or unresolvable verifier in its resume preflight, so do NOT re-dispatch. Surface `PHASE TRAIL ERROR: #{NUMBER} — <TRAIL line>` in the operator status update, add `needs-human`, and continue with the rest of the batch.
   - `TRAIL_RC=1` (`PHASE_TRAIL: FAIL`) → classify as a **bypass** (handling below).

   **Transient GitHub outage** — if a worker returns (or the issue's latest blocker comment shows) a blocker starting with `github-unavailable:`, the issue is not human-gated: do not count it as `needs-human`/GATED. Re-dispatch it once after the other ready issues (the `/work-on` router already retried each phase twice). <!-- field test: GitHub HTTP 500 window -->

   On `PHASE_TRAIL: FAIL`, classify the issue as a **bypass**, never `DONE`. Classify ONLY on objective evidence — the trail verdict above and the issue's labels. Do NOT reclassify an issue from a worker's own narrative ("ran inline", "dispatched reviewers directly", "skipped an optional step"): every phase runs forked and the merge itself is gated (CI green on the exact merged commit, reviewed head or docs-only delta, phase trail), so a merged issue whose trail passes is DONE. Field evidence: narrative-based holds flagged spec-compliant behaviour and put 5 of 6 merged issues in a stress batch on needs-human. Surface it in the operator status update (`PHASE BYPASS: #{NUMBER} — missing: ...`) and do not cascade it as a satisfied predecessor.

   **Do NOT re-dispatch a merged issue** (forge#3148): `/work-on` Phase 0B stops on a closed or `workflow:merged` issue before its resume preflight, so a fresh agent exits without repairing anything and the predecessor would stay unresolved forever. The PR is already merged, so the gap can only be resolved by a human. Escalate it instead, which classifies it **GATED** (`classify_predecessor_state` holds `workflow:merged` + `needs-human` with no recorded release, regardless of the verifier; the comment is posted first, then the label, both verified), so item 6.5 tracks its dependents as `blocked-on-human-merge` instead of dispatching them. A merged issue whose trail could not be read (`TRAIL_RC -ge 2`, handled above) is escalated by the same block, so it is gated the same way. A bypass reported by the agent on a `workflow:merged` issue whose trail verifies is handled the same way (set `TRAIL_RC=1` before this block):
   ```bash
   # Only a merged issue is escalated here; an unmerged bypass is resumed by item 2 (see below).
   # Any non-zero rc on a merged issue escalates: rc 1 (missing phases) and rc >= 2 (unverifiable trail) alike,
   # because classify_predecessor_state() gates a merged predecessor on the escalation record plus the needs-human label.
   # forge#3156: also escalate when the label read itself failed: an unreadable issue cannot be proven unmerged, so
   # fail closed instead of posting nothing. forge#3168: key on TRAIL_LABELS_READ_OK, not an empty TRAIL_LABELS, so a
   # successfully read, label-less, non-merged issue is never escalated (read OK + empty labels => no escalation).
   if [ "$TRAIL_RC" -ne 0 ] && { [ "${TRAIL_LABELS_READ_OK:-0}" != "1" ] || echo ",${TRAIL_LABELS:-}," | grep -q ',workflow:merged,'; }; then
     if [ "${DRY_RUN:-false}" = "true" ]; then
       echo "[DRY-RUN] Would add needs-human and post FORGE:PHASE_TRAIL_FAILED on merged #{NUMBER}"
     else
       # hold_merged_trail (defined with classify_predecessor_state) posts the escalation comment FIRST (re-read before
       # posting, verified), then writes `needs-human` (read-back verified, retried). A merged + needs-human issue with no
       # comment classifies GATED regardless of the verifier. A failed half is reported on stderr and the operator must
       # hold dependents manually (residual: a human clearing the label after both comment attempts failed).
       hold_merged_trail {NUMBER} "${TRAIL}" || echo "PHASE TRAIL ESCALATION FAILED: #{NUMBER} — comment or needs-human not verified." >&2
     fi
   fi
   ```
   Never hand-post missing markers. A bypass report on an issue that is NOT merged (the agent stopped before merge) is not covered here: classify it by label and let item 2 resume it, because `/work-on`'s resume preflight re-runs each missing phase via `Skill(...)` before PR creation and merge.

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

2. **If the issue is NOT in a terminal-for-this-agent state** (`workflow:merged`, `workflow:invalid`, `needs-human`, or `workflow:awaiting-merge`), the agent stalled mid-pipeline. **Resume it immediately**. `workflow:engine-error` (forge#2261 — `bin/engine.mjs`'s headless engine terminating on an engine/tool-level failure rather than a genuine human-judgment block) is deliberately excluded from the terminal-for-this-agent set: a completed agent run ending there is treated exactly like any other stall and auto-resumed/retried here, up to the resume-cap in item 3 below — no human decision is pending, so there is nothing to gate on.

   **Two distinct resume mechanisms, dispatched by which map resolved the completion (fixed forge#2743)** — `AGENT_ISSUE_MAP`-resolved completions (Agent-spawn path) and `ENGINE_DISPATCH_MAP`-resolved completions (engine-first path) hit `workflow:engine-error` for structurally different reasons and need different recovery:

   **2a. Agent-spawn-dispatched issue (`AGENT_ISSUE_MAP[{NUMBER}]` set)** — unchanged from prior behavior. Resume the same agent in place:
   ```
   Agent(
     resume=AGENT_ISSUE_MAP[{NUMBER}],
     description="Resume #{NUMBER} pipeline",
     run_in_background=true,
     prompt="{UNMODIFIED_STEP_4A_TEMPLATE_RENDERED_FOR_{NUMBER}}"
   )
   ```

   **Resume/relaunch prompts are the verbatim Step 4A template** <!-- Added: forge#3062 -->: never write free-text resume instructions such as "continue from where you left off" or "finish the uncommitted work". Render the unmodified 4A template (and pass it through the prompt lint above) so the agent re-enters via `Skill(skill='{FORGE_SKILL_PREFIX}work-on', ...)` and `/work-on`'s own checkpoint routing plus the phase-trail resume preflight pick the earliest missing phase. A recovered worktree with uncommitted work is never a substitute for the skipped phases.

   **2b. Engine-first-dispatched issue (`ENGINE_DISPATCH_MAP[{NUMBER}]` set, no `AGENT_ISSUE_MAP` entry)** — `Agent(resume=...)` has nothing to resume here; the completed task was a backgrounded `Bash(command="forgedock run-issue ...")` call, not an `Agent()`. Re-issuing the identical `forgedock run-issue` command would just reproduce the same environmental failure. Instead, fall back to the Agent-spawn path for this ONE issue — but only when it is safe to do so:
   ```bash
   # Safety gate: only fall back when the engine run committed NOTHING — no branch, no PR, no
   # committed phases. Primary source: the `FORGE:STATE` HTML-comment block the engine already
   # mirrors onto the issue BODY on every phase transition (`bin/engine/state.mjs`/`projector.mjs`
   # — see phase-3-dependency.md "Engine mode (default)"), which carries `committed`/`branch`/`pr`
   # as real JSON — read it directly rather than screen-scraping terminal text:
   # NOTE (forge#2750 review fix): `bin/engine/state.mjs`'s `serializeState()` writes the block
   # as THREE separate lines — `<!-- FORGE:STATE`, the JSON payload, and `-->` — never all on one
   # line. A single-line `grep -oP '(?<=<!-- FORGE:STATE)[\s\S]*?(?=-->)'` NEVER matches this <!-- allowlist:portability — cited non-portable anti-pattern being replaced, not a command this spec runs -->
   # (GNU `grep -P` without `-z` operates per-line, not across newlines, regardless of `[\s\S]`)
   # — it always returns empty. Extract the block with a `sed` line-range instead, which handles
   # the real multi-line shape correctly:
   STATE_BLOCK=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body' \
     | sed -n '/<!-- FORGE:STATE/,/-->/p')
    STATE_JSON=$(echo "$STATE_BLOCK" | sed '1d;$d')
    if [ -n "$STATE_JSON" ]; then
      # Missing or schema-invalid fields are unverifiable, not empty. In particular, jq's
      # `length` is also zero for null, {}, and "", so require the committed array type first.
      # The persisted engine run ID and state version are also required: together they give every
      # orchestrator handling this same failure one stable scope while allowing a later failure
      # for the same issue/run name to elect a new claimant.
      if echo "$STATE_JSON" | jq -e \
        '(.run | type == "string" and test("^[A-Za-z0-9._:/-]+$")) and (.v | type == "number" and . >= 0 and floor == .) and (.committed | type == "array") and (.committed | length == 0) and (.branch == null) and (.pr == null)' \
        >/dev/null 2>&1; then
        STATE_RUN=$(echo "$STATE_JSON" | jq -r '.run')
        STATE_VERSION=$(echo "$STATE_JSON" | jq -r '.v')
        EMPTY_COMMITTED_STATE="true"
      else
        EMPTY_COMMITTED_STATE="false"
      fi
   else
     # No FORGE:STATE block was ever written to the issue body (e.g. the run failed before
     # phase 1 committed anything). There is no reliable structured signal available in this
     # case — fail SAFE: do NOT auto-fallback on an unverifiable state. This surfaces via the
     # existing stall-detection alert / needs-human path instead, exactly as before this fix.
     # (An earlier draft of this fix attempted a second fallback source — a
     # `committed=[] branch=null pr=null` diagnostic line assumed to be present in the
     # completed background Bash call's captured stdout — but no code in this file or
     # phase-3-dependency.md actually captures/populates that stdout into a named variable,
     # so that fallback was dead code reading an unset variable. Removed rather than wired up:
     # the FORGE:STATE block above is the engine's own durable, already-documented mirror of
     # this exact data and should always be present by the time a phase transition occurs;
     # treating its absence as "cannot verify, don't risk it" is the correct fail-safe.)
     EMPTY_COMMITTED_STATE="false"
   fi
   # A non-empty committed/branch/pr means real per-issue work exists that a fresh Agent-spawn
   # dispatch could collide with or duplicate — that case is NOT auto-fallen-back; it surfaces
   # via the existing stall-detection alert / needs-human path instead, exactly as before this fix.

   if [ "$EMPTY_COMMITTED_STATE" = "true" ]; then
     # Atomic-enough cross-session claim: post first, then elect the lowest server-assigned
     # comment ID for this batch. Concurrent claimants may both post, but exactly one can win.
     # Pagination is mandatory; any POST/list/parse failure fails closed and dispatches nothing.
      CLAIM_SCOPE="${STATE_RUN}:${STATE_VERSION}"
     CLAIM_TOKEN="${CLAIM_SCOPE}-{NUMBER}-$$-${RANDOM}"
     ENGINE_FALLBACK_BODY="<!-- FORGE:ENGINE_FALLBACK -->
   ## Engine-First Dispatch Failed — Falling Back to Agent-Spawn

   **Batch**: ${CLAIM_SCOPE}
   **Claim**: ${CLAIM_TOKEN}

   \`forgedock run-issue\` ended at \`workflow:engine-error\` with no committed phases, branch, or PR
   (\`committed=[] branch=null pr=null\`) — this is an environmental/tool failure (forge#2261), not a
   per-issue content failure, and nothing was committed that a fresh dispatch could collide with.
   Auto-falling back to the Agent-spawn \`/work-on\` path for this issue. See forge#2743."
     CLAIM_ID=$(gh api "repos/{GH_REPO}/issues/{NUMBER}/comments" --method POST \
       --raw-field body="$ENGINE_FALLBACK_BODY" --jq '.id' 2>/dev/null) || CLAIM_ID=""
      CLAIM_LIST_OK="true"
      CLAIM_IDS=$(gh api "repos/{GH_REPO}/issues/{NUMBER}/comments" --paginate \
        --jq ".[] | select(.body | split(\"\\n\") | (any(. == \"<!-- FORGE:ENGINE_FALLBACK -->\") and any(. == \"   **Batch**: ${CLAIM_SCOPE}\"))) | .id" \
        2>/dev/null) || CLAIM_LIST_OK="false"
     WINNER_CLAIM_ID=$(printf '%s\n' "$CLAIM_IDS" | grep -E '^[0-9]+$' | sort -n | head -1)
     CLAIM_WON="false"
     [ "$CLAIM_LIST_OK" = "true" ] && [ -n "$CLAIM_ID" ] && \
       [ "$CLAIM_ID" = "$WINNER_CLAIM_ID" ] && CLAIM_WON="true"

     # Reuse the SAME Agent-spawn template as Step 4A's "Agent-spawn path (fallback when forgedock
     # CLI unavailable)" section above (the `Agent(subagent_type="general-purpose", ...)` block
     # under "Copy this template. Fill in variables. Do not modify the structure:") verbatim —
     # HARD RULE 1 preserved. This is a fresh dispatch, not a resume: capture its returned agent
     # ID into AGENT_ISSUE_MAP so subsequent completions for this issue route through 2a above.
     if [ "$CLAIM_WON" = "true" ]; then
       Agent(
       subagent_type="general-purpose",
       model="{SUBAGENT_MODEL}",
       description="Work on {PROJECT_PREFIX}#{NUMBER} (engine-error fallback)",
       run_in_background=true,
       prompt="<same template body as Step 4A's Agent-spawn path — see the 'Agent-spawn path (fallback when forgedock CLI unavailable)' section above; fill {NUMBER}/{GH_REPO}/{REPO_PATH}/{LANE}/{PR_BASE}/{ISSUE_TITLE} exactly as that template does>"
       )
       AGENT_ISSUE_MAP[{NUMBER}] = <agent_id returned by the Agent() call above>
       # Re-occupies the worker slot this completion just freed (see "Concurrency slot release" above).
       ACTIVE_DISPATCH_COUNT=$((ACTIVE_DISPATCH_COUNT + 1))
     else
       echo "#{NUMBER}: engine fallback claim lost or could not be verified — no duplicate Agent dispatch."
     fi
   else
     echo "#{NUMBER}: engine-error with non-empty committed state (partial work exists) — NOT auto-falling back. Surfaces via standard stall-detection alert; forgedock resume-stalled remains available for manual/scripted recovery."
   fi
   ```

   **Resume ALL stalled agents in a single message** (parallel resume/fallback across 2a and 2b together). Do not wait between resumes. Each resume or fallback dispatch re-occupies a worker slot — increment `ACTIVE_DISPATCH_COUNT` by 1 per agent resumed/dispatched here (it was already decremented by the "Concurrency slot release" rule above when the stall was first observed as a completion). <!-- Added: forge#1912 -->

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
      ACTIVE_CLAIMS=$(read_active_claims "$COORD_NUM" 2>/dev/null || echo '[]')
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

5. **Check for newly unblocked issues** — run the DAG readiness check above. If any issues are now ready, run Steps 4A.pre.0 → 4A.pre → 4A for them. **Step 4A's own headroom computation is the cap** (forge#1912) — "batch all newly ready issues into a single dispatch message" means one message covers `DISPATCH_NOW` (ready issues that fit current headroom), not necessarily every newly-ready issue; any that don't fit go to `DEFERRED_CONCURRENCY_ISSUES` and retry on the next completion.

6. **Handle predecessor failures** — if a completed agent's issue classifies as `FAILED` (`workflow:invalid`, or an explicit build/test error — see Predecessor Classification above; `needs-human` and `workflow:awaiting-merge` are GATED, not FAILED — see item 6.5), check for dependent issues in the DAG.

   **Edge re-verification before cascading the skip** <!-- Added: forge#1904 -->: For each direct dependent `DEP` of the FAILED predecessor `PRED`, call `verify_file_overlap_edge "$PRED" "$DEP"` (defined above, alongside `classify_predecessor_state`). If the pair has no `EDGE_KIND` entry (explicit dependency, DATABASE chain, Layer 4/5 edge), the helper returns `KEEP` immediately and behavior is unchanged — cascade the skip as before. If the pair IS an `EDGE_KIND` edge (Layer 1/2/3) and the helper returns `DROP` (FAILED predecessor never opened a PR, or its PR's actual diff never touched the guessed shared file), do NOT cascade the skip through that specific predecessor for that specific dependent — remove `PRED` from `DEP`'s predecessor set instead. If `DEP` has other still-unresolved predecessors it continues waiting on them normally; if `PRED` was `DEP`'s only predecessor, `DEP` becomes immediately ready (run Steps 4A.pre.0 → 4A.pre → 4A for it this cycle). Only when the helper returns `KEEP` (or there is no `EDGE_KIND` entry) does the "skipped — dependency #{X} failed" outcome apply, unchanged from prior behavior.

   Report every dependent whose skip was avoided this way — e.g. "#{DEP} — predecessor #{PRED} failed but never touched the shared file(s); edge dropped, #{DEP} not skipped." For all remaining dependents (real `EDGE_KIND` overlap confirmed, or a non-`EDGE_KIND` edge type), mark them "skipped — dependency #{X} failed" and report them. Do NOT dispatch them.

6.4. **Auto-dispatch remediation against a `needs-human`-gated issue's own PR — runs unconditionally per completion, with or without dependents** <!-- Added: forge#1813, fixed: forge#2243 --> — item 6.5 below tracks the *dependents* of a `GATED` predecessor; this item handles the gated issue's own PR, which item 6.5/6.6 never re-drive on their own. **This check is bound directly to the issue that just completed — `PRED="$NUM"` (the same issue number carried from items 1-4 of this Step 4B sequence) — NOT to any `$PRED` produced by walking a dependent's predecessor list (item 5's readiness loop) or by item 6's FAILED-specific dependent-walk.** Run it for every completed agent, every cycle, regardless of whether that issue has any dependents in the DAG at all — a leaf issue (no dependents) is just as eligible as an issue that blocks others. Trigger condition: the completed issue classifies `GATED` **specifically via `needs-human`** — NOT `workflow:awaiting-merge`. That second state already means "remediated and re-reviewed to a clean verdict" (see forge#1810's guard) — dispatching remediation again would be redundant, not just wasteful, since there is nothing left to fix. A PR that reaches `workflow:awaiting-merge` now does so only when it targets `main` / the deploy gate (where `staging → main` is the genuine human gate and a human's merge click is required); a remediated-clean PR targeting a non-`main` base (`staging`, `milestone/*`) auto-lands to `workflow:merged` via remediate.md Phase M7's base-scoped auto-land bar (forge#2570) and never parks here. Either way this item's skip of `workflow:awaiting-merge` is unchanged.

   ```bash
   # Bind PRED to the issue that just completed — independent of item 5's dependent-walk loop
   # and item 6's FAILED-specific dependent-walk. This is the fix for forge#2243: a leaf issue
   # (no dependents) must still reach this check, since it never appears as a loop-bound $PRED
   # in either of those other contexts.
   PRED="$NUM"

   PRED_CURRENT_LABEL=$(gh issue view "$PRED" -R {GH_REPO} --json labels \
     --jq '[.labels[].name | select(. == "needs-human" or . == "workflow:awaiting-merge")] | .[0] // empty' 2>/dev/null)

   if [ "$PRED_CURRENT_LABEL" = "needs-human" ]; then
     # Resolve PRED's open PR using the anchored search (forge#1634/#1646 precedent —
     # never a bare-number search, which would misattribute an unrelated PR).
     GATING_PR=$(gh pr list -R {GH_REPO} --state open --search "\"Closes #${PRED}\" in:body" \
       --json number --jq '.[0].number // empty' 2>/dev/null || echo "")

     if [ -n "$GATING_PR" ]; then
       # Idempotency guard: only one remediation attempt per PR, ever (single-attempt
       # semantics — remediate.md's own Phase M0 enforces this too, but checking here
       # avoids spawning a redundant agent that would immediately no-op on entry).
       ALREADY_REMEDIATED=$(gh api repos/{GH_REPO}/issues/${GATING_PR}/comments \
         --jq '[.[] | select(.body | contains("FORGE:REMEDIATION"))] | length' 2>/dev/null || echo "0")

       if [ "$ALREADY_REMEDIATED" -eq 0 ]; then
         echo "Dispatching remediation for #{PRED}'s gating PR #{GATING_PR} (needs-human)"
         # Same Agent-spawn-fallback style as Step 4A's template — one background agent,
         # whose sole job is to invoke /work-on in remediation mode and let it run to
         # completion (AUTO-LANDED, HELD-AWAITING-MERGE, RE-ESCALATED, or UNFIXABLE — all
         # are terminal-for-this-agent; see work-on/remediate.md Output).
         Agent(
           subagent_type="general-purpose",
           model="{SUBAGENT_MODEL}",
           description="Remediate PR #{GATING_PR} (needs-human, blocks #{PRED})",
           run_in_background=true,
           prompt="You are remediating GitHub PR #{GATING_PR} for the {PROJECT_NAME} project (repo: {GH_REPO}), which is currently held at `needs-human` on its linked issue #{PRED}.

**YOUR MISSION**: Invoke `Skill(skill='{FORGE_SKILL_PREFIX}work-on', args='{GATING_PR} --remediate --issue {PRED} --repo {GH_REPO} --gh-flag {GH_FLAG}')` and let it run to completion. This is a self-contained flow: it classifies the gate first, replaces `needs-human` with `workflow:in-review` only for fixable remediation, checks out the PR branch, fixes any fixable review findings, re-reviews, and either auto-lands the PR, holds it at `workflow:awaiting-merge` for a human, re-escalates back to `needs-human`, or reports the block as policy-level and unfixable. Do NOT intervene manually — do not run raw git/gh commands yourself.

**DO NOT STOP EARLY**: if the Skill call returns without a terminal `REMEDIATE_RESULT.status`, invoke it again — it re-reads GitHub state and resumes. Terminal statuses are: `COMPLETE`, `ALREADY_DONE`, `UNFIXABLE`, `BLOCKED`.

Do not ask the user questions — you are running autonomously in the background."
         )
       fi
     fi
   fi
   ```

   This satisfies #1809 Q2 (the orchestrator auto-dispatches remediation against the gated issue itself — the exact gap forge#1812's item 6.5/6.6 left open, since those items only ever track and wake *dependents*, never the gated PR's own remediation) — and closes forge#2243 (the gap that #1812's fix left open for *leaf* issues with no dependents: because this item's `$PRED` binding was never made explicit and self-contained, it was only ever reached while walking a dependent's predecessor list, so a `needs-human` issue that has no dependents never got remediation dispatched and its CHANGES-REQUESTED PR re-reviewed the same unchanged commit forever). The remediation agent's outcome is picked up on the **next** completion-monitoring cycle of this same Step 4B loop: if it lands (`workflow:merged`), item 6.6 below fires normally and wakes any `blocked-on-human-merge` dependents (if any exist — a leaf issue simply has none to wake); if it holds/re-escalates, the issue simply remains `GATED` and item 6.5 continues tracking its dependents (if any) unchanged.

6.5. **Handle predecessor gating** (`GATED` — `needs-human` or `workflow:awaiting-merge`) <!-- Added: forge#1812 --> — if a completed agent's issue classifies as `GATED`, its direct dependents are neither dispatched nor marked failed/skipped. For each direct dependent `DEP` of the gated predecessor `PRED`:

   **Edge re-verification gate (run FIRST, before any tracking)** <!-- Added: forge#1904 -->:
   ```bash
   EDGE_VERDICT=$(verify_file_overlap_edge "$PRED" "$DEP")
   if [ "$EDGE_VERDICT" = "DROP" ]; then
     echo "#{DEP} — predecessor #{PRED} is GATED but its EDGE_KIND file-overlap edge does not hold (no PR ever opened, or its actual diff never touched the guessed shared file(s)). Dropping the edge — not tracking #{DEP} as blocked-on-human-merge for this predecessor."
     # Remove PRED from DEP's predecessor set. If DEP has other unresolved predecessors it
     # keeps waiting on those normally. If PRED was DEP's only predecessor, DEP is immediately
     # ready — run Steps 4A.pre.0 → 4A.pre → 4A for it this cycle (same as any other newly
     # ready issue in the core streaming dispatch loop above).
     continue   # skip the tracking block below entirely for this (PRED, DEP) pair
   fi
   # EDGE_VERDICT = KEEP (real EDGE_KIND overlap confirmed, or no EDGE_KIND entry at all —
   # explicit dependency / DATABASE chain / Layer 4-5 edges always fall through to KEEP and
   # proceed with tracking exactly as before this fix).
   ```

   **Existing tracking logic (unchanged for the KEEP case)**:
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
**Status**: This issue is ready to dispatch once #${PRED} is resolved: when its gating PR merges, or — if #${PRED} is already merged and held on its phase trail — when a human clears \`needs-human\` on it. No action needed — the orchestrator (live session via the item 6.6 sweep on every monitoring cycle, or the next \`/orchestrate\` invocation via phase-3-dependency.md's wake reconstruction) will auto-dispatch it as soon as #${PRED} classifies DONE."
     gh issue edit "$DEP" -R {GH_REPO} --add-label "blocked-on-human-merge" 2>/dev/null || true
   fi
   ```
   Do NOT dispatch `DEP`. Do NOT mark it skipped — it remains visibly tracked as `blocked-on-human-merge` in the DAG, re-evaluated on the next completion event, stall-detection pass, or session wake.

6.6. **Release sweep for blocked-on-human-merge dependents** <!-- Added: forge#1812, reworked: forge#3157 --> — run this sweep on **every monitoring cycle** (after items 5-6 of each completion cycle and in each stall-detection pass), not only when an agent just merged: a human clearing `needs-human` on an already-merged, trail-held predecessor (Step 4B item 0) fires no completion event, so a sweep keyed on the just-completed `$NUM` would leave its dependents held until the next `/orchestrate` wake. Every hold the orchestrator creates needs a matching release check on each cycle. The sweep re-classifies the gating predecessors of every `blocked-on-human-merge` dependent and releases a dependent once all of them classify `DONE`:
   ```bash
   # The per-cycle trail cache was already reset by init_trail_cache at the top of this cycle (see "Cycle-start cache
   # reset" in Step 4B); do NOT reset it here, that would be after items 5-6 and stall detection already read it.
   WOKEN=$(gh issue list -R {GH_REPO} --state open --label "blocked-on-human-merge" --json number \
     --jq '.[].number' 2>/dev/null || echo "")
   for DEP in $WOKEN; do
     GATING_PREDS=$(gh api repos/{GH_REPO}/issues/${DEP}/comments \
       --jq '[.[] | select(.body | contains("FORGE:BLOCKED_ON_HUMAN_MERGE")) | (.body | capture("Gating predecessor\\*\\*: #(?<p>[0-9]+)").p)] | unique | .[]' 2>/dev/null || echo "")
     [ -n "$GATING_PREDS" ] || continue
     STILL_GATED=false
     for GPRED in $GATING_PREDS; do
       [ "$(classify_predecessor_state "$GPRED")" = "DONE" ] || STILL_GATED=true
     done
     [ "$STILL_GATED" = "false" ] || continue
     # Idempotency: only dispatch if DEP hasn't already been dispatched by another path.
     DEP_ALREADY_DISPATCHED=$(gh issue view "$DEP" -R {GH_REPO} --json labels \
       --jq '[.labels[].name | select(startswith("workflow:"))] | length' 2>/dev/null || echo "0")
     if [ "$DEP_ALREADY_DISPATCHED" -eq 0 ]; then
       if [ "${DRY_RUN:-false}" = "true" ]; then echo "DRY_RUN: would release #${DEP} (remove blocked-on-human-merge, post FORGE:UNBLOCKED, dispatch)"; continue; fi
       # Durable marker FIRST (forge#3182 CONC-3): a crash between label removal and dispatch would otherwise strand DEP with no
       # hold label and no workflow:* label. Post FORGE:UNBLOCKED before removing the label (deduped against the last comment so a
       # retried cycle does not repeat it), so an interrupted release leaves durable evidence for a human or later recovery.
       LAST_DEP_COMMENT=$(gh issue view "$DEP" -R {GH_REPO} --json comments --jq '.comments[-1].body // ""' 2>/dev/null || echo "")
       case "$LAST_DEP_COMMENT" in "<!-- FORGE:UNBLOCKED -->"*) ;; *)
         gh issue comment "$DEP" -R {GH_REPO} --body "<!-- FORGE:UNBLOCKED -->
   All gating predecessor(s) (#$(echo $GATING_PREDS | sed 's/ /, #/g')) are now resolved — merged, or released by a human after a phase-trail hold — dispatching now. (Was tracked via a prior FORGE:BLOCKED_ON_HUMAN_MERGE comment.)" >/dev/null 2>&1 || { echo "WARNING: #${DEP} UNBLOCKED marker not posted — not releasing; retrying next cycle." >&2; continue; } ;;
       esac
       # Remove the hold label and verify it is gone (forge#3182). Fail CLOSED: a failed edit OR a failed/empty `view` is
       # "unverified" — skip dispatch and retry next cycle (the view result is captured separately, never piped into grep).
       gh issue edit "$DEP" -R {GH_REPO} --remove-label "blocked-on-human-merge" >/dev/null 2>&1 \
         || { echo "WARNING: #${DEP} label removal failed — not dispatching; retrying next cycle." >&2; continue; }
       if ! DEP_LABELS=$(gh issue view "$DEP" -R {GH_REPO} --json labels --jq '.labels[].name' 2>/dev/null) \
          || printf '%s\n' "$DEP_LABELS" | grep -qx "blocked-on-human-merge"; then
         echo "WARNING: #${DEP} label removal unverified — not dispatching; retrying next cycle." >&2
         continue
       fi
       # Re-check after removal: another path may have labelled DEP workflow:* in the meantime.
       DEP_ALREADY_DISPATCHED=$(gh issue view "$DEP" -R {GH_REPO} --json labels \
         --jq '[.labels[].name | select(startswith("workflow:"))] | length' 2>/dev/null || echo "0")
       [ "$DEP_ALREADY_DISPATCHED" -eq 0 ] || continue
       # Record a human release of a trail-held merged predecessor so the escalation stops gating (decay).
       for GPRED in $GATING_PREDS; do release_merged_trail "$GPRED"; done
       echo "#{DEP} unblocked (gating predecessors resolved) — dispatching immediately (Steps 4A.pre.0 → 4A.pre → 4A)."
       # Add DEP to the same-response dispatch batch
     fi
   done
   ```
   `release_merged_trail` is a no-op unless the predecessor carries an ACTIVE merged-trail escalation, so ordinary merges are unaffected. The classifier's per-cycle comment cache (reset at cycle start by `init_trail_cache`) bounds the escalation-comment reads to one per predecessor per cycle. For the case where the hold is released after the orchestrator session has already ended, the equivalent check runs in `phase-3-dependency.md`'s wake/compaction reconstruction on the next `/orchestrate` invocation — see that file's "Orchestrator state reconstruction on wake / after compaction" section.

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

8. **Post a status update** to the user after each agent reaches terminal state. Format is gated by `{NARRATION_MODE}` (resolved in `config.md` from `pipeline.narration`, default `"terse"`):

   **`terse` (default)** — one line per completion, no table, nothing repeated between completions:
   ```
   ✓ #{NUMBER} — {title} → PR #{PR} merged to {target}
   ✗ #{NUMBER} — {title} → {reason for failure}
   ⚠ #{NUMBER} — {title} → PR #{PR} blocked: review panel degraded (full fresh-session re-review required)
   ⚠ #{NUMBER} — {title} → PIPELINE BYPASS (no /work-on — PR invalid)
   ⏸ #{NUMBER} — {title} → PR #{PR} awaiting-merge (remediated + re-approved, `main`/deploy-gate base — human merge only, no diagnosis needed; non-`main` bases now auto-land to `workflow:merged` via remediate.md M7, forge#2570)
   🔗 #{NUMBER} — {title} → blocked-on-human-merge (gated by #{PRED}, will auto-dispatch on #{PRED} merge)
   ⏳ Progress: {completed}/{total} complete, {active} active, {blocked} blocked
   → Dispatched #{NEWLY_READY} (predecessor #{PRED} completed)
   ```

   **`verbose`** — same one-liners, plus a running per-completion recap table (title, PR, target, elapsed):
   ```
   ✓ #{NUMBER} — {title} → PR #{PR} merged to {target}

   | # | Title | PR | Target | Elapsed |
   |---|-------|----|--------|---------|
   {one row per issue completed so far in this batch}
   ```

   **This gate is cosmetic only** — it changes what prints to the terminal between completions, never which phases run or what gets committed. Step 6B's full tables (Implementation Results, Review-Spawned Issues, Batch Trajectory Analytics) always render once at the end regardless of `{NARRATION_MODE}`; terse mode just skips the redundant per-completion recap, since Step 6B already aggregates everything.

   `⏸` (awaiting-merge) is deliberately distinct from `⚠` (blocked/bypass) — do not collapse the
   two. `⚠` means the pipeline hit something it cannot resolve and a human must diagnose it;
   `⏸` means the PR already cleared re-review and only needs a merge click. `🔗` (blocked-on-human-merge,
   forge#1812) is distinct from both: it marks a DEPENDENT of a GATED predecessor (item 6.5) — the
   dependent itself has no problem at all, it is simply waiting on someone else's merge. See Phase 6's
   "Merge-Ready" report section (`phase-6-report.md` Step 6A.5/6B) for the batch-level rollup.

   Before printing a terminal status for a PR, inspect its labels. If it has `review-degraded`, print the dedicated blocked line above and retain the issue's `needs-human` state. Never report a degraded review as merged or awaiting-merge.

9. **Run staging integrity check** (from Step 4A-pre) if the completed agent merged a PR targeting staging.

**Termination condition**: All issues in the DAG have reached `DONE` or `FAILED` (merged, invalid, or skipped due to dependency failure) — OR are `blocked-on-human-merge` (item 6.5) with no further dispatchable work remaining in the batch. These two outcomes are reported differently: a batch where every issue is `DONE`/`FAILED` is a **clean drain**; a batch where one or more issues remain `blocked-on-human-merge` is a **paused drain** — the active dispatch loop stops (there is nothing left to do until a human merges a gating PR) but this MUST be reported as paused, not as fully complete (see `phase-6-report.md`'s `🔗 Blocked-on-Merge` section). `needs-human` predecessors with no open PR are neither — they remain GATED indefinitely until either a PR appears (dependent moves to blocked-on-human-merge) or the predecessor itself resolves; do not treat isolated `needs-human` issues with no dependents as blocking termination. When either drain condition is met, check whether deferred review-spawned findings exist (accumulated in `DEFERRED_FINDINGS` during Step 4C). If deferred findings exist → proceed to Step 4F (Completion Sweep). If no deferred findings → **call `cleanup_trail_cache` (Step 4B) and `release_orchestrator_lease()` (Step 4A-pre.-1)** — this is a clean/paused drain of this session's own dispatch loop, so the lease should not be left held for a now-idle session — then proceed to Phase 5. <!-- Added: forge#2627 -->

**Reminder — this is the normal-exit lease release, distinct from the interrupted-stop procedure**: whether the drain is clean or paused, this session is no longer actively dispatching, so its lease must be released here (or, for a paused drain, at minimum have its heartbeat refresh stop — see Step 4A-pre.-1). This complements, but does not replace, the **Stopping the orchestrator** procedure (Step 4A-pre.-0.5) which handles the abnormal case of a mid-dispatch interrupt.

**Relationship to `DEFERRED_CONCURRENCY_ISSUES` (forge#1912)**: A non-empty `DEFERRED_CONCURRENCY_ISSUES[]` never satisfies either termination condition above — it means dispatchable work exists but is temporarily held back by the concurrency cap, not that the DAG has stalled. Unlike `blocked-on-human-merge`, this is never reported as a "paused drain" requiring human action — it self-resolves automatically the moment any in-flight agent completes and frees a slot (Step 4A's `dispatch_headroom` recomputes every cycle). Only treat the DAG as drained once `DEFERRED_CONCURRENCY_ISSUES` is also empty.

**Relationship to `BATCH_FULLY_GATED` (item 6.7, forge#1814)**: A paused drain (above) describes the *original batch DAG* reaching a stable, non-progressing state. `BATCH_FULLY_GATED` is the mechanism that keeps that stable state from being masked by cascade churn — without it, Step 4C would keep dispatching new review-finding issues indefinitely (each with its own predecessors/dependents), so the DAG would never actually look "drained" even though the original batch's productive work stopped the moment the last non-gated issue completed. Once `BATCH_FULLY_GATED` is true, Step 4C stops adding new dispatchable work (rule 0 defers all newly-spawned findings), which lets the batch actually reach the paused-drain termination condition above instead of chasing an ever-growing cascade tail. Report this state using the idle report from item 6.7, not a plain "waiting for agents" message — the whole point is to make the pause visible and actionable (which PR(s) to merge), not silent.

**Anti-pattern — DO NOT DO THIS:**
- `sleep 60/120/180/300` loops to check status — you will be notified automatically
- Spawning separate "progress check" agents — they waste tokens and add noise
- Reading agent JSONL output files to check progress — use GitHub labels as the source of truth
- Polling the same status check repeatedly on a timer
- Waiting for a "batch" of completions before checking for newly ready issues — check after EVERY completion

### Step 4B.6: Predicate Re-Resolution (standing queries only)

<!-- Added: forge#2236 -->

**Purpose**: Phase 1 resolves `$ARGUMENTS` to an issue-number list exactly once (see `phase-1-resolve.md` "Predicate Persistence"). For a standing-query input (`ORIGINATING_QUERY_KIND == "query"` — everything except an explicit `#1 #2 #3` literal set), a new issue matching the same predicate can appear mid-run (a human files it, `/analytics` or `/signal-planner` create it, it gets added to the milestone) and is otherwise invisible to this batch until the operator re-invokes `/orchestrate` by hand. This step closes that gap for the *originating* issue set, distinct from Step 4C which folds in review-findings spawned *by* this batch's own agents.

**Skip entirely if** `ORIGINATING_QUERY_KIND == "literal"` (see `phase-1-resolve.md`) — an explicit issue-number list is the complete intent; there is nothing to re-resolve, ever.

**Trigger** (event-driven, same model as the rest of this file — no sleep/poll timer): run once per Step 4B completion cycle, immediately after the per-agent-completion handling above and before Step 4B.5's stall check.

```bash
# Gate on config + literal/query kind + round cap via bin/engine/resolve.mjs's
# shouldReResolve (mirrors admission.mjs's role for Step 4C's admission rules).
RERESOLVE_ENABLED=$(yq '.orchestration.reresolve.enabled // true' forge.yaml 2>/dev/null || echo "true")
RERESOLVE_MAX_ROUNDS=$(yq '.orchestration.reresolve.max_rounds // "unbounded"' forge.yaml 2>/dev/null || echo "unbounded")

# FORGE_ROOT bootstrap (canonical; keep byte-identical across specs, guarded by scripts/forge-root.test.sh)
FORGE_ROOT=""
if [ -n "${FORGEDOCK_HOME:-}" ]; then case "$FORGEDOCK_HOME" in /*) FORGE_ROOT="$FORGEDOCK_HOME" ;; esac; else
  # Portable to bash 3.2 (macOS), BSD/GNU coreutils and zsh: no mapfile, no sort -V, no bare globs (zsh aborts on no match).
  _l="$HOME/.claude/commands/work-on.md"; _l="$(readlink -f "$_l" 2>/dev/null || readlink "$_l" 2>/dev/null)"; [ -n "$_l" ] && _l="$(dirname "$(dirname "$_l")")"
  # newest cached version first: numeric major.minor.patch of the version dir name only; a release outranks its pre-release (1.10.0 > 1.9.0 > 1.9.0-rc1)
  _v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ '$(NF-1)=="forgedock"{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$0}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5-)"
  _m="$(find -L "$HOME/.claude/plugins/marketplaces" -mindepth 1 -maxdepth 1 -type d -iname '*forgedock*' 2>/dev/null)"
  # '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
  _k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_v" "$_m")"
  while IFS= read -r _c; do
    case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
  done <<< "$_k"
fi
# Run ForgeDock's OWN orchestrate-canary.mjs from FORGE_ROOT, never from the consumer {REPO_PATH}.
# Unresolved/missing => no result, so reResolve is treated as false for this cycle (fail closed, loudly).
if [ -n "$FORGE_ROOT" ] && [ -r "$FORGE_ROOT/bin/engine/orchestrate-canary.mjs" ]; then
  node "$FORGE_ROOT/bin/engine/orchestrate-canary.mjs" \
    "$ORIGINATING_QUERY_KIND" "$ORIGINATING_QUERY_PATTERN" \
    "$RERESOLVE_ENABLED" "$RERESOLVE_MAX_ROUNDS" "$RERESOLVE_ROUNDS_SO_FAR"
else
  echo "WARNING: ForgeDock install root unresolved or orchestrate-canary.mjs missing (set FORGEDOCK_HOME) — skipping re-resolution this cycle" >&2
fi
```

If the result's `reResolve` is `false` (off switch, or `RERESOLVE_ROUNDS_SO_FAR` has reached `max_rounds` — bounded termination per the issue's acceptance criteria), skip this step for the current cycle and log the reason. `RERESOLVE_ROUNDS_SO_FAR` starts at 0 for the batch and increments once per cycle this step actually runs (declare it alongside the other Step 4A.pre batch-scope accumulators — do not re-initialize per completion).

**Re-run the original query** using the exact same resolution logic Phase 1 used for `$ORIGINATING_QUERY_PATTERN`/`$ORIGINATING_QUERY_ARGS` (e.g. re-run the `gh issue list --milestone`/`--label`/`priority:P*` fetch from `phase-1-resolve.md`'s "Fetch the issues" section), applying the exact same eligibility filter Phase 1 applied (`phase-4-execution.md` cross-reference: `phase-1-resolve.md` "Filter out ineligible issues" — closed/`needs-human`/`workflow:decomposed`/`workflow:awaiting-merge` excluded, same as T0).

**Fold new matches through the existing admission path — never a bypass**:

```bash
# FORGE_ROOT bootstrap (canonical; keep byte-identical across specs, guarded by scripts/forge-root.test.sh)
FORGE_ROOT=""
if [ -n "${FORGEDOCK_HOME:-}" ]; then case "$FORGEDOCK_HOME" in /*) FORGE_ROOT="$FORGEDOCK_HOME" ;; esac; else
  # Portable to bash 3.2 (macOS), BSD/GNU coreutils and zsh: no mapfile, no sort -V, no bare globs (zsh aborts on no match).
  _l="$HOME/.claude/commands/work-on.md"; _l="$(readlink -f "$_l" 2>/dev/null || readlink "$_l" 2>/dev/null)"; [ -n "$_l" ] && _l="$(dirname "$(dirname "$_l")")"
  # newest cached version first: numeric major.minor.patch of the version dir name only; a release outranks its pre-release (1.10.0 > 1.9.0 > 1.9.0-rc1)
  _v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ '$(NF-1)=="forgedock"{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$0}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5-)"
  _m="$(find -L "$HOME/.claude/plugins/marketplaces" -mindepth 1 -maxdepth 1 -type d -iname '*forgedock*' 2>/dev/null)"
  # '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
  _k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_v" "$_m")"
  while IFS= read -r _c; do
    case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
  done <<< "$_k"
fi
# Import ForgeDock's OWN resolve.mjs from FORGE_ROOT, never from the consumer {REPO_PATH}.
# Unresolved/missing => no output, so no new matches are folded this cycle (fail closed, loudly).
if [ -n "$FORGE_ROOT" ] && [ -r "$FORGE_ROOT/bin/engine/resolve.mjs" ]; then
  node -e '
  import(require("node:url").pathToFileURL(process.argv[1]).href).then(({ foldNewMatches }) => {
    const reResolved = JSON.parse(process.argv[2]);
    const processed = JSON.parse(process.argv[3]);
    console.log(JSON.stringify(foldNewMatches(reResolved, processed)));
  }, () => process.exit(0));
  ' "$FORGE_ROOT/bin/engine/resolve.mjs" "$RERESOLVED_NUMBERS_JSON" "$ALL_BATCH_ISSUE_NUMBERS_JSON"
else
  echo "WARNING: ForgeDock install root unresolved or resolve.mjs missing (set FORGEDOCK_HOME) — re-resolved matches not folded this cycle" >&2
fi
```

`newMatches` from `foldNewMatches` are candidate issues, not admitted ones. Each one MUST be dispatched through the exact same path a T0-resolved issue takes — DAG dependency analysis (`phase-3-dependency.md`), then Step 4A/4B's standard `dispatch_headroom`-gated dispatch — **not** through Step 4C's review-finding-specific `evaluateCascadeFinding` chain (that gate's rules, e.g. the comment/typo keyword heuristic, are shaped for cascade-spawned findings, not arbitrary re-resolved issues). This is the same non-bypass requirement Step 4C already satisfies for its own admission stream; this step must not become a second, ungated entry point into the DAG. Add every `newMatch` to `ALL_BATCH_ISSUE_NUMBERS` (so a later re-resolution round or Step 4C sees it as already processed) and to `SORTED_READY_SET`/the DAG exactly as Step 4A.pre.0 processes a T0-resolved issue.

**Reporting (mandatory — do not let this become an alert-only dead-code path, per forge#1832)**: track which issues were T0-resolved vs. admitted via re-resolution, and which round each entered in. Surface this distinction in the final report (`phase-6-report.md`) rather than only in a log line — a run whose predicate still matches unadmitted work at exit (round cap or config disabled mid-run) must say so explicitly, not report a silent clean drain.

**Multi-repo**: for `all-repos`/satellite-scoped queries (`next <N> all-repos`, `mcp:fast`, etc.), re-run the query against every repo the original resolution covered — not just the default repo.

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

**This step is the mid-run half of the run-spawned cascade mode** (`phase-1-resolve.md`
"Cascade / Review-Finding Resolution" — mode (a)). It scopes to `BATCH_T0` for the same reason
that resolve step does: this loop must only ever fold in `review-finding` issues *this batch's own
agents* produced, never the pre-existing open backlog. There is no whole-backlog-sweep mode here —
that mode only exists as the explicit, one-shot `--include-backlog` opt-in at Phase 1 resolve time
(a human directly asking for it); Step 4C runs autonomously on every completion cycle and must
never silently widen to the full backlog regardless of any flag, since nothing here is a
human-in-the-loop request. <!-- Added: forge#2628 -->

### Step 4C.0: Full-repository actionable-issue intake (`policy: all` only)

An operator-authorised `orchestration.cascade.policy: all` run must also check for newly-created
open issues that its own agents did not report and that lack `review-finding`. Run this sweep
after every five terminal completions, before the next dispatch cycle. It is not a cascade
replacement: Step 4C's `BATCH_T0` filter still governs review-finding recursion.

At batch start, seed `SEEN_OPEN_ISSUES` with the initial resolved issue set. On each sweep, list
the complete open set (`gh issue list --state open --limit 500 --json number,title,labels`), diff
it against `SEEN_OPEN_ISSUES`, then mark every returned number seen whether or not it is admitted.
For each newly-seen issue, add it to the normal Phase 3 DAG intake only when it has no terminal or
in-progress workflow label, `needs-human`, or `workflow:decomposed`; preserve its labels and
record why every excluded issue was skipped. Do not filter on `review-finding`, author, creation
time, or agent trajectory. This is how CI-created issues enter an all-policy run without silently
adopting pre-existing work in other policies.

```bash
if [ "$CASCADE_POLICY_NAME" = "all" ] && [ "$((TERMINAL_COMPLETIONS % 5))" -eq 0 ] && \
   [ "$TERMINAL_COMPLETIONS" -gt "$FULL_REPO_SWEEP_COUNT" ]; then
  FULL_REPO_SWEEP_COUNT=$TERMINAL_COMPLETIONS
  FULL_REPO_OPEN=$(gh issue list -R {GH_REPO} --state open --limit 500 --json number,title,labels)
  while IFS= read -r ISSUE; do
    NUM=$(echo "$ISSUE" | jq -r '.number')
    [ -n "${SEEN_OPEN_ISSUES[$NUM]:-}" ] && continue
    SEEN_OPEN_ISSUES[$NUM]=1
    LABELS=$(echo "$ISSUE" | jq -r '[.labels[].name] | join(",")')
    if echo "$LABELS" | grep -qE '(^|,)(workflow:(merged|invalid|awaiting-merge|building|in-review|decomposed)|needs-human)(,|$)'; then
      echo "Full-repo intake: #${NUM} seen but not admitted (terminal, in-progress, or human-gated)"
      continue
    fi
    FULL_REPO_INTAKE+=("$NUM")
    echo "Full-repo intake: admitted newly-seen actionable issue #${NUM}"
  done < <(echo "$FULL_REPO_OPEN" | jq -c '.[]')
  # Feed FULL_REPO_INTAKE through the existing Phase 3 extraction/DAG/claims gates.
fi
```

### Step 4C.1: Mechanical automated-alert deduplication (`policy: all` opt-in)

`orchestration.cascade.dedup_automated: true` permits a narrow exception to the normal
no-dedup rule for newly-seen automated alerts. Select one lowest-numbered canonical issue and
close another issue only when all of these are true: both authors are bot/app accounts; normalized
titles are identical; the generator identity is identical; the triggering condition is identical;
and the closing comment links the retained canonical issue. Never apply title similarity to a
human-authored report, or when generator/trigger provenance is absent or differs. The reference
predicate is `canDeduplicateAutomatedAlert()` in `bin/engine/admission.mjs`.

This opt-in handles mechanically identical alerts, not substantive bug adjudication. All other
possible duplicates remain separate and go through investigation.

```bash
# Method 1: Read TRAJECTORY comments from completed issues for "Finding issues" row
for NUM in {completed_issue_number}; do
  gh api repos/{GH_REPO}/issues/${NUM}/comments \
    --jq '.[] | select(.body | contains("FORGE:TRAJECTORY")) | .body' 2>/dev/null \
    | grep -oP 'Finding issues\s*\|\s*#?\K\d+[^|]*' | grep -oP '\d+' | sort -u
done

# Method 2 (fallback): Check for review-finding issues created since this batch started
# (BATCH_T0 — see Step 4A.pre above; reused from phase-1-resolve.md's Phase 1 capture, never
# a rolling "N hours ago" window). A rolling window can still admit pre-existing backlog
# issues that happen to have been created recently for reasons unrelated to this batch;
# anchoring to BATCH_T0 cannot, by construction — anything created before this batch began
# is excluded regardless of how recent it looks.
gh issue list -R {GH_REPO} --state open --search "label:review-finding created:>=${BATCH_T0}" --limit 20 \
  --json number,title,body,createdAt
```

```bash
# Run once for each completed issue before collecting its findings. Only merged
# units advance the denominator; invalid/skipped units do not imply delivered work.
# The ratio observation for this unit is recorded AFTER its findings are counted, in the
# "Amplification settle" block that follows the Step 4C rule loop (forge#3060) — recording it
# here would lag by one unit and could never reach 1.0 at exactly one finding per merged unit.
UNIT_MERGED_THIS_CYCLE=false
if gh issue view "$NUM" -R {GH_REPO} --json labels \
  --jq '[.labels[].name | select(. == "workflow:merged")] | length' | grep -qx '1'; then
  MERGED_UNITS=$((MERGED_UNITS + 1))
  UNIT_MERGED_THIS_CYCLE=true
fi

```

**Unconditional unit accounting (forge#3060):** the merged-unit accounting block and the "Amplification settle" block below run for EVERY completed unit, including a merged unit that spawned ZERO review-findings (an empty `{spawned_finding_numbers}` list simply makes the rule loop a no-op). Skipping them for finding-free units would leave the ratio history containing only finding-producing units (every observation >= 1.0) and the breaker could never release.

**If review-finding issues were spawned:**

**Amplification accounting (MANDATORY, before cascade admission):** Count every finding created by this batch, including findings later deferred by any cascade rule. After each merged unit, compute `FINDINGS_SPAWNED / MERGED_UNITS`, append the value to `AMPLIFICATION_RATIO_HISTORY`, and print a convergence warning when the latest `CONVERGENCE_WINDOW` observations are all `>= 1.0`. A high ratio is a signal, not a failure: valuable deep review findings can legitimately raise it.

For each finding, extract its source PR from `**Source**: PR #N` and increment `FINDINGS_BY_SOURCE_PR[N]`. Classify it as a **same-lineage refinement** only when that source PR closes a `review-finding` issue and both that parent finding and this finding name the same affected file; otherwise classify it as **new surface**. Record the finding number in `REFINEMENT_FINDINGS` or `NEW_SURFACE_FINDINGS` respectively. If provenance or a file path cannot be established, classify as new surface conservatively; never suppress it as a refinement.

When `CASCADE_MAX_AMPLIFICATION` is not `off`, and the current ratio is greater than that ceiling, defer only newly discovered entries in `REFINEMENT_FINDINGS` with reason `amplification bound exceeded (same-lineage refinement)`. Add them to `DEFERRED_FINDINGS` and `DEFERRED_REASONS` so Step 4F re-evaluates them after the batch drains. Do not apply this bound to new-surface findings, P1/P2 findings, or any finding when the option is `off`.

**Amplification breaker (on by default — forge#3060):** `max_amplification` above only ever sees same-lineage refinements, but most cascade growth is *new-surface* P3 hardening notes on code the batch just wrote. The breaker therefore counts **all** cascade findings: while `AMPLIFICATION_BREAKER_TRIPPED=true` (the latest `CONVERGENCE_WINDOW` ratios are all `>= 1.0`; see the block below), every P3-and-below finding is deferred under rule 6 (below) regardless of lineage. Deferred P3s are not discarded — they stay eligible for the P3 batch sweep (`planP3BatchGroups()`, with `batchExclusionReason()` unchanged: security/billing/domain findings stay unbatched and individually triaged) and for Step 4F's post-drain re-evaluation. P1/P2 findings are admitted exactly as before. The breaker releases when the newest ratio drops below 1.0. It is independent of `orchestration.cascade.policy`; only an explicit `amplification_breaker: off` disables it.

**Override guardrail (MANDATORY — forge#3060):** An operator directive that lifts the generation cap or token budget (`policy: all`, `--max-generation unlimited`, `--token-budget unlimited`, or a free-text request like "pick up any new issues") widens what is admitted at Phase 1/rule 1/rule 5; it MUST NOT leave P3 cascade unbounded. When such an override is active: (a) keep `AMPLIFICATION_BREAKER=on` unless the operator explicitly set `amplification_breaker: off`; (b) P1/P2 stay unlimited; (c) P3-and-below findings are never dispatched individually — they route through `planP3BatchGroups()` into bounded batches (`batch_max_generation` stays finite); (d) state the replacement bound in the Step 4B/4C status output. An orchestrator MUST NOT satisfy an override by simply deleting a bound without a replacement.

**Status updates (MANDATORY):** every Step 4B/4C status update must include `amplification={FINDINGS_SPAWNED}/{MERGED_UNITS}={AMPLIFICATION_RATIO} breaker={AMPLIFICATION_BREAKER}/{tripped|clear} p3_paused={#AMPLIFICATION_BREAKER_DEFERRED[@]}` so the operator sees divergence before the pipeline does.


**Cascade control (MANDATORY — run before folding findings into the DAG):**

For each spawned finding, determine whether it should be **executed** or **deferred**:

**Evaluation order** (first matching rule wins):
0. **Batch fully human-gated** (`BATCH_FULLY_GATED == true`, always defer, even for P1/P2) <!-- Added: forge#1814 -->: The original batch (see Step 4B item 6.7) has exhausted into DONE/FAILED/GATED with nothing left `IN_PROGRESS` — the real blockers are the GATED issues, not a lack of dispatchable findings. Dispatching a new review-finding here cannot produce net batch progress; it only inflates the open-issue count while the productive path waits on a human merge. Always defer, checked before generation and priority. Rationale: this is the idle/backpressure policy this issue adds — without it, rule 2 (below) unconditionally executes P1/P2 findings regardless of how gated the rest of the batch is, which is the root cause of the net-negative churn this policy exists to stop. **Configurable** via `orchestration.cascade.defer_on_batch_gated` (default `true`; `false` under `policy: all` — forge#2234).
1. **Generation ≥ 2** (always defer from individual autonomous dispatch, even for P1/P2, for mid-run cascade — see scope note below): Finding was spawned by an issue that was itself a review-finding. A P3 finding at or below the finite `orchestration.cascade.batch_max_generation` ceiling (default 2) is retained only as a candidate for the bounded P3 batch pass; it remains deferred if no batch forms. A formed batch records `FORGE:BATCH_MAX_GENERATION` and its generation-2+ members. No P1/P2, or finding above that ceiling, takes this exception. Rationale: gen-2+ individual cascade is theoretically unbounded — cap it here while permitting one auditable aggregation unit. **Scope**: this rule caps *autonomous* cascade — findings discovered and re-triaged automatically during an unattended run. It is not a cap on what a human can explicitly request. When an operator directly asks for cascade/review-finding work via `phase-1-resolve.md`'s dedicated `cascade`/`review-findings`/`findings` resolution (with `--include-deferred`/`--allow-gen2`, or the `orchestration.cascade.max_generation` config lever from #2234), those findings enter the DAG through Phase 1 resolution, not through this Step 4C mid-run triage. `batch_max_generation` is separate from `max_generation`, and remains finite even under `policy: all`. <!-- Added: forge#2231, forge#2849 -->
2. **Priority override** (P1 or P2 → always execute): If the finding is labeled P1 or P2, skip all remaining heuristics and execute. Rationale: high-priority findings must never be suppressed by keyword matching.
3. **Comment/typo heuristic** (P3 and below only): Finding title contains the word "comment" or "typo" (case-insensitive). These are 1-line cosmetic fixes that do not block other work. **Configurable** via `orchestration.cascade.keyword_heuristic` (default `true`; `false` under `policy: all` — forge#2234).
4. **P3 + same-file overlap**: Finding is labeled `P3` AND the file it targets overlaps with ANY file already in the current batch (active or queued in the DAG). Rationale: same-file P3 findings add predecessor edges that serialize agents — one finding per original issue increases wall-clock time with no proportional value. **Configurable** via `orchestration.cascade.p3_same_file_defer` (default `true`; `false` under `policy: all` — forge#2234).
5. **Per-batch token budget** (P3 and below only, applied AFTER surface-area batching below — see "Per-batch token budget gate") <!-- Added: forge#1858 -->: Once `BATCH_TOKEN_SPEND` would exceed `TOKEN_BUDGET`, additional P3-and-below units (an unclubbed finding, or an already-clubbed batch issue) defer rather than dispatch. This is NOT part of the per-finding rule 0-4 chain immediately below — it is a quantity gate applied to the POST-clubbing `QUEUED_FINDINGS` list, so a same-run surface-area batch issue (surface-area batching below) is charged once for the whole cluster, not once per member. P1/P2 are NEVER gated by it (they are excluded by rule 2 before reaching this gate, same as they are excluded from rules 3-4). **Configurable** via `orchestration.cascade.token_budget` (default `900000`, deprecated alias `pipeline.token_budget_per_batch`; `unlimited` under `policy: all` — forge#2234). This is a distinct, independent lever from rule 1's generation cap — "admit gen-2, stop at gen-3" (`max_generation: 3`) and "admit cascade until N tokens" (`token_budget: N`) can each be set without the other.

6. **Amplification breaker** (P3 and below only — P0/P1/P2 and untriaged findings are never gated; forge#3060): `AMPLIFICATION_BREAKER=on` AND the breaker is tripped (re-evaluated live per finding). Defer with reason `amplification breaker tripped` (appended to any earlier defer reason); the finding is routed to the bounded P3 batch planner and Step 4F never dispatches it individually. Checked last, after the other rules. **Configurable** via `orchestration.cascade.amplification_breaker` (default `on`, not changed by any `cascade.policy` preset).

**Defer** (do NOT add to the DAG) if rules 0, 1, 3, 4, 5, or 6 match.

**Execute** (add to the DAG) if:
- Rule 2 matches (P1 or P2) — AND rule 0 did not already match (rule 0 is checked first and overrides rule 2)
- None of the defer rules matched (generation 1, P3 with no file overlap, not a keyword match, batch not fully gated) AND rule 5's token budget still has headroom for this unit

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
# Use the same bounded ancestor walk as Phase 1 so batching records actual depth,
# not just whether the immediate source is a review finding.
compute_finding_generation() {
  local body="$1" generation=1 hops=0 source_num source_data
  while [ "$hops" -lt 10 ]; do
    source_num=$(echo "$body" | grep -ioE 'spawned from issue #[0-9]+|source issue[: #]+[0-9]+' | head -1 | grep -oE '[0-9]+$')
    [ -z "$source_num" ] && break
    source_data=$(gh issue view "$source_num" -R {GH_REPO} --json labels,body 2>/dev/null) || break
    echo "$source_data" | jq -e '[.labels[].name] | index("review-finding")' >/dev/null 2>&1 || break
    generation=$((generation + 1))
    body=$(echo "$source_data" | jq -r '.body')
    hops=$((hops + 1))
  done
  echo "$generation"
}

# For each finding, check its priority label and generation
# NOTE: DEFERRED_FINDINGS, QUEUED_FINDINGS, and DEFERRED_REASONS are declared at
# batch scope in Step 4A.pre — do NOT re-initialize them here (Step 4C runs per-agent).
for FINDING_NUM in {spawned_finding_numbers}; do
  FINDING_DATA=$(gh issue view $FINDING_NUM -R {GH_REPO} --json labels,title,body,updatedAt \
    --jq '{labels: [.labels[].name], title: .title, body: .body, updatedAt: .updatedAt}')

  # Count each finding once and retain source provenance for the final per-PR
  # breakdown. Missing source/file evidence fails open as new surface.
  FINDING_BODY=$(echo "$FINDING_DATA" | jq -r '.body')
  SOURCE_PR=""
  if [[ "$FINDING_BODY" =~ \*\*[Ss]ource\*\*:[[:space:]]*[Pp][Rr][[:space:]]*\#([0-9]+) ]]; then
    SOURCE_PR="${BASH_REMATCH[1]}"
  fi
  if [ -z "${AMPLIFICATION_FINDING_SEEN[$FINDING_NUM]:-}" ]; then
    AMPLIFICATION_FINDING_SEEN[$FINDING_NUM]=1
    FINDINGS_SPAWNED=$((FINDINGS_SPAWNED + 1))
    [ -n "$SOURCE_PR" ] && FINDINGS_BY_SOURCE_PR[$SOURCE_PR]=$(( ${FINDINGS_BY_SOURCE_PR[$SOURCE_PR]:-0} + 1 ))
  fi
  FINDING_IS_REFINEMENT=false
  FINDING_FILE_FOR_LINEAGE=$(echo "$FINDING_BODY" | grep -oE '`[^`]+\.(py|tsx?|jsx?|sql|json|ya?ml|sh|md)`' | head -1 | tr -d '`')
  if [ -n "$SOURCE_PR" ] && [ -n "$FINDING_FILE_FOR_LINEAGE" ]; then
    SOURCE_ISSUE=""
    SOURCE_PR_BODY=$(gh pr view "$SOURCE_PR" -R {GH_REPO} --json body --jq '.body' 2>/dev/null || echo "")
    SOURCE_PR_BODY_LOWER=$(echo "$SOURCE_PR_BODY" | tr '[:upper:]' '[:lower:]')
    if [[ "$SOURCE_PR_BODY_LOWER" =~ (close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+\#([0-9]+) ]]; then
      SOURCE_ISSUE="${BASH_REMATCH[3]}"
    fi
    if [ -n "$SOURCE_ISSUE" ]; then
      PARENT_DATA=$(gh issue view "$SOURCE_ISSUE" -R {GH_REPO} --json labels,body \
        --jq '{labels: [.labels[].name], body: .body}' 2>/dev/null || echo '{}')
      PARENT_FILE=$(echo "$PARENT_DATA" | jq -r '.body // ""' | grep -oE '`[^`]+\.(py|tsx?|jsx?|sql|json|ya?ml|sh|md)`' | head -1 | tr -d '`')
      if echo "$PARENT_DATA" | jq -e '[.labels[] | select(. == "review-finding")] | length > 0' >/dev/null && \
         [ "$PARENT_FILE" = "$FINDING_FILE_FOR_LINEAGE" ]; then
        FINDING_IS_REFINEMENT=true
        REFINEMENT_FINDINGS[$FINDING_NUM]="$SOURCE_PR"
      else
        NEW_SURFACE_FINDINGS[$FINDING_NUM]="$SOURCE_PR"
      fi
    else
      NEW_SURFACE_FINDINGS[$FINDING_NUM]="$SOURCE_PR"
    fi
  else
    NEW_SURFACE_FINDINGS[$FINDING_NUM]="${SOURCE_PR:-unknown}"
  fi

  # Code-branch repair guard (MANDATORY — before priority/defer heuristics below).
  # A review-finding with no **Code branch** annotation, whose parent PR's base is
  # not the staging fast lane, would otherwise silently fall through to
  # classify-lane.sh's implicit staging default — the one branch where the
  # finding's subject code is guaranteed absent (forge#2443: 5 findings from
  # milestone-lane PRs were misrouted this way in one batch; absent manual
  # correction, /work-on's investigation phase would have closed all 5 as
  # invalid). This is a synchronous per-finding check, distinct from the
  # periodic Step 4C.5 lane-consistency sweep below (that one audits an
  # entire milestone's PRs for base-branch drift after the fact; this one
  # repairs a single finding's missing provenance at discovery time).
  FINDING_BODY_RAW=$(echo "$FINDING_DATA" | jq -r '.body')
  # Snapshot freshness marker alongside the body read above — compared immediately
  # before the body-mutating write below to detect a concurrent edit (forge#2512).
  FINDING_UPDATED_AT_SNAPSHOT=$(echo "$FINDING_DATA" | jq -r '.updatedAt')
  if ! echo "$FINDING_BODY_RAW" | grep -q '\*\*Code branch\*\*:'; then
    # Portable (non-PCRE) extraction — PCRE grep lookbehinds are not supported by
    # Git Bash's grep build on Windows (same convention as
    # scripts/derive-finding-milestone.sh and scripts/code-index.sh), so use a
    # bash regex + BASH_REMATCH instead of a lookbehind.
    REPAIR_SOURCE_PR=""
    FINDING_BODY_LOWER=$(echo "$FINDING_BODY_RAW" | tr '[:upper:]' '[:lower:]')
    if [[ "$FINDING_BODY_LOWER" =~ \*\*source\*\*:[[:space:]]*pr[[:space:]]*#([0-9]+) ]]; then
      REPAIR_SOURCE_PR="${BASH_REMATCH[1]}"
    fi
    if [ -n "$REPAIR_SOURCE_PR" ]; then
      REPAIR_PARENT_BASE=$(gh pr view "$REPAIR_SOURCE_PR" -R {GH_REPO} --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "")
      if [ -n "$REPAIR_PARENT_BASE" ] && [ "$REPAIR_PARENT_BASE" != "$STAGING_BRANCH" ]; then
        # GOVERNOR: cap the number of body-mutating repairs Step 4C will attempt
        # in a single run — bounds the blast radius of this new autonomous
        # `gh issue edit --body` mutation regardless of how many findings in the
        # batch happen to be missing Code branch. Declared with `:=` so it is
        # safe to reference whether or not a prior iteration already set it
        # (bash arithmetic increment below persists it across loop iterations).
        : "${REPAIR_GOVERNOR_COUNT:=0}"
        REPAIR_GOVERNOR_MAX=25
        if [ "$REPAIR_GOVERNOR_COUNT" -ge "$REPAIR_GOVERNOR_MAX" ]; then
          echo "REPAIR: #${FINDING_NUM} skipped — GOVERNOR cap reached (${REPAIR_GOVERNOR_MAX} repairs already attempted this run); flagging instead of repairing"
          gh issue edit "$FINDING_NUM" -R {GH_REPO} --add-label needs-human 2>/dev/null || true  # governor-cap path
        else
        REPAIR_GOVERNOR_COUNT=$((REPAIR_GOVERNOR_COUNT + 1))
        echo "REPAIR: #${FINDING_NUM} has no **Code branch** and parent PR #${REPAIR_SOURCE_PR} bases on '${REPAIR_PARENT_BASE}' (non-staging) — attempting repair (${REPAIR_GOVERNOR_COUNT}/${REPAIR_GOVERNOR_MAX} this run)"
        # Read-then-append: never blind-overwrite the existing body, only extend it.
        REPAIRED_BODY=$(printf '%s\n\n## Source Branch Context (repaired by orchestrate Step 4C — forge#2443)\n\n**Code branch**: `%s`\n**Worktree base**: `origin/%s`\n' \
          "$FINDING_BODY_RAW" "$REPAIR_PARENT_BASE" "$REPAIR_PARENT_BASE")
        # Concurrency guard (forge#2512 — TOCTOU fix): REPAIRED_BODY above was built purely
        # by string-appending to the FINDING_BODY_RAW snapshot captured at the top of this
        # loop iteration. The write below is a full-body overwrite — if the issue's body
        # changed since that read (a human edit, a second orchestrator run, or the finding's
        # own creation process still settling), a blind write here would silently clobber
        # that concurrent edit with no conflict signal. Re-fetch just `updatedAt` (cheap —
        # no body/labels payload) immediately before the write and compare against the
        # snapshot captured alongside FINDING_BODY_RAW. Bounded by the same
        # REPAIR_GOVERNOR_MAX cap as the write itself — at most one extra `gh issue view`
        # call per repair attempt.
        FINDING_UPDATED_AT_CURRENT=$(gh issue view "$FINDING_NUM" -R {GH_REPO} --json updatedAt --jq '.updatedAt' 2>/dev/null || echo "")
        if [ -z "$FINDING_UPDATED_AT_CURRENT" ]; then
          # forge#2565: the re-fetch itself failed (network error, API rate limit, or any
          # other non-zero `gh issue view` exit) — the `|| echo ""` fallback above produces
          # an empty string that is indistinguishable, to a plain `[ -n ... ] && [ ... != ... ]`
          # check, from "confirmed no concurrent edit." Treat an unverifiable freshness check
          # as its own outcome and fail closed, mirroring the concurrent-edit branch below
          # rather than silently falling through to the unprotected write.
          echo "REPAIR: #${FINDING_NUM} skipped — freshness re-fetch failed (network error or API rate limit); cannot verify no concurrent edit occurred, failing closed instead of risking a silent clobber"
          # Scope the scratch name to both this finding and this orchestrator process.
          # The marker read-back below detects a plausible-looking body substitution.
          SCRATCHPAD="${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}"
          AGENT_TOKEN="${AGENT_ID:-${HOSTNAME:-orchestrator}-$$}"
          mkdir -p "$SCRATCHPAD"
          GATE_BODY_MARKER="FORGE:BODY-INTEGRITY:${FINDING_NUM}_freshness-gate_${AGENT_TOKEN}"
          GATE_BODY_TMPFILE="$(mktemp "$SCRATCHPAD/${FINDING_NUM}_freshness-gate_${AGENT_TOKEN}.XXXXXX.md")"
          printf '%s' "<!-- FORGE:GATE_FAILURE -->
## Code Branch Repair Skipped — Freshness Re-fetch Failed

Finding #${FINDING_NUM} has no **Code branch** annotation and its parent PR #${REPAIR_SOURCE_PR} bases on \`${REPAIR_PARENT_BASE}\` — not the staging fast lane. Automatic repair was skipped because the freshness re-fetch (\`gh issue view --json updatedAt\`) failed, so the concurrency guard could not confirm the issue body is still at the snapshot captured earlier in this iteration (\`${FINDING_UPDATED_AT_SNAPSHOT}\`). Proceeding with the write here would risk silently clobbering a concurrent edit with no way to verify. Human review required to confirm the current body state and, if still needed, re-apply the Code branch stamp manually. <!-- forge#2565 -->
<!-- ${GATE_BODY_MARKER} -->" > "$GATE_BODY_TMPFILE"
          gh issue comment "$FINDING_NUM" -R {GH_REPO} --body-file "$GATE_BODY_TMPFILE" 2>/dev/null || true
          gh api "repos/{GH_REPO}/issues/${FINDING_NUM}/comments" --jq '.[].body' | grep -Fqx "<!-- ${GATE_BODY_MARKER} -->" || { echo "ERROR: freshness-gate comment marker missing" >&2; exit 1; }
          rm -f "$GATE_BODY_TMPFILE"
          gh issue edit "$FINDING_NUM" -R {GH_REPO} --add-label needs-human 2>/dev/null || true  # freshness-recheck-failure path
        elif [ "$FINDING_UPDATED_AT_CURRENT" != "$FINDING_UPDATED_AT_SNAPSHOT" ]; then
          echo "REPAIR: #${FINDING_NUM} skipped — concurrent edit detected (updatedAt changed from ${FINDING_UPDATED_AT_SNAPSHOT} to ${FINDING_UPDATED_AT_CURRENT} since this iteration's initial read); flagging instead of repairing"
          CONCURRENT_EDIT_BODY_MARKER="FORGE:BODY-INTEGRITY:${FINDING_NUM}_concurrent-edit_${AGENT_TOKEN}"
          CONCURRENT_EDIT_BODY_TMPFILE="$(mktemp "$SCRATCHPAD/${FINDING_NUM}_concurrent-edit_${AGENT_TOKEN}.XXXXXX.md")"
          printf '%s' "<!-- FORGE:GATE_FAILURE -->
## Code Branch Repair Skipped — Concurrent Edit Detected

Finding #${FINDING_NUM} has no **Code branch** annotation and its parent PR #${REPAIR_SOURCE_PR} bases on \`${REPAIR_PARENT_BASE}\` — not the staging fast lane. Automatic repair was skipped because the issue body was edited concurrently (\`updatedAt\` changed from \`${FINDING_UPDATED_AT_SNAPSHOT}\` to \`${FINDING_UPDATED_AT_CURRENT}\` between this run's initial read and the repair write). Overwriting the body now would have silently discarded that concurrent edit. Human review required to reconcile and, if still needed, re-apply the Code branch stamp manually. <!-- forge#2512 -->
<!-- ${CONCURRENT_EDIT_BODY_MARKER} -->" > "$CONCURRENT_EDIT_BODY_TMPFILE"
          gh issue comment "$FINDING_NUM" -R {GH_REPO} --body-file "$CONCURRENT_EDIT_BODY_TMPFILE" 2>/dev/null || true
          gh api "repos/{GH_REPO}/issues/${FINDING_NUM}/comments" --jq '.[].body' | grep -Fqx "<!-- ${CONCURRENT_EDIT_BODY_MARKER} -->" || { echo "ERROR: concurrent-edit comment marker missing" >&2; exit 1; }
          rm -f "$CONCURRENT_EDIT_BODY_TMPFILE"
          gh issue edit "$FINDING_NUM" -R {GH_REPO} --add-label needs-human 2>/dev/null || true  # concurrent-edit path
        else
        if gh issue edit "$FINDING_NUM" -R {GH_REPO} --body "$REPAIRED_BODY" 2>/dev/null; then
          echo "REPAIR: #${FINDING_NUM} Code branch repaired to '${REPAIR_PARENT_BASE}'"
          # Re-fetch so the rest of this loop iteration (priority/defer heuristics
          # below) sees the repaired body, not the stale pre-repair one.
          FINDING_DATA=$(gh issue view $FINDING_NUM -R {GH_REPO} --json labels,title,body,updatedAt \
            --jq '{labels: [.labels[].name], title: .title, body: .body, updatedAt: .updatedAt}')
        else
          REPAIR_FAILED_BODY_MARKER="FORGE:BODY-INTEGRITY:${FINDING_NUM}_repair-failure_${AGENT_TOKEN}"
          REPAIR_FAILED_BODY_TMPFILE="$(mktemp "$SCRATCHPAD/${FINDING_NUM}_repair-failure_${AGENT_TOKEN}.XXXXXX.md")"
          printf '%s' "<!-- FORGE:GATE_FAILURE -->
## Code Branch Repair Failed

Finding #${FINDING_NUM} has no **Code branch** annotation and its parent PR #${REPAIR_SOURCE_PR} bases on \`${REPAIR_PARENT_BASE}\` — not the staging fast lane. Automatic repair (\`gh issue edit --body\`) failed. Without this annotation, \`/work-on\`'s investigation phase may look for the code on the wrong branch (staging, where it is absent) and misclassify this confirmed finding as invalid. Human review required. <!-- forge#2443 -->
<!-- ${REPAIR_FAILED_BODY_MARKER} -->" > "$REPAIR_FAILED_BODY_TMPFILE"
          gh issue comment "$FINDING_NUM" -R {GH_REPO} --body-file "$REPAIR_FAILED_BODY_TMPFILE" 2>/dev/null || true
          gh api "repos/{GH_REPO}/issues/${FINDING_NUM}/comments" --jq '.[].body' | grep -Fqx "<!-- ${REPAIR_FAILED_BODY_MARKER} -->" || { echo "ERROR: repair-failure comment marker missing" >&2; exit 1; }
          rm -f "$REPAIR_FAILED_BODY_TMPFILE"
          gh issue edit "$FINDING_NUM" -R {GH_REPO} --add-label needs-human 2>/dev/null || true  # repair-failure path
        fi
        fi
        fi
      fi
    fi
  fi

  # Priority extraction accepts both label schemas: canonical `priority:P<n>` (the only
  # form review-pr.md ever creates) and bare `P<n>` (carried by some consumer repos'
  # externally/legacy-labeled issues). `priority:P<n>` wins if both are present on the
  # same issue. Normalizes to bare P<n> form since all downstream comparisons in this file
  # compare against bare "P1"/"P2"/"P3". Mirrored verbatim in the token-budget gate below,
  # the Step 4F.2 sweep loop, and phase-1-resolve.md / cleanup.md's batching queries —
  # keep all sites byte-identical (forge#1837: mirrored checks must not drift). <!-- Added: forge#2232 -->
  # NOTE: $FINDING_DATA.labels is already a flat array of label-name strings (see the
  # gh issue view --jq above: {labels: [.labels[].name], ...}) — so this reads `.labels[]`
  # directly, NOT `.labels[].name` (that would error: "Cannot index string with name").
  PRIORITY=$(echo "$FINDING_DATA" | jq -r '
    ([.labels[] | select(test("^priority:P[0-9]+$"))] | .[0]) //
    ([.labels[] | select(test("^P[0-9]+$"))] | .[0]) //
    "" | ltrimstr("priority:")')
  TITLE=$(echo "$FINDING_DATA" | jq -r '.title')

  if [ -z "$PRIORITY" ]; then
    echo "WARNING: #${FINDING_NUM} has no parseable priority label (checked priority:P<n> and bare P<n>) — treating as untriaged, all priority-dependent rules below will not match"
  fi

  # Rule 0: Batch fully human-gated — checked FIRST, overrides even the P1/P2 priority
  # override below. BATCH_FULLY_GATED is computed once per completion cycle in Step 4B
  # item 6.7; read it here, do not recompute. <!-- Added: forge#1814 -->
  # Gated by CASCADE_DEFER_ON_BATCH_GATED (orchestration.cascade, forge#2234) — "policy:
  # all" sets this to false so an operator draining a backlog is never idle-gated.
  if [ "$CASCADE_DEFER_ON_BATCH_GATED" = "true" ] && [ "${BATCH_FULLY_GATED:-false}" = "true" ]; then
    DEFER=true; DEFER_REASON="batch fully human-gated — idle policy"
  # Heuristic 1: Generation check — source issue has review-finding label. Always defer
  # individual dispatch; only bounded P3 aggregation can consume an eligible member.
  # NOT gated by orchestration.cascade.max_generation — this is Step 4C's autonomous
  # mid-run cascade cap, which stays absolute regardless of config (see forge#2231's
  # scope note above and phase-1-resolve.md's Cascade / Review-Finding Resolution
  # section). `orchestration.cascade.max_generation` governs what an explicit human
  # request admits at Phase 1 resolve time, not what this unattended triage pass defers.
  elif SOURCE_NUM=$(echo "$FINDING_DATA" | jq -r '.body' | grep -oP '(?i)spawned from issue #\K\d+|source issue[: #]+\K\d+' | head -1) && \
       [ -n "$SOURCE_NUM" ] && \
       gh issue view $SOURCE_NUM -R {GH_REPO} --json labels --jq '[.labels[].name]' 2>/dev/null | grep -q "review-finding"; then
    FINDING_GENERATION=$(compute_finding_generation "$(echo "$FINDING_DATA" | jq -r '.body')")
    FINDING_GENERATIONS[$FINDING_NUM]="$FINDING_GENERATION"
    DEFER=true; DEFER_REASON="generation ${FINDING_GENERATION} (source #${SOURCE_NUM} is also a review-finding)"
    if [ "$PRIORITY" = "P3" ] && [ "$FINDING_GENERATION" -le "$BATCH_MAX_GENERATION" ]; then
      # Keep this out of individual cascade dispatch, but offer it to the P3 batching
      # pass below. A singleton remains deferred; only a formed batch is admitted.
      BATCHABLE_DEFERRED_P3+=("$FINDING_NUM")
      DEFER_REASON="generation ${FINDING_GENERATION} — eligible for bounded P3 batching only"
    fi
   # Priority override: P0/P1 always execute; P2 is eligible for batch planning.
   elif [ "$PRIORITY" = "P0" ] || [ "$PRIORITY" = "P1" ]; then
    DEFER=false
  # Heuristic 2: Comment/typo keyword (only applies to P3 and below)
  # Gated by CASCADE_KEYWORD_HEURISTIC (orchestration.cascade, forge#2234).
  elif [ "$CASCADE_KEYWORD_HEURISTIC" = "true" ] && echo "$TITLE" | grep -qi "comment\|typo"; then
    DEFER=true; DEFER_REASON="comment/typo heuristic"
  # Heuristic 3: P3 + same-file overlap
  # Gated by CASCADE_P3_SAME_FILE_DEFER (orchestration.cascade, forge#2234).
  elif [ "$CASCADE_P3_SAME_FILE_DEFER" = "true" ] && [ "$PRIORITY" = "P3" ]; then
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

  [ -n "${FINDING_GENERATIONS[$FINDING_NUM]:-}" ] || FINDING_GENERATIONS[$FINDING_NUM]=1

  # Opt-in only: never defer a new-surface or P1/P2 finding because another
  # lineage is noisy. Step 4F re-evaluates this explicit deferral after drain.
  AMPLIFICATION_RATIO=$(awk "BEGIN { if ($MERGED_UNITS) printf \"%.2f\", $FINDINGS_SPAWNED / $MERGED_UNITS; else print 0 }")
  if [ "$DEFER" = "false" ] && [ "$FINDING_IS_REFINEMENT" = "true" ] && \
     [ "$PRIORITY" != "P1" ] && [ "$PRIORITY" != "P2" ] && \
     [ "$CASCADE_MAX_AMPLIFICATION" != "off" ] && \
     awk "BEGIN { exit !($AMPLIFICATION_RATIO > $CASCADE_MAX_AMPLIFICATION) }"; then
    DEFER=true
    DEFER_REASON="amplification bound exceeded (same-lineage refinement; ${AMPLIFICATION_RATIO} > ${CASCADE_MAX_AMPLIFICATION})"
    AMPLIFICATION_DEFERRED+=("$FINDING_NUM")
  fi

  # Rule 6 (forge#3060): on-by-default breaker over ALL cascade findings. Applies ONLY to
  # P3-and-below (P0/P1/P2 and untriaged/unparseable priorities are never gated by it) and NEVER
  # to security/billing-class findings (classifyBatchSafety != routine): those can neither batch
  # with routine work nor be individually dispatched by the sweep, so pausing them would starve
  # them; they keep their pre-existing individual triage path unchanged.
  # Evaluated live per finding. When a unit merged this cycle (UNIT_MERGED_THIS_CYCLE), its ratio
  # observation is not yet in the history (recorded by "Amplification settle"), so the live
  # unrounded ratio plus the last CONVERGENCE_WINDOW-1 recorded observations form the window.
  # Applied even when another rule already deferred the finding, and APPENDED to the reason, so
  # Step 4F's `*"amplification breaker"*` hold (checked FIRST) still catches it.
  if [ "$AMPLIFICATION_BREAKER" = "on" ] && echo "$PRIORITY" | grep -qE '^P[3-9]$'; then
    # Fail CLOSED: if the classifier cannot run (missing module, bad cwd), treat the finding as
    # non-routine so a security/billing finding is never paused. Import via {REPO_PATH} and pass
    # the text through the environment (argv text beginning with "-" is parsed as a node option).
    # FORGE_ROOT bootstrap (canonical; keep byte-identical across specs, guarded by scripts/forge-root.test.sh)
    FORGE_ROOT=""
    if [ -n "${FORGEDOCK_HOME:-}" ]; then case "$FORGEDOCK_HOME" in /*) FORGE_ROOT="$FORGEDOCK_HOME" ;; esac; else
      # Portable to bash 3.2 (macOS), BSD/GNU coreutils and zsh: no mapfile, no sort -V, no bare globs (zsh aborts on no match).
      _l="$HOME/.claude/commands/work-on.md"; _l="$(readlink -f "$_l" 2>/dev/null || readlink "$_l" 2>/dev/null)"; [ -n "$_l" ] && _l="$(dirname "$(dirname "$_l")")"
      # newest cached version first: numeric major.minor.patch of the version dir name only; a release outranks its pre-release (1.10.0 > 1.9.0 > 1.9.0-rc1)
      _v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ '$(NF-1)=="forgedock"{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$0}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5-)"
      _m="$(find -L "$HOME/.claude/plugins/marketplaces" -mindepth 1 -maxdepth 1 -type d -iname '*forgedock*' 2>/dev/null)"
      # '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
      _k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_v" "$_m")"
      while IFS= read -r _c; do
        case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
      done <<< "$_k"
    fi
    # Import ForgeDock's OWN admission.mjs from FORGE_ROOT, never from the consumer {REPO_PATH}
    # (inert on non-ForgeDock repos, and would execute repo-controlled JS). Unresolved/missing => fail closed, loudly.
    BREAKER_SAFETY="unclassified"
    if [ -n "$FORGE_ROOT" ] && [ -r "$FORGE_ROOT/bin/engine/admission.mjs" ]; then
      BREAKER_SAFETY=$(FINDING_TEXT="$(echo "$FINDING_DATA" | jq -r '(.title // "") + "\n" + (.body // "")')" \
        node -e 'import(require("node:url").pathToFileURL(process.argv[1]).href).then(({ classifyBatchSafety }) => process.stdout.write(classifyBatchSafety(process.env.FINDING_TEXT) || "routine"))' "$FORGE_ROOT/bin/engine/admission.mjs" 2>/dev/null || echo "unclassified")
    else
      echo "WARNING: ForgeDock install root unresolved or admission.mjs missing (set FORGEDOCK_HOME) — breaker classifying #${FINDING_NUM} as unclassified (fail closed: not deferred)" >&2
    fi
    BREAKER_LIVE_TRIPPED="$AMPLIFICATION_BREAKER_TRIPPED"
    if [ "$BREAKER_LIVE_TRIPPED" = "false" ] && [ "$UNIT_MERGED_THIS_CYCLE" = "true" ] && [ "$MERGED_UNITS" -gt 0 ] && \
       awk "BEGIN { exit !($FINDINGS_SPAWNED / $MERGED_UNITS >= 1) }"; then
      if [ "$CONVERGENCE_WINDOW" -le 1 ] || \
         { [ "${#AMPLIFICATION_RATIO_HISTORY[@]}" -ge $((CONVERGENCE_WINDOW - 1)) ] && \
           printf '%s\n' "${AMPLIFICATION_RATIO_HISTORY[@]: -$((CONVERGENCE_WINDOW - 1))}" | awk '$1 < 1 { exit 1 }'; }; then
        BREAKER_LIVE_TRIPPED=true
        AMPLIFICATION_BREAKER_TRIPPED=true
      fi
    fi
    if [ "$BREAKER_LIVE_TRIPPED" = "true" ] && [ "$BREAKER_SAFETY" = "routine" ]; then
      DEFER_REASON="${DEFER_REASON:+${DEFER_REASON}; }${BREAKER_DEFER_TAG} tripped (ratio >= 1.0 for ${CONVERGENCE_WINDOW} merged units) — held for bounded P3 batches"
      DEFER=true
      case " ${AMPLIFICATION_BREAKER_DEFERRED[*]} " in *" $FINDING_NUM "*) ;; *) AMPLIFICATION_BREAKER_DEFERRED+=("$FINDING_NUM") ;; esac
      # Route to the bounded P3 batch planner (never individual dispatch); dedupe so a finding
      # already added by the generation rule is not listed twice.
      if [ "$PRIORITY" = "P3" ]; then
        case " ${BATCHABLE_DEFERRED_P3[*]} " in *" $FINDING_NUM "*) ;; *) BATCHABLE_DEFERRED_P3+=("$FINDING_NUM") ;; esac
      fi
    fi
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

**Amplification settle (MANDATORY — after the rule loop above, before batching/dispatch; forge#3060):** now that this unit's findings are counted, record its ratio observation (unrounded; the printed value is rounded for display only) and evaluate the breaker over the latest `CONVERGENCE_WINDOW` observations. Release as soon as the newest observation is below 1.0.

```bash
if [ "$UNIT_MERGED_THIS_CYCLE" = "true" ]; then
  AMPLIFICATION_RATIO=$(awk "BEGIN { printf \"%.2f\", $FINDINGS_SPAWNED / $MERGED_UNITS }")
  AMPLIFICATION_RATIO_HISTORY+=("$(awk "BEGIN { printf \"%.6f\", $FINDINGS_SPAWNED / $MERGED_UNITS }")")
  if [ "${#AMPLIFICATION_RATIO_HISTORY[@]}" -ge "$CONVERGENCE_WINDOW" ]; then
    RECENT_RATIOS=("${AMPLIFICATION_RATIO_HISTORY[@]: -$CONVERGENCE_WINDOW}")
    if printf '%s\n' "${RECENT_RATIOS[@]}" | awk '$1 < 1 { exit 1 }'; then
      echo "CONVERGENCE WARNING: amplification has remained >= 1.0 for ${CONVERGENCE_WINDOW} merged units (${AMPLIFICATION_RATIO} current). This can be productive review refinement, but the batch is not shrinking."
      if [ "$AMPLIFICATION_BREAKER" = "on" ] && [ "$AMPLIFICATION_BREAKER_TRIPPED" = "false" ]; then
        AMPLIFICATION_BREAKER_TRIPPED=true
        # One operator report per trip: ratio and queue size, no per-finding spam.
        echo "AMPLIFICATION BREAKER TRIPPED: ratio ${AMPLIFICATION_RATIO} (${FINDINGS_SPAWNED} findings / ${MERGED_UNITS} merged units) stayed >= 1.0 for ${CONVERGENCE_WINDOW} units. P3 cascade admission is paused; ${#AMPLIFICATION_BREAKER_DEFERRED[@]} finding(s) paused so far. P1/P2 are still admitted. Paused P3s are routed to the bounded P3 batch planner (planP3BatchGroups) and are never dispatched individually. Operator decision: batch them or defer. Opt out: orchestration.cascade.amplification_breaker: off"
      fi
    else
      # Newest observation fell below 1.0 — the cascade is converging again; release the breaker.
      AMPLIFICATION_BREAKER_TRIPPED=false
    fi
  fi
fi
UNIT_MERGED_THIS_CYCLE=false
```

**Concern-level batching for queued P3 findings (MANDATORY check before dispatch):** <!-- Added: forge#1818 -->

Cascade-spawned findings collected within a single `/orchestrate` run must be reconsidered against the complete open, unbatched, undispatched candidate registry, not only `QUEUED_FINDINGS` from this completion cycle. At initial resolution and after every five completions (or whenever `DEFERRED_FINDINGS` reaches `MAX_CONCURRENT`), collect retained ungrouped candidates, new findings, and open batch membership; call `planP3BatchGroups()` with that registry and `batchExclusionReason()` danger-zone inputs. Execute returned `extensions` before new groups, retain `ungrouped` members for the next sweep, and record group kinds or exclusion predicates in the run summary. <!-- Added: forge#2858; extended: forge#2851, forge#2852 -->

The per-cycle `QUEUED_FINDINGS` loop below remains the action-creation mechanism, but it MUST consume the complete-sweep planner output rather than decide groups from its local same-file map. Do not dispatch a locally ungrouped member until the next periodic sweep has considered it against the retained candidate set.

```bash
# Group QUEUED_FINDINGS by exact affected file, reusing the SAME safety
# exclusions as phase-1-resolve.md. Both sites go through jq test() (Oniguruma)
# with identical patterns — NOT grep ERE — so the two batching checks cannot
# classify the same issue body differently. <!-- forge#1837 -->
# NOTE: SURFACE_BATCHED_FINDINGS and SURFACE_BATCH_COUNT are declared once in Step 4A.pre
# (batch scope) — do NOT re-initialize them here, this block runs per-agent-completion cycle.
# SURFACE_FILE_MEMBERS itself must NOT survive across cycles — `declare -A` on an
# already-declared associative array is a no-op on its existing contents in bash, so an
# explicit `unset` is required to actually clear it before each cycle repopulates it.
# <!-- Added: forge#1909 -->
unset SURFACE_FILE_MEMBERS
declare -A SURFACE_FILE_MEMBERS

# Include generation-2 P3 findings only as batch candidates. They remain deferred
# unless this pass actually forms a bounded batch; no member is individually queued.
BATCHING_CANDIDATES=("${QUEUED_FINDINGS[@]}" "${BATCHABLE_DEFERRED_P3[@]}")

# Defensive cap on gh issue view fan-out. BATCHING_CANDIDATES is already bounded by
# upstream cascade control; this cap holds even if that bound is later loosened,
# so the loop can never scale API calls linearly with cascade-seeded findings. <!-- forge#1836 -->
MAX_BATCH_SCAN=50
SCANNED=0

for FINDING_NUM in "${BATCHING_CANDIDATES[@]}"; do
  SCANNED=$((SCANNED + 1))
  if [ "$SCANNED" -gt "$MAX_BATCH_SCAN" ]; then
    echo "Surface-area batching: reached MAX_BATCH_SCAN=$MAX_BATCH_SCAN — remaining findings stay individually queued"
    break
  fi

  FINDING_DATA=$(gh issue view $FINDING_NUM -R {GH_REPO} --json title,body,labels \
    --jq '{title: .title, body: .body, labels: [.labels[].name]}')

  # Billing is never batched. Security findings are classified below and may
  # batch only with their exact same class. Same jq test() engine and
  # patterns as phase-1-resolve.md's batching rule (single shared mechanism).
  # Word-boundary anchored (not bare substrings) and attribution-boilerplate
  # (**Confidence**/**Severity**/**Review comment** — see forge#2477 note below
  # for why **Source**/**Agent** are deliberately excluded from this list)
  # stripped from the body before scanning, so a finding naming its own
  # reviewing agent ("Security") or an identifier like `authority_source` no
  # longer false-positives.
  # `authentication|authorization|authn|authz` preserve real auth-domain coverage
  # as separate whole-word alternatives now that bare `auth` is boundary-anchored.
  # <!-- forge#2423 -->
  # Each stripped alternative is anchored to the field's real generator-output
  # shape (enum for Confidence/Severity, URL for Review comment) rather than a
  # bare label-prefix + `.*$` — matching on label shape alone lets
  # attacker-controlled body text on one of these lines get stripped along
  # with the label, smuggling banned keywords past the scan below. Source/Agent
  # are deliberately NOT stripped: both hold genuinely free-text generator
  # output (a PR title; an agent's self-description) with no fixed vocabulary,
  # so no shape bound can distinguish legitimate attribution from
  # attacker-authored payload placed in the same position — a length-bounded
  # free-text alternative for either field re-opens the exact smuggling gap
  # this fix closes (an attacker need only prefix their payload with a fake
  # "PR #N — " or agent name to satisfy the bound). Leaving them unstripped
  # trades a narrow, already-known false-positive (forge#2423's Agent-line
  # case; a P3 finding whose Source/Agent text happens to mention a domain
  # keyword is not auto-batched) for closing a real bypass — the safe
  # direction for a security-relevant exclusion. <!-- forge#2477 -->
  echo "$FINDING_DATA" | jq -e '
    (.title | test("\\b(billing|operator-only|manual action required|human action required)\\b"; "i"))
    or ((.body | gsub("(?m)^\\*\\*(?:Confidence\\*\\*: (?:CONFIRMED|LIKELY|POSSIBLE)|Severity\\*\\*: (?:CRITICAL|HIGH|MEDIUM|LOW|INFO)|Review comment\\*\\*: https?://\\S+)$"; "")) | test("## Problem[\\s\\S]{0,500}\\b(billing|operator-only|manual action required|human action required)\\b"; "i"))
    or ([.labels[]] | any(. == "billing" or . == "needs-human" or . == "blocked" or . == "operator-only"))
  ' >/dev/null && continue

  # Only P3 findings are eligible (P1/P2 already dispatched individually above).
  # Schema-tolerant: matches canonical priority:P3 or bare P3 (forge#2232).
  echo "$FINDING_DATA" | jq -e '[.labels[]] | any(test("^(priority:)?P3$"))' >/dev/null || continue

  FINDING_FILE=$(echo "$FINDING_DATA" | jq -r '.body' | grep -oE '`[^`]+\.(py|tsx?|jsx?|sql|json|ya?ml|sh|md)`' | head -1 | tr -d '`')
  [ -z "$FINDING_FILE" ] && continue

  # FORGE_ROOT bootstrap (canonical; keep byte-identical across specs, guarded by scripts/forge-root.test.sh)
  FORGE_ROOT=""
  if [ -n "${FORGEDOCK_HOME:-}" ]; then case "$FORGEDOCK_HOME" in /*) FORGE_ROOT="$FORGEDOCK_HOME" ;; esac; else
    # Portable to bash 3.2 (macOS), BSD/GNU coreutils and zsh: no mapfile, no sort -V, no bare globs (zsh aborts on no match).
    _l="$HOME/.claude/commands/work-on.md"; _l="$(readlink -f "$_l" 2>/dev/null || readlink "$_l" 2>/dev/null)"; [ -n "$_l" ] && _l="$(dirname "$(dirname "$_l")")"
    # newest cached version first: numeric major.minor.patch of the version dir name only; a release outranks its pre-release (1.10.0 > 1.9.0 > 1.9.0-rc1)
    _v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ '$(NF-1)=="forgedock"{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$0}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5-)"
    _m="$(find -L "$HOME/.claude/plugins/marketplaces" -mindepth 1 -maxdepth 1 -type d -iname '*forgedock*' 2>/dev/null)"
    # '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
    _k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_v" "$_m")"
    while IFS= read -r _c; do
      case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
    done <<< "$_k"
  fi
  # Import from ForgeDock's own root, never the consumer cwd; fail closed (non-routine) when unresolved.
  SAFETY_CLASS="unclassified"
  if [ -n "$FORGE_ROOT" ] && [ -r "$FORGE_ROOT/bin/engine/admission.mjs" ]; then
    SAFETY_CLASS=$(node -e 'import(require("node:url").pathToFileURL(process.argv[1]).href).then(({ classifyBatchSafety }) => process.stdout.write(classifyBatchSafety(process.argv[2]) || "routine"))' "$FORGE_ROOT/bin/engine/admission.mjs" "$(echo "$FINDING_DATA" | jq -r '.title + "\n" + .body + "\n" + (.labels | join(" "))')" 2>/dev/null || echo "unclassified")
  else
    echo "WARNING: ForgeDock install root unresolved or admission.mjs missing (set FORGEDOCK_HOME) — #${FINDING_NUM} classified unclassified (non-routine: may batch only with other unclassified findings on the same file, capped at 3)" >&2
  fi
  # Same file is not enough for security work: the class key prevents a
  # credential finding from sharing a batch with injection/auth hardening.
  SURFACE_KEY="${SAFETY_CLASS}:${FINDING_FILE}"
  SURFACE_FILE_MEMBERS["$SURFACE_KEY"]="${SURFACE_FILE_MEMBERS[$SURFACE_KEY]} $FINDING_NUM"
done

# For each same-file cluster of 2+, actually CREATE the batch issue (executable —
# mirrors phase-1-resolve.md's "Batch creation rule") and REPLACE the members with
# the batch issue in QUEUED_FINDINGS so the dispatch step below never double-dispatches
# them. This is what makes SURFACE_BATCHED_FINDINGS a live control, not dead wiring. <!-- forge#1832, forge#1834 -->
for FILE in "${!SURFACE_FILE_MEMBERS[@]}"; do
  MEMBERS=($(printf '%s\n' ${SURFACE_FILE_MEMBERS[$FILE]} | sort -un))   # dedupe: a finding listed twice must not form a self-batch
  [ "${#MEMBERS[@]}" -ge 2 ] || continue

  SAFETY_CLASS=${FILE%%:*}
  SURFACE_FILE=${FILE#*:}

  # Sanitize the affected-file path before interpolating it into the issue title/body.
  # Git filenames can legally carry shell metacharacters (`$()`, backticks, quotes);
  # restrict to a validated charset so the value cannot break the gh argument
  # boundary from an untrusted issue body. Shared guard with phase-1-resolve.md. <!-- forge#1833, forge#1835 -->
  SAFE_SURFACE_AREA=$(printf '%s' "$SURFACE_FILE" | tr -cd 'A-Za-z0-9._/-')

  echo "Same-run surface-area cluster: ${#MEMBERS[@]} ${SAFETY_CLASS} findings share $SURFACE_FILE — creating batch issue(s)"

  # Routine batches cap at 8; security-class batches cap at 3 and their body
  # must state a live-vector or defence-in-depth verdict for every member.
  BATCH_CAP=8
  [ "$SAFETY_CLASS" != "routine" ] && BATCH_CAP=3
  for START in $(seq 0 "$BATCH_CAP" $(( ${#MEMBERS[@]} - 1 ))); do
    CHUNK=("${MEMBERS[@]:$START:$BATCH_CAP}")
    [ "${#CHUNK[@]}" -ge 2 ] || continue

    MEMBER_LINES=""
    BATCH_MEMBER_GENERATION=1
    GEN2_MEMBER_LINES=""
    for M in "${CHUNK[@]}"; do
      MTITLE=$(gh issue view "$M" -R {GH_REPO} --json title --jq '.title' 2>/dev/null || echo "")
      MEMBER_LINES="${MEMBER_LINES}- [ ] #${M}: ${MTITLE}"$'\n'
      MEMBER_GENERATION="${FINDING_GENERATIONS[$M]:-1}"
      if [ "$MEMBER_GENERATION" -gt "$BATCH_MEMBER_GENERATION" ]; then
        BATCH_MEMBER_GENERATION="$MEMBER_GENERATION"
      fi
      if [ "$MEMBER_GENERATION" -ge 2 ]; then
        GEN2_MEMBER_LINES="${GEN2_MEMBER_LINES}- #${M}: generation ${MEMBER_GENERATION}"$'\n'
      fi
      [ "$SAFETY_CLASS" = "routine" ] || MEMBER_LINES="${MEMBER_LINES}  - **Verdict**: [ ] live vector  [ ] defence-in-depth"$'\n'
    done

    # Dedup-check with member exclusion (MANDATORY — forge#2432, identical mechanism to
    # phase-1-resolve.md's mirror block; this site keeps its existing direct-to-gh issue
    # creation below rather than migrating to /issue's Skill routing, since this loop runs
    # per-completion-cycle and a direct scripts/issue-dedup.sh call is cheaper here). A
    # batch title necessarily restates its own members' subject matter by construction —
    # excluding the cluster's own member numbers means Phase-2D-style dedup only fires on
    # a GENUINE non-member duplicate. --exclude narrows the candidate set; it is NOT a
    # --force equivalent.
    CHUNK_LIST=$(IFS=,; echo "${CHUNK[*]}")
    PROPOSED_BATCH_TITLE="fix(batch): P3 review findings — ${SAFE_SURFACE_AREA} (same-run batch)"
    DEDUP_RESULT=$(scripts/issue-dedup.sh "$PROPOSED_BATCH_TITLE" {GH_FLAG} --exclude "$CHUNK_LIST" 2>&1)
    DEDUP_EXIT=$?

    if [ "$DEDUP_EXIT" -eq 1 ]; then
      # Genuine non-member duplicate — some other open issue already covers this exact
      # surface area. Do NOT create the batch; its members stay individually queued.
      echo "Batch dedup STOP (non-member match): $DEDUP_RESULT — skipping batch creation for $SAFE_SURFACE_AREA, members stay individually queued"
      continue
    elif [ "$DEDUP_EXIT" -eq 2 ]; then
      echo "Batch dedup usage error: $DEDUP_RESULT — skipping batch creation for $SAFE_SURFACE_AREA, members stay individually queued"
      continue
    fi

    CREATE_TOKEN="forge-create-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
    CREATE_BODY="$(cat <<BATCH_EOF
## Problem

Batch of P3 review findings in **${SAFE_SURFACE_AREA}** (same file), clustered mid-run by phase-4-execution.md to reduce per-finding pipeline overhead.

## Member Findings

<!-- FORGE:BATCH_MEMBERS -->
${MEMBER_LINES}<!-- /FORGE:BATCH_MEMBERS -->

**Maximum member generation**: ${BATCH_MEMBER_GENERATION}
<!-- FORGE:BATCH_MAX_GENERATION: ${BATCH_MEMBER_GENERATION} --> <!-- allowlist:check-spec-markers -->

**Generation >= 2 members admitted by bounded batching**:
${GEN2_MEMBER_LINES:-none}

## Acceptance Criteria

- [ ] All member findings addressed or closed as false-positive
- [ ] Member issues auto-closed with reference to this batch PR on merge
- [ ] No security, billing, anti-bot, or auth paths touched (validated before batching)

<!-- FORGE:BATCHABLE -->
BATCH_EOF
    )"
    CREATE_BODY="${CREATE_BODY}

<!-- issue-create-token:${CREATE_TOKEN} -->"
    CREATE_RESPONSE=$(gh api "repos/{GH_REPO}/issues" --method POST \
      -f title="$PROPOSED_BATCH_TITLE" -f body="$CREATE_BODY" \
      -f 'labels[]=review-finding' -f 'labels[]=priority:P3' -f 'labels[]=batch') || {
      echo "ERROR: GitHub rejected same-run batch creation; members remain queued." >&2
      continue
    }
    BATCH_ISSUE_NUM=$(echo "$CREATE_RESPONSE" | jq -r '.number // empty')
    if [ -z "$BATCH_ISSUE_NUM" ]; then
      echo "ERROR: same-run batch creation returned no issue number; members remain queued." >&2
      continue
    fi
    CREATED_BODY=$(gh issue view "$BATCH_ISSUE_NUM" -R {GH_REPO} --json body --jq '.body') || continue
    if ! printf '%s' "$CREATED_BODY" | grep -qF "issue-create-token:${CREATE_TOKEN}"; then
      echo "ERROR: batch issue #${BATCH_ISSUE_NUM} failed create-token read-back; members remain queued." >&2
      continue
    fi

    # Consume the cluster: record members and REPLACE them in QUEUED_FINDINGS
    # with the single batch issue, so the dispatch step below operates on the
    # batch unit and skips the individual members.
    SURFACE_BATCHED_FINDINGS+=("${CHUNK[@]}")
    [ -n "$BATCH_ISSUE_NUM" ] && SURFACE_BATCH_COUNT=$((SURFACE_BATCH_COUNT + 1))   # forge#1858 Step 6B counter
    QUEUED_FINDINGS=($(printf '%s\n' "${QUEUED_FINDINGS[@]}" | grep -vxF -f <(printf '%s\n' "${CHUNK[@]}") || true))
    [ -n "$BATCH_ISSUE_NUM" ] && QUEUED_FINDINGS+=("$BATCH_ISSUE_NUM")
    echo "Batched ${#CHUNK[@]} findings into #${BATCH_ISSUE_NUM}; members removed from QUEUED_FINDINGS and the DAG."
  done
done
```

Findings clustered here are replaced by their batch issue in `QUEUED_FINDINGS` (and therefore the DAG, which is built from `QUEUED_FINDINGS` in the dispatch step below) — the individual member issues in `SURFACE_BATCHED_FINDINGS` are never dispatched. Findings that remain ungrouped (fewer than 2 sharing a file in this collection round) stay individually queued below; they retain default-batchable eligibility and will be picked up by the next `/orchestrate` invocation's Phase 1 resolve if a same-file or leaf-directory cluster later forms across runs.

**Per-batch token budget gate (P3-and-below only — MANDATORY, runs on the POST-clubbing `QUEUED_FINDINGS` list):** <!-- Added: forge#1858 -->

Rule 5 from the evaluation order above. Charges ONE `TOKEN_ESTIMATE_PER_FINDING` per unit remaining in `QUEUED_FINDINGS` at this point — a same-run surface-area-clubbed batch issue counts as a single unit (its members were already replaced by the batch issue number above), never once per member. `TOKEN_BUDGET`, `TOKEN_ESTIMATE_PER_FINDING`, and `BATCH_TOKEN_SPEND` were declared in Step 4A.pre and persist across every Step 4C run this session performs — do NOT re-initialize `BATCH_TOKEN_SPEND` here. This is a DIFFERENT mechanism from the `--budget N` dollar-cost flag (economic scheduling, forge#1743, `should_dispatch()` in Step 4A-pre.0): that one is opt-in, dollar-denominated, and gates only the *original* `SORTED_READY_SET` dispatch loop — it is never consulted here.

```bash
TOKEN_BUDGET_DEFERRED_THIS_RUN=()

for FINDING_NUM in "${QUEUED_FINDINGS[@]}"; do
  # Schema-tolerant extraction (forge#2232) — same pattern as the Step 4C main loop above.
  # Defaults to P3 only when NEITHER label form is present (an empty labels match, not
  # merely a non-priority:P<n> label), so a bare-P3-labeled finding is read correctly
  # instead of falling through to this default.
  FINDING_PRIORITY=$(gh issue view "$FINDING_NUM" -R {GH_REPO} --json labels \
    --jq '(
      ([.labels[].name | select(test("^priority:P[0-9]+$"))] | .[0]) //
      ([.labels[].name | select(test("^P[0-9]+$"))] | .[0]) //
      "priority:P3"
    ) | ltrimstr("priority:")' 2>/dev/null || echo "P3")

  # P1/P2 are NEVER gated by the token budget — they were queued by rule 2 above
  # regardless of budget headroom; skip them here and leave them in QUEUED_FINDINGS.
  if [ "$FINDING_PRIORITY" = "P1" ] || [ "$FINDING_PRIORITY" = "P2" ]; then
    continue
  fi

  PROJECTED_TOKEN_SPEND=$((BATCH_TOKEN_SPEND + TOKEN_ESTIMATE_PER_FINDING))
  # TOKEN_BUDGET may be the "unlimited" sentinel (orchestration.cascade.token_budget /
  # policy: all) — never gate in that case, regardless of projected spend.
  if [ "$TOKEN_BUDGET" != "unlimited" ] && [ "$PROJECTED_TOKEN_SPEND" -gt "$TOKEN_BUDGET" ]; then
    TOKEN_DEFERRED+=("$FINDING_NUM")
    TOKEN_BUDGET_DEFERRED_THIS_RUN+=("$FINDING_NUM")
    DEFERRED_REASONS[$FINDING_NUM]="token budget exceeded (est. ${TOKEN_ESTIMATE_PER_FINDING} tokens would push batch spend to ${PROJECTED_TOKEN_SPEND} > ceiling ${TOKEN_BUDGET})"
    echo "TOKEN BUDGET DEFER: #${FINDING_NUM} (est. ${TOKEN_ESTIMATE_PER_FINDING} tokens, projected total ${PROJECTED_TOKEN_SPEND} > ${TOKEN_BUDGET})"
  else
    BATCH_TOKEN_SPEND=$PROJECTED_TOKEN_SPEND
  fi
done

# Remove budget-deferred units from QUEUED_FINDINGS — they move to DEFERRED_FINDINGS/
# TOKEN_DEFERRED instead of dispatching this cycle. Re-evaluable in Step 4F.2.6, never
# permanent (distinct from the generation>=2 bucket in Step 4F.1).
if [ "${#TOKEN_BUDGET_DEFERRED_THIS_RUN[@]}" -gt 0 ]; then
  QUEUED_FINDINGS=($(printf '%s\n' "${QUEUED_FINDINGS[@]}" | grep -vxF -f <(printf '%s\n' "${TOKEN_BUDGET_DEFERRED_THIS_RUN[@]}") || true))
  DEFERRED_FINDINGS+=("${TOKEN_BUDGET_DEFERRED_THIS_RUN[@]}")
  echo "Token budget: deferred ${#TOKEN_BUDGET_DEFERRED_THIS_RUN[@]} P3-and-below unit(s) this cycle — batch spend now ${BATCH_TOKEN_SPEND}/${TOKEN_BUDGET}"
fi
```

**Classify lane for each queued finding (MANDATORY — before dispatch)** <!-- Added: forge#2629 -->

Cascade-dispatched findings inherit NO lane assumption from the parent batch. Step 4A.pre's classify-lane loop (above) only covers `{ready_issue_numbers}` — the *original* dispatch group — and does not see findings discovered mid-run by this Step 4C pass. Without an explicit gate here, a finding reaches the Step 4A/4B dispatch loop with `${ISSUE_LANE[$NUM]}`/`${ISSUE_PR_BASE[$NUM]}` unset for its number, which is exactly the milestone-owned-finding-misrouted-to-staging risk this issue exists to close. Run this loop over `QUEUED_FINDINGS` (the post-clubbing, post-token-budget-gate list) before any of the numbered steps below, reusing the identical `classify-lane.sh` invocation and failure handling as Step 4A.pre — same script, same batch-scope `ISSUE_LANE`/`ISSUE_PR_BASE` arrays (declared once, line ~362-363), no new mechanism:

```bash
for FINDING_NUM in "${QUEUED_FINDINGS[@]}"; do
  PR_BASE=$(bash "$CLASSIFY_LANE_SCRIPT" "$FINDING_NUM" -R {GH_REPO}) || {
    echo "ERROR: classify-lane.sh failed for #$FINDING_NUM — adding needs-human label and removing from QUEUED_FINDINGS" >&2
    # GOVERNOR-exempt: intentional coordination side-effect (best-effort lease/board/finding post), DRY_RUN-safe — reviewed & accepted for the check-command-side-effects gate. Flagged only by the staging->main full-diff; passes on every feature PR. forge#2627
    gh issue edit "$FINDING_NUM" -R {GH_REPO} --add-label "needs-human" 2>/dev/null || true
    QUEUED_FINDINGS=($(printf '%s\n' "${QUEUED_FINDINGS[@]}" | grep -vxF "$FINDING_NUM" || true))
    continue
  }
  # Derive LANE label from PR_BASE — identical rule to Step 4A.pre.
  if [ "$PR_BASE" = "staging" ]; then
    LANE="fast-lane"
  else
    LANE="feature-lane"
  fi
  ISSUE_LANE[$FINDING_NUM]="$LANE"
  ISSUE_PR_BASE[$FINDING_NUM]="$PR_BASE"
  echo "#$FINDING_NUM → lane=$LANE, PR_BASE=$PR_BASE (cascade finding)"
done
```

A finding that fails classify-lane is removed from `QUEUED_FINDINGS` (mirrors Step 4A.pre's `continue`, which never admits a failed classification into the ready set) and flagged `needs-human` instead of silently falling through to the dispatch loop with an unset lane.

**For queued (non-deferred) findings:**

1. **Add them to the dependency DAG.** They are implementation issues — same as issues spawned by investigations in Phase 2. Compute their predecessor sets using the same conflict detection (Step 3C Layers 1-4) against all remaining blocked/active issues.
2. **Respect source branch context.** Review-finding issues have `**Code branch**: \`{branch}\`` in their body — the `/work-on` agent will read this and branch from the right origin (the body annotation is repaired earlier in this step if missing — see the Code-branch repair guard above). Separately, and mandatorily, `${ISSUE_LANE[$NUM]}`/`${ISSUE_PR_BASE[$NUM]}` are now populated by the classify-lane loop immediately above this list — every queued finding is lane-classified individually, inheriting no lane assumption from the parent batch, before it reaches the standard Step 4A/4B dispatch loop.
3. **Report to user:**
   ```
   Agent #{COMPLETED} spawned {count} new finding issues: #{A}, #{B}
   Added to DAG: #{A} (predecessors: {}), #{B} (predecessors: {#{X}})
   Deferred (cascade control): #{C} (P3 same-file), #{D} (comment heuristic), #{E} (token budget)
   ```
4. **Re-run file-overlap detection** (Step 3C) on the expanded issue set — finding issues may conflict with active or queued issues that touch the same files. Ready findings dispatch immediately via the standard Step 4B dispatch loop.

**For deferred findings:**

Track them in `DEFERRED_FINDINGS` for re-evaluation in Step 4F (Completion Sweep) after the DAG drains. Do NOT close or label them yet — the sweep will determine their final disposition.

**If no review-finding issues were spawned:** Still run the "Amplification settle" block above with an empty finding list (it records this unit's ratio observation, which is what lets the breaker release), then Continue monitoring for the next agent completion.

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

**Step 4F.1: Classify deferred findings into permanent vs re-evaluable vs idle-gated vs token-gated**

```bash
PERMANENT_DEFERRED=()
SWEEP_CANDIDATES=()
IDLE_DEFERRED=()   # <!-- Added: forge#1814 -->
TOKEN_GATED=()     # <!-- Added: forge#1858 -->
: "${BREAKER_DEFER_TAG:=amplification breaker}"   # default if this block runs in a fresh shell (an empty tag would match every defer reason)
AMPLIFICATION_BREAKER_HELD=()    # amplification-breaker holds: bounded P3 batches only, never individually dispatched (forge#3060)

for FINDING_NUM in "${DEFERRED_FINDINGS[@]}"; do
  DEFER_REASON="${DEFERRED_REASONS[$FINDING_NUM]}"

  # Amplification-breaker holds (forge#3060) are checked FIRST: the breaker reason is appended to
  # whatever rule deferred the finding earlier (idle policy, generation, same-file, token budget),
  # and such a finding must never fall into a bucket whose re-evaluation dispatches it individually.
  if echo "$DEFER_REASON" | grep -qiF "$BREAKER_DEFER_TAG"; then
    AMPLIFICATION_BREAKER_HELD+=($FINDING_NUM)
  # Generation >= 2 deferrals are PERMANENT — unbounded cascade prevention
  elif echo "$DEFER_REASON" | grep -qi "generation"; then
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
  # "Token budget exceeded" deferrals (forge#1858) are ALSO their own bucket — re-evaluating
  # them via the file-overlap logic in Step 4F.2 would incorrectly clear them (they were never
  # deferred for file-overlap reasons) without checking whether token headroom actually exists.
  # See Step 4F.2.6 below, which mirrors the Step 4F.2.5 idle-gated pattern.
  elif echo "$DEFER_REASON" | grep -qi "token budget"; then
    TOKEN_GATED+=($FINDING_NUM)
  else
    # All other deferrals (comment/typo, P3 same-file) are re-evaluable
    SWEEP_CANDIDATES+=($FINDING_NUM)
  fi
done

echo "Completion sweep: ${#SWEEP_CANDIDATES[@]} re-evaluable, ${#PERMANENT_DEFERRED[@]} permanent, ${#IDLE_DEFERRED[@]} idle-gated, ${#TOKEN_GATED[@]} token-gated, ${#AMPLIFICATION_BREAKER_HELD[@]} breaker-held (P3 batches only)"
```

**Step 4F.2: Re-evaluate sweep candidates**

Re-run the Step 4C heuristics against the now-empty DAG. Since all original batch issues are in terminal state, the `ALL_BATCH_FILES` list for file-overlap detection is empty — P3 same-file deferrals will now pass.

```bash
SWEEP_EXECUTE=()
SWEEP_STILL_DEFERRED=()
AMPLIFICATION_BREAKER_SWEEP_HELD=()

for FINDING_NUM in "${SWEEP_CANDIDATES[@]}"; do
  FINDING_DATA=$(gh issue view $FINDING_NUM -R {GH_REPO} --json labels,title,body,state \
    --jq '{labels: [.labels[].name], title: .title, body: .body, state: .state}')

  # Skip if already closed (resolved by another process)
  STATE=$(echo "$FINDING_DATA" | jq -r '.state')
  [ "$STATE" = "CLOSED" ] && continue

  # Schema-tolerant extraction (forge#2232), mirrors the Step 4C main loop above.
  # PRIORITY is not currently read by the branches below (comment/typo is title-only),
  # kept normalized for consistency and to avoid reintroducing the schema bug if a
  # future rule here starts branching on it. NOTE: $FINDING_DATA.labels here is already
  # a flat array of label-name strings (see the --jq above: {labels: [.labels[].name], ...}),
  # so this reads `.labels[]` directly, not `.labels[].name`.
  PRIORITY=$(echo "$FINDING_DATA" | jq -r '
    ([.labels[] | select(test("^priority:P[0-9]+$"))] | .[0]) //
    ([.labels[] | select(test("^P[0-9]+$"))] | .[0]) //
    "" | ltrimstr("priority:")')
  TITLE=$(echo "$FINDING_DATA" | jq -r '.title')

  # Amplification-breaker deferrals (forge#3060) are NEVER individually dispatched by the sweep:
  # draining the DAG does not make a P3 cascade bounded. Leave them open for the bounded P3
  # batch sweep (planP3BatchGroups) and report them to the operator instead.
  case "${DEFERRED_REASONS[$FINDING_NUM]:-}" in
    *"$BREAKER_DEFER_TAG"*)
      SWEEP_STILL_DEFERRED+=($FINDING_NUM)
      AMPLIFICATION_BREAKER_SWEEP_HELD+=($FINDING_NUM)
      echo "Sweep: #${FINDING_NUM} held for P3 batching (amplification breaker) — not dispatched individually"
      continue ;;
  esac

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

**Step 4F.2.6: Re-evaluate token-gated deferrals** <!-- Added: forge#1858 -->

The original batch has now drained — the token spend that caused these deferrals belongs to a batch that is no longer competing for dispatch. Re-evaluate `TOKEN_GATED` against a **fresh, sweep-scoped** token allowance (`SWEEP_TOKEN_SPEND`, separate from the drained `BATCH_TOKEN_SPEND` — do NOT reuse or reset the original batch counter, which other reporting still reads in Step 6B). This mirrors the file-overlap re-check in Step 4F.2 (which also benefits from the drained-DAG state) rather than the idle-gated re-check in Step 4F.2.5 (which re-tests an external condition, not a resettable budget).

```bash
# Skip entirely if nothing was token-gated this run.
if [ "${#TOKEN_GATED[@]}" -gt 0 ]; then
  SWEEP_TOKEN_SPEND=0

  for FINDING_NUM in "${TOKEN_GATED[@]}"; do
    STATE=$(gh issue view "$FINDING_NUM" -R {GH_REPO} --json state --jq '.state' 2>/dev/null || echo "")
    [ "$STATE" = "CLOSED" ] && continue   # resolved by another process — drop silently

    PROJECTED_SWEEP_SPEND=$((SWEEP_TOKEN_SPEND + TOKEN_ESTIMATE_PER_FINDING))
    if [ "$TOKEN_BUDGET" != "unlimited" ] && [ "$PROJECTED_SWEEP_SPEND" -gt "$TOKEN_BUDGET" ]; then
      SWEEP_STILL_DEFERRED+=($FINDING_NUM)
      echo "Sweep: #${FINDING_NUM} still deferred (token budget — sweep allowance ${TOKEN_BUDGET} would be exceeded at ${PROJECTED_SWEEP_SPEND})"
    else
      SWEEP_TOKEN_SPEND=$PROJECTED_SWEEP_SPEND
      SWEEP_EXECUTE+=($FINDING_NUM)
      echo "Sweep: #${FINDING_NUM} cleared for execution (fits fresh sweep token allowance — ${SWEEP_TOKEN_SPEND}/${TOKEN_BUDGET})"
    fi
  done
fi
```

Findings that still don't fit the fresh sweep allowance remain deferred — never permanent (unlike `generation >= 2`). They are re-evaluated again on the next `/orchestrate` invocation or completion sweep, exactly like comment/typo and P3-same-file deferrals.

**Step 4F.3: Dispatch cleared findings**

For each finding in `SWEEP_EXECUTE`, add it to a fresh sweep DAG and dispatch using the same Steps 4A.pre.0, 4A.pre, and 4A logic. Run file-overlap detection between the swept findings themselves (they may conflict with each other).

**MANDATORY**: Use the full Step 4A agent template verbatim for each swept finding. Do NOT use a bare `prompt="Run /work-on N"` — that bypasses the label-state loop contract, source branch detection, and all pipeline enforcement rules. Swept findings are always `review-finding` issues that require source branch detection to route correctly.

**Step 4F.3.pre: Classify lane for each sweep finding (MANDATORY before dispatching)**

Run `classify-lane.sh` per finding — same pattern as Step 4A.pre:

```bash
declare -A SWEEP_LANE
declare -A SWEEP_PR_BASE

for FINDING_NUM in "${SWEEP_EXECUTE[@]}"; do
  SWEEP_BASE=$(bash "$CLASSIFY_LANE_SCRIPT" "$FINDING_NUM" -R {GH_REPO}) || {
    echo "ERROR: classify-lane.sh failed for #$FINDING_NUM — adding needs-human and skipping" >&2
    # GOVERNOR-exempt: intentional coordination side-effect (best-effort lease/board/finding post), DRY_RUN-safe — reviewed & accepted for the check-command-side-effects gate. Flagged only by the staging->main full-diff; passes on every feature PR. forge#2627
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
      model="{SUBAGENT_MODEL}",
      description="Work on {PROJECT_PREFIX}#${FINDING_NUM}",
      run_in_background=true,
      prompt="You are working on GitHub issue #${FINDING_NUM} for the {PROJECT_NAME} project.

**Project**: {PROJECT_NAME}
**Repository**: {GH_REPO}
**Repo path**: {REPO_PATH}

**KNOWLEDGE GIST CAPABILITY**: This orchestration already probed it: `${FORGE_GIST_CAPABLE}`. Before invoking `/work-on`, run `export FORGE_GIST_CAPABLE=${FORGE_GIST_CAPABLE}`. Do not re-probe or attempt Gist creation when it is `false`.

**YOUR MISSION**: Invoke \`/work-on\` via the Skill tool and let it run to completion. \`/work-on\` is a self-contained routing loop that handles the ENTIRE pipeline: investigate → build (context → architect → implement → validate) → review (push → PR → /review-pr --auto-merge) → close (project board → trajectory log → worktree cleanup). Do NOT intervene, compensate, or manually close issues — \`/work-on\` handles everything including issue closure and label updates in its close phase.

**CRITICAL — DO NOT STOP EARLY**: /work-on runs as a multi-phase routing loop. Each phase (investigate, build, review, close) returns an intermediate result — these are NOT completion signals. You are NOT done until the issue reaches a terminal state: \`workflow:merged\`, \`workflow:invalid\`, \`needs-human\`, or \`workflow:awaiting-merge\`. If /work-on returns after only one phase (e.g., investigation), you MUST invoke it again immediately — it will re-read GitHub state and continue to the next phase. Keep invoking /work-on until it reaches a terminal state. Never output 'done' or stop after an intermediate result.

**HOW REVIEW FINDINGS WORK**: /review-pr may create GitHub issues (with \`review-finding\` label) for findings it discovers. These are NOT blockers — they are separate work items that will go through their own /work-on pipeline later. The original PR should ALWAYS merge after review. The only exception is build errors (code doesn't compile) — those must be fixed before merging.

**IMPORTANT RULES**:
- **MANDATORY**: You MUST use the Skill tool to invoke '{FORGE_SKILL_PREFIX}work-on' with args '${FINDING_NUM}'. Do NOT implement manually — /work-on handles the full pipeline including label state machine (workflow:investigating → workflow:building → workflow:in-review → workflow:merged), investigation reports, PR creation, and cleanup.
  - For default repo issues: \`Skill(skill='{FORGE_SKILL_PREFIX}work-on', args='${FINDING_NUM} --under-orchestration')\`
  - For satellite repo issues: \`Skill(skill='{FORGE_SKILL_PREFIX}work-on', args='<satellite-prefix>:${FINDING_NUM} --under-orchestration')\` (\`<satellite-prefix>\` from forge.yaml → repos.satellites)
  - **If \`{FORGE_SKILL_PREFIX}work-on\` is reported unknown or not found, this is a HARD ERROR: STOP and report 'skill not found: {FORGE_SKILL_PREFIX}work-on' as your final result. Do NOT run the pipeline phases inline or with the Agent tool — an inline run bypasses the phase trail.**
- NEVER bypass /work-on with manual git/gh commands — the label updates and structured comments are critical for tracking
- NEVER target \`main\` for PRs targeting the default repo. Use \`{STAGING_BRANCH}\` for fast-lane issues, or \`milestone/{slug}\` for milestone issues.
- Satellite repos (MCP, n8n) have no staging branch — fast-lane PRs go to \`main\` for those.
- If the issue is INVALID after investigation, close it with a comment explaining why
- If you hit merge conflicts or blockers, post a comment on the issue and STOP — do not force anything
- Do not interact with the user — you are running autonomously in the background
- **NEVER ask the user questions** — you are a background agent. If review finds issues, auto-fix simple ones and proceed, then let `/review-pr`'s own verdict decide: APPROVED (no unresolved CONFIRMED HIGH/CRITICAL finding) → merge to `staging` and create follow-up issues for the rest, **regardless of domain**. Domain alone (AUTH, BILLING, DATABASE, or any domain tagged as security-critical in Step 3B) is NOT a reason to add `needs-human` and stop — `staging` is reversible; the real human deploy gate is `staging → main`, not this merge. <!-- Added: forge#1815 --> `needs-human` is reserved for what the pipeline genuinely cannot do itself: spend/procurement decisions, real-environment validation it has no access to, product/architecture judgment calls a human must make, or `/review-pr`'s existing evidence-based escalations (spec-evolution guard, novel task-type/module-combo trust escalation, calibration-based overconfidence routing). An unresolved CONFIRMED HIGH/CRITICAL finding is `/review-pr`'s own withheld-APPROVED case, not a domain-driven `needs-human` halt — `/review-pr` already refuses to return APPROVED when that's true, so there is no separate domain check to perform here.

**LABEL-STATE LOOP CONTRACT — enforce after EVERY Skill return**:
After EVERY \`Skill(skill='{FORGE_SKILL_PREFIX}work-on', ...)\` call returns, immediately check the issue's current workflow label:
\`\`\`bash
gh issue view ${FINDING_NUM} -R {GH_REPO} --json labels --jq '[.labels[].name | select(startswith(\"workflow:\"))]'
\`\`\`
**Terminal labels** (only these allow you to stop): \`workflow:merged\`, \`workflow:invalid\`
**Terminal condition also**: \`needs-human\` label present, \`workflow:awaiting-merge\` label present, OR issue state is \`closed\`
If the label is NOT terminal (e.g., \`workflow:investigating\`, \`workflow:ready-to-build\`, \`workflow:building\`, \`workflow:in-review\`), invoke \`Skill(skill='{FORGE_SKILL_PREFIX}work-on', args='${FINDING_NUM} --under-orchestration')\` again immediately. The \`/work-on\` skill will re-read GitHub state and advance to the next phase. Do NOT output a summary, do NOT pause, do NOT ask for confirmation — just invoke it again.

**CRITICAL — SOURCE BRANCH DETECTION**:
- If the issue has the \`review-finding\` label, read the issue body for \`**Code branch**: \\\`{branch}\\\`\`
- If found, that branch is the source branch (`<source-branch>` below) — the code ONLY exists on that branch (e.g., \`staging\`), NOT on \`origin/main\`
- Investigation MUST use \`git show origin/<source-branch>:<filepath>\` to verify the code exists
- Worktree MUST branch from \`origin/<source-branch>\`, NOT \`origin/main\`
- PR target is \`<source-branch>\` (the fix goes back to where the code lives)

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
  Permanently deferred (gen2): #{D} (generation >= 2 cascade cap — requires manual /work-on, or an explicit `cascade`/`review-findings --allow-gen2` request via phase-1-resolve.md; see #2231/#2234)
  Idle-gated — still deferred: #{E} (batch still fully human-gated — waiting on a merge)
  Idle-gated — cleared: #{F} (a gating PR merged since deferral — no longer idle)
  Token-gated — cleared: #{G} (fits fresh sweep token allowance — batch spend ${SWEEP_TOKEN_SPEND}/${TOKEN_BUDGET})
  Token-gated — still deferred: #{H} (sweep allowance also exhausted — re-evaluable next run)
```

**After sweep agents complete** (or if no findings were dispatched): output the budget deferred-issues report (if applicable), **call `cleanup_trail_cache` (Step 4B) and `release_orchestrator_lease()` (Step 4A-pre.-1)** — the sweep is this session's last dispatch activity, so the lease must not be left held for a now-idle session (the Termination condition's own release call, above, only fires on the no-deferred-findings branch; this is the equivalent release for the deferred-findings/Completion Sweep branch) <!-- Added: forge#2627 -->, then proceed to Phase 5.

**Anti-patterns — DO NOT DO THIS:**
- Re-sweeping findings spawned during the sweep itself — this creates unbounded recursion. Sweep is a single pass.
- Overriding generation >= 2 deferrals **inside this Step 4C mid-run triage** — the cascade cap is absolute for autonomous cascade: a sweep or triage pass must never promote a gen≥2 finding to executed just because it looks low-risk. This is distinct from an explicit human request made *before* the run starts: an operator may deliberately admit gen≥2 findings via `phase-1-resolve.md`'s `cascade`/`review-findings`/`findings` resolution with `--include-deferred`/`--allow-gen2` (or the `orchestration.cascade.max_generation` config lever from #2234) — that is the sanctioned override path, entered at Phase 1 resolution, not a violation of this rule. Do not use that human-request path as precedent to relax Step 4C itself. <!-- Added: forge#2231 -->
- Skipping the sweep because "there are only a few" deferred findings — even one deferred finding represents unresolved work.
- Clearing an idle-gated deferral (forge#1814) without recomputing `BATCH_FULLY_GATED` fresh at sweep time — a stale "not gated" read would re-introduce the exact net-negative churn this policy exists to stop.
- Clearing a token-gated deferral (forge#1858) by reusing the drained `BATCH_TOKEN_SPEND` instead of the fresh `SWEEP_TOKEN_SPEND` allowance — the whole point of Step 4F.2.6 is that the *original* batch's spend is no longer relevant once it has drained.

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
