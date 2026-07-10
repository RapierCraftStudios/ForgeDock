---
description: Ship a branch to its deploy target — detect or create PR, fix CI, review, merge. Returns structured result for callers.
argument-hint: [source_branch | "staging" | "milestone/{slug}"] [--target TARGET] [--issue ISSUE_NUMBER] [--repo REPO] [--max-ci-iterations N] [--max-review-iterations N] [--dry-run]
allowed-tools: Bash, Read, Grep, Glob, Skill
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /deploy-pr — PR Ship Orchestrator

**Input**: $ARGUMENTS

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.
**NEVER use the Agent tool** — deploy-pr dispatches sub-skills via `Skill(...)` only. The Agent tool bypasses the allowed-tools constraint and produces opaque output that cannot be structured into the deploy result.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. User can override with `--model <name>`.

<!-- FORGE:SPEC_LOADED — deploy-pr.md loaded and active. Agent is bound by this spec. -->

---

## What This Command Does

`/deploy-pr` is a **sub-skill** designed to be invoked by callers like `/autopilot` that need to ship a branch without consuming their own context window. It handles the full PR shipping lifecycle:

1. Detect or create the PR for the source→target pair
2. Run the CI gate — fix failures via `/fix-ci` (loop up to max iterations)
3. Run the review gate — via `/review-pr` (fix + re-review loop up to max iterations)
4. Merge the PR after both gates pass
5. Return a structured result to the caller

**Never force-merges.** If CI or review fail after maximum iterations, the command stops and reports the blocking state without merging.

---

## Forbidden Tools Self-Check

**Before executing any phase**, verify you are NOT using any of these tools:

| Tool | Status | Reason |
|------|--------|--------|
| `Agent` | **FORBIDDEN** | Bypasses allowed-tools; produces opaque output that cannot feed the structured result |
| `EnterPlanMode` | **FORBIDDEN** | Breaks execution context; phases must be executed, not planned |

---

## Phase 0: Config Resolution & Argument Parsing

### 0A: Read forge.yaml

Resolve all config variables before any logic runs. This prevents unresolved `{PLACEHOLDER}` values in bash blocks — a known failure mode on deploy-info.md (issues #318, #1392).

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"

GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE" 2>/dev/null)
GH_FLAG="-R $GH_REPO"
STAGING_BRANCH=$(yq '.branches.staging // "staging"' "$CONFIG_FILE" 2>/dev/null || echo "staging")
DEFAULT_BRANCH=$(yq '.branches.default // "main"' "$CONFIG_FILE" 2>/dev/null || echo "main")
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE" 2>/dev/null || echo "$(git rev-parse --show-toplevel)")
```

### 0B: Parse Arguments

```
$ARGUMENTS format examples:
  staging
  milestone/my-feature
  feat/my-branch --target staging
  staging --issue 1234 --repo owner/repo --max-ci-iterations 2 --max-review-iterations 3
  staging --dry-run
```

Parse:
- `SOURCE` — first positional arg, or `staging` if omitted
- `--target TARGET` — explicit PR target override (skips routing table)
- `--issue ISSUE_NUMBER` — parent issue to reference in PR body (optional)
- `--repo REPO` — override GH_REPO (optional — forge.yaml takes precedence if absent)
- `--max-ci-iterations N` — max CI fix attempts, default 3
- `--max-review-iterations N` — max review + fix cycles, default 3
- `--dry-run` — run all phases but do NOT merge; print what would happen

```bash
SOURCE="${1:-staging}"
TARGET=""          # resolved in Phase 1 if not passed via --target
ISSUE_NUMBER=""
MAX_CI_ITER=3
MAX_REVIEW_ITER=3
DRY_RUN=false

# Parse optional flags
shift 2>/dev/null || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)      TARGET="$2";           shift 2 ;;
    --issue)       ISSUE_NUMBER="$2";     shift 2 ;;
    --repo)        GH_REPO="$2"; GH_FLAG="-R $GH_REPO"; shift 2 ;;
    --max-ci-iterations)     MAX_CI_ITER="$2";     shift 2 ;;
    --max-review-iterations) MAX_REVIEW_ITER="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=true;          shift ;;
    *) shift ;;
  esac
