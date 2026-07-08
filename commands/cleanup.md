---
description: Sweep closed issues for stale labels, missing workflow state, and Project board gaps — plus prune worktrees, branches, and milestones
argument-hint: [labels | branches | milestones | board | orphans | all]
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /cleanup — Full Hygiene Sweep

**Input**: $ARGUMENTS

Scan the entire development environment for rot and fix it. This is a maintenance command — run periodically or after large orchestration batches. It covers 6 domains: stale labels, orphaned issues, worktree/branch pruning, milestone hygiene, and Project board sync.

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

---

## Config Resolution

Read `forge.yaml` at the project root to resolve all project-specific variables before running any commands:

```bash
# Parse forge.yaml for project context
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE")
PROJECT_BOARD_OWNER=$(yq '.project_board.owner // .project.owner' "$CONFIG_FILE")
PROJECT_NUMBER=$(yq '.project_board.project_number // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
PROJECT_ID=$(yq '.project_board.project_id // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
# Project board field and option IDs — empty string when project_board section is absent
STATUS_FIELD_ID=$(yq '.project_board.field_ids.status // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
WORKFLOW_FIELD_ID=$(yq '.project_board.field_ids.workflow // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
STATUS_DONE_OPTION_ID=$(yq '.project_board.option_ids.status.done // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
WORKFLOW_MERGED_OPTION_ID=$(yq '.project_board.option_ids.workflow.merged // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
```

All `{GH_REPO}`, `{GH_FLAG}`, `{REPO_PATH}`, `{STAGING_BRANCH}`, `{PROJECT_BOARD_OWNER}`, `{PROJECT_NUMBER}`, `{PROJECT_ID}`, `{STATUS_FIELD_ID}`, `{WORKFLOW_FIELD_ID}`, `{STATUS_DONE_OPTION_ID}`, and `{WORKFLOW_MERGED_OPTION_ID}` references below are populated from `forge.yaml`.

---

## Command Router

| Input | Action |
|-------|--------|
| `labels` or empty | Fix stale/missing workflow labels on closed issues; detect OPEN issues stuck in intermediate states (Phase 1D) |
| `orphans` | Close open issues whose PRs are already merged |
| `branches` | Prune worktrees and remote branches for merged PRs |
| `milestones` | Report milestones with 0 open issues (advisory — never closes) |
| `board` | Sync closed issues to Project board with correct terminal state |
| `batch-p3` | Sweep: fold stale unbatched P3 review findings into domain-grouped batch issues |
| `all` | All of the above, in order |

---

## Phase 1: Stale Labels

### 1A: Detect stale intermediate labels on closed issues

These labels should only exist on OPEN issues. If a closed issue has them, the pipeline crashed mid-flight.

```bash
echo "=== Stale workflow:in-review ==="
gh issue list {GH_FLAG} --state closed --label "workflow:in-review" --limit 100 --json number,title --jq '.[] | "#\(.number) — \(.title)"'

echo "=== Stale workflow:building ==="
gh issue list {GH_FLAG} --state closed --label "workflow:building" --limit 100 --json number,title --jq '.[] | "#\(.number) — \(.title)"'

echo "=== Stale workflow:investigating ==="
gh issue list {GH_FLAG} --state closed --label "workflow:investigating" --limit 100 --json number,title --jq '.[] | "#\(.number) — \(.title)"'

echo "=== Stale needs-validation ==="
gh issue list {GH_FLAG} --state closed --label "needs-validation" --limit 100 --json number,title --jq '.[] | "#\(.number) — \(.title)"'
```

### 1B: Fix stale labels

For each closed issue with a stale intermediate label:

**Stale `workflow:in-review`, `workflow:building`** — these were merged but label wasn't updated:
```bash
for NUM in {stale_issue_numbers}; do
  gh issue edit $NUM {GH_FLAG} --add-label "workflow:merged"
  gh issue edit $NUM {GH_FLAG} --remove-label "workflow:in-review,workflow:building,needs-validation" 2>/dev/null || true
done
```

