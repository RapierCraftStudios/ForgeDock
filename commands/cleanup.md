---
description: Sweep closed issues for stale labels, missing workflow state, and Project board gaps — plus prune worktrees, branches, and milestones
argument-hint: [labels | branches | milestones | board | orphans | all]
---

# /cleanup — Full Hygiene Sweep

**Input**: $ARGUMENTS

Scan the entire development environment for rot and fix it. This is a maintenance command — run periodically or after large orchestration batches. It covers 6 domains: stale labels, orphaned issues, worktree/branch pruning, milestone hygiene, and Project board sync.

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

---

## Command Router

| Input | Action |
|-------|--------|
| `labels` or empty | Fix stale/missing workflow labels on closed issues |
| `orphans` | Close open issues whose PRs are already merged |
| `branches` | Prune worktrees and remote branches for merged PRs |
| `milestones` | Close milestones with 0 open issues |
| `board` | Sync closed issues to Project board with correct terminal state |
| `all` | All of the above, in order |

---

## Phase 1: Stale Labels

### 1A: Detect stale intermediate labels on closed issues

These labels should only exist on OPEN issues. If a closed issue has them, the pipeline crashed mid-flight.

```bash
echo "=== Stale workflow:in-review ==="
gh issue list -R RapierCraft/AlterLab --state closed --label "workflow:in-review" --limit 100 --json number,title --jq '.[] | "#\(.number) — \(.title)"'

echo "=== Stale workflow:building ==="
gh issue list -R RapierCraft/AlterLab --state closed --label "workflow:building" --limit 100 --json number,title --jq '.[] | "#\(.number) — \(.title)"'

echo "=== Stale workflow:investigating ==="
gh issue list -R RapierCraft/AlterLab --state closed --label "workflow:investigating" --limit 100 --json number,title --jq '.[] | "#\(.number) — \(.title)"'

echo "=== Stale needs-validation ==="
gh issue list -R RapierCraft/AlterLab --state closed --label "needs-validation" --limit 100 --json number,title --jq '.[] | "#\(.number) — \(.title)"'
```

### 1B: Fix stale labels

For each closed issue with a stale intermediate label:

**Stale `workflow:in-review`, `workflow:building`** — these were merged but label wasn't updated:
```bash
for NUM in {stale_issue_numbers}; do
  gh issue edit $NUM -R RapierCraft/AlterLab --add-label "workflow:merged"
  gh issue edit $NUM -R RapierCraft/AlterLab --remove-label "workflow:in-review,workflow:building,needs-validation" 2>/dev/null || true
done
```

**Stale `workflow:investigating`** — check if closed as invalid or completed:
- If it has `workflow:invalid` already → just remove `workflow:investigating`
- If closed normally → add `workflow:merged`, remove `workflow:investigating`

**Stale `needs-validation`** — remove from all closed issues:
```bash
for NUM in {needs_validation_numbers}; do
  gh issue edit $NUM -R RapierCraft/AlterLab --remove-label "needs-validation" 2>/dev/null || true
done
```

### 1C: Report closed issues with NO workflow label

```bash
gh issue list -R RapierCraft/AlterLab --state closed --limit 200 --json number,title,labels \
  --jq '.[] | select([.labels[].name] | any(startswith("workflow:")) | not) | "#\(.number) — \(.title)"'
```

These were closed outside the pipeline. Report count but don't fix (not necessarily wrong).

---

## Phase 2: Orphaned Issues (open issues with merged PRs)

Find open issues whose fix PRs have already been merged — these slipped through because `Closes #N` doesn't auto-close when merging to `staging` (only works for default branch `main`).

### 2A: Detect orphans

For each open issue with `workflow:in-review` label, check if it has a merged PR:

```bash
# Get all open issues with workflow:in-review
OPEN_IN_REVIEW=$(gh issue list -R RapierCraft/AlterLab --state open --label "workflow:in-review" --limit 100 --json number --jq '.[].number')

for NUM in $OPEN_IN_REVIEW; do
  # Search for merged PRs that reference this issue
  MERGED_PR=$(gh pr list -R RapierCraft/AlterLab --search "Closes #$NUM" --state merged --json number --jq '.[0].number' 2>/dev/null)
  if [ -n "$MERGED_PR" ]; then
    echo "ORPHAN: #$NUM has merged PR #$MERGED_PR"
  fi
done
```

### 2B: Close orphans

For each orphaned issue found:
```bash
gh issue close $NUM -R RapierCraft/AlterLab --comment "Closed by cleanup — PR #$MERGED_PR was already merged."
gh issue edit $NUM -R RapierCraft/AlterLab --add-label "workflow:merged"
gh issue edit $NUM -R RapierCraft/AlterLab --remove-label "workflow:in-review" 2>/dev/null || true
```

Also check open issues with `workflow:building` — same pattern (search for merged PRs referencing them).

---

## Phase 3: Worktree & Branch Pruning

### 3A: Identify worktrees with merged PRs

