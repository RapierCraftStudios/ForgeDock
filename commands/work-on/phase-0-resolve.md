---
description: Resolve a GitHub issue, run pre-flight checks, load context, and sync project board state — Phase 0 of the /work-on pipeline
argument-hint: "[issue number] [--repo {owner}/{repo}] [--gh-flag \"-R {owner}/{repo}\"]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/phase-0-resolve — Resolve Issue & Load Context

**Input**: $ARGUMENTS

Phase 0 of the `/work-on` pipeline: pre-flight checks, input parsing, remediation-mode
detection, GitHub state load, checkpoint routing, learned-override application, project
board sync, and selective spec-set resolution. Invoked at the start of every `/work-on`
run before any phase-specific logic (investigate, build, review, close) executes.

**Agent model policy**: see `work-on.md` section "Model and Effort Tiering — What Actually
Applies" (`FORGE:MODEL_TIER_NOTE`) — this file's steps are mechanical (label edits, config
reads, board sync) end-to-end, a legitimate `effort: low` candidate; `model` overrides are
non-functional for `Skill()`-dispatched sub-phases per that note.
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — work-on/phase-0-resolve.md loaded and active. -->

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

### 0.0: Pre-Flight Checks (MANDATORY — run before any other Phase 0 step)

Validate the environment before the pipeline spends tokens. Each check fails fast with an actionable error and a pointer to the troubleshooting guide (`docs/site/troubleshooting.md`). Run all checks; report every failure, then STOP if any HARD check fails. <!-- Added: forge#1149 -->

```bash
PREFLIGHT_FAILED=0

# Check 1 — forge.yaml present (HARD)
if [ ! -f forge.yaml ]; then
  echo "ERROR: forge.yaml not found in the repository root."
  echo "  Fix: run \`npx forgedock init\` to generate one, or copy forge.yaml.example."
  echo "  See: docs/site/troubleshooting.md#1-forgeyaml-not-found"
  PREFLIGHT_FAILED=1
fi

# Check 2 — yq installed; forge.yaml is valid YAML (HARD, only if present)
if [ -f forge.yaml ]; then
  if ! command -v yq >/dev/null 2>&1; then
    echo "ERROR: yq is not installed. The pipeline requires yq to parse forge.yaml."
    echo "  Fix: install yq — https://github.com/mikefarah/yq#install"
    echo "  See: docs/site/troubleshooting.md#2-forgeyaml-has-a-syntax-error"
    PREFLIGHT_FAILED=1
  elif ! yq '.' forge.yaml >/dev/null 2>&1; then
    echo "ERROR: forge.yaml has a YAML syntax error."
    echo "  Fix: run \`yq '.' forge.yaml\` to locate the offending line, then correct the indentation/quoting."
    echo "  See: docs/site/troubleshooting.md#2-forgeyaml-has-a-syntax-error"
    PREFLIGHT_FAILED=1
  fi
fi

# Check 3 — gh CLI authenticated (HARD)
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh CLI is not authenticated. The pipeline cannot read or write GitHub state."
  echo "  Fix: run \`gh auth login\` (ensure repo scope), then \`gh auth status\` to confirm."
  echo "  See: docs/site/troubleshooting.md#3-gh-cli-not-authenticated"
  PREFLIGHT_FAILED=1
fi

# Check 4 — workflow labels exist on the repo (SOFT — warn, auto-recoverable)
if [ -f forge.yaml ] && gh auth status >/dev/null 2>&1; then
  GH_REPO_PF="$(yq -r '.project.owner + "/" + .project.repo' forge.yaml 2>/dev/null)"
  if [ -n "$GH_REPO_PF" ] && ! gh label list -R "$GH_REPO_PF" --search "workflow:" 2>/dev/null | grep -q "workflow:"; then
    echo "WARNING: ForgeDock workflow:* labels not found on $GH_REPO_PF."
    echo "  Fix: run \`npx forgedock labels setup\` (or \`--repo $GH_REPO_PF\`) to bootstrap them."
    echo "  See: docs/site/troubleshooting.md#9-missing-workflow-labels"
  fi
fi

# Check 5 — GitHub API rate limit headroom (SOFT — warn)
if gh auth status >/dev/null 2>&1; then
  RL_REMAINING="$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null || echo '')"
  if [ -n "$RL_REMAINING" ] && [ "$RL_REMAINING" -lt 100 ] 2>/dev/null; then
    RL_RESET="$(gh api rate_limit --jq '.resources.core.reset' 2>/dev/null)"
    echo "WARNING: GitHub API rate limit low ($RL_REMAINING remaining; resets at epoch $RL_RESET)."
    echo "  Fix: wait for the reset, reduce orchestration parallelism, or use a higher-limit PAT."
    echo "  See: docs/site/troubleshooting.md#10-github-api-rate-limit-exceeded"
  fi
fi

if [ "$PREFLIGHT_FAILED" -eq 1 ]; then
  echo "Pre-flight checks failed. Resolve the errors above and re-run /work-on {NUMBER}."
  echo "Full recovery guide: docs/site/troubleshooting.md"
  exit 1
fi
```