done
```

---

## Phase 1: Branch Routing

Determine the PR target from the source branch. If `--target` was passed explicitly, skip the routing table and use it directly.

### Routing Table

| Source Branch Pattern | Target | PR Title Prefix |
|----------------------|--------|-----------------|
| `staging` | `main` (DEFAULT_BRANCH) | `Deploy` |
| `milestone/*` | `staging` (STAGING_BRANCH) | `Ship` |
| Any other branch | `staging` (STAGING_BRANCH) | `Merge` |

```bash
if [ -n "$TARGET" ]; then
  # Explicit override
  PR_TARGET="$TARGET"
  case "$SOURCE" in
    staging)        TITLE_PREFIX="Deploy" ;;
    milestone/*)    TITLE_PREFIX="Ship" ;;
    *)              TITLE_PREFIX="Merge" ;;
  esac
else
  case "$SOURCE" in
    staging)
      PR_TARGET="$DEFAULT_BRANCH"
      TITLE_PREFIX="Deploy"
      ;;
    milestone/*)
      PR_TARGET="$STAGING_BRANCH"
      TITLE_PREFIX="Ship"
      ;;
    *)
      PR_TARGET="$STAGING_BRANCH"
      TITLE_PREFIX="Merge"
      ;;
  esac
fi

echo "Source: $SOURCE → Target: $PR_TARGET (prefix: $TITLE_PREFIX)"
```

**Routing guard — staging→main**: When `SOURCE=staging` and `PR_TARGET=main`, the review gate (Phase 4) MUST route to `Skill("review-pr-staging", ...)` rather than the standard `review-pr`. This ensures the staging deploy review (comprehensive, multi-agent) runs instead of the single-PR review.

**Routing guard — milestone→staging**: When `SOURCE` matches `milestone/*`, this is a feature lane ship. `/review-pr` handles these normally (they target staging, not main).

---

## Phase 2: PR Detection / Creation

### 2A: Detect Existing PR

Always check for an open PR before creating one. Never close-and-recreate — always update in place. <!-- Ref: issue #1328 -->

```bash
cd "$REPO_PATH"
git fetch origin "$SOURCE" "$PR_TARGET" 2>/dev/null || true

EXISTING_PR=$(gh pr list $GH_FLAG \
  --head "$SOURCE" \
  --base "$PR_TARGET" \
  --state open \
  --json number,url,title,headRefOid \
  --jq '.[0] // empty' 2>/dev/null)

if [ -n "$EXISTING_PR" ]; then
  PR_NUMBER=$(echo "$EXISTING_PR" | jq -r '.number')
  PR_URL=$(echo "$EXISTING_PR" | jq -r '.url')
  echo "Found existing open PR #${PR_NUMBER}: ${PR_URL}"
  PR_CREATED=false
else
  echo "No existing PR found — creating new PR"
  PR_NUMBER=""
  PR_CREATED=true
fi
```

### 2B: Gather Commit Summary (for new PR body)

Skip if PR already exists.

```bash
if [ "$PR_CREATED" = "true" ]; then
  # Commits on source that are not yet on target
  COMMIT_LOG=$(git log --oneline "origin/${PR_TARGET}..origin/${SOURCE}" --format="%h %s" 2>/dev/null | head -30)
  COMMIT_COUNT=$(git rev-list --count "origin/${PR_TARGET}..origin/${SOURCE}" 2>/dev/null || echo "0")

  if [ "$COMMIT_COUNT" -eq 0 ]; then
    echo "DEPLOY_RESULT: status=NOTHING_TO_DEPLOY source=$SOURCE target=$PR_TARGET"
    echo "{ \"pr\": null, \"source\": \"$SOURCE\", \"target\": \"$PR_TARGET\", \"status\": \"nothing_to_deploy\", \"ci_fixes\": 0, \"review_findings\": 0 }"
    exit 0
  fi

  # Extract issue references from commit messages
  ISSUE_REFS=$(echo "$COMMIT_LOG" | grep -oE '#[0-9]+' | sort -u | head -20 | tr '\n' ' ')

  # Build issue ref block
  if [ -n "$ISSUE_NUMBER" ]; then
    CLOSES_LINE="Closes #${ISSUE_NUMBER}"
  else
    CLOSES_LINE="<!-- No parent issue specified -->"
  fi

  PR_BODY="## Summary

${TITLE_PREFIX}: \`${SOURCE}\` → \`${PR_TARGET}\`

**Commits**: ${COMMIT_COUNT}

## Changes

\`\`\`
${COMMIT_LOG}
\`\`\`

## Issue References

${ISSUE_REFS:-None}

---
${CLOSES_LINE}
**Source**: \`${SOURCE}\`
**Target**: \`${PR_TARGET}\`"
fi
```

### 2C: Create PR (if needed)

```bash
if [ "$PR_CREATED" = "true" ] && [ "$DRY_RUN" = "false" ]; then
  # Determine PR title
  PR_TITLE="${TITLE_PREFIX}: ${SOURCE} → ${PR_TARGET} (${COMMIT_COUNT} commits)"

  # Route to correct review spec — staging→main PRs use review-pr-staging conventions
  if [ "$SOURCE" = "$STAGING_BRANCH" ] && [ "$PR_TARGET" = "$DEFAULT_BRANCH" ]; then
    PR_TITLE="${TITLE_PREFIX}: Deploy staging → main (${COMMIT_COUNT} commits)"
  fi

  PR_URL=$(gh pr create $GH_FLAG \
    --head "$SOURCE" \
    --base "$PR_TARGET" \
    --title "$PR_TITLE" \
    --body "$PR_BODY" 2>&1)

  if echo "$PR_URL" | grep -qE '^https://'; then
    PR_NUMBER=$(echo "$PR_URL" | grep -oE '/pull/[0-9]+' | grep -oE '[0-9]+' | tail -1)
    echo "Created PR #${PR_NUMBER}: ${PR_URL}"
  else
    echo "ERROR: PR creation failed:"
    echo "$PR_URL"
    echo "{ \"pr\": null, \"source\": \"$SOURCE\", \"target\": \"$PR_TARGET\", \"status\": \"pr_creation_failed\", \"ci_fixes\": 0, \"review_findings\": 0 }"
    exit 1
  fi

elif [ "$DRY_RUN" = "true" ] && [ "$PR_CREATED" = "true" ]; then
  echo "[DRY-RUN] Would create PR: ${TITLE_PREFIX}: ${SOURCE} → ${PR_TARGET} (${COMMIT_COUNT} commits)"
  echo "[DRY-RUN] PR body would include ${COMMIT_COUNT} commits and issue refs: ${ISSUE_REFS}"
  PR_NUMBER="DRY_RUN"
fi
```

**State after Phase 2**: `PR_NUMBER` is set (either detected or created).

---

## Phase 3: CI Gate

Invoke `/fix-ci` to handle CI failures. Loop until green or max iterations reached.

**Graceful degradation**: If `/fix-ci` is not available (not yet installed — issue #1675 is its companion), skip this phase with a warning. The review gate in Phase 4 will still run, and a failing CI will block the merge at the review stage.

```bash
CI_FIXES=0
CI_GATE_PASSED=false
CI_ITER=0

# Check if fix-ci is available
FIX_CI_AVAILABLE=$(ls ~/.claude/commands/fix-ci.md 2>/dev/null && echo "true" || echo "false")

if [ "$FIX_CI_AVAILABLE" = "false" ]; then
  echo "WARNING: /fix-ci not available — skipping CI gate. Install fix-ci (issue #1675) for automated CI fixing."
  echo "CI gate: SKIPPED (fix-ci unavailable)"
  CI_GATE_PASSED=true  # Allow pipeline to continue; review gate will catch CI failures
else
  # Check current CI status
  CURRENT_CI_STATUS=$(gh pr checks "$PR_NUMBER" $GH_FLAG --json name,status,conclusion \
    --jq '[.[] | select(.conclusion == "failure")] | length' 2>/dev/null || echo "0")

  if [ "$CURRENT_CI_STATUS" -eq 0 ]; then
    echo "CI gate: PASSED (no failing checks)"
    CI_GATE_PASSED=true
  else
    echo "CI has $CURRENT_CI_STATUS failing checks — invoking /fix-ci (max $MAX_CI_ITER iterations)"

    while [ "$CI_ITER" -lt "$MAX_CI_ITER" ] && [ "$CI_GATE_PASSED" = "false" ]; do
      CI_ITER=$((CI_ITER + 1))
      echo "=== CI Gate Iteration $CI_ITER / $MAX_CI_ITER ==="

      if [ "$DRY_RUN" = "false" ]; then
        Skill("fix-ci", args="$PR_NUMBER $GH_FLAG")
      else
        echo "[DRY-RUN] Would invoke: Skill(fix-ci, $PR_NUMBER $GH_FLAG)"
      fi

      CI_FIXES=$((CI_FIXES + 1))

      # Re-check CI status after fix attempt
      FAILING_AFTER=$(gh pr checks "$PR_NUMBER" $GH_FLAG --json name,status,conclusion \
        --jq '[.[] | select(.conclusion == "failure")] | length' 2>/dev/null || echo "0")

      if [ "$FAILING_AFTER" -eq 0 ]; then
        echo "CI gate: PASSED after $CI_ITER iteration(s)"
        CI_GATE_PASSED=true
      else
        echo "CI still has $FAILING_AFTER failing checks after iteration $CI_ITER"
      fi
    done

    if [ "$CI_GATE_PASSED" = "false" ]; then
      echo "CI gate: FAILED — still failing after $MAX_CI_ITER fix iteration(s). NOT merging."
      echo "{ \"pr\": $PR_NUMBER, \"source\": \"$SOURCE\", \"target\": \"$PR_TARGET\", \"status\": \"ci_failed\", \"ci_fixes\": $CI_FIXES, \"review_findings\": 0 }"
      exit 1
    fi
  fi
fi

# Emit gate state marker for auditability <!-- Ref: issue #1582 — gate passes must be auditable -->
if [ "$DRY_RUN" = "false" ] && [ -n "$PR_NUMBER" ] && [ "$PR_NUMBER" != "DRY_RUN" ]; then
  gh pr comment "$PR_NUMBER" $GH_FLAG --body "<!-- FORGE:GATE_PASS phase=ci iterations=${CI_ITER} fixes=${CI_FIXES} -->" 2>/dev/null || true
fi
```

---

## Phase 4: Review Gate

Invoke `/review-pr` for the PR. Route staging→main PRs to the staging review spec.

**On rejection**: Callers (e.g., /autopilot) are expected to push a fix commit to the source branch before this command is re-invoked. The re-review loop here handles only the re-review after a fix is already pushed — it does NOT fix code itself.

```bash
REVIEW_FINDINGS=0
REVIEW_GATE_PASSED=false
REVIEW_ITER=0

while [ "$REVIEW_ITER" -lt "$MAX_REVIEW_ITER" ] && [ "$REVIEW_GATE_PASSED" = "false" ]; do
  REVIEW_ITER=$((REVIEW_ITER + 1))
  echo "=== Review Gate Iteration $REVIEW_ITER / $MAX_REVIEW_ITER ==="

  if [ "$DRY_RUN" = "false" ]; then
    # Route: staging→main uses review-pr-staging; all other uses standard review-pr
    if [ "$SOURCE" = "$STAGING_BRANCH" ] && [ "$PR_TARGET" = "$DEFAULT_BRANCH" ]; then
      REVIEW_RESULT=$(Skill("review-pr-staging", args="$PR_NUMBER $GH_FLAG"))
    else
      REVIEW_RESULT=$(Skill("review-pr", args="$PR_NUMBER $GH_FLAG"))
    fi
  else
    echo "[DRY-RUN] Would invoke review-pr for PR #$PR_NUMBER"
    REVIEW_RESULT="DRY_RUN_APPROVED"
  fi

  # Extract verdict from review result
  # Review-pr posts <!-- FORGE:REVIEW --> comment on the PR — read it
  if [ "$DRY_RUN" = "false" ]; then
    REVIEW_VERDICT=$(gh api "repos/${GH_REPO}/issues/${PR_NUMBER}/comments" \
      --jq '[.[] | select(.body | contains("FORGE:REVIEW"))] | last | .body' 2>/dev/null \
      | grep -oE 'APPROVED|CHANGES REQUESTED' | head -1 || echo "")
    FINDINGS_THIS_ROUND=$(gh api "repos/${GH_REPO}/issues/${PR_NUMBER}/comments" \
      --jq '[.[] | select(.body | contains("FORGE:REVIEW"))] | last | .body' 2>/dev/null \
      | grep -oE '[0-9]+ finding' | grep -oE '[0-9]+' | head -1 || echo "0")
    REVIEW_FINDINGS=$((REVIEW_FINDINGS + ${FINDINGS_THIS_ROUND:-0}))
  else
    REVIEW_VERDICT="APPROVED"
  fi

  if [ "$REVIEW_VERDICT" = "APPROVED" ]; then
    echo "Review gate: APPROVED after $REVIEW_ITER iteration(s)"
    REVIEW_GATE_PASSED=true
  elif [ "$REVIEW_VERDICT" = "CHANGES REQUESTED" ]; then
    echo "Review gate: CHANGES REQUESTED (iteration $REVIEW_ITER / $MAX_REVIEW_ITER)"
    if [ "$REVIEW_ITER" -lt "$MAX_REVIEW_ITER" ]; then
      echo "Waiting for caller to push a fix commit, then re-reviewing..."
      echo "NOTE: /deploy-pr does not fix code itself. Push fix commits to $SOURCE and re-invoke, or allow the max-review-iterations loop to exhaust."
      # In an autonomous context (e.g., /autopilot), the caller pushes the fix.
      # In manual context, the operator pushes the fix and re-invokes /deploy-pr.
      # This loop's next iteration will re-read the latest PR state.
    fi
  else
    # Fail-closed: unknown verdict must block merge, not grant it.
    # If FORGE:REVIEW comment is missing, malformed, or unparseable for any reason
    # (race condition, context compaction, skill error, comment format mismatch),
    # treat it as a failed review — REVIEW_GATE_PASSED remains false.
    echo "ERROR: Could not determine review verdict from FORGE:REVIEW comment. Blocking merge — review verdict is required. (#1714)"
  fi
done

if [ "$REVIEW_GATE_PASSED" = "false" ]; then
  echo "Review gate: FAILED — changes requested after $MAX_REVIEW_ITER review iteration(s). NOT merging."
  echo "{ \"pr\": $PR_NUMBER, \"source\": \"$SOURCE\", \"target\": \"$PR_TARGET\", \"status\": \"review_failed\", \"ci_fixes\": $CI_FIXES, \"review_findings\": $REVIEW_FINDINGS }"
  exit 1
fi

# Emit review gate state marker for auditability
if [ "$DRY_RUN" = "false" ] && [ -n "$PR_NUMBER" ] && [ "$PR_NUMBER" != "DRY_RUN" ]; then
  gh pr comment "$PR_NUMBER" $GH_FLAG --body "<!-- FORGE:GATE_PASS phase=review iterations=${REVIEW_ITER} findings=${REVIEW_FINDINGS} -->" 2>/dev/null || true
fi
```

---

## Phase 5: Merge

Both CI and review gates have passed. Merge the PR.

**Never force-merges.** If merge fails, report and stop.

```bash
if [ "$DRY_RUN" = "true" ]; then
  echo "[DRY-RUN] Would merge PR #$PR_NUMBER (${SOURCE} → ${PR_TARGET})"
  MERGE_STATUS="dry_run"
else
  echo "Merging PR #$PR_NUMBER..."
  MERGE_OUTPUT=$(gh pr merge "$PR_NUMBER" $GH_FLAG --merge 2>&1)
  MERGE_EXIT=$?

  if [ "$MERGE_EXIT" -eq 0 ]; then
    echo "Merged PR #$PR_NUMBER successfully"
    MERGE_STATUS="merged"
  else
    echo "ERROR: Merge failed:"
    echo "$MERGE_OUTPUT"
    echo "{ \"pr\": $PR_NUMBER, \"source\": \"$SOURCE\", \"target\": \"$PR_TARGET\", \"status\": \"merge_failed\", \"ci_fixes\": $CI_FIXES, \"review_findings\": $REVIEW_FINDINGS }"
    exit 1
  fi
fi
```

---

## Phase 6: Report Structured Result

Return a machine-readable result for callers. This structured block is the primary output consumed by `/autopilot` and other callers.

```bash
echo ""
echo "=== /deploy-pr Complete ==="
echo ""
echo "DEPLOY_RESULT: pr=$PR_NUMBER source=$SOURCE target=$PR_TARGET status=$MERGE_STATUS ci_fixes=$CI_FIXES review_findings=$REVIEW_FINDINGS"
echo ""

# Machine-readable JSON result (consumed by callers)
cat <<JSON
{
  "pr": ${PR_NUMBER:-null},
  "source": "${SOURCE}",
  "target": "${PR_TARGET}",
  "status": "${MERGE_STATUS}",
  "ci_fixes": ${CI_FIXES},
  "review_findings": ${REVIEW_FINDINGS},
  "ci_gate": "$([ $CI_GATE_PASSED = true ] && echo passed || echo failed)",
  "review_gate": "$([ $REVIEW_GATE_PASSED = true ] && echo passed || echo failed)",
  "iterations": {
    "ci": ${CI_ITER},
    "review": ${REVIEW_ITER}
  }
}
JSON
```

---

## Error Reference

| Exit Condition | Status Field | Action |
|---------------|-------------|--------|
| No commits to deploy | `nothing_to_deploy` | No PR created — exit 0 |
| PR creation failed | `pr_creation_failed` | Check gh auth and branch existence |
| CI failed after max iterations | `ci_failed` | Check failing CI job logs; fix manually |
| Review failed after max iterations | `review_failed` | Address review findings; re-invoke |
| Merge failed | `merge_failed` | Check merge conflicts; may need manual resolution |

**`needs-human` pattern**: When any exit condition produces a non-zero exit, callers (like `/autopilot`) should add a `needs-human` label to the parent issue and stop autonomous iteration for this branch.