**Stale `workflow:investigating`** — check if closed as invalid or completed:
- If it has `workflow:invalid` already → just remove `workflow:investigating`
- If closed normally → add `workflow:merged`, remove `workflow:investigating`

**Stale `needs-validation`** — backfill from FORGE:INVESTIGATOR verdict where available; strip-only for issues with no verdict comment: <!-- Added: forge#1730 -->

This is the H1 backfill sweep from the Design Decision (#1730). For each closed finding-issue with `needs-validation`:
1. Fetch any `FORGE:INVESTIGATOR` comment on the issue
2. Extract the `**Verdict**: ...` line
3. `CONFIRMED` → apply `validated` + remove `needs-validation`
4. `NOT-CONFIRMED` / `INVALID` / `PARTIAL` → apply `false-positive` + remove `needs-validation`
5. No verdict comment (or unrecognized verdict) → strip `needs-validation` only (no label added — do not guess)

**H4 is forbidden**: Do NOT use file-overlap heuristics (whether a fix-PR touched the cited file) to infer validated/false-positive. H4 has ~10% error rate and poisons the corpus. If there is no FORGE:INVESTIGATOR comment, the issue goes to strip-only.

```bash
BACKFILL_VALIDATED=0
BACKFILL_FALSE_POSITIVE=0
BACKFILL_STRIP_ONLY=0

for NUM in {needs_validation_numbers}; do
  # Fetch FORGE:INVESTIGATOR comment if any
  INVESTIGATOR_COMMENT=$(gh api repos/{GH_REPO}/issues/$NUM/comments \
    --jq '[.[] | select(.body | contains("FORGE:INVESTIGATOR"))] | last | .body // ""' 2>/dev/null || echo "")

  if [ -n "$INVESTIGATOR_COMMENT" ]; then
    # Extract verdict — matches "**Verdict**: CONFIRMED" etc.
    VERDICT=$(echo "$INVESTIGATOR_COMMENT" | grep -oE '\*\*Verdict\*\*: [A-Za-z0-9_][A-Za-z0-9_-]*' | sed 's/^\*\*Verdict\*\*: //' | head -1)

    case "$VERDICT" in
      CONFIRMED)
        gh issue edit $NUM {GH_FLAG} --add-label "validated" --remove-label "needs-validation" 2>/dev/null || true
        echo "#$NUM: needs-validation → validated (verdict: CONFIRMED)"
        BACKFILL_VALIDATED=$((BACKFILL_VALIDATED + 1))
        ;;
      NOT-CONFIRMED|INVALID|PARTIAL)
        gh issue edit $NUM {GH_FLAG} --add-label "false-positive" --remove-label "needs-validation" 2>/dev/null || true
        echo "#$NUM: needs-validation → false-positive (verdict: $VERDICT)"
        BACKFILL_FALSE_POSITIVE=$((BACKFILL_FALSE_POSITIVE + 1))
        ;;
      *)
        # Unrecognized or empty verdict — strip-only (no guessing)
        gh issue edit $NUM {GH_FLAG} --remove-label "needs-validation" 2>/dev/null || true
        echo "#$NUM: needs-validation stripped (no recognized verdict in INVESTIGATOR comment)"
        BACKFILL_STRIP_ONLY=$((BACKFILL_STRIP_ONLY + 1))
        ;;
    esac
  else
    # No INVESTIGATOR comment — strip-only
    gh issue edit $NUM {GH_FLAG} --remove-label "needs-validation" 2>/dev/null || true
    echo "#$NUM: needs-validation stripped (no FORGE:INVESTIGATOR comment found)"
    BACKFILL_STRIP_ONLY=$((BACKFILL_STRIP_ONLY + 1))
  fi
done

echo "Backfill complete: validated=$BACKFILL_VALIDATED false-positive=$BACKFILL_FALSE_POSITIVE strip-only=$BACKFILL_STRIP_ONLY"
```

### 1C: Report closed issues with NO workflow label

```bash
gh issue list {GH_FLAG} --state closed --limit 200 --json number,title,labels \
  --jq '.[] | select([.labels[].name] | any(startswith("workflow:")) | not) | "#\(.number) — \(.title)"'
```

These were closed outside the pipeline. Report count but don't fix (not necessarily wrong).

### 1D: Detect stale OPEN issues in intermediate workflow states

Open issues stuck in `workflow:building`, `workflow:in-review`, or `workflow:investigating` beyond a configurable threshold indicate a stalled agent. These are invisible to Phase 1A–1C (which only query closed issues).

```bash
# Configurable threshold — override by setting STALE_THRESHOLD_HOURS before invoking /cleanup
STALE_THRESHOLD_HOURS=${STALE_THRESHOLD_HOURS:-48}

# Compute cutoff datetime — GNU date (Linux) with BSD date (macOS) fallback
CUTOFF=$(date -d "${STALE_THRESHOLD_HOURS} hours ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -v-${STALE_THRESHOLD_HOURS}H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || echo "")

echo "=== Stale-Open Intermediate Issues (threshold: ${STALE_THRESHOLD_HOURS}h) ==="

STALE_OPEN_COUNT=0

for LABEL in "workflow:building" "workflow:in-review" "workflow:investigating"; do
  ISSUES=$(gh issue list {GH_FLAG} \
    --state open \
    --label "$LABEL" \
    --limit 100 \
    --json number,title,updatedAt,labels \
    --jq --arg threshold "$CUTOFF" --arg label "$LABEL" \
    '[.[] | select($threshold == "" or .updatedAt < $threshold)] |
     .[] | "#\(.number) — \(.title[:60]) [label: \($label)] [last update: \(.updatedAt[:10])] → resume: /work-on \(.number)"' \
    2>/dev/null || echo "")

  if [ -n "$ISSUES" ]; then
    echo "$ISSUES"
    COUNT=$(echo "$ISSUES" | grep -c '^#' 2>/dev/null || echo 0)
    STALE_OPEN_COUNT=$((STALE_OPEN_COUNT + COUNT))
  fi
done

echo "Total stale-open intermediate issues: $STALE_OPEN_COUNT"
```

These are **report-only** — no automatic action is taken. Use `/work-on <n>` (idempotent) to resume a stalled issue. Priority issues (P1/P2) should be actioned first.

---

## Phase 2: Orphaned Issues (open issues with merged PRs)

Find open issues whose fix PRs have already been merged — these slipped through because `Closes #N` doesn't auto-close when merging to `staging` (only works for default branch `main`).

### 2A: Detect orphans

For each open issue with `workflow:in-review` label, check if it has a merged PR:

```bash
# Get all open issues with workflow:in-review
OPEN_IN_REVIEW=$(gh issue list {GH_FLAG} --state open --label "workflow:in-review" --limit 100 --json number --jq '.[].number')

for NUM in $OPEN_IN_REVIEW; do
  # Search for merged PRs that reference this issue
  MERGED_PR=$(gh pr list {GH_FLAG} --search "Closes #$NUM" --state merged --json number --jq '.[0].number' 2>/dev/null)
  if [ -n "$MERGED_PR" ]; then
    echo "ORPHAN: #$NUM has merged PR #$MERGED_PR"
  fi
done
```

### 2B: Close orphans

For each orphaned issue found:
```bash
gh issue close $NUM {GH_FLAG} --comment "Closed by cleanup — PR #$MERGED_PR was already merged."
gh issue edit $NUM {GH_FLAG} --add-label "workflow:merged"
gh issue edit $NUM {GH_FLAG} --remove-label "workflow:in-review" 2>/dev/null || true
```

Also check open issues with `workflow:building` — same pattern (search for merged PRs referencing them).

---

## Phase 3: Worktree & Branch Pruning

### 3A: Identify worktrees with merged PRs

```bash
cd {REPO_PATH}

# For each worktree (excluding the main one), check if its branch has a merged PR
REPO_NAME=$(basename "{REPO_PATH}")
git worktree list --porcelain | grep "^worktree " | grep -v "/$REPO_NAME$" | sed 's/^worktree //' | while read wt; do
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

Delete remote `fix/` and `feat/` branches whose PR has merged — using **GitHub PR state as the source of truth**, not local git ancestry.

**Why not `git branch -r --merged {STAGING_BRANCH}`**: an ancestry check only catches branches whose tip commit is reachable from `{STAGING_BRANCH}`. This misses two common cases:
- **Feature-lane branches merged into a milestone branch.** Per `work-on.md` Phase 3E, milestone issues branch from and PR into `origin/milestone/{slug}`, not `{STAGING_BRANCH}`. Once such a branch's own PR merges into the milestone branch, it's fully absorbed and safe to delete — but it won't show up as "merged into staging" until the milestone itself ships (which may be days later, or never, if abandoned). This is the dominant cause of `feat/*` branches accumulating for a milestone/feature cluster.
- **Squash merges.** If a branch was merged via squash (manual UI merge, or org/branch-protection settings that force squash-only), the resulting commit is a brand-new SHA that is never an ancestor of the original branch — so ancestry-based detection never matches it, even though the PR is clearly `MERGED` on GitHub.

Both gaps disappear when merged-PR head-refs (regardless of base branch or merge strategy) are used directly as the deletion set:

**Why also check `headRefOid`**: branch names are freely reusable in git. A name-only match cannot distinguish "this branch's current tip is the commit that merged" from "a branch with this name merged at some point in the past and has since been reused for new, unmerged work" (e.g. a second issue happens to slugify to the same `fix/*`/`feat/*` name). Comparing the branch's live remote tip SHA against the merged PR's `headRefOid` closes that gap — deletion only proceeds when the (name, SHA) pair matches a merged PR exactly, regardless of base branch or merge strategy.

**Why `--force-with-lease` on the delete**: the `CURRENT_SHA` snapshot above is read from the local `origin/$branch` ref as of the `git fetch --prune` at the top of this phase. For large batches this loop can run for a while (one network call per branch), so a new commit can land on the remote branch between the fetch and that branch's turn in the loop — a TOCTOU window. A plain `git push origin --delete "$branch"` is unconditional: it deletes whatever the remote ref currently points to, even if that's no longer `$CURRENT_SHA`. Using `--force-with-lease=refs/heads/$branch:$CURRENT_SHA` makes the deletion a server-verified compare-and-swap — the remote rejects the update if `refs/heads/$branch` has moved since the snapshot, instead of silently deleting new work.

```bash
cd {REPO_PATH}
git fetch --prune origin

# All remote fix/* and feat/* branches currently on origin
REMOTE_BRANCHES=$(git branch -r | grep -E "origin/(fix|feat)/" | sed 's|origin/||' | tr -d ' ')

# Head-ref name + head-ref SHA of every merged PR, regardless of base branch (staging,
# milestone/*, main) or merge strategy (merge-commit vs. squash) — this is GitHub's own
# merge bookkeeping, not local ref topology, so it's immune to both gaps above.
# headRefOid is captured alongside headRefName so deletion can be gated on the branch's
# CURRENT tip matching the commit that actually merged, not just a name match.
# --limit is set high to avoid silent truncation; repos with more historical merged PRs
# than this should re-run `/cleanup branches` incrementally to catch the remainder.
MERGED_HEADS=$(gh pr list {GH_FLAG} --state merged --limit 1000 --json headRefName,headRefOid --jq '.[] | "\(.headRefName)\t\(.headRefOid)"')

DELETE_COUNT=0
SKIP_COUNT=0
RACE_SKIP_COUNT=0
for branch in $REMOTE_BRANCHES; do
  CURRENT_SHA=$(git rev-parse "origin/$branch" 2>/dev/null)
  if printf '%s\n' "$MERGED_HEADS" | grep -qxF "$(printf '%s\t%s' "$branch" "$CURRENT_SHA")"; then
    # Name AND tip SHA match a merged PR's head-ref — safe to delete.
    # Use --force-with-lease as a server-side compare-and-swap: the remote re-verifies
    # refs/heads/$branch is still at $CURRENT_SHA at push time, closing the TOCTOU gap
    # between this snapshot and the actual delete (see note above).
    if git push origin --force-with-lease="refs/heads/$branch:$CURRENT_SHA" ":refs/heads/$branch" 2>&1; then
      DELETE_COUNT=$((DELETE_COUNT + 1))
      # Log the pre-deletion SHA so it's visible in run output/logs for recovery —
      # see "Recovery: restoring an accidentally pruned branch" below.
      echo "Deleted origin/$branch (was $CURRENT_SHA) — restorable via: git push origin $CURRENT_SHA:refs/heads/$branch"
    else
      # Lease rejected — the branch's remote tip moved since the snapshot (a new push
      # landed mid-loop). Do NOT retry/force past this: skip and let the next cleanup
      # run re-evaluate it against fresh state.
      RACE_SKIP_COUNT=$((RACE_SKIP_COUNT + 1))
      echo "RACE: origin/$branch tip changed since snapshot ($CURRENT_SHA) — lease rejected, not deleting. Will re-evaluate on next /cleanup run."
    fi
  elif printf '%s\n' "$MERGED_HEADS" | cut -f1 | grep -qxF "$branch"; then
    # Name matches a merged PR's head-ref, but the branch's current tip does not match
    # any merged commit recorded under that name — likely a reused branch name holding
    # new, unmerged work. Skip deletion rather than risk destroying live commits.
    SKIP_COUNT=$((SKIP_COUNT + 1))
    echo "SKIP: origin/$branch name matches a merged PR head-ref but current tip ($CURRENT_SHA) does not match the merged commit — branch name likely reused for new work. Not deleting."
  fi
done
echo "Deleted $DELETE_COUNT merged remote branches, skipped $SKIP_COUNT name-matched/SHA-mismatched branches, skipped $RACE_SKIP_COUNT raced branches (tip changed between snapshot and delete) (source of truth: gh pr list --state merged, verified against headRefOid, deletion gated by --force-with-lease)"
```

**Note**: This can take a while for large batches (1 network call per deleted branch, plus one batched `gh pr list` call). Run in background if > 20 branches.

**One-time backfill for existing stale branches**: repos that adopted this fix after already accumulating stale `feat/*`/`fix/*` branches (e.g. from milestones that shipped long ago) should run `/cleanup branches` once manually — the PR-state query above will catch the full backlog in a single pass since it isn't scoped to "this batch" or "this session," it queries all merged PRs on the repo.

**Recovery: restoring an accidentally pruned branch**

Phase 3C only ever deletes a branch whose (name, SHA) pair matched a merged PR's `headRefOid`, so the exact deleted commit is always recoverable: its SHA is echoed in the run log above (`Deleted origin/$branch (was $CURRENT_SHA) ...`), and the commit object survives in the remote's object store until garbage collection (for merge-commit merges it also remains reachable from the PR's merge commit; for squash merges the original tip becomes a dangling commit — not reachable by ancestry, but still restorable by SHA for as long as it hasn't been GC'd). If a branch is pruned in error (or needs to be recreated for any reason), restore it with:

```bash
# Using the SHA logged at deletion time (or from `gh pr view {PR_NUMBER} --json headRefOid`
# if the run log is no longer available):
git push origin <sha>:refs/heads/<branch>
```

Alternatively, GitHub itself offers a one-click **"Restore branch"** button on the merged PR's page (shown on the "<branch> was deleted" banner) for a limited window after deletion — typically available for as long as the underlying ref data hasn't been garbage-collected, often a few weeks. This is the fastest option when working from the GitHub UI rather than a local clone.

Both options only apply to branches deleted by this phase (or by GitHub's own merge/delete UI) — a SHA is not captured for branches removed by other means (e.g. manual `git push origin --delete` run outside of `/cleanup`), so recovery there depends on `git reflog` on a clone that still has the ref, or GitHub's audit log.

---

## Phase 4: Milestone Hygiene (Advisory Only)

**NEVER close milestones in this phase.** Milestones are only closed by `/milestone ship` (human-gated) or `/milestone close` (explicit abandonment). Incorrect closure destroys milestone state that cannot be trivially recovered. <!-- fix: forge#1160 -->

### 4A: Find milestones with 0 open issues

```bash
# List open milestones with 0 remaining issues
gh api repos/:owner/:repo/milestones --jq '.[] | select(.state == "open" and .open_issues == 0) | "\(.number) | \(.title) | open:\(.open_issues) closed:\(.closed_issues)"'
```

### 4B: Report findings (DO NOT close)

For each milestone with 0 open issues, report it as a candidate for shipping or closing — but take no action:

```bash
echo "ADVISORY: $MILESTONE_TITLE — 0 open issues, $CLOSED_ISSUES closed"
echo "  → To ship: /milestone ship $SLUG"
echo "  → To abandon: /milestone close $SLUG"
```

Do NOT call `gh api ... -X PATCH -f state=closed` on any milestone. This phase is informational only.

---

## Phase 4B: P3 Batch Sweep (if `batch-p3` or `all`)

<!-- Added: forge#1333 -->

**Purpose**: Fold stale unbatched P3 review findings into domain-grouped batch issues. Reduces pipeline overhead from individual per-finding full-pipeline runs.

**Skip if**: Input is not `batch-p3` and not `all`.

### Step 4B.1: Fetch open batchable P3 findings

```bash
# Find all open P3 review findings that carry the FORGE:BATCHABLE annotation
# and are not already members of a batch (no "batch" label)
UNBATCHED_P3=$(gh issue list {GH_FLAG} \
  --state open \
  --label "review-finding,priority:P3" \
  --limit 500 \
  --json number,title,body,labels,createdAt \
  --jq '.[] | select(.body | test("<!-- FORGE:BATCHABLE -->"))
         | select(([.labels[].name] | any(. == "batch")) | not)
         | select(([.labels[].name] | any(. == "security" or . == "billing")) | not)
         | select((.title | test("security|billing|payment|stripe"; "i")) | not)')

echo "Unbatched batchable P3 findings: $(echo "$UNBATCHED_P3" | jq -s 'length')"
```

### Step 4B.2: Group by domain

For each finding, extract the domain from the first affected file path under `## Affected Files`:

```bash
# Domain = top-level directory of the first affected file
# e.g., "services/api/auth/login.py" → "services/api/auth"
#        "commands/review-pr.md"     → "commands"
# Exclude findings where the domain contains "billing" or "security"

# Group findings by domain, track oldest creation timestamp per group
declare -A DOMAIN_ISSUES
declare -A DOMAIN_OLDEST

echo "$UNBATCHED_P3" | jq -c '.[]' | while read -r issue; do
  NUM=$(echo "$issue" | jq -r '.number')
  CREATED=$(echo "$issue" | jq -r '.createdAt')
  BODY=$(echo "$issue" | jq -r '.body')

  # Extract first affected file path from body
  FIRST_FILE=$(echo "$BODY" | sed -n '/^## Affected Files/,/^## /p' | grep -oP '`[^`]+`' | head -1 | tr -d '`')
  if [ -z "$FIRST_FILE" ]; then
    FIRST_FILE=$(echo "$BODY" | grep -oP '(?<=\`)[^`]+\.(?:py|ts|tsx|js|go|rs|java|sh|md)(?=\`)' | head -1 || echo "unknown")
  fi
  DOMAIN=$(echo "$FIRST_FILE" | cut -d/ -f1,2,3 | sed 's|/[^/]*$||')
  [ -z "$DOMAIN" ] && DOMAIN="general"

  echo "${NUM}:${DOMAIN}:${CREATED}"
done
```

### Step 4B.3: Apply batching threshold

For each domain group:
- **Trigger**: 5+ unbatched batchable P3 findings in the domain, **OR** the oldest finding in the domain is > 72 hours old
- **No trigger**: fewer than 5 findings AND none older than 72 hours → skip (no batch created)

```bash
NOW_EPOCH=$(date +%s)
HOURS_72=$((72 * 3600))

# For each domain group that meets the threshold, create a batch issue
# (max 10 members per batch — if more, create multiple batches of ≤ 10 each)

# Exclude domains with "security" or "billing" in the domain path
echo "$DOMAIN_ISSUES" | while IFS=: read -r domain issue_list; do
  echo "$domain" | grep -qiE 'security|billing' && continue

  COUNT=$(echo "$issue_list" | tr ',' '\n' | wc -l)
  OLDEST_EPOCH=$(echo "$DOMAIN_OLDEST[$domain]" | date -d "$..." +%s 2>/dev/null || echo "$NOW_EPOCH")
  AGE_SECS=$((NOW_EPOCH - OLDEST_EPOCH))

  if [ "$COUNT" -ge 5 ] || [ "$AGE_SECS" -ge "$HOURS_72" ]; then
    echo "Batching $COUNT P3 findings in domain: ${domain}"
    # Create batch issues (in chunks of ≤ 10)
    # See orchestrate.md Phase 1 for the batch creation template
  fi
done
```

**Batch creation** uses the same template as `orchestrate.md Phase 1 → P3 Review-Finding Batching`. After creating the batch issue, add the `batch` label to each member issue to prevent re-batching on the next sweep.

### Step 4B.4: Report

```
## P3 Batch Sweep

| Domain | Unbatched P3s | Threshold Met | Action |
|--------|--------------|---------------|--------|
| {domain} | {N} | ≥5 issues | Created batch #{NUM} ({M} members) |
| {domain} | {N} | Oldest > 72h | Created batch #{NUM} ({M} members) |
| {domain} | {N} | Below threshold | No action |

Total batch issues created: {N}
Total P3 findings batched: {N}
```

---

## Phase 5: Sync Project Board (if `board` or `all`)

**Skip if `project_board` is not configured** — check resolved vars before proceeding:

```bash
if [ -z "$PROJECT_BOARD_OWNER" ] || [ -z "$PROJECT_ID" ] || [ -z "$PROJECT_NUMBER" ]; then
  echo "INFO: project_board not configured in forge.yaml — skipping board sync"
else
  # Board sync: mark closed issues as Done/Merged on the project board

  # List all board items
  ITEMS=$(gh project item-list "$PROJECT_NUMBER" --owner "$PROJECT_BOARD_OWNER" --format json --limit 200)

  # For each item where content.state == "CLOSED" but status != "Done" or workflow is not terminal:
  echo "$ITEMS" | jq -r '.items[] | select(.content.state == "CLOSED") | .id' | while read -r ITEM_ID; do
    if [ -n "$STATUS_FIELD_ID" ] && [ -n "$STATUS_DONE_OPTION_ID" ]; then
      gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
        --field-id "$STATUS_FIELD_ID" --single-select-option-id "$STATUS_DONE_OPTION_ID" 2>/dev/null || true  # Status=Done
    fi
    if [ -n "$WORKFLOW_FIELD_ID" ] && [ -n "$WORKFLOW_MERGED_OPTION_ID" ]; then
      gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
        --field-id "$WORKFLOW_FIELD_ID" --single-select-option-id "$WORKFLOW_MERGED_OPTION_ID" 2>/dev/null || true  # Workflow=Merged
    fi
  done
fi
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
| needs-validation → validated (backfill H1) | {N} |
| needs-validation → false-positive (backfill H1) | {N} |
| needs-validation stripped (no verdict) | {N} |

### Stale-Open Intermediate Issues (Phase 1D)
| Issue | Label | Last Update | Action |
|-------|-------|-------------|--------|
| #{N} | workflow:X | YYYY-MM-DD | `/work-on {N}` to resume |

*Total stale-open: {N} (threshold: {STALE_THRESHOLD_HOURS}h)*

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

### Milestones Ready to Ship (advisory — no action taken)
| Milestone | Issues (closed) | Recommended Action |
|-----------|-----------------|-------------------|
| {title} | {N} | `/milestone ship {slug}` or `/milestone close {slug}` |

### Board Synced
| Action | Count |
|--------|-------|
| Status → Done | {N} |
| Workflow → Merged | {N} |

### Still Missing Workflow Label
{N} closed issues have no workflow label (closed outside pipeline — no action needed)

### P3 Batch Sweep Results
| Domain | Unbatched P3s | Action |
|--------|--------------|--------|
| {domain} | {N} | Created batch #{NUM} with {M} members |
| {domain} | {N} | Below threshold — no action (< 5 findings, none > 72h) |
```
