---
description: Review subcommand — push branch, create PR, invoke /review-pr with --auto-merge
argument-hint: [issue number] [--repo GH_REPO] [--gh-flag GH_FLAG] [--worktree PATH] [--branch BRANCH] [--base PR_BASE]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/review — Review & PR Creation Subcommand

**Input**: $ARGUMENTS

**Invoked by**: `work-on.md` Phase 4–5, after `build/validate.md` returns `GATE_PASSED: true`.
**Output**: Push branch, create PR, invoke /review-pr --auto-merge, return result to caller.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--worktree {WORKTREE_PATH}` — absolute path to the git worktree
- `--branch {BRANCH}` — feature branch name (e.g. `feat/my-feature`)
- `--base {PR_BASE}` — PR target branch (e.g. `milestone/modular-pipeline-architecture` or `staging`)

---

## Phase R0: Load State from GitHub (MANDATORY)

Re-read current state before doing anything:

```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,milestone

# Get builder comment (for branch + commit info)
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:BUILDER")) | .body'

# Check if PR already exists for this branch
gh pr list {GH_FLAG} --head {BRANCH} --json number,state,url 2>/dev/null
```

**Resume check**:
- If PR already exists AND is OPEN → skip to Phase R3 (invoke /review-pr)
- If PR already exists AND is MERGED → return `REVIEW_RESULT: status: ALREADY_MERGED`
- If no `<!-- FORGE:BUILDER -->` comment exists → EXIT with `REVIEW_RESULT: status: BLOCKED`, blocker: "FORGE:BUILDER comment not found — implement phase may not have completed"

---

## Phase R1: Pre-Push Ancestry Guard

Before pushing, verify the branch contains no merge commits from branches outside the PR base ancestry. This is the final defense against milestone-code-onto-staging contamination.

```bash
cd {WORKTREE_PATH}
# Skip if PR_BASE does not exist on origin yet (new branch — no contamination possible)
if git ls-remote --exit-code origin {PR_BASE} >/dev/null 2>&1; then
  MERGE_COMMITS=$(git log --merges {BRANCH} ^origin/{PR_BASE} 2>/dev/null)
  if [ -n "$MERGE_COMMITS" ]; then
    echo "PRE-PUSH ANCESTRY GUARD FAILED: merge commits from outside {PR_BASE} detected"
    gh issue comment {NUMBER} {GH_FLAG} --body "## Pre-Push Ancestry Guard Failed

Branch \`{BRANCH}\` contains merge commits from branches outside the PR base (\`{PR_BASE}\`). Pushing this branch risks contaminating \`{PR_BASE}\` with unapproved code (e.g. milestone code leaking onto staging).

**Detected merge commits**:
\`\`\`
${MERGE_COMMITS}
\`\`\`

Do NOT push this branch. Human review required to identify the source of the merge commits and clean the branch history (e.g. via \`git rebase\` to replay only the intended commits onto \`origin/{PR_BASE}\`).

<!-- FORGE:PUSH_BLOCKED -->"
    gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
    # Return REVIEW_RESULT: status: BLOCKED — do not push
    exit 1
  fi
fi
```

## Phase R1: Non-Empty Commit Guard (MANDATORY — run before push) <!-- Added: forge#1305 -->

Before pushing, verify the branch has at least one commit ahead of the PR base. This is the last-line defense against the phantom-commit hazard: a session that resumed from a partial FORGE:BUILDER comment (without `:COMPLETE`) would have skipped the commit step and could otherwise push an empty branch.

```bash
cd {WORKTREE_PATH}
# Count commits on this branch that are not reachable from origin/{PR_BASE}
COMMIT_COUNT=$(git rev-list --count HEAD ^origin/{PR_BASE} 2>/dev/null || echo "0")
if [ "$COMMIT_COUNT" -eq 0 ]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "## Push Blocked — No Commits Ahead of Base

Branch \`{BRANCH}\` has 0 commits ahead of \`origin/{PR_BASE}\`. Pushing this branch would create an empty PR.

**Likely cause**: Build was interrupted after the FORGE:BUILDER comment was posted (implement.md Phase I6) but before the commit was created (validate.md Phase V5). The branch was pushed with no implementation on it.

**Resolution**: Delete this branch, re-run \`/work-on {NUMBER}\` to restart the build phase. The partial FORGE:BUILDER comment (lacking \`FORGE:BUILDER:COMPLETE\`) will be detected and deleted, and the build will restart cleanly.

<!-- FORGE:PUSH_BLOCKED_EMPTY_BRANCH -->"
  gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
  exit 1
fi
echo "Commit count ahead of origin/{PR_BASE}: $COMMIT_COUNT — OK to push"
```

## Phase R1: Push Branch

```bash
cd {WORKTREE_PATH}
git push origin {BRANCH}
```

If push fails, retry with `--force-with-lease`:
```bash
git push origin {BRANCH} --force-with-lease
```

