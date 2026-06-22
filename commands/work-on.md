---
description: Pick up a GitHub issue and run the full investigate-build-review-merge pipeline
argument-hint: [issue number or "next" to pick highest priority]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /work-on — Full Issue Pipeline

**Input**: $ARGUMENTS

Orchestrator for the full issue lifecycle: investigate → decompose (if needed) → build → review → merge → close. GitHub issues are the persistent context layer — read existing comments before starting, write structured reports back, use `workflow:*` labels to track state.

**Agent model policy**: Default `model: "sonnet"`. Fallback: `model: "opus"` if Sonnet is rate-limited.
**NEVER use plan mode (EnterPlanMode).**

### Compaction Resilience

1. Write state to GitHub after EVERY significant step
2. Re-read GitHub state at the START of each phase (don't rely on in-memory context)
3. After compaction: re-read issue (body + comments + labels) to reconstruct state
4. Key principle: A NEW session running `/work-on {number}` should pick up where the last left off by reading GitHub state alone

### Universal Phase Dispatcher

<!-- FORGE:DISPATCHER — This is the SINGLE source of truth for phase transitions. Every phase boundary references this section. -->

**Phase sequence** (canonical order):

| Step | Phase | Entry Condition | Terminal? |
|------|-------|-----------------|-----------|
| 1 | Phase 0: Resolve Issue | Always first | No |
| 2 | Phase 1: Investigation | No `INVESTIGATION:COMPLETE` comment | No |
| 3 | Phase 1D: Route | Investigation complete | No |
| 4 | Phase 2: Decomposition | decompose: YES | Yes (spawns sub-issues) |
| 5 | Phase 3: Build (3A–3M) | `workflow:ready-to-build` or `workflow:building` | No |
| 6 | Phase 4: PR Creation | Builder comment posted, no PR exists | No |
| 7 | Phase 5: Auto-Review | PR exists, `workflow:in-review` | No |
| 8 | Phase 6: Close & Cleanup | PR merged | No |
| 9 | Phase 7: Trajectory | Issue closed | Yes |

**Phase 3 sub-phase sequence** (execute in order; 3C.5 and 3C.6 are conditional — see Phase 3B):

3A → 3B → [3C → 3C.5* → 3C.6*] → 3D → 3E → 3F → 3F.5 → 3G → 3H → 3I → 3I.5 → 3J → 3K → 3L → 3M

*3C.5 and 3C.6 are skipped for TRIVIAL tasks; 3C (Builder Contract) is still required. Investigation tasks exit at 3B before 3C.

**Universal continuation rule**: After ANY phase or sub-phase completes, check whether a terminal state has been reached. Terminal states are:
- `workflow:merged` label is set
- `workflow:invalid` label is set
- `needs-human` label is set
- `workflow:decomposed` label is set (sub-issues spawned)
- Issue state is CLOSED with terminal label

**If the current state is NOT terminal: proceed to the next phase in the sequence immediately. Do NOT stop. Do NOT emit a summary. Do NOT treat any intermediate phase completion as a terminal signal.** Every phase completion — investigation done, quality gate passed, PR merged, review complete — is an intermediate result. Only the terminal states listed above allow stopping.

**Adding a new phase**: Insert it into the phase sequence table above and the sub-phase sequence if it belongs to Phase 3. No per-boundary transition code is needed — the universal continuation rule handles all transitions.

---

## Pipeline Rules

- **NEVER merge to main.** PRs target `staging` (fast lane) or `milestone/{slug}` (feature lane).
- **`Closes #N` does not auto-close for non-default-branch PRs.** You MUST explicitly `gh issue close`.
- **Review findings are NOT merge blockers.** They become separate issues.

---

## Project Configuration

Read `forge.yaml` from the repository root before processing any issue.

If `forge.yaml` is missing: stop and tell the user to run `npx forgedock init` to generate it.

**Resolve these values from `forge.yaml`**:

| Variable | Source field | Notes |
|----------|-------------|-------|
| `GH_REPO` | `project.owner` + `/` + `project.repo` | e.g. `acme-org/acme-platform` |
| `GH_FLAG` | `-R {GH_REPO}` | Passed to all `gh` commands |
| `REPO_PATH` | `paths.root` | Absolute path to repo root |
| `WORKTREE_BASE` | `paths.worktree_base` | Base dir for git worktrees |
| `STAGING_BRANCH` | `branches.staging` | Fast-lane PR target |
| `PROJECT_BOARD_OWNER` | `project_board.owner` (or `project.owner` as fallback) | For `gh project` commands |
| `PROJECT_BOARD_NUMBER` | `project_board.project_number` (or `1` as fallback) | Project number in `gh project` commands |

**Multi-repo routing** (when `forge.yaml → repos` section is present):

Parse issue input for a prefix (`<prefix>:<number>`). Look up `<prefix>` in `forge.yaml → repos.satellites[]`. Use that satellite's `repo` and `staging_branch` as `GH_REPO` and `STAGING_BRANCH`. If no prefix is given, use the default (`project.owner/project.repo`).

If `forge.yaml → repos` is absent, only the default repo is available — prefixed issue numbers are invalid.

Satellite repos (those without a `staging` branch) receive fast-lane PRs directly to `main`.

---

## Phase 0: Resolve Issue & Load Context

### 0A: Parse input
Extract project prefix and issue number. If `next`/`pick`: list open issues sorted by priority, skip `needs-human` and `workflow:decomposed`, pick highest priority.

**Optional pre-flight**: Before committing to the full pipeline, run `/scope {NUMBER}` to get a complexity estimate (affected files, blast radius, risk flags, and decomposition recommendation). Especially useful for large or ambiguous issues.

### 0A.5: Post Heartbeat Annotation

Post a lightweight activity signal immediately after resolving the issue number. This gives the stall detector (orchestrate Step 4B.5) a fresh timestamp to compare against `STALL_TIMEOUT`. Without this, the stall detector can only see the last structured comment (INVESTIGATOR, BUILDER, etc.) which may be hours old during a valid long-running phase.

```bash
PHASE_START_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:HEARTBEAT -->
**Phase**: Phase 0 — starting pipeline
**Timestamp**: ${PHASE_START_TIMESTAMP}
**Issue**: #{NUMBER}"
```

**Also post at major phase entry points** (Phases 1, 3, and 5) — replace `Phase 0` with the correct phase name in each case. These mid-pipeline heartbeats ensure the stall detector sees recent activity during long phases (e.g., a build phase running for 20 minutes is not falsely classified as stalled). Inline snippets are embedded at Phase 1A, Phase 3A, and Phase 5A — agents resuming mid-pipeline encounter them without reading this section. <!-- Added: forge#740 -->

**Skip if**: Issue already has a terminal label (`workflow:merged`, `workflow:invalid`, `needs-human`) — no heartbeat needed on a completed issue.

### 0B: Load issue + existing context
```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,comments,milestone
gh api repos/{GH_REPO}/issues/{NUMBER}/comments --jq '.[] | {id: .id, author: .user.login, body: .body}'
```

**Check**: state (closed → STOP), terminal labels (`workflow:merged`/`workflow:invalid` → STOP), existing agent comments (`FORGE:INVESTIGATOR`, `FORGE:DECOMPOSED`, `FORGE:CONTRACT`, `FORGE:BUILDER`, `FORGE:TRAJECTORY`, `FORGE:DECISION_RECORD`), parent tracker status, sub-issue status.

**Determine resume point**: No comments → Phase 1. Investigation exists + ready-to-build → Phase 3. Builder + no PR → Phase 4. Builder + PR open → Phase 5. PR merged + issue open → Phase 6.

### 0B.5: Read Phase Checkpoint (MANDATORY — executes before any phase-skip decision)

Query for the latest `<!-- FORGE:CHECKPOINT -->` comment. This is the machine-readable source of truth for the pipeline's current phase position — it takes priority over all prose-based resume heuristics above.

```bash
CHECKPOINT=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:CHECKPOINT"))] | last | .body // ""')

if [ -n "$CHECKPOINT" ]; then
  # Extract next_phase from the JSON block inside the comment
  NEXT_PHASE=$(echo "$CHECKPOINT" | grep -A5 '```json' | grep '"next_phase"' \
    | sed -n 's/.*"next_phase": "\([^"]*\)".*/\1/p')
  echo "Checkpoint found: next_phase=${NEXT_PHASE}"
fi
```

**Routing from checkpoint** (overrides prose heuristics above when a checkpoint exists):

| `next_phase` value | Resume at |
|--------------------|-----------|
| `BUILD` | Phase 3 (skip Phase 1 investigation) |
| `DECOMPOSE` | Phase 2 (skip Phase 1 investigation) |
| `REVIEW` | Phase 4 (skip Phase 1–3) |
| `CLOSE` | Phase 6 (skip Phase 1–5) |
| *(absent or unrecognized)* | Fall back to prose heuristics above |

**If no checkpoint exists**: fall back to prose resume heuristics in Phase 0B above — treat as fresh start at Phase 1.

**Classify lane**: Milestone → feature lane (`milestone/{slug}`). No milestone → fast lane (`staging`).

**Source branch for review-findings**: Parse `**Code branch**: \`{branch}\`` from body. Branch from there, not main.

**Script resolution** — Use the following `resolve_script()` function whenever calling a pipeline script. It enforces the 4-level precedence hierarchy (see `devdocs/project/architecture.md → Script Precedence`):

```bash
ADAPTIVE_DIR_RAW="${REPO_PATH}/$(yq '.adaptive_scripts.directory // ".forgedock/scripts"' forge.yaml 2>/dev/null || echo '.forgedock/scripts')"
ADAPTIVE_DIR=$(realpath -m "$ADAPTIVE_DIR_RAW" 2>/dev/null || echo "$ADAPTIVE_DIR_RAW")
ADAPTIVE_ENABLED=$(yq '.adaptive_scripts.enabled // "true"' forge.yaml 2>/dev/null || echo 'true')
# Bounds check: reject adaptive_scripts.directory values that escape the repo root.
# Normalize REPO_PATH the same way ADAPTIVE_DIR is normalized (realpath -m) so a trailing
# slash in paths.root does not inject a '//' into the glob and trigger a false positive.
REPO_PATH_NORM=$(realpath -m "$REPO_PATH" 2>/dev/null || echo "$REPO_PATH")
if [[ "$ADAPTIVE_DIR" != "${REPO_PATH_NORM}/"* ]]; then
  echo "WARNING: adaptive_scripts.directory resolves outside repo root ('$ADAPTIVE_DIR') — adaptive tier disabled" >&2
  ADAPTIVE_ENABLED=false
fi
UNIVERSAL_DIR="${FORGEDOCK_HOME:-$(dirname "$(which classify-lane.sh 2>/dev/null || echo 'scripts')")}/scripts"

resolve_script() {
  local operation="$1"
  # Tier 2: per-repo adaptive (skip if disabled)
  if [ "$ADAPTIVE_ENABLED" != "false" ] && [ -f "${ADAPTIVE_DIR}/${operation}.sh" ]; then
    echo "adaptive:${ADAPTIVE_DIR}/${operation}.sh"
    return
  fi
  # Tier 3: universal script
  if [ -f "${UNIVERSAL_DIR}/${operation}.sh" ]; then
    echo "universal:${UNIVERSAL_DIR}/${operation}.sh"
    return
  fi
  # Tier 4: prose fallback
  echo "prose:"
}

# Canonical tier-dispatch usage pattern — inline at every resolve_script() call site:
#
# There is no centralised run_script() function. The pattern below is inlined
# directly at each call site because each operation has a different prose
# fallback. Copy and adapt this block wherever resolve_script() is called.
#
# Usage pattern at each call site:
#   RESOLUTION=$(resolve_script 'op')
#   TIER="${RESOLUTION%%:*}"
#   SCRIPT_PATH="${RESOLUTION#*:}"
#   case "$TIER" in
#     adaptive|universal) bash "$SCRIPT_PATH" ARGS ;;
#     prose)              # inline fallback here ;;
#   esac
#
# The case pattern is inlined at every call site (rather than centralised here)
# because each operation has a different prose fallback — transition-label falls
# back to inline gh issue edit; classify-lane has no valid prose fallback and
# must exit 1; validate-pr-target emits a WARNING and continues (the PR review
# step catches any mismatch before merge). <!-- Added: forge#822 -->
```

