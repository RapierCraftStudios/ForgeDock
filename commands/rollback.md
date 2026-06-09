---
description: Create a revert PR to roll back a shipped feature or fix that caused a production incident
argument-hint: [PR number to revert, or "last" for most recent deploy]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /rollback — Automated Revert PR Creation

**Input**: $ARGUMENTS

**Config variables used by this command** (set in `forge.yaml`):
- `{REPO_PATH}` ← `paths.root` — project repository root

You are the pipeline's emergency rollback system. When a shipped feature or fix causes production issues, this command creates a revert PR and fast-tracks it through the pipeline.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`. User can override with `--model <name>`.

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

---

## Phase 1: Identify What to Revert

### Step 1A: Parse the input

| Input | Action |
|-------|--------|
| PR number (e.g., `142`) | Revert that specific PR |
| `last` or empty | Revert the most recent merge to `main` |
| Issue number with `#` (e.g., `#55`) | Find the PR that closed this issue, revert it |

### Step 1B: Resolve the target PR

```bash
# If PR number given directly
gh pr view {PR_NUMBER} --json number,title,mergeCommit,headRefName,baseRefName,body,mergedAt

# If "last" — find most recent merge to main
gh pr list --state merged --base main --limit 1 --json number,title,mergeCommit,mergedAt

# If issue number — find the PR that closed it
gh pr list --state merged --search "Closes #{ISSUE}" --limit 1 --json number,title,mergeCommit
```

### Step 1C: Validate revert is safe

Before reverting, check:

1. **Was the PR actually merged to main?** If it's only on staging, revert from staging instead.
2. **Are there dependent PRs merged after this one?** If later PRs build on this code, a simple revert may break them.

```bash
# Check what changed in the PR
gh pr diff {PR_NUMBER} --name-only

# Check if any later PRs touched the same files
MERGE_DATE=$(gh pr view {PR_NUMBER} --json mergedAt --jq '.mergedAt')
gh pr list --state merged --base main --json number,title,mergedAt,files \
  --jq ".[] | select(.mergedAt > \"$MERGE_DATE\") | {number, title}"
```

If dependent PRs exist, warn the user:
```
⚠️ PRs merged AFTER #{PR_NUMBER} that touch the same files:
- #{LATER_PR} — {title}

A simple revert may break these. Options:
1. Revert all dependent PRs together (risky)
2. Create a targeted fix instead of a full revert
3. Proceed with revert anyway (you'll need to fix conflicts)

Which approach? (Reply or press enter for option 1)
```

---

## Phase 2: Create the Revert

### Step 2A: Create a revert branch

```bash
cd {REPO_PATH}
git fetch origin main
git worktree add ../revert-pr-{PR_NUMBER} -b revert/pr-{PR_NUMBER} origin/main

cd ../revert-pr-{PR_NUMBER}
```

### Step 2B: Execute the revert

```bash
# Get the merge commit SHA
MERGE_SHA=$(gh pr view {PR_NUMBER} --json mergeCommit --jq '.mergeCommit.oid')

# Revert the merge commit (use -m 1 for merge commits to select the mainline parent)
git revert -m 1 $MERGE_SHA --no-edit
```

If the revert has conflicts:
```bash
# Show conflicts
git diff --name-only --diff-filter=U

# Report to user
echo "Revert has conflicts in these files:"
git diff --name-only --diff-filter=U
echo ""
echo "This usually means later changes depend on the reverted PR."
echo "Manual resolution needed — opening conflicted files for review."
```

If conflicts cannot be auto-resolved, report to user and STOP.

### Step 2C: Verify the revert compiles

```bash
# Python files
poetry -C services/api run python -m py_compile {reverted_python_files} 2>&1

# TypeScript files (if any)
cd web && npx tsc --noEmit 2>&1 | head -20
```

---

## Phase 3: Create the Revert PR

### Step 3A: Push and create PR