If still fails:
```bash
gh issue comment {NUMBER} {GH_FLAG} --body "## Push Failed

Branch \`{BRANCH}\` could not be pushed to origin.

**Error**: {ERROR_OUTPUT}

This may indicate a merge conflict or remote rejection. Human review required.

<!-- FORGE:PUSH_FAILED -->"

gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
```
Return `REVIEW_RESULT: status: BLOCKED`, blocker: "git push failed".

---

## Phase R2: Create PR

### R2A: Determine PR title

Derive from issue title:
- `fix(...):`  → `Fix: {description}`
- `feat(...):`  → `Feat: {description}`
- `refactor(...):`  → `Refactor: {description}`
- `docs(...):`  → `Docs: {description}`
- fallback: use issue title as-is

### R2B: Create PR

```bash
gh pr create {GH_FLAG} \
  --base {PR_BASE} \
  --head {BRANCH} \
  --title "{PR_TITLE}" \
  --body "## Summary

{BRIEF_DESCRIPTION_FROM_ISSUE_BODY}

## Changes

{BULLETED_LIST_OF_KEY_CHANGES_FROM_BUILDER_COMMENT}

## Testing

{TESTING_CHECKLIST_FROM_BUILDER_COMMENT}

---

Closes #{NUMBER}

**Implementation branch**: \`{BRANCH}\`
**Base**: \`{PR_BASE}\`"
```

**Note**: `Closes #{NUMBER}` documents intent but does NOT auto-close for non-default-branch PRs. The close subcommand handles explicit closure after merge.

If PR creation fails because a PR already exists for this branch:
```bash
gh pr list {GH_FLAG} --head {BRANCH} --json number,url --jq '.[0]'
```
Use the existing PR number and continue.

### R2C: Update labels

```bash
gh issue edit {NUMBER} {GH_FLAG} \
  --add-label "workflow:in-review" \
  --remove-label "workflow:building"
```

---

## Phase R3: Invoke /review-pr with --auto-merge

Re-read the PR number (from creation or from resume check):

```bash
PR_NUMBER=$(gh pr list {GH_FLAG} --head {BRANCH} --json number --jq '.[0].number')
```

Post a progress comment before delegating:

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "## Submitting for Review

PR #${PR_NUMBER} created targeting \`{PR_BASE}\`. Invoking /review-pr with --auto-merge.

Review will: analyze changes → spawn domain agents → post findings → merge → close issue → clean up worktree.

<!-- FORGE:REVIEW_STARTED -->"
```

Invoke the review command:

```
Skill(skill="review-pr", args="{PR_NUMBER} --auto-merge --issue {NUMBER} --base {PR_BASE} --gh-flag {GH_FLAG}")
```

/review-pr handles: full domain-agent review → post findings as separate issues (non-blocking) → merge the PR → close the issue → clean up worktree.

---

## Phase R4: Verify Review Outcome

After /review-pr returns, verify the outcome:

```bash
# Check PR state
gh pr view {PR_NUMBER} {GH_FLAG} --json state,mergedAt --jq '{state: .state, mergedAt: .mergedAt}'

# Check issue state
gh issue view {NUMBER} {GH_FLAG} --json state --jq '.state'
```

**Cases**:
- PR MERGED (issue OPEN or CLOSED) → write checkpoint, then return `REVIEW_RESULT: status: COMPLETE` — do NOT close the issue or add labels here; the router will route to `work-on:close` which handles issue closure, label updates, project board, trajectory log, and worktree cleanup.

  Write machine-readable phase checkpoint before returning (MANDATORY when PR is MERGED):
  ```bash
  CHECKPOINT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CHECKPOINT -->
  \`\`\`json
  {\"phase\": \"REVIEW\", \"status\": \"COMPLETE\", \"next_phase\": \"CLOSE\", \"timestamp\": \"${CHECKPOINT_TIMESTAMP}\"}
  \`\`\`"
  ```

- PR NOT MERGED → attempt manual merge:
  ```bash
  gh pr merge {PR_NUMBER} {GH_FLAG} --merge --auto
  ```
  If merge fails: post comment, add `needs-human`, return `REVIEW_RESULT: status: BLOCKED`

---

## Output

**After posting this result, immediately proceed to the close subcommand — do NOT stop here. `REVIEW_RESULT: status: COMPLETE` is an intermediate result, NOT a terminal state. The pipeline is not done. You MUST invoke `Skill("work-on:close", ...)` now to close the issue, update labels to `workflow:merged`, post the trajectory log, and clean up the worktree.**

Output this structured block:

```
REVIEW_RESULT:
  status: COMPLETE | ALREADY_MERGED | BLOCKED
  pr_number: {PR_NUMBER}
  pr_url: {PR_URL}
  merged_to: {PR_BASE}
  blocker: {description if status=BLOCKED}
```

---

## Integration Point in work-on.md

This module runs at **Phases 4–5** — after validate returns `GATE_PASSED: true`, before close:

```
3F.5 → Validate (by build/validate.md) — gate passed
4    → [THIS MODULE] Push + PR creation + /review-pr invocation + merge verification
5    → Close (by close.md) — trajectory, parent tracker, summary
```

/review-pr is invoked within this module (not by the router). The router waits for REVIEW_RESULT before invoking close.md.