When invoking a resolved script, log the tier in the FORGE annotation: `Script tier: {adaptive|universal|prose} ({path})`. This provides full pipeline observability. <!-- Added: forge#670 -->

### 0B.1: Apply learned overrides (MANDATORY — run after 0B, before any routing)

Read `forge.yaml → learned:` and override runtime variables. If the `learned:` key is absent or empty, all steps below are no-ops — continue to 0C.

```bash
# Read learned section — all reads use // "" fallback so absent keys are silent no-ops
LEARNED_STAGING=$(yq '.learned.branch_targets.staging // ""' forge.yaml 2>/dev/null || echo '')
LEARNED_TEST_COMMANDS=$(yq '.learned.test_commands // []' forge.yaml 2>/dev/null || echo '[]')
LEARNED_LABEL_MAP=$(yq '.learned.label_map // {}' forge.yaml 2>/dev/null || echo '{}')
LEARNED_COMMIT_STYLE=$(yq '.learned.commit_style // ""' forge.yaml 2>/dev/null || echo '')
```

**Apply overrides**:

1. **Branch target override** — If `LEARNED_STAGING` is non-empty, replace `STAGING_BRANCH` with its value:
   ```bash
   [ -n "$LEARNED_STAGING" ] && STAGING_BRANCH="$LEARNED_STAGING" && \
     echo "Learned override: STAGING_BRANCH → $STAGING_BRANCH (from learned.branch_targets.staging)"
   ```

2. **Test commands** — Store `LEARNED_TEST_COMMANDS` for use in Phase 3H (validate). These are appended to the `verification.commands` runs, not replaced:
   ```bash
   # Pass LEARNED_TEST_COMMANDS to Phase 3H as additional commands to run after verification.commands
   # (consumed in 3H — store as env var or carry forward in context)
   echo "Learned test commands: $LEARNED_TEST_COMMANDS"
   ```

3. **Label map** — If `LEARNED_LABEL_MAP` is non-empty, export it as `FORGE_LABEL_MAP` so that all subsequent `resolve_script 'transition-label'` invocations (which are child processes) can read it. The script performs the substitution internally: if the canonical label (e.g. `workflow:investigating`) appears as a key in the map, it uses the mapped value instead.
   ```bash
   # Export as FORGE_LABEL_MAP so child processes (resolve_script 'transition-label') can read it.
   # All 8 resolve_script 'transition-label' call sites in this command inherit this env var automatically.
   # The script substitutes the canonical workflow:* label with the mapped value when found.
   export FORGE_LABEL_MAP="$LEARNED_LABEL_MAP"
   [ -n "$LEARNED_LABEL_MAP" ] && [ "$LEARNED_LABEL_MAP" != "{}" ] && \
     echo "Learned override: FORGE_LABEL_MAP active — label_map will be applied by resolve_script 'transition-label'"
   ```

4. **Commit style** — If `LEARNED_COMMIT_STYLE` is non-empty, use it in Phase 3M:
   ```bash
   [ -n "$LEARNED_COMMIT_STYLE" ] && COMMIT_STYLE="$LEARNED_COMMIT_STYLE" && \
     echo "Learned override: COMMIT_STYLE → $COMMIT_STYLE"
   ```

<!-- Added: forge#667 — learned section reader -->

### 0C: Sync to Project board
Add issue to project, set Status=In Progress, Lane, Component, Priority, Workflow=Investigating.

---

## Phase 1: Investigation

**Skip if**: `<!-- FORGE:INVESTIGATOR -->` exists with `<!-- INVESTIGATION:COMPLETE -->` in the SAME comment.

**Partial investigation**: If investigator comment exists BUT `<!-- INVESTIGATION:COMPLETE -->` is ABSENT → investigation was interrupted. Delete the partial comment and restart:
```bash
COMMENT_ID=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .id')
gh api repos/{GH_REPO}/issues/comments/$COMMENT_ID -X DELETE
```

### 1A: Set label
```bash
RESOLUTION=$(resolve_script 'transition-label')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} investigating ;;
  prose)
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:investigating" \
      --remove-label "workflow:ready-to-build,workflow:building,workflow:in-review,workflow:merged,workflow:invalid,workflow:decomposed" 2>/dev/null || true
    ;;
esac
```

**Post Phase 1 heartbeat** (skip if issue already has a terminal label — `workflow:merged`, `workflow:invalid`, `needs-human`):
```bash
PHASE_START_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:HEARTBEAT -->
**Phase**: Phase 1 — Investigation
**Timestamp**: ${PHASE_START_TIMESTAMP}
**Issue**: #{NUMBER}"
```

### 1A.5: Normalize Issue Body (MANDATORY)

Before investigation begins, verify the issue body contains the four mandatory pipeline sections. If any are missing, add placeholder content so the investigator has the correct scaffolding.

**Skip if**: All four sections (`## Problem`, `## Affected Files`, `## Expected Behavior`, `## Acceptance Criteria`) are already present.

```bash
ISSUE_BODY=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body')

MISSING_SECTIONS=""
echo "$ISSUE_BODY" | grep -q "^## Problem" || MISSING_SECTIONS="$MISSING_SECTIONS PROBLEM"
echo "$ISSUE_BODY" | grep -q "^## Affected Files" || MISSING_SECTIONS="$MISSING_SECTIONS AFFECTED_FILES"
echo "$ISSUE_BODY" | grep -q "^## Expected Behavior" || MISSING_SECTIONS="$MISSING_SECTIONS EXPECTED_BEHAVIOR"
echo "$ISSUE_BODY" | grep -q "^## Acceptance Criteria" || MISSING_SECTIONS="$MISSING_SECTIONS ACCEPTANCE_CRITERIA"

if [ -n "$MISSING_SECTIONS" ]; then
  echo "Missing sections:$MISSING_SECTIONS — normalizing issue body before investigation"

  APPEND_TEXT=""
  echo "$MISSING_SECTIONS" | grep -q "PROBLEM" && APPEND_TEXT="$APPEND_TEXT
## Problem

Root cause unknown — investigation needed."

  echo "$MISSING_SECTIONS" | grep -q "AFFECTED_FILES" && APPEND_TEXT="$APPEND_TEXT
## Affected Files

Files to be identified during investigation."

  echo "$MISSING_SECTIONS" | grep -q "EXPECTED_BEHAVIOR" && APPEND_TEXT="$APPEND_TEXT
## Expected Behavior

Expected behavior to be determined during investigation."

  echo "$MISSING_SECTIONS" | grep -q "ACCEPTANCE_CRITERIA" && APPEND_TEXT="$APPEND_TEXT
## Acceptance Criteria

- [ ] Fix confirmed during investigation."

  # Append missing sections to the existing body (never replace — only extend)
  NORMALIZED_BODY="${ISSUE_BODY}${APPEND_TEXT}"
  gh issue edit {NUMBER} {GH_FLAG} --body "$NORMALIZED_BODY"
  echo "Issue body normalized — added:$MISSING_SECTIONS"
else
  echo "Issue body already contains all mandatory sections — skipping normalization"
fi
```

**Continue to Phase 1B unconditionally.** Normalization is a compensation step — it never blocks investigation.

### 1B: Investigate the issue

Mission: Validate whether the issue is real. Assume description is wrong until proven otherwise.

**Resolve target repo and branch**:

Read `forge.yaml → review.tech_stack` and `forge.yaml → review.key_paths` (if present) to identify which files are most relevant for the affected domain. If the `review` section is absent, use the issue labels, title keywords, and the affected files listed in the issue body to determine the domain. Start with the files the issue explicitly names, then expand to callers and related modules.

**Workflow pipeline issues** (repo is a ForgeDock installation):
- Key files: `commands/work-on.md`, `commands/review-pr.md`, `commands/quality-gate.md`, `commands/orchestrate.md`, `forge.yaml`, `bin/forgedock.mjs`

**Application issues** (all other repos):

Use `forge.yaml → review.tech_stack` and the issue domain labels to identify entry points. If `forge.yaml → review.key_paths` lists domain-to-file mappings, use that table directly. Otherwise, infer key files from the issue body's Affected Files section.

**INFRA domain known footguns** (read before writing any `.github/workflows/*.yml` changes):
- **appleboy/ssh-action Go template preprocessing**: Any `{{` in a `script:` block is interpreted as a Go template directive **before the script reaches SSH**. This means `docker ps --format '{{.Names}}'` and `docker inspect --format '{{index .RepoTags 0}}'` will crash the action with exit 1. Both function calls (`{{index .X Y}}`) AND field accessors (`{{.Names}}`, `{{.Status}}`) fail on the action's empty data context. Shell error handlers (`|| fallback`, `set -e`, `2>/dev/null`) are bypassed because the failure is client-side. Always use `docker inspect IMAGE | jq -r '.[0].RepoTags[0]'` and `docker ps --format json | jq -r '.Names'` patterns in `appleboy/ssh-action` scripts. (Ref: forge#226 — 6-day silent deploy failure masked by `continue-on-error: true`)