Worktree/branch-already-exists and stale-label conditions are surfaced later (Phase 3E worktree creation and the `## Error Handling` section) with their own recovery guidance in `docs/site/troubleshooting.md`.

### 0A: Parse input
Extract project prefix and issue number. If `next`/`pick`: list open issues sorted by priority, skip `needs-human`, `workflow:decomposed`, and `workflow:awaiting-merge`, pick highest priority.

**Resolve `UNDER_ORCHESTRATION`**: `true` if the invocation args contain `--under-orchestration`, else `false`. This is a single parse done once, here — every later gated block (heartbeats) just checks this variable, no re-parsing.

**Optional pre-flight**: Before committing to the full pipeline, run `/scope {NUMBER}` to get a complexity estimate (affected files, blast radius, risk flags, and decomposition recommendation). Especially useful for large or ambiguous issues.

### 0A.1: Remediation Mode Detection (`--remediate`) <!-- Added: forge#1813 -->

**Engine coverage** (forge#2379): `remediate` is now a registered phase in the headless engine's phase table (`packages/protocol/src/phases.js`, `bin/engine/phases.mjs`) — see `commands/work-on/remediate.md`'s own "Engine coverage" note for the current, documented limitation (a single continuous headless `runIssue()` walk cannot yet reach it; this prose-layer standalone-invocation path below remains the only way `remediate` actually runs today).

**Check first, before any other Phase 0 routing** — if `$ARGUMENTS` contains `--remediate`, this is NOT a normal issue-pipeline invocation. The first positional argument is a **PR number**, not an issue number:

```bash
if echo "$ARGUMENTS" | grep -qE -- '--remediate\b'; then
  REMEDIATE_PR_NUMBER=$(echo "$ARGUMENTS" | grep -oP '^\s*\K[0-9]+' | head -1)  # <!-- allowlist: relocated verbatim from work-on.md, forge#2676; portability tracked under forge#1608 -->
  REMEDIATE_ISSUE_FLAG=""
  REMEDIATE_ISSUE_NUMBER=$(echo "$ARGUMENTS" | grep -oP -- '--issue\s+\K[0-9]+' | head -1)  # <!-- allowlist: relocated verbatim from work-on.md, forge#2676; portability tracked under forge#1608 -->
  [ -n "$REMEDIATE_ISSUE_NUMBER" ] && REMEDIATE_ISSUE_FLAG="--issue ${REMEDIATE_ISSUE_NUMBER}"

  if [ -z "$REMEDIATE_PR_NUMBER" ]; then
    echo "ERROR: --remediate requires a PR number as the first argument, e.g. /work-on 1234 --remediate"
    exit 1
  fi

  echo "Remediation mode: routing PR #${REMEDIATE_PR_NUMBER} to work-on/remediate (issue flag: ${REMEDIATE_ISSUE_FLAG:-<resolved from PR body>})"
fi
```

If detected, dispatch immediately and STOP — do NOT fall through to Phase 0B's normal issue-number resume logic (an issue number is not even known yet; `work-on/remediate.md` Phase M0 resolves it):

```
Skill(skill="work-on/remediate", args="${REMEDIATE_PR_NUMBER} ${REMEDIATE_ISSUE_FLAG} --repo {GH_REPO} --gh-flag {GH_FLAG}")
```

**After `REMEDIATE_RESULT` returns, STOP unconditionally** — do not run any further Phase 0–7 logic in this file. `work-on/remediate.md` is self-contained: when `re_gate_outcome: AUTO-LANDED`, it drives its own close phase internally (Phase M8 invokes `Skill("work-on:close", ...)` directly) before returning. For every other outcome (`HELD-AWAITING-MERGE`, `RE-ESCALATED`, `UNFIXABLE`, `BLOCKED`, `ALREADY_DONE`), the issue is already at a terminal state (`workflow:awaiting-merge` or `needs-human`, or already closed) per the Universal Phase Dispatcher — nothing further to do.

This mode is reachable both standalone (a human or script running `/work-on <pr> --remediate` directly) and via the orchestrator (`commands/orchestrate/phase-4-execution.md` item 6.4 auto-dispatches the identical `Skill(skill='work-on', args='{PR} --remediate --issue {N} ...')` invocation against a `needs-human`-gated predecessor's own PR).

**Skip this entire section if `--remediate` is absent from `$ARGUMENTS`** — proceed to the normal parse below.

### 0A.5: Post Heartbeat Annotation (orchestration-only)

**Skip entirely if `UNDER_ORCHESTRATION` is `false`** — a solo run has no stall detector polling comment timestamps, so this write has zero consumer. Do not post it "just in case."

When `UNDER_ORCHESTRATION` is `true`: post a lightweight activity signal immediately after resolving the issue number. This gives the stall detector (orchestrate Step 4B.5) a fresh timestamp to compare against `STALL_TIMEOUT`. Without this, the stall detector can only see the last structured comment (INVESTIGATOR, BUILDER, etc.) which may be hours old during a valid long-running phase.

```bash
# Not DRY_RUN-gated — this heartbeat write is an unconditional part of every
# /work-on run once UNDER_ORCHESTRATION is true (see the skip check above),
# matching sibling phase files (investigate.md, build.md, close.md) which
# perform the same class of side effect without a governor.
PHASE_START_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:HEARTBEAT -->
**Phase**: Phase 0 — starting pipeline
**Timestamp**: ${PHASE_START_TIMESTAMP}
**Issue**: #{NUMBER}"
```

**Also post at major phase entry points** (Phases 1, 3, and 5) — replace `Phase 0` with the correct phase name in each case, and same `UNDER_ORCHESTRATION` gate. These mid-pipeline heartbeats ensure the stall detector sees recent activity during long phases (e.g., a build phase running for 20 minutes is not falsely classified as stalled). Inline snippets are embedded at Phase 1A, Phase 3A, and Phase 5A — agents resuming mid-pipeline encounter them without reading this section. <!-- Added: forge#740 -->

**Skip if**: Issue already has a terminal label (`workflow:merged`, `workflow:invalid`, `needs-human`, `workflow:awaiting-merge`) — no heartbeat needed on a completed issue. (This is in addition to, not instead of, the `UNDER_ORCHESTRATION` gate above.)

### 0B: Load issue + existing context
```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,comments,milestone
gh api repos/{GH_REPO}/issues/{NUMBER}/comments --jq '.[] | {id: .id, author: .user.login, body: .body}'
```

**Check**: state (closed → STOP), terminal labels (`workflow:merged`/`workflow:invalid`/`workflow:awaiting-merge` → STOP), existing agent comments (`FORGE:INVESTIGATOR`, `FORGE:DECOMPOSED`, `FORGE:CONTRACT`, `FORGE:BUILDER`, `FORGE:TRAJECTORY`, `FORGE:DECISION_RECORD`), parent tracker status, sub-issue status.

**Determine resume point**: No comments → Phase 1. Investigation exists + ready-to-build → Phase 3. Builder:COMPLETE + no PR → Phase 4. Builder without :COMPLETE (partial/interrupted build) + no PR → Phase 3 (partial-build cleanup). Builder + PR open → Phase 5. PR merged + issue open → Phase 6.

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

Note: Phase 1D no longer writes `next_phase: BUILD`/`DECOMPOSE` CHECKPOINT comments (removed as redundant with the `workflow:ready-to-build`/`workflow:decomposed` label transition — see Phase 1D). Those two rows remain here only to route older, pre-existing CHECKPOINT comments correctly; new runs land on the prose-heuristic fallback for those two cases instead, which is equally precise. `REVIEW` and `CLOSE` are still written (Phase 3M and Phase 5D) because each covers a real gap before the corresponding label transition.

**If no checkpoint exists**: fall back to prose resume heuristics in Phase 0B above — treat as fresh start at Phase 1.

**Classify lane**: Milestone → feature lane (`milestone/{slug}`). No milestone → fast lane (`staging`).

**Batch issue detection**: <!-- Added: forge#1333 --> If the issue body contains `<!-- FORGE:BATCH_MEMBERS -->`, this is a P3 batch issue. Set `IS_BATCH=true` and extract the member issue list:

```bash
IS_BATCH=0
BATCH_MEMBERS=()

BATCH_MEMBERS_BLOCK=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body' \
  | sed -n '/<!-- FORGE:BATCH_MEMBERS -->/,/<!-- \/FORGE:BATCH_MEMBERS -->/p' 2>/dev/null || true)

if [ -n "$BATCH_MEMBERS_BLOCK" ]; then
  IS_BATCH=1
  # Extract member issue numbers (- [ ] #NNN: title lines)
  BATCH_MEMBERS=($(echo "$BATCH_MEMBERS_BLOCK" | grep -oP '(?<=- \[ \] #)\d+' || true))  # <!-- allowlist: relocated verbatim from work-on.md, forge#2676; portability tracked under forge#1608 -->
  echo "Batch issue detected — member issues: ${BATCH_MEMBERS[*]}"
fi
```

**Batch issue pipeline rules** (when `IS_BATCH=true`):
- Build phases execute exactly as normal (the batch issue body IS the spec for what to fix)
- After successful merge, auto-close all member issues with a cross-reference:
  ```bash
  for MEMBER in "${BATCH_MEMBERS[@]}"; do
    gh issue close "$MEMBER" {GH_FLAG} \
      --comment "Resolved as part of batch PR #{PR_NUMBER} (#{ISSUE_NUMBER}). See batch issue for details."
    gh issue edit "$MEMBER" {GH_FLAG} --add-label "workflow:merged" 2>/dev/null || true  # <!-- allowlist:check-command-side-effects -->
  done
  ```
- Member issues are closed in Phase 6 (after PR merge) — NOT before

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
UNIVERSAL_DIR="${FORGEDOCK_HOME:-$REPO_PATH}/scripts"
# NOTE: never resolve this via `which` or `find` — universal scripts are
# repo-relative, not installed on $PATH, so a PATH lookup always misses.
# REPO_PATH is already resolved from forge.yaml → paths.root earlier in
# Phase 0, so it is the deterministic fallback when FORGEDOCK_HOME is unset.
# Pipeline agents MUST NOT use `find` (unbounded or filesystem-wide) to
# locate pipeline scripts under any circumstances: if UNIVERSAL_DIR/${operation}.sh
# does not exist, resolve_script() falls through to Tier 4 (prose) below,
# which is always safe and available. A missing script is never a reason
# to search the filesystem. <!-- Added: forge#1984 -->

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
# back to inline gh issue edit; classify-lane has no valid prose fallback and  <!-- allowlist:check-command-side-effects -->
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

### 0C.5: Resolve minimal spec set (selective spec loading)

Rather than loading the full ~27-command corpus (~1.1 MB / ~276K tokens) into
context, resolve the **minimal spec set** this run actually needs from the spec
knowledge graph. Use the universal-tier `graph-query` script via the canonical
`resolve_script` tier-dispatch pattern:

```bash
# Forward-transitive reachability: work-on + its reachable sub-phases (CONTAINS)
# + required devdocs (REQUIRES), as repo-relative file paths.
RESOLUTION=$(resolve_script 'graph-query')
TIER="${RESOLUTION%%:*}"
SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal)
    SPEC_SET=$(bash "$SCRIPT_PATH" load-set work-on 2>/dev/null || echo '[]')
    echo "$SPEC_SET" | jq -r '.[]'
    ;;
  prose)
    # Prose fallback: graph-query.sh unavailable — read specs on demand as each
    # Skill(...) is invoked. Selective loading is an optimization, not required.
    : ;;
esac
```

**Read ONLY the files returned by `load-set work-on`** when you need full spec
text during this run — these are the work-on orchestrator plus the sub-phases
and devdocs reachable from it (e.g. `commands/work-on/build/*`, `commands/work-on/review.md`,
`commands/review-pr.md`). Do **not** broadly read unrelated command specs
(`pipeline-health.md`, `audit.md`, `geo-audit.md`, …) that are not in the set.
Sub-phases are still invoked normally via their existing `Skill(...)` calls; this
step only narrows what is *pre-read* into context, it does not remove any phase.

This is the inverse of `graph-query.sh impact` (forward instead of reverse
reachability). It is read-only and auto-builds the graph if the gitignored JSON
is absent — no committed graph is required. The prose tier above handles older
installs without the scripts layer: selective loading is an optimization, never
a hard dependency.

→ Return to `work-on.md` Universal Phase Dispatcher: Phase 0 complete, proceed to Phase 1 (Investigation) via `work-on/investigate.md`, or resume at whatever phase the checkpoint/label state (0B/0B.5) indicated.
