---
description: Create, manage, and ship milestones — the top-level planning layer for feature development
argument-hint: [create <name> | status | ship <slug> | sync <slug>]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /milestone — Milestone Lifecycle Manager

**Input**: $ARGUMENTS

Milestones are the top-level planning unit. They group related issues into a shippable feature set. Each milestone gets its own long-lived Git branch (`milestone/{slug}`) where feature PRs accumulate. When the milestone is ready, it ships to `main` as a single reviewed merge.

**Hierarchy**: Milestone → Issues → Sub-issues (optional decomposition)

**You have access to ALL tools** — Task tool, Skill tool, sub-agents, everything.

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
DEFAULT_BRANCH=$(yq '.branches.default' "$CONFIG_FILE")
PROJECT_BOARD_OWNER=$(yq '.project_board.owner // .project.owner' "$CONFIG_FILE")
PROJECT_NUMBER=$(yq '.project_board.project_number // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
PROJECT_ID=$(yq '.project_board.project_id // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
# Project board field and option IDs — empty string when project_board section is absent
STATUS_FIELD_ID=$(yq '.project_board.field_ids.status // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
LANE_FIELD_ID=$(yq '.project_board.field_ids.lane // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
COMPONENT_FIELD_ID=$(yq '.project_board.field_ids.component // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
PRIORITY_FIELD_ID=$(yq '.project_board.field_ids.priority // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
STATUS_TODO_OPTION_ID=$(yq '.project_board.option_ids.status.todo // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
LANE_FEATURE_OPTION_ID=$(yq '.project_board.option_ids.lane.feature // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
PRIORITY_OPTION_ID=""  # Resolved per-issue from the issue's priority label — see Step 6B
# Build satellite repo map from repos.satellites list
# Each satellite: { prefix, repo, staging_branch }
```

All `{GH_REPO}`, `{GH_FLAG}`, `{REPO_PATH}`, `{PROJECT_NAME}`, `{STAGING_BRANCH}`, `{DEFAULT_BRANCH}`, `{PROJECT_BOARD_OWNER}`, `{PROJECT_NUMBER}`, `{PROJECT_ID}`, `{STATUS_FIELD_ID}`, `{LANE_FIELD_ID}`, `{COMPONENT_FIELD_ID}`, `{PRIORITY_FIELD_ID}`, `{STATUS_TODO_OPTION_ID}`, and `{LANE_FEATURE_OPTION_ID}` references below are populated from `forge.yaml`.

---

## Multi-Repo Support

Milestones can span multiple repositories. Project context (repo map, paths, conventions) comes from `forge.yaml`.

### Cross-Repo Milestones

Some milestones require changes across multiple repos — the platform, SDKs, satellite services, etc. For these:

- **The milestone is created in the primary repo** (`{GH_REPO}` — the default repo from `forge.yaml`)
- **Issues are created in the repo where the code lives** — satellite repos come from `forge.yaml → repos.satellites`
- **Each repo gets its own milestone branch** (`milestone/{slug}`) if it has issues in the milestone
- **Issues reference the parent milestone** in their body: `Part of cross-repo milestone: **{TITLE}** (primary: {GH_REPO})`

### Repo Prefixes (same as `/work-on`)

Prefixes and repos are defined in `forge.yaml → repos.satellites`. Read the config to build the routing table:

| Prefix | Repo |
|--------|------|
| _(none)_ | `{GH_REPO}` (default) |
| `{SATELLITE_PREFIX}:` | `{SATELLITE_REPO}` (from `forge.yaml → repos.satellites`) |

When decomposing a milestone, tag each proposed issue with its target repo. Use `-R {SATELLITE_REPO}` flag for non-default repos.

---

## Command Router

Parse `$ARGUMENTS` to determine which action to take:

| Input Pattern | Action |
|--------------|--------|
| `create <name>` or just a descriptive phrase | → **Create Milestone** |
| `status` (no args, or "status") | → **Show All Milestones** |
| `status <slug>` | → **Show Milestone Detail** |
| `ship <slug>` | → **Ship Milestone** |
| `sync <slug>` | → **Sync Milestone Branch** |
| `close <slug>` | → **Close Milestone** |

---

## Action: Create Milestone

### Step 1: Parse the milestone scope

The user provides a name or description. Extract:
- **Title**: Short, descriptive (e.g., "LLM Extraction Platform", "API Expansion v1")
- **Slug**: Lowercase, hyphenated, max 40 chars (e.g., `llm-extraction-platform`)
- **Description**: What this milestone delivers, extracted from user's input

### Step 2: Create the GitHub milestone

```bash
gh api repos/{owner}/{repo}/milestones --method POST \
  --field title="{TITLE}" \
  --field description="{DESCRIPTION}" \
  --field state="open"
```

Capture the milestone number from the response.

### Step 3: Create the milestone branch

```bash
cd {REPO_PATH}
git fetch origin $DEFAULT_BRANCH
git branch milestone/{slug} origin/$DEFAULT_BRANCH
git push origin milestone/{slug}
```

### Step 4: Scope decomposition

**Investigation-gated decomposition** — do NOT skip code reads. The single-pass shallow-planning approach (one agent, whole milestone, no per-issue code reads) produces under-specified issues that ship incomplete. This step mandates per-proposed-issue investigation before any issue body is written. See `work-on/decompose.md` Phase D0 for the reference pattern that enforces this gate. <!-- Added: forge#293 -->

**4A: First pass — enumerate proposed issues (no code reads yet)**

Analyze the milestone description and produce a preliminary list of proposed issues. At this stage, only the title, type, and rough dependency order are needed. Do NOT write issue bodies yet.

**4B: Per-issue investigation (MANDATORY before writing any issue body)**

For each proposed issue in the preliminary list, MUST read the actual code before writing the issue body:

1. **Identify affected files**: Read the files the issue will touch. Start with the files named in the milestone description, then expand to callers and related modules.
2. **Enumerate all call sites**: For coverage/refactor tasks, grep for every occurrence of the pattern being changed. Do NOT estimate — enumerate. Example: `grep -rn 'poetry run\|npx ' commands/ --include='*.md' | wc -l` to count call sites before writing a "make X config-driven" issue.
3. **Write exhaustive acceptance criteria**: For coverage/refactor tasks, acceptance criteria MUST be falsifiable. A `grep`/absence assertion qualifies (e.g., `` `grep -rn 'hardcoded_value' commands/` returns no matches ``). The number of criteria must match the scope — there is no cap. Two criteria for a 14-call-site refactor is not acceptable.
4. **Identify override/companion files**: If a file needs a change, its companion files (config overrides, prod variants, sibling modules) almost certainly do too. List all of them.

**4C: Output format — per-issue, after code read**

For each proposed issue, after completing the per-issue investigation in Step 4B:

- **Title**: Actionable, specific (conventional commit prefix: `fix:`, `feat:`, `refactor:`)
- **Repo**: Which repo this issue belongs to (default or satellite prefix from forge.yaml)
- **Type**: `feature`, `bug`, `refactor`, `infra`
- **Priority**: P1-P3
- **Size**: S (1-2 files), M (3-5 files), L (6+ files)
- **Dependencies**: Which other issues must be done first (by number)
- **Affected files**: Full list of files enumerated during the Step 4B code read (not estimated)
- **Acceptance criteria**: Exhaustive and falsifiable. For coverage/refactor tasks: one criterion per affected call site or pattern, written as a grep/absence assertion. No cap on criteria count — the list must be complete enough that a reviewer can verify coverage without reading the implementation.

**Project ecosystem context** (from `forge.yaml`):
- **Primary repo** (`{GH_REPO}`): The main project codebase at `{REPO_PATH}`
- **Tech stack**: {review.tech_stack from forge.yaml, or read CLAUDE.md for project context}
- **Satellite repos**: Read from `forge.yaml → repos.satellites` (each has a prefix and repo)

### Step 5: Review with user

Present the proposed issues to the user. Ask:
- "Does this scope look right? Should I add/remove/modify any issues?"
- Wait for confirmation before creating.

### Step 6: Create issues and assign to milestone

**Issue body standard**: Use the **Pipeline Issue Template** from `issue.md` Phase 3D as the body structure for every issue created here. Do NOT use a bespoke inline template — the Pipeline Issue Template is the single canonical standard for all automated issue creation across the pipeline. The body content (Problem, Root Cause, Affected Files, Acceptance Criteria, Context, Dependencies) comes from the per-issue investigation in Step 4B. <!-- Added: forge#293 -->

For each approved issue, create it in the **correct repo** based on the scope analysis:

```bash
# For default repo issues:
# Body content derives from the Step 4B per-issue investigation.
# Structure MUST match the Pipeline Issue Template in issue.md Phase 3D.
gh issue create {GH_FLAG} \
  --title "{fix|feat|refactor}: {issue_title}" \
  --label "{type},{priority}" \
  --milestone "{TITLE}" \
  --body "$(cat <<'BODY_EOF'
## Problem

{1-3 sentences: what needs to be built or fixed for this milestone. Specific — derived from Step 4B code read, not milestone description alone.}

## Root Cause (if known)

{Why this needs to change — architecture gap, missing feature, technical debt. Reference specific file:line where possible. If a new feature: "New capability required for {MILESTONE_TITLE}."}

## Affected Files

Files that need changes (full list from Step 4B code read — ordered by dependency):
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

{Exhaustive and falsifiable. For coverage/refactor tasks: one criterion per affected call site or pattern, written as a grep/absence assertion. No cap — list must be complete.}
- [ ] {Specific, testable criterion}
- [ ] {Specific, testable criterion}
- [ ] No regression in {related feature}

## Context

Part of milestone: **{MILESTONE_TITLE}**
**Type**: {feature|bug|refactor|infra}

## Dependencies

{Either "None" or "Depends on #{ISSUE_NUMBER} — {reason}"}
BODY_EOF
)"

# For satellite repo issues (MCP, n8n) — create in the satellite repo:
# Note: GitHub milestones are per-repo, so satellite issues reference the milestone by name only
# Body structure MUST match the Pipeline Issue Template in issue.md Phase 3D.
gh issue create -R {SATELLITE_REPO} \
  --title "{fix|feat|refactor}: {issue_title}" \
  --label "{type},{priority}" \
  --body "$(cat <<'BODY_EOF'
## Problem

{1-3 sentences: what needs to be built or fixed in this satellite repo for the milestone.}

## Root Cause (if known)

{Why this needs to change. Reference specific file:line where possible. If a new feature: "New capability required for {MILESTONE_TITLE}."}

## Affected Files

Files that need changes (full list from Step 4B code read):
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

{Exhaustive and falsifiable. No cap — coverage/refactor tasks require one criterion per affected call site.}
- [ ] {Specific, testable criterion}
- [ ] {Specific, testable criterion}

## Context

Part of cross-repo milestone: **{MILESTONE_TITLE}** (primary: {GH_REPO})
**Type**: {feature|bug|refactor|infra}

## Dependencies

{Either "None" or "Depends on #{ISSUE_NUMBER} — {reason}"}
BODY_EOF
)"
```

### Step 6B: Add issues to Project board

**Skip if `project_board` is not configured** — check resolved vars before proceeding:

```bash
if [ -z "$PROJECT_BOARD_OWNER" ] || [ -z "$PROJECT_ID" ] || [ -z "$PROJECT_NUMBER" ]; then
  echo "INFO: project_board not configured in forge.yaml — skipping board sync for created issues"
else
  # Resolve component option ID for this repo from forge.yaml → project_board.components
  COMPONENT_OPTION_ID=$(yq '.project_board.components[] | select(.repo == "'"$GH_REPO"'") | .option_id' "$CONFIG_FILE" 2>/dev/null || echo "")

  for ISSUE_NUM in {created_issue_numbers}; do
    ISSUE_URL="https://github.com/$GH_REPO/issues/${ISSUE_NUM}"
    ITEM_ID=$(gh project item-add "$PROJECT_NUMBER" --owner "$PROJECT_BOARD_OWNER" --url "$ISSUE_URL" --format json --jq '.id' 2>/dev/null)
    if [ -n "$ITEM_ID" ]; then
      # Resolve priority option ID from the issue's priority label
      ISSUE_PRIORITY=$(gh issue view "$ISSUE_NUM" "$GH_FLAG" --json labels \
        --jq '[.labels[].name | select(startswith("priority:"))] | .[0] | ltrimstr("priority:") | ascii_downcase' 2>/dev/null || echo "")
      # Validate ISSUE_PRIORITY matches expected pattern before use as yq key path <!-- Added: forge#300 -->
      PRIORITY_OPTION_ID=""
      if [[ "$ISSUE_PRIORITY" =~ ^p[0-3]$ ]]; then
        PRIORITY_OPTION_ID=$(yq '.project_board.option_ids.priority.'"$ISSUE_PRIORITY"' // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
      fi

      if [ -n "$STATUS_FIELD_ID" ] && [ -n "$STATUS_TODO_OPTION_ID" ]; then
        gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
          --field-id "$STATUS_FIELD_ID" --single-select-option-id "$STATUS_TODO_OPTION_ID" 2>/dev/null || true  # Status=Todo
      fi
      if [ -n "$LANE_FIELD_ID" ] && [ -n "$LANE_FEATURE_OPTION_ID" ]; then
        gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
          --field-id "$LANE_FIELD_ID" --single-select-option-id "$LANE_FEATURE_OPTION_ID" 2>/dev/null || true  # Lane=Feature
      fi
      if [ -n "$COMPONENT_FIELD_ID" ] && [ -n "$COMPONENT_OPTION_ID" ]; then
        gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
          --field-id "$COMPONENT_FIELD_ID" --single-select-option-id "$COMPONENT_OPTION_ID" 2>/dev/null || true  # Component (from forge.yaml → project_board.components)
      fi
      if [ -n "$PRIORITY_FIELD_ID" ] && [ -n "$PRIORITY_OPTION_ID" ]; then
        gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" \
          --field-id "$PRIORITY_FIELD_ID" --single-select-option-id "$PRIORITY_OPTION_ID" 2>/dev/null || true  # Priority (from issue label)
      fi
    fi
  done
fi
```

### Step 7: Report

```
## Created: Milestone "{TITLE}"

Branch: `milestone/{slug}`
Issues: {count} created

| # | Issue | Type | Priority | Size | Depends On |
|---|-------|------|----------|------|------------|
| 1 | #{N} — {title} | {type} | {P} | {S/M/L} | — |
| 2 | #{N} — {title} | {type} | {P} | {S/M/L} | #{dep} |
...

**Next**: Run `/work-on next` to start on the first issue, or `/work-on #{N}` for a specific one.
Issues with this milestone will automatically PR to `milestone/{slug}`.
```

---

## Action: Show All Milestones (status)

```bash
# List open milestones with progress
gh api repos/{owner}/{repo}/milestones --jq '.[] | select(.state == "open") | {
  title: .title,
  number: .number,
  open_issues: .open_issues,
  closed_issues: .closed_issues,
  due_on: (.due_on // "no due date"),
  description: (.description[:100])
}'
```

Format as a table:

```
## Active Milestones

| Milestone | Progress | Open | Closed | Due |
|-----------|----------|------|--------|-----|
| LLM Extraction Platform | ████░░░░ 40% | 6 | 4 | Apr 15 |
| Scraper Quality v1 | ████████░ 85% | 2 | 11 | — |
| API Expansion | ░░░░░░░░ 0% | 3 | 0 | — |
```

---

## Action: Show Milestone Detail (status <slug>)

```bash
# Find milestone by slug (match against title, case-insensitive)
MILESTONE=$(gh api repos/{owner}/{repo}/milestones --jq '.[] | select(.title | ascii_downcase | gsub(" "; "-") | startswith("{slug}"))')

# List issues in this milestone
gh issue list --milestone "{TITLE}" --state all --json number,title,state,labels --jq '.[] | {number, title, state, labels: [.labels[].name]}'
```

Show detailed progress with per-issue status.

---

## Action: Ship Milestone

**This is the human-gated deployment step.** When the user says "ship {slug}", they've decided this feature set is ready for production.

### Step 1: Pre-flight check

```bash
# Check milestone branch exists
git fetch origin milestone/{slug}

# Check for open issues still in the milestone
OPEN_COUNT=$(gh issue list --milestone "{TITLE}" --state open --json number --jq '. | length')
```

If there are open issues, warn the user:
```
⚠ Milestone "{TITLE}" still has {OPEN_COUNT} open issues:
{list them}

Ship anyway? Open issues will remain assigned to the milestone.
```

Wait for confirmation.

### Step 2: Sync milestone branch with staging

Before shipping, ensure the milestone branch is up to date with `staging` (picks up any fast-lane fixes that accumulated since the milestone branch was created):

```bash
cd {REPO_PATH}
git fetch origin {STAGING_BRANCH} milestone/{slug}
git checkout milestone/{slug}
git merge origin/{STAGING_BRANCH} --no-edit
# If conflicts, report to user and STOP — do not auto-resolve
git push origin milestone/{slug}
git checkout {STAGING_BRANCH}
```

### Step 2.5: Pre-Merge Hunk-Loss Audit (MANDATORY before creating PR)

**WHY THIS EXISTS**: When a long-lived milestone branch is merged into staging, git hunks that exist in staging but were NOT touched by the milestone can be silently dropped. This happened in a 20h window that produced 13 regression-fix PRs (27% of total pipeline throughput) restoring lost code: postgres tuning params, completion_refund sweep, credit_ledger columns, browser flags, pool guards, Redis config, crawl TTL refresh, challenge_strategy guard. Each regression required investigation → new issue → new PR → review → merge — consuming nearly a third of pipeline capacity on damage repair instead of forward progress.

This step identifies "at-risk hunks" — staging-only content in files the milestone also modifies — and absorbs them into the milestone branch via rebase before the PR is created. After the rebase, even a squash merge will preserve all staging content because it's now part of the milestone branch's commits.

```bash
cd {REPO_PATH}
git fetch origin {STAGING_BRANCH} milestone/{slug}

echo "=== Pre-Merge Hunk-Loss Audit ==="

# Files the milestone branch changes vs the staging branch
MILESTONE_FILES=$(git diff --name-only origin/{STAGING_BRANCH}...origin/milestone/{slug})

if [ -z "$MILESTONE_FILES" ]; then
    echo "No files changed by milestone vs staging — nothing to audit. Proceeding to PR creation."
else
    # What does staging have in those files that the milestone branch doesn't carry?
    # NOTE: $MILESTONE_FILES is intentionally unquoted here — word-splitting is required to pass
    # each filename as a separate path argument to git diff. Quoting would collapse the newline-
    # separated list into a single argument matching no real path, silently producing an empty diff.
    # Filenames with spaces are not expected in standard project paths.
    AT_RISK=$(git diff origin/milestone/{slug}...origin/{STAGING_BRANCH} -- $MILESTONE_FILES 2>/dev/null)
    AT_RISK_COUNT=$(echo "$AT_RISK" | grep -c '^@@' 2>/dev/null || echo 0)

    if [ "$AT_RISK_COUNT" -eq 0 ]; then
        echo "Hunk-loss audit: CLEAN — no at-risk staging hunks in milestone-modified files."
    else
        echo "AT-RISK HUNKS: $AT_RISK_COUNT staging hunks in milestone-modified files will be lost without rebase."
        echo "Affected files:"
        echo "$AT_RISK" | grep '^--- a/' | sed 's|^--- a/||'

        echo "Rebasing milestone/{slug} onto origin/{STAGING_BRANCH} to absorb at-risk hunks..."
        git checkout milestone/{slug}
        git rebase origin/{STAGING_BRANCH}

        REBASE_EXIT=$?
        if [ "$REBASE_EXIT" -ne 0 ]; then
            # Capture conflicting files BEFORE aborting (after abort, unmerged state is gone)
            CONFLICTING_FILES=$(git diff --name-only --diff-filter=U 2>/dev/null)
            [ -z "$CONFLICTING_FILES" ] && CONFLICTING_FILES="unknown — check git status after resolving manually"

            # Abort the failed rebase and return to a clean state
            git rebase --abort 2>/dev/null || true
            git checkout {STAGING_BRANCH}

            # Truncate AT_RISK to safe size for issue body (avoid shell quoting issues with large diffs)
            AT_RISK_SNIPPET=$(echo "$AT_RISK" | head -60 | sed "s/'/'\\\\''/g")

            gh issue create {GH_FLAG} \
              --title "fix(milestone): rebase conflict during hunk-loss audit for milestone/{slug}" \
              --body "$(cat <<ISSUE_EOF
## Problem

The pre-merge hunk-loss audit for milestone \`{slug}\` detected $AT_RISK_COUNT at-risk staging hunks, then attempted to rebase \`milestone/{slug}\` onto \`origin/{STAGING_BRANCH}\` to absorb them. The rebase conflicted and was aborted. Manual resolution is required before the milestone can ship.

## Root Cause

Divergent changes between \`milestone/{slug}\` and \`origin/{STAGING_BRANCH}\` cannot be automatically rebased. Conflicting files must be resolved manually.

## Affected Files

Files with rebase conflicts:
\`\`\`
${CONFLICTING_FILES}
\`\`\`

**At-risk diff** (staging content that would be lost):
\`\`\`diff
${AT_RISK_SNIPPET}
\`\`\`

## Acceptance Criteria

- [ ] Rebase conflict in milestone/{slug} resolved manually
- [ ] \`git push origin milestone/{slug} --force-with-lease\` succeeds
- [ ] \`/milestone ship {slug}\` completes without conflict

## Context

Resolve the rebase conflict manually:
\`\`\`bash
git checkout milestone/{slug}
git rebase origin/{STAGING_BRANCH}
# resolve conflicts in the files listed above
git rebase --continue
git push origin milestone/{slug} --force-with-lease
\`\`\`
Then re-run \`/milestone ship {slug}\`.

<!-- AUTO-CREATED: hunk-loss audit rebase conflict -->
ISSUE_EOF
)" \
              --label "bug" --label "priority:P0" --label "needs-human"

            echo "STOP: Rebase conflict. Created issue for manual resolution. Do NOT proceed to PR creation."
            echo "Run '/milestone ship {slug}' again after resolving the conflict."
            exit 1
        fi

        # Rebase succeeded — push the rebased branch
        git push origin milestone/{slug} --force-with-lease
        echo "Rebase complete. Milestone branch now includes all $AT_RISK_COUNT at-risk staging hunks."
        git checkout {STAGING_BRANCH}
    fi
fi
```

### Step 3: Create shipping PR

```bash
# Get the full diff summary (computed after Step 2.5 rebase, so it reflects the final state)
DIFF_STATS=$(git diff origin/{STAGING_BRANCH}...origin/milestone/{slug} --stat)
COMMIT_LOG=$(git log origin/{STAGING_BRANCH}..origin/milestone/{slug} --oneline)

gh pr create {GH_FLAG} \
  --base {STAGING_BRANCH} \
  --head milestone/{slug} \
  --title "Ship: {MILESTONE_TITLE}" \
  --body "$(cat <<'PR_EOF'
## Milestone: {MILESTONE_TITLE}

{MILESTONE_DESCRIPTION}

## Issues Included
{list of all closed issues in this milestone with PR references}

## Hunk-Loss Audit
{If Step 2.5 rebase ran: "✓ Rebase completed — {AT_RISK_COUNT} at-risk staging-branch hunks absorbed into milestone branch before this PR was created. All staging content is preserved."}
{If Step 2.5 found no at-risk hunks: "✓ Clean — no at-risk staging-branch hunks detected. Safe to merge."}

> ⚠ **IMPORTANT: Merge this PR using a MERGE COMMIT, not squash.** Squash-merging a milestone PR can silently drop staging-only hunks in files the milestone touches. Use the "Create a merge commit" option in the GitHub UI, or `gh pr merge {PR_NUMBER} --merge`.

## Diff Summary
{DIFF_STATS}

## Commits
{COMMIT_LOG}
PR_EOF
)"
```

### Step 4: Run staging review

Use the `/review-pr` skill to review the shipping PR. This is a comprehensive review of the entire feature set:

```
Skill(skill="review-pr", args="{PR_NUMBER}")
```

### Step 5: Report — PR is ready for user to merge

```
## Ready to Ship: {MILESTONE_TITLE}

PR #{PR_NUMBER}: milestone/{slug} → staging
- {X} issues resolved
- {Y} files changed
- Review: {PASSED/FINDINGS}

**Merging this PR lands the milestone on staging.** To deploy to production, merge `staging → main` via the GitHub web UI when ready.
PR link: {PR_URL}
```

**STOP here.** The agent does NOT merge this PR. The user merges it manually via the GitHub web UI when they're ready to deploy.

If the user explicitly says "merge it" or "deploy it" in the chat, THEN proceed to Step 6.

### Step 6: Merge and cleanup (ONLY with explicit user authorization)

**Only execute this step if the user explicitly authorizes the merge in the current conversation.** The user may say things like "merge it", "ship it", "land it on staging". Without this explicit authorization, STOP at Step 5.

**CRITICAL: NEVER use `--squash` for milestone PRs.** Squash-merging collapses all milestone commits into one and can silently discard staging-only hunks in files the milestone touches — even after Step 2.5 rebase, if someone squashes manually via the GitHub UI, staging content can be lost. Always use `--merge` (merge commit). If the repository policy forces squash-only merges, the Step 2.5 rebase (which absorbs at-risk hunks into the milestone branch) is the only safe mitigation — but a merge commit is strongly preferred.

**If the PR was rejected or closed without merging**: do nothing here. Milestone stays open, all issues remain assigned to it, and the milestone branch stays intact. The code those issues reference only exists on the milestone branch — moving them to fast lane would be wrong. Log the rejection and stop:

```
Shipping attempt for "{MILESTONE_TITLE}" was rejected (PR #{PR_NUMBER} closed without merging).
Milestone stays open. Issues remain assigned. Branch milestone/{slug} preserved.
Run /milestone ship {slug} again when the milestone is ready for another shipping attempt.
```

**If the PR merged successfully**, run the following:

```bash
gh pr merge {PR_NUMBER} --merge

# Step 6A: Promote remaining open issues to fast lane
# Query open issues still on this milestone (per_page=100 to avoid silent truncation beyond default 30)
OPEN_ISSUES=$(gh api "repos/{owner}/{repo}/issues?milestone={MS_NUMBER}&state=open&per_page=100" \
  --jq '.[].number')
OPEN_COUNT=$(echo "$OPEN_ISSUES" | grep -c '[0-9]' 2>/dev/null || echo 0)

if [ "$OPEN_COUNT" -gt 0 ]; then
  echo "Promoting $OPEN_COUNT open issue(s) to fast lane (removing milestone assignment)..."
  for ISSUE_NUM in $OPEN_ISSUES; do
    gh api "repos/{owner}/{repo}/issues/$ISSUE_NUM" -X PATCH --field milestone=null
    echo "  Demoted #$ISSUE_NUM → fast lane"
  done
else
  echo "No open issues remain on the milestone — nothing to demote."
fi

# Step 6B: Close the milestone
gh api repos/{owner}/{repo}/milestones/{MILESTONE_NUMBER} --method PATCH --field state="closed"

# Step 6C: Delete the milestone branch
git push origin --delete milestone/{slug}
git branch -D milestone/{slug} 2>/dev/null
```

Report:
```
## Shipped: {MILESTONE_TITLE}

Merged to staging. Milestone branch deleted.
{If OPEN_COUNT > 0: "{OPEN_COUNT} open issue(s) moved to fast lane: #{list}. They will target staging on next /work-on run."}
{If OPEN_COUNT == 0: "No open issues remaining — clean close."}

To deploy: merge `staging → main` via GitHub web UI when ready.
```

---

## Action: Sync Milestone Branch

Syncs the milestone branch with the latest default branch to pick up fast-lane fixes. Run periodically on long-lived milestones.

```bash
cd {REPO_PATH}
DEFAULT_BRANCH=$(yq '.branches.default' "$CONFIG_FILE")
git fetch origin $DEFAULT_BRANCH milestone/{slug}
git checkout milestone/{slug}
git merge origin/$DEFAULT_BRANCH --no-edit
# If conflicts, report to user and STOP
git push origin milestone/{slug}
git checkout $DEFAULT_BRANCH
```

Report: "Synced milestone/{slug} with latest `{DEFAULT_BRANCH}`. {N} new commits incorporated."

---

## Action: Close Milestone (without shipping)

For milestones that are abandoned or superseded:

```bash
gh api repos/{owner}/{repo}/milestones/{MILESTONE_NUMBER} --method PATCH --field state="closed"

# Optionally delete the branch
git push origin --delete milestone/{slug} 2>/dev/null
```

Open issues remain open but lose their milestone assignment. They can be reassigned to a new milestone.

---

## Assigning Existing Issues to Milestones

When the user says "add #123 to milestone X":

```bash
# Find milestone number
MILESTONE_NUMBER=$(gh api repos/{owner}/{repo}/milestones --jq '.[] | select(.title | ascii_downcase | contains("{slug}")) | .number')

# Assign issue to milestone
gh issue edit {NUMBER} --milestone "{TITLE}"
```

This automatically makes the issue a feature-lane issue — next time `/work-on` picks it up, the PR will target `milestone/{slug}`.

---

## Error Handling

- **Milestone already exists**: Check first with `gh api repos/{owner}/{repo}/milestones --jq '.[] | select(.title == "{TITLE}")'`
- **Branch already exists**: Reuse it, don't recreate
- **Merge conflicts on sync/ship**: Report to user, do NOT auto-resolve. List conflicting files.
- **No issues in milestone**: Warn user — empty milestones are valid but unusual