**Steps**:
1. Check the right branch — read from branch specified in issue body (`**Code branch**: \`{branch}\``) if present
2. Read domain files — start with key files for the affected domain
2.5. **Existing system search (conditional)**: If the issue describes a gap in a functional capability — content not being distributed, notifications not sending, jobs not running, data not being synced — MUST search for an existing automated system before proposing a new one. The issue body may name a specific tool or path (e.g., `reddit-bot/`, `marketing/`) — do NOT anchor on that path alone. Expand the search to all service layers:
   ```bash
   # Check all service layers for the capability (adapt paths to your project structure)
   grep -rn "{capability_keyword}" {REPO_PATH}/services/ --include="*.py" -l | head -20
   # Look for scheduled jobs, automated runners, existing integrations
   grep -rn "scheduler\|celery\|cron\|nightly\|periodic" {REPO_PATH}/services/ --include="*.py" -l | head -10
   ```
   If an existing system is found that already handles the capability: the fix MUST route through the existing system (fix its config, env var, or gate) — NOT create a new parallel tool. Document the existing system in the investigation report and make it the centerpiece of the recommendation. This check is especially critical when the issue references a standalone tool directory (`reddit-bot/`, `scripts/`, `tools/`) — those directories often duplicate functionality that a service already owns. (Ref: forge#279 — investigator anchored on `reddit-bot/` from issue body, never checked `services/herald/app/scheduler/`, built parallel PRAW integration alongside Herald's existing automated crosspost scheduler)
3. Verify claims — does the code actually have the problem described?
3.5. **Type Invariant Verification (MANDATORY)**: Before declaring that a field, key, or parameter has a specific type (e.g. "content is always a dict", "status is always an int"), search for ALL code paths that write to that field across ALL services:
   ```bash
   grep -rn '"field_name"\s*:' services/   # Python dict key assignments
   grep -rn 'result\["field_name"\]\s*=' services/  # Direct assignments
   grep -rn '\.field_name\s*=' services/   # Attribute assignments
   ```
   If the field is written with different types in different code paths (e.g. dict in the standard path, string in the auth-gated path), document ALL variants. The fix must handle every variant — not just the one on the primary investigated code path. A type guard like `or {}` only protects against falsy values; a non-empty string is truthy and bypasses it.
4. Git blame — trace when/why the relevant code was written
4.5. **Rogue commit pre-state comparison (conditional)**: If the issue body references a specific commit as rogue, bad, or unintended (e.g., "rogue commit `abc1234`", "bad commit", "this was never intended"), MUST run `git show {commit}^:{file}` to see the file before that commit. Compare the pre-commit state against the current file. Any block present in the current file but absent in the pre-commit state was introduced by that commit chain and is a candidate for full reversion — not just partial editing. Report the delta (pre vs. current) in the investigation report. Do NOT assume surrounding code near a named import/bug is correct simply because the issue only named a specific sub-problem. (Ref: forge#278 — investigator confirmed the broken import but never ran `git show 18a3a2cf3^:batch.py`; the surrounding 50-line feature gate was also rogue and was preserved by the fix PR, causing a P1 access regression for all non-Scale users)
5. Domain context discovery (narrow scope only, 1–5 files):
   ```bash
   git log --oneline --all -30 -- {affected_files} | grep -oE '#[0-9]+' | sort -u
   gh issue list -R {GH_REPO} --state closed --limit 8 --search "{function_name}"
   ```
   Keep only file/function-level overlap. Max 5 related issues.
6. Determine root cause
7. Identify affected files — full list of files that need changes
7.5. **Sibling Pattern Sweep** *(conditional — when the bug is a condition, gated function call, or field presence check)*: After identifying the affected files, grep for the same pattern in sibling files within the same directory. The issue spec may name only the file where the error was first observed — but the same commit or PR that introduced the bug often applied it uniformly across related handlers.
   ```bash
   # Identify the broken condition or gated function call from the issue
   # Then search sibling files in the same router/service directory
   AFFECTED_DIR=$(dirname {PRIMARY_AFFECTED_FILE})
   grep -rn "{broken_pattern}" "$AFFECTED_DIR" --include="*.py" | grep -v "{PRIMARY_AFFECTED_FILE}"
   ```
   **If identical patterns are found in files NOT listed in the issue spec**, output a scope-gap warning:
   > **Scope-Gap Warning**: The issue spec lists `{PRIMARY_FILE}` but the same pattern exists in `{SIBLING_FILE}:{LINE}`. These were likely introduced together. Recommend widening scope to fix all callers in this PR, or creating follow-up issues for the other files before proceeding.

   Do NOT silently exclude sibling matches. The appropriate output when sibling files have the same bug is to flag them explicitly — even if the issue spec's silence appears intentional. The fix-approach validation step (step 8) will confirm whether to widen scope or create follow-ups. <!-- Added: forge#383 -->
8. Fix-approach validation — if issue proposes a fix, don't adopt as spec. Trace through middleware, auth, routing, config. Cross-domain: if fix in domain A interacts with domain B, read domain B's files too.

### 1C: Post investigation comment

The comment MUST include `<!-- INVESTIGATION:COMPLETE -->` at the very end.

**Before posting, read the attribution config**:
```bash
SHOW_ATTRIBUTION=$(yq '.branding.show_attribution // "true"' forge.yaml 2>/dev/null || echo "true")
[ "$SHOW_ATTRIBUTION" = "false" ] && ATTRIBUTION_LINE="" || ATTRIBUTION_LINE="
> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)"
```

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:INVESTIGATOR -->
## Investigation Report

**Verdict**: {CONFIRMED|PARTIAL|INVALID}
**Confidence**: {HIGH|MEDIUM|LOW}
**Severity**: {CRITICAL|HIGH|MEDIUM|LOW}
**Task Type**: {Bug Fix|Feature|Refactor|Maintenance|Investigation}

### What Was Claimed
{summary of what the issue describes}

### What We Found
{what the code actually shows}

### Root Cause
{specific root cause, with file:line references where applicable}

### Affected Files
{numbered list of files that need changes}

### Evidence
{specific findings — function names, line numbers, behavior observed}

### Recommendation
{what to build/fix, concrete and actionable}

### Related Issues
{if any found via domain context discovery, max 5}

### Decomposition Assessment
**{YES|NO}** — {reason}
{if YES: proposed sub-issues with titles and dependencies}
${ATTRIBUTION_LINE}
<!-- INVESTIGATION:COMPLETE -->"
```

### 1D: Correction capture (MANDATORY — run before label update)

Before routing, scan all non-agent comments for correction signals from the repository owner. Correction signals are owner comments that contain phrases like "no, use", "actually use", "use X instead", "not X, use Y", or "wrong branch". If found, write the correction to `forge.yaml → learned:` and emit a `FORGE:LEARNED` annotation.

**Scan for correction signals**:
```bash
# Get repo owner login for filtering.
# Tiered resolution — necessary because project.owner is the GitHub org/user NAME,
# but comment .user.login is always a personal account login. For org-owned repos
# these are structurally different (e.g. org="RapierCraftStudios", commenter="mrdubey"),
# so using project.owner directly silently disables correction capture for all org repos.
#
# Resolution order:
#   1. project.owner_login (explicit override — required for org repos where owner ≠ personal login)
#   2. gh api repos/{GH_REPO} --jq '.owner.login' (auto-resolves correctly for personal repos)
#   3. project.owner (backward-compat fallback — still broken for org repos, but avoids hard failure)
REPO_OWNER=$(yq '.project.owner_login // ""' forge.yaml 2>/dev/null || echo '')
if [ -z "$REPO_OWNER" ]; then
  REPO_OWNER=$(gh api repos/{GH_REPO} --jq '.owner.login' 2>/dev/null || echo '')
fi
if [ -z "$REPO_OWNER" ]; then
  REPO_OWNER=$(yq '.project.owner' forge.yaml 2>/dev/null || echo '')
fi

# Fetch all comments, filter to owner-only, look for correction signals
CORRECTIONS=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  | jq -r --arg owner "$REPO_OWNER" \
  '.[] | select(.user.login == $owner) | select(
    (.body | test("no,? use|actually use|use .+ instead|not .+, use|wrong branch"; "i"))
  ) | .body' 2>/dev/null || echo '')
```

**If correction signals found** — extract and write each correction:

```bash
# Example: extract branch target correction "use develop not staging"
# Adjust regex to the correction pattern detected

if [ -n "$CORRECTIONS" ]; then
  echo "Correction signals detected — writing to forge.yaml → learned:"
  echo "$CORRECTIONS"

  # Write to forge.yaml using yq in-place merge (idempotent — yq merge overwrites existing keys)
  # Always use env variable injection to avoid YAML injection from comment content
  # Example for branch target correction:
  #   BRANCH_VALUE="develop"
  #   yq eval '.learned.branch_targets.staging = env(BRANCH_VALUE)' -i forge.yaml

  # After writing, emit FORGE:LEARNED annotation
  LEARNED_KEYS="branch_targets.staging"  # replace with actual extracted keys
  CAPTURED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Update captured_at and captured_by metadata
  CAPTURED_AT_VAL="$CAPTURED_AT" yq eval '.learned.captured_at = env(CAPTURED_AT_VAL)' -i forge.yaml
  CAPTURED_BY_VAL="work-on/{NUMBER}" yq eval '.learned.captured_by = env(CAPTURED_BY_VAL)' -i forge.yaml

  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:LEARNED -->
## Learned Pattern Captured

**Source**: Owner correction in comment on issue #{NUMBER}
**Captured at**: $CAPTURED_AT
**Keys written**: \`$LEARNED_KEYS\`

The following project-specific pattern was detected from owner feedback and written to \`forge.yaml → learned:\`. Future sessions will use this override automatically (read in Phase 0B.1).

\`\`\`yaml
# Written to forge.yaml
learned:
  # {key}: {value}
\`\`\`

**Idempotency**: yq merge-write — re-running will not duplicate entries."

  echo "FORGE:LEARNED annotation posted."
fi
```

**Idempotency guarantee**: Use `yq eval '.learned.key = env(VAR)' -i forge.yaml` — yq overwrites existing keys rather than appending. Re-running the capture step on the same comment produces the same forge.yaml state. <!-- Added: forge#667 -->

### 1D: Update labels & route

**CONFIRMED or PARTIAL with decompose: NO**:
```bash
RESOLUTION=$(resolve_script 'transition-label')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} ready-to-build ;;
  prose)
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:ready-to-build" \
      --remove-label "workflow:investigating,workflow:building,workflow:in-review,workflow:merged,workflow:invalid,workflow:decomposed" 2>/dev/null || true
    ;;
esac
```

Write machine-readable phase checkpoint (MUST execute immediately after label transition, before continuing):
```bash
CHECKPOINT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CHECKPOINT -->
\`\`\`json
{\"phase\": \"INVESTIGATION\", \"status\": \"COMPLETE\", \"next_phase\": \"BUILD\", \"timestamp\": \"${CHECKPOINT_TIMESTAMP}\"}
\`\`\`"
```
<!-- FORGE:PHASE_COMPLETE — Investigation routed to build. See Universal Phase Dispatcher: next phase is Phase 3. Not terminal — continue immediately. -->
→ Continue to Phase 3.

**CONFIRMED or PARTIAL with decompose: YES**:
```bash
RESOLUTION=$(resolve_script 'transition-label')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} decomposed ;;
  prose)
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:decomposed" \
      --remove-label "workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:merged,workflow:invalid" 2>/dev/null || true
    ;;
esac
```

Write machine-readable phase checkpoint (MUST execute immediately after label transition, before continuing):
```bash
CHECKPOINT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CHECKPOINT -->
\`\`\`json
{\"phase\": \"INVESTIGATION\", \"status\": \"COMPLETE\", \"next_phase\": \"DECOMPOSE\", \"timestamp\": \"${CHECKPOINT_TIMESTAMP}\"}
\`\`\`"
```
<!-- FORGE:PHASE_COMPLETE — Investigation routed to decomposition. See Universal Phase Dispatcher: next phase is Phase 2. Not terminal — continue immediately. -->
→ Continue to Phase 2 (Decomposition).

**INVALID**:
```bash
RESOLUTION=$(resolve_script 'transition-label')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} invalid ;;
  prose)
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:invalid" \
      --remove-label "workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:merged,workflow:decomposed" 2>/dev/null || true
    ;;
esac
gh issue close {NUMBER} {GH_FLAG} --comment "Closing as invalid: {reason from investigation}"
```
→ STOP. No checkpoint written — INVALID is terminal.

---

## Phase 2: Decomposition (Conditional)

**Skip if**: Already decomposed, is a sub-issue, or investigation says decompose: NO.

**Trigger if**: Investigation assessment says YES — 2+ signals match (at least 1 Strong): multiple task types, 3+ service groups, phased requirements, 6+ files across directories.

### 2A: Load state
```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,milestone
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'
```

**MANDATORY — Owner override detection**: After reading the investigation comment, read ALL comments on the issue to check for owner override signals:
```bash
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR") | not) | {author: .user.login, body: .body}'
```

Scan non-agent comments for override signals — phrases like "do not", "do NOT", "instead", "revert", "remove this", "override", "actually", or explicit disagreement with the investigation's recommendation. If an override comment is found from a repo owner or admin (not a bot):

1. **Document the override**: Note which direction the owner is steering (e.g., "remove the feature" vs. investigation's "keep with warnings")
2. **Re-derive sub-issue scopes**: Derive sub-issue titles, bodies, and file scope from the override direction — NOT from the original investigation recommendation. The investigation's Decomposition Assessment may list sub-issues that are now stale or contradictory with the override.
3. **If override makes a sub-issue obsolete**: Skip creating it. Note the skip reason in the decomposition comment.
4. **If override changes the sequencing dependency**: Revise the execution order so that the override's primary action (e.g., "strip the feature") completes before any downstream doc/SDK sub-issues are built against it.

**Why this matters**: Sub-issues scoped before an override are built against a stale premise. A docs sub-issue scoped as "neutralize liability language" becomes incorrect if the upstream schema sub-issue will fully remove the feature — the docs sub-issue should instead be "remove all references to the deleted feature." Building both in parallel against the pre-override scope produces contradictory staging state.

### 2B: Design sub-issues
From the Decomposition Assessment (adjusted for any owner override detected in 2A), extract sub-issue titles (dependency order — independent first), dependencies, and descriptions.

For each sub-issue:
- **Title**: from investigation report
- **Body**: brief scope + `**Parent**: #{NUMBER}` + dependency note
- **Labels**: inherit priority label from parent; do NOT copy workflow labels
- **Milestone**: same as parent

### 2C: Create sub-issues
```bash
gh issue create {GH_FLAG} \
  --title "{fix|feat|refactor}: {SUB_ISSUE_TITLE}" \
  --body "$(cat <<'SUB_BODY_EOF'
## Problem

{1-3 sentences: what this sub-issue specifically addresses. What's wrong or what needs to be built.}

## Root Cause (if known)

{Specific root cause for this sub-task. Reference the parent investigation findings where applicable. If unknown: "Root cause unknown — investigation needed."}

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific, testable criterion}
- [ ] {Specific, testable criterion}
- [ ] No regression in {related feature}

## Context

**Parent**: #{NUMBER}
{If depends on another sub-issue: "**Depends on**: #{SUB_ISSUE_N} — {reason}"}
SUB_BODY_EOF
)" \
  --label "{PRIORITY_LABEL}" \
  --milestone "{MILESTONE_TITLE}"
```

### 2D: Update parent issue body
Add tracker checklist with all sub-issues in dependency order.

### 2E: Post decomposition comment

**Before posting, read the attribution config**:
```bash
SHOW_ATTRIBUTION=$(yq '.branding.show_attribution // "true"' forge.yaml 2>/dev/null || echo "true")
[ "$SHOW_ATTRIBUTION" = "false" ] && ATTRIBUTION_LINE="" || ATTRIBUTION_LINE="
> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)"
```

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:DECOMPOSED -->
## Decomposition Complete

### Sub-Issues Created
- #{SUB_NUMBER}: {TITLE}

### Decomposition Rationale
{brief summary}
${ATTRIBUTION_LINE}
<!-- FORGE:DECOMPOSED:COMPLETE -->"
```

### 2F: Update labels
```bash
RESOLUTION=$(resolve_script 'transition-label')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} decomposed ;;
  prose)
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:decomposed" \
      --remove-label "workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:merged,workflow:invalid" 2>/dev/null || true
    ;;