```bash
git push origin revert/pr-{PR_NUMBER}

gh pr create --base main --title "Revert: #{PR_NUMBER} — {original_title}" --body "$(cat <<'PR_EOF'
## Revert

Reverts #{PR_NUMBER} ({original_title}).

**Reason**: {user-provided reason or "Production incident — rollback requested"}

**Original PR**: #{PR_NUMBER}
**Merge commit**: {MERGE_SHA}

## What This Reverts

{List of files changed, from the original PR}

## Verification

- [ ] Revert compiles cleanly
- [ ] No dependent PRs broken
- [ ] Production incident should resolve after deploy
PR_EOF
)"
```

### Step 3B: Fast-track decision

**If this is a P0 incident** (user said "urgent", "P0", "production down", or similar):
- Skip the full review — revert PRs are low-risk (they restore known-good state)
- Merge immediately:
```bash
gh pr merge {REVERT_PR} --merge
```
- Then trigger hotfix deploy:
```bash
echo "Revert merged to main. CI/CD will deploy automatically."
echo "For faster deploy, trigger hotfix: gh workflow run hotfix-deploy.yml --ref main -f services={affected} -f reason=\"Rollback PR #{PR_NUMBER}\""
```

**If not urgent**:
- Let the revert PR go through normal review via `/review-pr`
- It will merge to main and deploy on next CI/CD cycle

---

## Phase 4: Post-Revert Cleanup

### Step 4A: Update the original issue

If the reverted PR referenced an issue:

```bash
# Reopen the original issue
ORIGINAL_ISSUE=$(gh pr view {PR_NUMBER} --json body --jq '.body' | grep -oP 'Closes #\K\d+')
if [ -n "$ORIGINAL_ISSUE" ]; then
  gh issue reopen $ORIGINAL_ISSUE --comment "Reverted in PR #{REVERT_PR_NUMBER} due to production incident. Needs a new fix approach."
  gh issue edit $ORIGINAL_ISSUE --remove-label "workflow:merged"
  gh issue edit $ORIGINAL_ISSUE --add-label "workflow:ready-to-build,needs-validation"
fi
```

### Step 4B: Create a follow-up issue

```bash
gh issue create --title "fix: {original_title} (reverted — needs new approach)" \
  --label "bug,P1" \
  --body "$(cat <<'BODY_EOF'
## Problem

PR #{PR_NUMBER} ({original_title}) was merged and deployed but caused a production incident. It was reverted in PR #{REVERT_PR_NUMBER}. The original fix needs to be re-implemented with a different approach that avoids the production issue.

**What went wrong**: {brief description of the production issue}

## Root Cause (if known)

{Why the original approach caused the incident — the failure mode that needs to be avoided in the new approach. If unknown: "Root cause unknown — investigation needed."}

**Original approach that failed**: {summary of what the reverted PR did}

## Affected Files

Files that need changes (same as original fix, different approach):
1. `{filepath}` — {what needs to change with the new approach}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] New approach avoids the failure mode from the reverted PR
- [ ] Fix validated in staging before merging
- [ ] Original production issue is resolved

## Context

**Original issue**: #{ORIGINAL_ISSUE}
**Reverted PR**: #{REVERT_PR_NUMBER}

## Dependencies

Regression of #{ORIGINAL_ISSUE}. Should investigate why the original approach caused issues before implementing.
BODY_EOF
)"
```

### Step 4C: Clean up worktree

```bash
cd {REPO_PATH}
git worktree remove ../revert-pr-{PR_NUMBER}
git branch -D revert/pr-{PR_NUMBER} 2>/dev/null || true
```

---

## Phase 5: Summary

```
## Rollback Complete

- **Reverted**: PR #{PR_NUMBER} — {original_title}
- **Revert PR**: #{REVERT_PR_NUMBER} → main
- **Status**: {Merged + deploying | Pending review}
- **Original issue**: #{ORIGINAL_ISSUE} — reopened with `needs-validation`
- **Follow-up**: #{FOLLOWUP_ISSUE} — fix with new approach

{If urgent: "Deploy in progress. Monitor production for resolution."}
{If not urgent: "Revert PR is in review. Once merged, CI/CD will deploy."}
```