```bash
cd /home/mrdubey/projects/ScraperAPI/alterlab

# For each worktree (excluding the main one), check if its branch has a merged PR
git worktree list --porcelain | grep "^worktree " | grep -v "/alterlab$" | sed 's/^worktree //' | while read wt; do
  branch=$(git -C "$wt" branch --show-current 2>/dev/null)
  if [ -n "$branch" ]; then
    merged_pr=$(gh pr list --head "$branch" --state merged --json number --jq '.[0].number' 2>/dev/null)
    if [ -n "$merged_pr" ]; then
      echo "STALE_WT|$wt|$branch|PR#$merged_pr"
    fi
  fi
done
```

### 3B: Remove stale worktrees and local branches

For each worktree with a merged PR:
```bash
git worktree remove "$WORKTREE_PATH" --force
git branch -D "$BRANCH_NAME" 2>/dev/null || true
echo "Removed: $WORKTREE_PATH ($BRANCH_NAME)"
```

### 3C: Prune merged remote branches

Delete remote `fix/` and `feat/` branches that are fully merged into `staging`:

```bash
cd /home/mrdubey/projects/ScraperAPI/alterlab
git fetch --prune origin

# Count first
MERGED_COUNT=$(git branch -r --merged origin/staging | grep -E "origin/(fix|feat)/" | wc -l)
echo "Found $MERGED_COUNT merged remote branches to delete"

# Delete them
if [ "$MERGED_COUNT" -gt 0 ]; then
  git branch -r --merged origin/staging | grep -E "origin/(fix|feat)/" | sed 's|origin/||' | xargs -I{} git push origin --delete {} 2>&1
fi
```

**Note**: This can take a while for large batches (1 network call per branch). Run in background if > 20 branches.

---

## Phase 4: Milestone Hygiene

### 4A: Find completed milestones

```bash
# List open milestones with 0 remaining issues
gh api repos/:owner/:repo/milestones --jq '.[] | select(.state == "open" and .open_issues == 0) | "\(.number) | \(.title) | open:\(.open_issues) closed:\(.closed_issues)"'
```

### 4B: Close completed milestones (shipping-verified only)

For each milestone with 0 open issues, verify the milestone branch has been merged to staging or main before closing:

```bash
# Derive slug from milestone title (lowercase, spaces→hyphens, strip non-alphanumeric except hyphens)
SLUG=$(echo "$MILESTONE_TITLE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')

# Check if milestone branch was merged to staging or main
SHIPPED_STAGING=$(gh pr list --base staging --head "milestone/$SLUG" --state merged --json number --jq '.[0].number' 2>/dev/null)
SHIPPED_MAIN=$(gh pr list --base main --head "milestone/$SLUG" --state merged --json number --jq '.[0].number' 2>/dev/null)

if [ -n "$SHIPPED_STAGING" ] || [ -n "$SHIPPED_MAIN" ]; then
  # Safe to close — code has been shipped to staging or main
  gh api repos/:owner/:repo/milestones/$MILESTONE_NUMBER -X PATCH -f state=closed
  echo "CLOSED milestone: $MILESTONE_TITLE (shipped via PR #${SHIPPED_STAGING:-$SHIPPED_MAIN})"
else
  # DO NOT close — code is only on the milestone branch, not yet shipped
  echo "SKIPPED: $MILESTONE_TITLE — issues done but milestone branch not merged to staging or main"
fi
```

**Exception**: Don't close milestones that are intentionally kept open for future work (check if the milestone description says "ongoing" or "rolling"). If unsure, **SKIP it** — milestones are only closed by `/milestone ship` after code reaches staging. Incorrect closure destroys milestone state that cannot be trivially recovered.

---

## Phase 5: Sync Project Board (if `board` or `all`)

For closed issues that are on the Project board but have stale fields:

```bash
gh project item-list 1 --owner RapierCraft --format json --limit 200
```

For each item where `content.state == "CLOSED"` but `status != "Done"` or `workflow` is not a terminal state:

```bash
gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" \
  --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF6E --single-select-option-id 98236657 2>/dev/null || true  # Status=Done
gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" \
  --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yGAA --single-select-option-id b510c537 2>/dev/null || true  # Workflow=Merged
```

---

## Phase 6: Report

```
## Cleanup Report

### Labels Fixed
| Action | Count |
|--------|-------|
| workflow:in-review → workflow:merged | {N} |
| workflow:building → workflow:merged | {N} |
| workflow:investigating → cleaned | {N} |
| needs-validation removed | {N} |

### Orphaned Issues Closed
| Issue | Merged PR | Action |
|-------|-----------|--------|
| #{N} | PR #{M} | Closed |

### Worktrees & Branches Pruned
| Type | Count |
|------|-------|
| Worktrees removed | {N} |
| Local branches deleted | {N} |
| Remote branches deleted | {N} |

### Milestones Closed
| Milestone | Issues (closed) | Shipped via |
|-----------|-----------------|-------------|
| {title} | {N} | PR #{M} → staging/main |

### Milestones Skipped (unshipped)
| Milestone | Issues (closed) | Reason |
|-----------|-----------------|--------|
| {title} | {N} | No merged PR from milestone/{slug} → staging or main |

### Board Synced
| Action | Count |
|--------|-------|
| Status → Done | {N} |
| Workflow → Merged | {N} |

### Still Missing Workflow Label
{N} closed issues have no workflow label (closed outside pipeline — no action needed)
```