esac
```

→ STOP. Each sub-issue runs its own `/work-on`.

---

## Phase 3: Build

<!-- FORGE:PHASE_COMPLETE — Entering Phase 3 (Build). See Universal Phase Dispatcher: sub-phases 3A–3M execute in sequence. No sub-phase completion is terminal. -->

**Skip if**: `<!-- FORGE:BUILDER -->` exists.

**CRITICAL: You MUST execute ALL sub-phases 3A–3M in order. Sub-phases 3C.5 (context) and 3C.6 (architect) are skipped ONLY for TRIVIAL tasks and Investigation tasks — see Phase 3B for classification. For STANDARD and COMPLEX tasks they post mandatory `FORGE:CONTEXT` and `FORGE:ARCHITECT` comments that Phase 3F reads as its primary input. Skipping them without a TRIVIAL/Investigation classification degrades build quality and causes review findings. After each sub-phase, continue to the next — no sub-phase is terminal.**

### 3A: Re-read state from GitHub (MANDATORY)

**Post Phase 3 heartbeat** (skip if issue already has a terminal label — `workflow:merged`, `workflow:invalid`, `needs-human`):
```bash
PHASE_START_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:HEARTBEAT -->
**Phase**: Phase 3 — Build
**Timestamp**: ${PHASE_START_TIMESTAMP}
**Issue**: #{NUMBER}"
```

```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,milestone

# Read investigation report
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'

# Check if build already completed
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:BUILDER")) | .body'

# Check for existing COMPLEXITY_BAND from a prior run (resume path)
EXISTING_FAST_PATH=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:FAST_PATH")) | .body' 2>/dev/null | head -1)
```

If no investigation comment with `<!-- INVESTIGATION:COMPLETE -->` → STOP (investigation not complete).

Extract from investigation: affected files, root cause, recommendation, task type.

### 3B: Classify task type and complexity

**Step 1 — Task type classification:**

| Signal | Type | Approach |
|--------|------|----------|
| Title starts with "Investigate:"/"Audit:"/"Research:" | Investigation | Produce issues as deliverables |
| UI/UX, feature + web/ files | UI/UX | `frontend-design` skill |
| Feature + services/ | Backend Feature | Implement directly |
| Feature + both | Full-Stack | Backend first, then frontend-design |
| Bug + web/ | Frontend Fix | Direct |
| Bug + services/ | Backend Fix | Direct |
| Refactor/docs | Maintenance | Direct |

**Investigation tasks — early exit (BEFORE Phase 3C):** If task type = Investigation, skip Phases 3C, 3C.5, and 3C.6 entirely. Post `<!-- FORGE:FAST_PATH -->` comment, then jump directly to Phase 3F (implement → issue creation path). Do NOT run the Builder Contract, Context Gathering, or Architecture Plan for investigation tasks.

```bash
# Post fast-path comment for investigation tasks
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:FAST_PATH -->
## Fast-Path Classification

**COMPLEXITY_BAND**: INVESTIGATION
**Task type**: Investigation
**Rationale**: Title prefix 'Investigate:' (or task type = Investigation from investigator report) — skipping Builder Contract (3C), Context Gathering (3C.5), and Architecture Plan (3C.6). Jumping directly to Phase 3F (issue creation).
**Phases skipped**: 3C, 3C.5, 3C.6"
```

→ Jump to Phase 3F immediately. Do not continue to Phase 3C.

**Step 2 — Complexity classification (for non-Investigation tasks):**

Classify COMPLEXITY_BAND based on affected file count and task nature:

| Condition | COMPLEXITY_BAND |
|-----------|-----------------|
| Single file, doc/config/markdown only, no logic changes expected | TRIVIAL |
| 1–5 files, existing patterns, no cross-service impact | STANDARD |
| 6+ files, new abstractions, cross-service, migration, schema changes | COMPLEX |

Post `<!-- FORGE:FAST_PATH -->` comment immediately after classification:

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:FAST_PATH -->
## Fast-Path Classification

**COMPLEXITY_BAND**: {TRIVIAL|STANDARD|COMPLEX}
**Task type**: {TASK_TYPE}
**Affected file count**: {N}
**Rationale**: {one-sentence explanation of classification decision}
**Phases skipped**: {list phases skipped, or 'none — full pipeline' for STANDARD/COMPLEX}"
```

**Resume path**: If `EXISTING_FAST_PATH` was read in Phase 3A, extract COMPLEXITY_BAND from it and skip re-classification.

**TRIVIAL tasks**: After posting FORGE:FAST_PATH, skip Phase 3C.5 (Context Gathering) and Phase 3C.6 (Architecture Plan) only. Phase 3C (Builder Contract) is **retained** — it still runs. Continue: 3C (Builder Contract) → 3D → 3E → 3F → 3F.5 → 3G → 3H onward. When filling in **Phases skipped** in the FORGE:FAST_PATH comment, write: `3C.5, 3C.6`.

**STANDARD and COMPLEX tasks**: Run full pipeline — 3C → 3C.5 → 3C.6 → 3D onward. No phases skipped.

### 3C: Builder Contract (MANDATORY)

Post `<!-- FORGE:CONTRACT -->` comment with: task type, proposed approach, deliverables table (file/change/why), acceptance criteria, quality considerations (auth model, new env vars, SQL safety, security surface), out of scope, alternatives.

**Before posting, read the attribution config**:
```bash
SHOW_ATTRIBUTION=$(yq '.branding.show_attribution // "true"' forge.yaml 2>/dev/null || echo "true")
[ "$SHOW_ATTRIBUTION" = "false" ] && ATTRIBUTION_LINE="" || ATTRIBUTION_LINE="
> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)"
```

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
{OUT_OF_SCOPE_ITEMS}
${ATTRIBUTION_LINE}"
```

Contract must be grounded in the investigation report. Adversarially validate proposed fixes against adjacent system layers.

### 3C.5: Context Gathering (MANDATORY for STANDARD/COMPLEX — skip for TRIVIAL)

**Skip if COMPLEXITY_BAND: TRIVIAL** (classified in Phase 3B) — post nothing, proceed directly to Phase 3C.6. Trivial single-file changes have no institutional memory value to surface.

**For STANDARD and COMPLEX tasks**: This phase is NOT optional. Run it regardless. Do NOT skip it without a TRIVIAL classification from Phase 3B.

Surface institutional memory before writing code. Extract function names from the contract deliverables table:

```bash
FUNCTION_NAMES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTRACT")) | .body' \
  | awk '/^### Deliverables/{p=1; next} /^### /{p=0} p' \
  | grep -oE '`[A-Za-z_][A-Za-z0-9_]*`' \
  | tr -d '`' | sort -u | tr '\n' ' ' | xargs)
```

**The ONLY acceptable skip conditions** (all must be true): Issue is a 1-file config/docs edit with no code logic AND affected files have zero git history. In all other cases, run context gathering.

Run these queries (20s timeout each, 2 min total budget):

**C1: Past Review Findings on These Files**
```bash
for file in {AFFECTED_FILES}; do
  basename=$(basename "$file" .py)
  gh issue list -R {GH_REPO} --state closed --label "review-finding" \
    --search "$basename" --limit 10 \
    --json number,title,body \
    --jq '.[] | {number, title,
      pattern: (.body | capture("\\*\\*Pattern\\*\\*: *(?<p>[^\\n]+)").p // null),
      prevention: (.body | capture("\\*\\*Prevention\\*\\*: *(?<v>[^\\n]+)").v // null),
      root_cause: (.body | capture("\\*\\*Root cause\\*\\*: *(?<rc>[^\\n]+)").rc // (.body | capture("Root Cause[^\\n]*\\n(?<rc>[^\\n]+)").rc // "see body"))
    }'
done
```

**C2: Past Bugs in the Same Module**
```bash
git log --oneline -30 -- {AFFECTED_FILES} | grep -oE '#[0-9]+' | sort -u | head -8
# For each issue: fetch title + root cause, keep only bug/fix/review-finding labeled. Max 5.
```

**C3: Related Code Paths** (callers/importers of FUNCTION_NAMES)
```bash
for fn in {FUNCTION_NAMES}; do
  grep -r "$fn" {WORKTREE_PATH} --include="*.py" -l | grep -v __pycache__ | head -5
  grep -r "$fn" {WORKTREE_PATH}/web/src --include="*.ts" --include="*.tsx" -l 2>/dev/null | head -5
done
```

**C4: Successful Similar Implementations**
```bash
gh pr list -R {GH_REPO} --state merged --search "{domain_keywords}" --limit 5 \
  --json number,title,files --jq '.[] | {number, title, file_count: (.files | length)}'
```

Post `<!-- FORGE:CONTEXT -->` comment with findings:
```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CONTEXT -->
## Implementation Context for #{NUMBER}

### Known Pitfalls for This Area
{prevention rules from past review-findings}

### Historical Findings on These Files
{past review-finding issues}

### Past Bugs in This Module
{closed bug issues from git log mining}

### Related Code Paths (must stay consistent)
{files that import/call changed functions}

### Patterns That Cause Bugs Here
{recurring bug types synthesized from C1+C2}

### Successful Similar Implementations
{positive patterns from C4}

<!-- FORGE:CONTEXT:COMPLETE -->"
```

If total time exceeds 2 minutes, post partial results with `<!-- FORGE:CONTEXT:PARTIAL -->`.

### 3C.6: Architecture Plan (MANDATORY for STANDARD/COMPLEX — skip for TRIVIAL)

**Skip if COMPLEXITY_BAND: TRIVIAL** (classified in Phase 3B) — post nothing, proceed directly to Phase 3D. Trivial single-file changes have no multi-path consistency risk.

**For STANDARD and COMPLEX tasks**: This phase is NOT optional. Always run it. Even a 1-file STANDARD fix benefits from cross-path consistency checks. Do NOT skip without a TRIVIAL classification from Phase 3B.

Trace ALL affected code paths before writing code.

**Additional skip condition** (STANDARD tasks only): Issue creates ONLY new files with no existing callers AND title starts with "docs:" or "chore:".

**A1: Read Entry Points** — For each affected file: identify the primary function, all callers (grep), and sibling implementations. Read 3–5 most relevant files, max 8 total.

**A1.5: Route-Tree Classification for Shared Components** *(conditional — skip if no files under `components/` are affected, except `components/ui/primitives/`)* — When a change adds a new hook call or context dependency to a shared component, classify ALL call sites found in A1 by route context:
1. **Authenticated routes**: Callers under `app/dashboard/`, `app/(authenticated)/`, or any layout that wraps children with an auth provider (e.g., `UserProvider`, `SessionProvider`).
2. **Public routes**: Callers under `app/(public)/`, `app/playground/`, `app/(marketing)/`, or any layout without the relevant provider.
3. **If both categories have callers AND the new hook throws when its provider is absent**: add an explicit implementation step to either (a) guard the hook call with a null-context check, (b) make the hook return a safe default when called outside its provider, or (c) remove the hook from the shared component and move it to the authenticated-route-only caller. Document the split in the FORGE:ARCHITECT affected paths table. Do NOT leave a shared component that crashes public routes to be discovered by the FE review agent. <!-- Added: forge#381 -->

**A2: Trace Data Flow** — From each entry point: Entry → Transform → Persist/Relay → Exit. Check if the proposed change needs to propagate to each step. **For every field or key read by the changed code, enumerate ALL write paths first** — search across all services for assignments to that field. If multiple code paths write different types to the same field (e.g. dict in the standard path, string in the auth-gated path), the implementation must handle all variants. Do not assume the type you see on the primary code path is the only possible type.

**A2.1: Runtime UID × Volume Ownership Check** *(conditional — skip if no Dockerfile or entrypoint is affected)* — When the PR changes the container's runtime user (Dockerfile `USER` directive, `su-exec`, `gosu`, `setuid`), the architect MUST trace the full write-path chain before writing the implementation plan:
1. **Enumerate volume mounts**: Read all `docker-compose*.yml` files for the affected service. List every named volume and its container mount point (e.g. `storage_shared:/app/storage`). Docker named volumes are created as root-owned by default — any UID change without a corresponding ownership fix will silently break writes.
2. **Grep for filesystem writes**: Search the affected service's codebase for all filesystem write operations (`mkdir`, `Path.mkdir`, `write_bytes`, `open(`, `os.makedirs`, `shutil.copy`, `shutil.move`). For each write operation, identify the target path.
3. **Cross-reference**: For each write path that falls under a named volume mount point, add an explicit implementation step to ensure ownership compatibility before the privilege drop — typically `chown -R <user>:<group> <mount_point>` in the entrypoint script before the `exec su-exec` / `exec gosu` call.
4. **Add to FORGE:ARCHITECT deliverables table**: List the entrypoint or docker-compose change as an explicit deliverable. Do NOT leave volume ownership to be discovered by the builder or reviewer. <!-- Added: forge#323 -->

**A2.2: Gate-Condition Caller Sweep** *(conditional — when the fix changes a gate condition that guards a function call or restricts a field)*: Before finalizing the affected-paths table, grep for all callers of the gated function across sibling files in the same service directory. For each caller, verify that the gate condition applied at the call site is semantically correct.
   ```bash
   # Identify the gated function from the issue/contract
   GATED_FUNCTION="{function_being_called_inside_the_gate}"
   SERVICE_DIR=$(dirname {PRIMARY_AFFECTED_FILE})
   # Find all call sites
   grep -rn "$GATED_FUNCTION" "$SERVICE_DIR" --include="*.py" | grep -v "#"
   ```
   For each call site found: read the surrounding gate condition (±10 lines). If the condition includes fields that do NOT require the gated resource (e.g., `extraction_schema` gated behind an LLM key check when `extraction_schema` is processed without an LLM), add that caller file to the FORGE:ARCHITECT affected-paths table with a note explaining the incorrect gate condition.

   **Do NOT** omit sibling callers from the affected-paths table simply because they were not listed in the issue spec. The architect's scope is determined by code correctness, not by the issue spec's file list. A gate-condition bug that exists identically in 3 router files must be fixed in all 3 — even if the issue only named 1. <!-- Added: forge#383 -->

**A2.5: Pipeline Phase-Dependency Check** *(Forge pipeline changes only — skip if no `commands/*.md` file is affected)* — Identify artefact contracts the changed file produces (comment markers, structured output blocks, Skill() invocation signatures, label transitions). Find downstream pipeline phases that consume those artefacts. Flag any invocation signature change and verify all callers. Emit a checklist of downstream phases that must be updated — appended to the Consistency Checks block in the FORGE:ARCHITECT comment.

**A3: Consistency Rules** — Identify invariants all paths must satisfy: null handling, validation, logging, error response shape, auth checks.

**A4: Sequence Implementation** — Order: schema/type changes first → core logic → secondary paths → tests → config/env. Files imported by others change before importers. Higher risk first.

**A5: Risk Assessment** — Rate each non-obvious interaction: HIGH/MEDIUM/LOW with mitigation.

Post `<!-- FORGE:ARCHITECT -->` comment:
```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:ARCHITECT -->
## Implementation Plan for #{NUMBER}

### Affected Paths (ALL must be updated)
| # | File | Function/Class | Change Required | Why |
|---|------|----------------|-----------------|-----|
{rows}

### Implementation Order
1. {FIRST_CHANGE} — {WHY_FIRST}
2. {SECOND_CHANGE} — {WHY_SECOND}

### Consistency Checks
- [ ] {INVARIANT_1}
- [ ] {INVARIANT_2}

### Risk Assessment
| Risk | Severity | Mitigation |
|------|----------|------------|
{rows}

### Files to Read Before Coding
- \`{FILE}\` — {WHY_READ_IT}

<!-- FORGE:ARCHITECT:COMPLETE -->"
```

If budget exceeded (3 min), use `<!-- FORGE:ARCHITECT:PARTIAL -->`.

### 3D: Set building label
```bash
RESOLUTION=$(resolve_script 'transition-label')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} building ;;
  prose)
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:building" \
      --remove-label "workflow:investigating,workflow:ready-to-build,workflow:in-review,workflow:merged,workflow:invalid,workflow:decomposed" 2>/dev/null || true
    ;;
esac
```

### 3E: Create worktree

Branch slug from title (lowercase, hyphenated, max 40 chars). Prefix: `fix/` (bugs) or `feat/` (features).

**Compute `PR_BASE` before worktree creation** — the source branch for the worktree MUST match the PR target. Compute `PR_BASE` now using `classify-lane.sh` so both worktree creation and Phase 4C use the same deterministic value. <!-- Added: forge#639 -->

```bash
# Compute PR_BASE deterministically from issue milestone — no LLM interpretation
RESOLUTION=$(resolve_script 'classify-lane')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal)
    if ! PR_BASE=$(bash "$SCRIPT_PATH" {NUMBER} -R {GH_REPO}); then
      gh issue comment {NUMBER} {GH_FLAG} --body "BLOCKER: classify-lane.sh failed to compute PR target — see script error above. Adding needs-human."
      gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
      exit 1
    fi
    ;;
  prose)
    # classify-lane has no valid prose fallback — the script output is authoritative.
    # Without it, PR target cannot be determined safely. Add needs-human and stop.
    gh issue comment {NUMBER} {GH_FLAG} --body "BLOCKER: classify-lane.sh not installed (prose tier). Cannot compute PR target deterministically. Adding needs-human."
    gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
    exit 1
    ;;
esac
```

**Determine source branch**:
- Review-finding → parse `**Code branch**: \`{branch}\`` from issue body; branch from `origin/{branch}`
  - **Milestone review-finding hybrid lane** (Code branch matches `milestone/*`): High-risk lane. NEVER use `git merge` to resolve conflicts — use `git rebase` or `git cherry-pick` only. If conflicts can't be resolved without merge, post comment, add `needs-human`, STOP.
- Feature lane (has milestone) → branch from `origin/{PR_BASE}` (PR_BASE now set above)
- Fast lane (no milestone) → branch from `origin/{PR_BASE}` (PR_BASE = `{STAGING_BRANCH}`)

```bash
cd {REPO_PATH}
git fetch origin
BRANCH="fix/{slug}-{NUMBER}"
WORKTREE_PATH="{REPO_PATH}/.claude/worktrees/{BRANCH_SLUG}"
git worktree add {WORKTREE_PATH} -b {BRANCH} origin/{PR_BASE}
```

If worktree already exists: verify correct branch, reuse or remove and recreate.

### 3F: Implement

**Load context chain** — Read these from GitHub BEFORE writing code:
1. `FORGE:ARCHITECT` comment (primary implementation guide — if present, follow its ordered list exactly)
2. `FORGE:INVESTIGATOR` comment (root cause, affected files)
3. `FORGE:CONTRACT` comment (deliverables, acceptance criteria)
4. `FORGE:CONTEXT` comment (pitfalls, related paths, past bugs)

If `FORGE:ARCHITECT` is absent, fall back to investigation report + contract.

**Route by task type**: Bug Fix → implement directly. Feature (backend) → implement directly. Feature (UI/UX) → invoke `frontend-design` skill. Full-Stack → backend first, then frontend-design. Investigation → create issues, skip to Phase 7.

**Implementation rules**:
- Work in `{WORKTREE_PATH}` — all file reads, writes, git ops happen here
- Read the current file before modifying it — never assume its state
- Read related files identified in context briefing before touching changed code
- Follow architect plan's implementation order exactly (when present)
- For each acceptance criterion: implement it, then verify it's met
- Do NOT add unrequested scope — contract out-of-scope stays out
- **Library callback verification**: When writing a lambda/callable passed to a library parameter, MUST verify expected calling convention BEFORE writing it. Check library's default value, documentation, or source code. Wrong arity causes runtime `TypeError` invisible to static analysis. (Ref: PR #14391 — `lambda _: ""` passed where SQLAlchemy expects 0 args)
- **Cross-lane import guard**: Before adding any `import` or `from X import Y` statement for a service-internal module (`app.*`), verify the module exists on the PR's base branch — NOT just on your local disk or a milestone branch. Run `git show origin/{base_branch}:{module_path}.py` (replacing dots with slashes) to confirm. If the module only exists on a milestone branch, do NOT import it — find an alternative implementation or make the import conditional with a `try/except ImportError` fallback. A milestone-only import on a fast-lane PR will crash production on every request with `ModuleNotFoundError`. (Ref: forge#277 — builder imported `app.billing.subscriptions` from `milestone/subscription-model`, which doesn't exist on `staging`/`main`, causing P1 production crash for paying customer)
- **Deliverable-type consistency check**: Before committing, compare the actual output against the CONTRACT's deliverable list. If the CONTRACT explicitly states "no code changes required", "docs only", or "configuration update only" AND the diff introduces new executable files (`.py`, `.js`, `.ts`, `.sh` — not test, config, or documentation files), STOP. Do NOT commit. Re-read the CONTRACT, the investigation recommendation, and the ARCHITECT plan. If all three agree that code is needed, update the CONTRACT comment to reflect the new deliverable type before proceeding. If only the builder decided to add code without contract support, discard the code change and implement the contracted deliverable instead. <!-- Added: forge#279 -->
- **Pipeline check documentation — generalization rule**: When writing or updating pipeline check documentation (in `commands/*.md`), describe the **bug class**, not a specific incident. Do NOT embed: PR numbers, issue numbers, run IDs, timestamps, function names, dollar amounts, or multi-sentence incident timelines in check prose or `**Evidence**:` blocks. One brief HTML comment `<!-- Added: forge#NNN -->` is acceptable per check for traceability. `**Evidence**:` blocks must describe the vulnerability pattern (what the class of bug looks like, why it's dangerous) — not narrate a single historical occurrence. CHANGELOG entries may reference originating issues; command prompt text must not.
- **Endpoint response contract consumer tracing**: When changing an endpoint's response body shape or status field values (e.g., changing `"status": "healthy"` to `"status": "ok"`, renaming response keys, removing fields), grep the full repo for ALL consumers of that response body before committing. Consumers are not limited to the service being changed — they include deploy scripts, CI health checks, monitoring configs, docker-compose healthcheck definitions, Traefik probes, and any script that parses or pattern-matches on the response body. Run: `grep -rn "{old_value}\|{endpoint_path}" scripts/ infra/ .github/ docker-compose*.yml traefik/ 2>/dev/null`. All consumers whose behavior depends on the old response format MUST be updated in the same PR — a response contract change that updates only one consumer while leaving others on the old format is a deploy-time breakage. <!-- Added: forge#321 -->
- If contract is wrong (file doesn't exist, function has different signature): STOP, post comment, add `needs-human`, EXIT

### 3F.5: Env/Config Completeness Check

Run BEFORE committing. Read-only scan of working changes.

**Trigger**: Run whenever diff introduces env vars, touches infra/deploy configs, or adds literal IPs.

**Check 1 — New env var sync**: Scan for `os.getenv`/`process.env.` references. For each, verify present in `.env.example`, `ENV_VARS.md`, `env_validation.py`. Add if missing.

**Check 2 — Deploy/infra restart risk**: If docker-compose/deploy/infra files changed, scan for restart-inducing changes. Annotate commit with `[restart: <service>]`.

**Check 3 — Hardcoded IPs and credentials**: Scan for bare IPv4 literals and credential-like assignments. HARD BLOCKER — replace with env vars before staging.

**Check 4 — SDK/API Literal sync advisory** (trigger: diff contains `Literal[` in a schema file):
```bash
# Detect Literal type changes in API schema files
cd {WORKTREE_PATH}
LITERAL_CHANGES=$(git diff HEAD -- | grep -E '^\+.*Literal\[' | grep -v '^\+\+\+')
if [ -n "$LITERAL_CHANGES" ]; then
    echo "SDK SYNC ADVISORY: Literal type changed in schema."
    echo "Changed Literal lines:"
    echo "$LITERAL_CHANGES"
    echo ""
    echo "ACTION REQUIRED — verify SDK method/type lists match new API schema:"
    echo "  - sdk/python/*/client.py: check _valid_methods or equivalent list"
    echo "  - sdk/node/src/index.ts: check JSDoc @param Literal type annotation"
    echo "  - web/public/openapi*.json: check enum arrays for affected field"
    echo "  - web/public/openapi-versions/*.json: check all versioned specs"
    echo ""
    echo "Inconsistency example: API schema narrows Literal['GET','POST','PUT','PATCH','DELETE']"
    echo "to Literal['GET','POST'] but SDK JSDoc still lists all 5 methods — API returns 422"
    echo "for callers following SDK docs. This produces silent user-facing failures."
fi
```

This advisory is informational — it does NOT block the commit. But the implementer MUST check each listed file and add to the implementation scope if any SDK/spec file still documents the removed/changed Literal values. If SDK files need changes, add them to the current PR rather than leaving the inconsistency for review to catch.

### 3G: Quality Gate

Skip for 1-file config/docs edits.

```
iteration = 0
max_iterations = 3

while iteration < max_iterations:
    iteration += 1
    Skill("quality-gate", args="{CHANGED_FILES} --worktree {WORKTREE_PATH}")
    if result == "QUALITY GATE: PASS":
        GATE_PASSED = true
        break
    else:
        Fix each HIGH and MEDIUM finding in {WORKTREE_PATH}
        Re-stage fixes

if iteration == max_iterations AND not PASS:
    Post "Quality Gate Failed After 3 Iterations" comment
    Add needs-human label → STOP
```

# MUST CONTINUE to sub-phase 3H (Format and verify) — quality gate PASS is intermediate, NOT terminal. <!-- Added: forge#220 -->

**After quality gate completes (PASS or fixes applied): proceed immediately to sub-phase 3H below. Quality gate is an intermediate check — "PASS" means the code is clean, NOT that the build is done. Do NOT stop.**

**After PASS: Do NOT re-read GitHub state, issue body, labels, or any file. Do NOT run any gh commands. Do NOT check PR status. Proceed directly to Phase 3H (Format and verify) below.** <!-- Added: forge#93 -->

### 3H: Format and verify

All tool commands are read from `forge.yaml → verification.commands`. When a key is absent, the step logs `SKIPPED — not configured in verification.commands` and continues rather than silently passing.

**Python**:
```bash
cd {WORKTREE_PATH}

PYTHON_FORMAT=$(yq '.verification.commands.python.format // ""' forge.yaml 2>/dev/null || echo '')
if [ -n "$PYTHON_FORMAT" ]; then
    eval "$PYTHON_FORMAT" 2>&1
else
    echo "SKIPPED — python.format not configured in verification.commands"
fi

# Compile check always runs (no config needed — catches syntax errors)
python -m py_compile {PYTHON_FILES}
```
`py_compile` failures are BLOCKING.

**TypeScript**:
```bash
cd {WORKTREE_PATH}

TS_FORMAT=$(yq '.verification.commands.typescript.format // ""' forge.yaml 2>/dev/null || echo '')
TS_TYPECHECK=$(yq '.verification.commands.typescript.typecheck // ""' forge.yaml 2>/dev/null || echo '')
TS_BUILD=$(yq '.verification.commands.typescript.build // ""' forge.yaml 2>/dev/null || echo '')

if [ -n "$TS_FORMAT" ]; then
    eval "$TS_FORMAT" 2>&1
else
    echo "SKIPPED — typescript.format not configured in verification.commands"
fi

if [ -n "$TS_TYPECHECK" ]; then
    eval "$TS_TYPECHECK" 2>&1
    TS_EXIT=$?
elif [ -n "$TS_BUILD" ]; then
    eval "$TS_BUILD" 2>&1 | tail -30
    TS_EXIT=$?
else
    echo "SKIPPED — typescript.typecheck and typescript.build not configured in verification.commands"
    TS_EXIT=0
fi
```
Typecheck or build failures are BLOCKING.

**Learned test commands** — After all `verification.commands` steps complete, run any commands from `learned.test_commands` (captured from owner corrections in Phase 1D or set manually in forge.yaml):

```bash
# LEARNED_TEST_COMMANDS was set in Phase 0B.1 from forge.yaml → learned.test_commands
# If empty/null, this block is a no-op
if [ -n "$LEARNED_TEST_COMMANDS" ] && [ "$LEARNED_TEST_COMMANDS" != "[]" ]; then
  echo "Running learned test commands..."
  # yq outputs each entry on its own line with -r flag
  echo "$LEARNED_TEST_COMMANDS" | yq '.[]' | while IFS= read -r cmd; do
    [ -z "$cmd" ] && continue
    echo "Running learned command: $cmd"
    eval "$cmd" 2>&1 | tail -30
    CMD_EXIT=$?
    if [ $CMD_EXIT -ne 0 ]; then
      echo "FAILED (exit $CMD_EXIT): $cmd"
      exit $CMD_EXIT
    fi
  done
else
  echo "No learned test commands configured — skipping"
fi
```
Learned test command failures are BLOCKING (same as verification.commands failures). <!-- Added: forge#667 -->

### 3I: Frontend proxy wiring check (MANDATORY)

Skip if no TS/TSX files changed.

All client-side `fetch`/`useSWR`/`apiFetch`/`axios` MUST use `/api/...` proxy routes, NEVER `/api/v1/...` or hardcoded host:port. Scan and fix violations.

### 3I.5: Database Configuration Change Advisory

Skip if no changed Python files contain DB engine/session/pool patterns.

```bash
cd {WORKTREE_PATH}
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$'); do
    grep -qE "create_async_engine|AsyncSession|connect_args|pool_size|prepared_statement|engine_from_config|sessionmaker" "$f" 2>/dev/null && \
        echo "DB CONFIG CHANGE DETECTED in: $f"
done
```

Advisory only — does not block build. Check for lambda/callable in connect_args (the exact bug class from PR #14391).

### 3J: Deployment completeness check (MANDATORY)

Skip if no new env vars introduced.

**Config variables used by this phase** (set in `forge.yaml`):
- `{deploy.secrets_backend}` — secrets delivery method (`sops`, `aws-sm`, `vault`, `ci-env`, `none`). When absent or not `sops`, SOPS-specific checks below are skipped with an explicit log message.
- `{verification.services[name].container}` — container name for post-deploy verification. Resolved by matching the service name; falls back to `{service}` (bare name) when not configured.

For each new env var, verify present in ALL required locations:

| Location | Required for |
|----------|-------------|
| `.env.example` | All new vars |
| Secrets backend (see `deploy.secrets_backend`) | Secret vars — skip if backend is `none` or unset |
| `app/env_validation.py` | API service vars (if project has one) |
| `docker-compose.prod.yml` | Vars needing explicit injection (if project uses Docker Compose) |

**Secrets backend check** *(trigger: `deploy.secrets_backend == "sops"`)*:

If the project uses SOPS, verify the new var is present in all SOPS chain locations:
- `infra/secrets/prod.enc.yaml` — SOPS-encrypted secret store
- `infra/decrypt-secrets.sh` ENV_MAPPING — maps SOPS key to env var name
- Deploy chain: SOPS → `decrypt-secrets.sh` (ENV_MAPPING) → `.env.secrets` → `merge-env-secrets.sh` → `.env.production` → docker-compose `env_file`

If `deploy.secrets_backend` is absent or not `sops`, skip these checks and log:
> `SKIP: SOPS chain check — deploy.secrets_backend is not "sops". Configure deploy.secrets_backend in forge.yaml to enable.`

**Operator-set var classification** *(trigger: new env var is NOT in the configured secrets backend)*: <!-- Added: forge#380 -->

Some env vars are operator-set (non-secret, not sourced from the secrets backend) — they must be manually added to the runtime environment on the production server. When a new env var has no entry in the secrets backend, classify it as operator-set and add a **HARD BLOCKER** item to the Testing Checklist.

Resolve the container name for the verification command:
1. Look up the service in `forge.yaml → verification.services[]` by name — use the `container` field if present.
2. If no matching entry, fall back to the bare service name: `{service}` (no suffix).

```
- [ ] HARD BLOCKER: Add {VAR_NAME} to the runtime environment on the production server.
      This var is operator-set — it does NOT flow through the automated secrets chain.
      It must be added manually before or after deploy.
      Verify with: docker exec {CONTAINER_NAME} env | grep {VAR_NAME}
      (CONTAINER_NAME resolved from verification.services[{service}].container in forge.yaml,
       or bare service name if not configured)
```

**`env_file` re-read warning** *(trigger: any new env var added to `.env.production` path)*:

> **Docker `env_file` re-read behavior**: New entries in `.env.production` are only read when a container is **recreated** (e.g., `docker compose up --force-recreate`). A plain `docker restart` restarts the existing container with its frozen env — new `env_file` entries are silently absent. The standard deploy workflow uses `--force-recreate` and handles this correctly. If any out-of-band restart is used, new env vars will not take effect.

Add this warning to the Testing Checklist whenever a new env var is introduced (whether secret or operator-set).

**Post-deploy in-container verification** *(trigger: any new env var)*:

Add the following to the Testing Checklist so the deployer can confirm delivery after deploy.

Resolve `{CONTAINER_NAME}` from `forge.yaml → verification.services[{service}].container`; use `{service}` (bare) if the field is absent.

```bash
# Verify env var reached the running container (run post-deploy)
docker exec {CONTAINER_NAME} env | grep {VAR_NAME}
# Expected: {VAR_NAME}={value}
# If blank: container was not recreated — run: docker compose up --no-deps --force-recreate {service}
```

### 3K: Commit

Stage all changes and commit:

```bash
cd {WORKTREE_PATH}
git add -u
git commit -m "fix({SCOPE}): {description} (#{NUMBER})"
```

Conventional prefix: `fix`/`feat`/`refactor`/`docs`. Reference `#{NUMBER}` in message.

**Post-commit ancestry audit (MANDATORY)**:
```bash
cd {WORKTREE_PATH}
if git ls-remote --exit-code origin {PR_BASE} >/dev/null 2>&1; then
  MERGE_COMMITS=$(git log --merges HEAD ^origin/{PR_BASE} 2>/dev/null)
  if [ -n "$MERGE_COMMITS" ]; then
    # Post ancestry audit failure comment, add needs-human → STOP
  fi
fi
```

### 3L: Update issue body (MANDATORY)
Check off completed items, mark phases complete, add PR references.

### 3M: Post implementation comment

**Before posting, read the attribution config**:
```bash
SHOW_ATTRIBUTION=$(yq '.branding.show_attribution // "true"' forge.yaml 2>/dev/null || echo "true")
[ "$SHOW_ATTRIBUTION" = "false" ] && ATTRIBUTION_LINE="" || ATTRIBUTION_LINE="
> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)"
```

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:BUILDER -->
## Implementation Complete

**Branch**: \`{BRANCH}\`
**Commits**: {COMMIT_SHA(S)}
**Files changed**: {COUNT}

### Approach
{what was built, key decisions}

### Changes
{bulleted list of file changes}

### Acceptance Criteria Status
{checklist from contract, marked pass/fail}

### Testing Checklist
- [ ] {scenario 1}
- [ ] {scenario 2}
${ATTRIBUTION_LINE}
<!-- FORGE:BUILDER:COMPLETE -->"
```

Write machine-readable phase checkpoint (MUST execute immediately after FORGE:BUILDER comment is posted, before Phase 4):
```bash
CHECKPOINT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CHECKPOINT -->
\`\`\`json
{\"phase\": \"BUILD\", \"status\": \"COMPLETE\", \"next_phase\": \"REVIEW\", \"timestamp\": \"${CHECKPOINT_TIMESTAMP}\"}
\`\`\`"
```

---

## Phase 4: PR Creation

### 4A: Pre-push ancestry guard

```bash
cd {WORKTREE_PATH}
if git ls-remote --exit-code origin {PR_BASE} >/dev/null 2>&1; then
  MERGE_COMMITS=$(git log --merges {BRANCH} ^origin/{PR_BASE} 2>/dev/null)
  if [ -n "$MERGE_COMMITS" ]; then
    # Post ancestry guard failure, add needs-human → STOP
  fi
fi
```

### 4B: Push branch
```bash
cd {WORKTREE_PATH} && git push -u origin {BRANCH}
```
If fails: try `--force-with-lease`. If still fails: post comment, add `needs-human`, STOP.

### 4C: Determine PR target
`PR_BASE` was computed in Phase 3E. If somehow unset (e.g., resumed session after compaction), recompute:
```bash
RESOLUTION=$(resolve_script 'classify-lane')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal)
    if ! PR_BASE=$(bash "$SCRIPT_PATH" {NUMBER} -R {GH_REPO}); then
      gh issue comment {NUMBER} {GH_FLAG} --body "BLOCKER: classify-lane.sh failed to recompute PR target — see script error above. Adding needs-human."
      gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
      exit 1
    fi
    ;;
  prose)
    # No valid prose fallback — see Phase 3E note.
    gh issue comment {NUMBER} {GH_FLAG} --body "BLOCKER: classify-lane.sh not installed (prose tier). Cannot recompute PR target. Adding needs-human."
    gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
    exit 1
    ;;
esac
```
Output is authoritative — no prose fallback. Script exits 1 on error (invalid issue, `gh` auth failure, or milestone branch absent on remote); treat non-zero exit as `needs-human` and STOP. <!-- Added: forge#669, forge#639 -->

### 4C.5: Validate PR target against classified lane
```bash
RESOLUTION=$(resolve_script 'validate-pr-target')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal)
    bash "$SCRIPT_PATH" {PR_BASE} {CLASSIFIED_LANE}
    ;;
  prose)
    # validate-pr-target has no safe prose fallback — silently skipping validation risks
    # merging to the wrong branch. Log a warning but do NOT block the pipeline; the PR
    # review step will catch a mismatched target before merge.
    echo "WARNING: validate-pr-target.sh not installed (prose tier) — skipping lane validation. Confirm PR base manually." >&2
    ;;
esac
```
`{CLASSIFIED_LANE}` is the value returned by `classify-lane.sh` in Phase 4C. `{PR_BASE}` is the branch the PR will target. If exit code is 1 (mismatch):
```bash
gh issue comment {NUMBER} {GH_FLAG} --body "BLOCKING: validate-pr-target.sh — PR base \`{PR_BASE}\` does not match classified lane \`{CLASSIFIED_LANE}\`. Manual intervention required."
gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
```
→ STOP. Do NOT proceed to Phase 4D. <!-- Added: forge#671 -->

### 4D: Create PR
```bash
gh pr create {GH_FLAG} --base {PR_BASE} --head {BRANCH} \
  --title "{Fix|Feat|Refactor}: {description}" \
  --body "## Summary
{BRIEF_DESCRIPTION}

## Changes
{CHANGES_LIST}

## Testing
{TESTING_CHECKLIST}

---
Closes #{NUMBER}
**Implementation branch**: \`{BRANCH}\`
**Base**: \`{PR_BASE}\`"
```

`Closes #{NUMBER}` documents intent but does NOT auto-close for non-default-branch PRs.

If PR already exists for this branch, use the existing PR number.

### 4E: Update labels
```bash
RESOLUTION=$(resolve_script 'transition-label')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} in-review ;;
  prose)
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:in-review" \
      --remove-label "workflow:investigating,workflow:ready-to-build,workflow:building,workflow:merged,workflow:invalid,workflow:decomposed" 2>/dev/null || true
    ;;
esac
```

---

## Phase 5: Auto-Review

### 5A: Re-read state from GitHub (MANDATORY)

**Post Phase 5 heartbeat** (skip if issue already has a terminal label — `workflow:merged`, `workflow:invalid`, `needs-human`):
```bash
PHASE_START_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:HEARTBEAT -->
**Phase**: Phase 5 — Review
**Timestamp**: ${PHASE_START_TIMESTAMP}
**Issue**: #{NUMBER}"
```

```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state
PR_NUMBER=$(gh pr list {GH_FLAG} --head {BRANCH} --json number --jq '.[0].number')
```

### 5B: Post progress comment
```bash
gh issue comment {NUMBER} {GH_FLAG} --body "## Submitting for Review

PR #${PR_NUMBER} created targeting \`{PR_BASE}\`. Invoking /review-pr with --auto-merge.

<!-- FORGE:REVIEW_STARTED -->"
```

### 5C: Invoke /review-pr with --auto-merge

**Context budget check** (run before invoking review-pr): <!-- Added: forge#93 -->

Large-context sessions that accumulated significant build history cause review-pr to hit the token limit mid-review. Check the accumulated context before delegating:

- If the build changed **≥10 files** OR this agent has made **≥20 Skill invocations** since it started: invoke `work-on/review` as a fresh sub-agent (via `Skill(skill="work-on/review", args="...")`) rather than calling review-pr directly. The sub-agent starts with a clean context window.
- Otherwise (small build, few skill calls): invoke review-pr directly as below.
- **Fallback**: if `work-on/review` is not available (partial install), invoke review-pr directly regardless of file count and add a note that context may be large.

**Direct invocation** (small builds — <10 changed files AND <20 Skill invocations):
```
Skill(skill="review-pr", args="{PR_NUMBER} --auto-merge --issue {NUMBER} --base {PR_BASE} --gh-flag {GH_FLAG}")
```

**Sub-agent invocation** (large builds — ≥10 changed files OR ≥20 Skill invocations):
```
Skill(skill="work-on/review", args="{NUMBER} --repo {GH_REPO} --gh-flag {GH_FLAG} --worktree {WORKTREE_PATH} --branch {BRANCH} --base {PR_BASE}")
```

Review-pr handles: full domain-agent review → post findings as separate issues → merge PR. It does NOT close the issue or clean up the worktree — those run in Phase 6.

### 5D: Verify merge and close (recovery)

```bash
gh pr view {PR_NUMBER} {GH_FLAG} --json state,mergedAt --jq '{state: .state, mergedAt: .mergedAt}'
gh issue view {NUMBER} {GH_FLAG} --json state --jq '.state'
```

- PR MERGED + issue CLOSED → write checkpoint, then proceed to Phase 6
- PR MERGED + issue OPEN → close issue manually, write checkpoint, proceed to Phase 6
- PR NOT MERGED → `gh pr merge {PR_NUMBER} {GH_FLAG} --merge --auto`. If fails → post comment, add `needs-human`, STOP.

**When PR is MERGED — write machine-readable phase checkpoint (MANDATORY)**:
```bash
CHECKPOINT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CHECKPOINT -->
\`\`\`json
{\"phase\": \"REVIEW\", \"status\": \"COMPLETE\", \"next_phase\": \"CLOSE\", \"timestamp\": \"${CHECKPOINT_TIMESTAMP}\"}
\`\`\`"
```

<!-- FORGE:PHASE_COMPLETE — Review done, PR merged. See Universal Phase Dispatcher: next phase is Phase 6 (Close & Cleanup). Not terminal — continue immediately. -->

**After /review-pr returns and the PR is confirmed merged: immediately proceed to Phase 6 (Close & Cleanup). Do NOT stop here. `REVIEW_RESULT: status: COMPLETE` is an intermediate result — the pipeline is NOT done. Invoke Phase 6 now to close the issue, update labels, post the trajectory log, and clean up the worktree.**

**Do NOT output any text describing this transition. Do NOT write phrases like "returning to work-on", "proceeding to close", "now invoking Phase 6", or any narrative summary of what comes next. Do NOT emit end_turn. Execute Phase 6 code immediately.** <!-- Added: forge#93 -->

---

## Phase 6: Close & Cleanup

### 6A: Final issue body update

**Multi-phase guard**: Detect whether the issue has multiple phases. Only check off items belonging to the current completed phase.

```bash
BODY=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body')
REMAINING_BEFORE=$(echo "$BODY" | grep -c '^- \[ \]' || true)
HAS_PHASE_HEADINGS=$(echo "$BODY" | grep -cP '^#{2,3} ' || true)
```

If multi-phase (`HAS_PHASE_HEADINGS > 0` AND `REMAINING_BEFORE > 0`): do NOT check off future phase items. Add PR reference only.

If single-phase or final phase: check off all `[ ]` items, add PR reference.

### 6B: Project board update (Status=Done, Workflow=Merged)

Resolve `PROJECT_BOARD_OWNER` and `PROJECT_BOARD_NUMBER` from `forge.yaml → project_board` (fields: `owner`, `project_number`). Fall back to `forge.yaml → project.owner` and project number `1` if `project_board` section is absent.

```bash
ISSUE_URL="https://github.com/{GH_REPO}/issues/{NUMBER}"
ITEM_ID=$(gh project item-list {PROJECT_BOARD_NUMBER} --owner {PROJECT_BOARD_OWNER} --format json --limit 200 \
  --jq ".items[] | select(.content.url == \"$ISSUE_URL\") | .id" 2>/dev/null | head -1)
```

If found: set Status=Done, Workflow=Merged using project field IDs from `forge.yaml → project_board.field_ids`.

### 6C: Ensure issue is closed

**Multi-phase guard**: If `REMAINING_AFTER > 0`, uncompleted phases remain. Post phase-complete comment, leave issue open, EXIT — router picks up next phase on next iteration.

If all phases complete:
```bash
gh issue close {NUMBER} {GH_FLAG} \
  --comment "Closed: PR #{PR_NUMBER} merged to \`{PR_BASE}\`. Closes #{NUMBER}."
RESOLUTION=$(resolve_script 'transition-label')
TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} merged ;;
  prose)
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:merged" \
      --remove-label "workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:invalid,workflow:decomposed" 2>/dev/null || true
    ;;
esac
```

### 6D: Parent tracker update (sub-issues only)

**Skip if**: Not a sub-issue (no parent reference in body).

```bash
PARENT_REF=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body' \
  | grep -iE '(part of|spawned from|sub-issue of|parent issue:?|parent:)\s*#[0-9]+' \
  | sed -n 's/.*#\([0-9][0-9]*\).*/\1/p' | head -1)
```

If parent found: check off this sub-issue in parent body. If ALL sub-issues checked off → close parent with `workflow:merged`.

### 6E: Worktree & branch cleanup

```bash
if [ -n "{WORKTREE_PATH}" ] && [ -d "{WORKTREE_PATH}" ]; then
  GIT_COMMON=$(git -C {WORKTREE_PATH} rev-parse --git-common-dir 2>/dev/null)
  REPO_ROOT=$(dirname "$(realpath "$GIT_COMMON" 2>/dev/null || echo "$GIT_COMMON")")
  git -C "$REPO_ROOT" worktree remove {WORKTREE_PATH} --force 2>/dev/null || true
  if [ -n "{BRANCH}" ]; then
    git -C "$REPO_ROOT" branch -D {BRANCH} 2>/dev/null || true
  fi
fi
```

---

## Phase 7: Summary & Trajectory

### 7A: Report
```
## Done: #{NUMBER} — {TITLE}
- Investigation: {VERDICT} ({CONFIDENCE})
- Lane: {FAST/FEATURE}
- Fix: {BRANCH} → PR #{PR_NUMBER} → merged to `{PR_BASE}`
- Files changed: {COUNT}
```

### 7B: Trajectory Log (MANDATORY)

**Review-presence check** (run before filling in Phase 4-5 row): <!-- Added: forge#381 -->
```bash
# Check whether /review-pr was actually invoked — look for review agent comments on the PR
REVIEW_PRESENT=$(gh pr view {PR_NUMBER} {GH_FLAG} --json reviews,comments \
  --jq '([.reviews[].body // ""] + [.comments[].body // ""]) |
        map(select(test("APPROVED:|CHANGES REQUESTED:|FORGE:REVIEWER|review-pr";"i"))) |
        length > 0')
# Set Phase 4-5 row: ✅ Merged if review present, ⚠ Skipped (no review) if not
REVIEW_ROW=$([ "$REVIEW_PRESENT" = "true" ] && echo "✅ Merged" || echo "⚠ Skipped (no review)")
```

This check is **audit-only** — it annotates the trajectory for visibility. It cannot retroactively block a merged PR. If `⚠ Skipped (no review)` is emitted, log it in the Anomalies field so the skip is surfaced during pipeline health review.

Post `<!-- FORGE:TRAJECTORY -->` comment with phase-by-phase results table:

**Before posting, read the attribution config**:
```bash
SHOW_ATTRIBUTION=$(yq '.branding.show_attribution // "true"' forge.yaml 2>/dev/null || echo "true")
[ "$SHOW_ATTRIBUTION" = "false" ] && ATTRIBUTION_LINE="" || ATTRIBUTION_LINE="
> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)"
```

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:TRAJECTORY -->
## Pipeline Trajectory — #{NUMBER}

| Phase | Result | Notes |
|-------|--------|-------|
| Phase 0: Context Load | ✅ Complete | {lane} → \`{PR_BASE}\` |
| Phase 1: Investigation | ✅ {VERDICT} ({CONFIDENCE}) | Task type: {TASK_TYPE} |
| Phase 2: Decomposition | ⏭ Skipped | {reason} |
| Phase 3: Build | ✅ Complete | Branch: \`{BRANCH}\` |
| Phase 3G: Quality Gate | ✅ Gate passed | {iterations} iterations |
| Phase 4–5: Review + PR | {REVIEW_ROW} | PR #{PR_NUMBER} → \`{PR_BASE}\` |
| Phase 6: Close | ✅ Complete | Issue closed |

**Decisions**: {key decisions}
**Anomalies**: {anomalies or None}
**Pipeline completed**: {TIMESTAMP}
${ATTRIBUTION_LINE}"
```

### 7C: Graph Decision Record (MANDATORY when PR exists)

**Skip if**: `{PR_NUMBER}` is empty (investigation-only tasks with no PR) OR `<!-- FORGE:DECISION_RECORD -->` already posted on the PR.

**Purpose**: Post a single consolidated provenance artifact to the PR that proves the merge was backed by citable evidence. Enables downstream benchmarking queries (repeated-mistake rate, stale-edge hit rate, review escape rate) by making every pipeline run queryable via `gh api`.

**Idempotency check**:
```bash
GDR_EXISTS=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:DECISION_RECORD"))] | length > 0' 2>/dev/null || echo "false")
```

**Extract context edge counts** from FORGE:CONTEXT comment (already posted on issue):
```bash
CONTEXT_COMMENT=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTEXT")) | .body' 2>/dev/null | head -1)

# Count historical review-finding issue references (#NNN patterns in Context comment)
REVIEW_FINDING_COUNT=$(echo "$CONTEXT_COMMENT" | grep -oE '#[0-9]+' | wc -l | tr -d ' ')
REVIEW_FINDING_COUNT=${REVIEW_FINDING_COUNT:-0}
```

**Extract review verdict and findings count** from PR review summary (Phase 9 of review-pr):
```bash
REVIEW_SUMMARY=$(gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:REVIEWER") or (.body | test("APPROVED:|CHANGES REQUESTED:"; "i")))] | last | .body // ""' 2>/dev/null || echo '')

REVIEW_VERDICT=$(echo "$REVIEW_SUMMARY" | sed -n 's/.*Verdict: \(APPROVED\|CHANGES REQUESTED\).*/\1/p' | head -1 || echo "APPROVED")
REVIEW_VERDICT="${REVIEW_VERDICT:-APPROVED}"
FINDINGS_COUNT=$(echo "$REVIEW_SUMMARY" | grep -oE '[0-9]+ findings' | grep -oE '[0-9]+' | head -1 || echo "0")
FINDINGS_COUNT="${FINDINGS_COUNT:-0}"
AGENTS_RUN=$(echo "$REVIEW_SUMMARY" | grep -oE '[0-9]+ agents' | grep -oE '[0-9]+' | head -1 || echo "0")
AGENTS_RUN="${AGENTS_RUN:-0}"
```

**Post GDR to PR** (not to issue — PR comment survives as permanent artifact on the merged diff):
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
  \"lane\": \"{lane}\",
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
\`\`\`

**Queryable**: \`gh api repos/{GH_REPO}/issues/{PR_NUMBER}/comments --jq '[.[] | select(.body | contains(\"FORGE:DECISION_RECORD\"))] | .[0].body\`"
fi
```

**Benchmarking**: Query all GDRs for a repo to compute pipeline metrics:
```bash
# Fetch all merged PRs and extract their GDR JSON blocks for metric computation
# (used by /pipeline-health to measure repeated-mistake rate, stale-edge hit rate, etc.)
gh pr list -R {GH_REPO} --state merged --limit 100 --json number \
  --jq '.[].number' | while read pr; do
    gh api repos/{GH_REPO}/issues/$pr/comments \
      --jq '.[] | select(.body | contains("FORGE:DECISION_RECORD")) | .body' 2>/dev/null
  done
```

<!-- Added: forge#776 -->

---

## Error Handling

- Worktree exists: reuse or clean up
- PR creation fails: check if branch pushed, if PR already exists
- Merge conflicts: report to user, do NOT auto-resolve
- gh CLI fails: check `gh auth status`
- Label missing: run `npx forgedock labels setup` (from the project directory, or pass `--repo owner/repo`) to idempotently bootstrap all ForgeDock-managed labels with canonical colors and descriptions. Alternatively: `gh label create "{name}" --color {hex} --description "Managed by ForgeDock." --force -R {GH_REPO}`
