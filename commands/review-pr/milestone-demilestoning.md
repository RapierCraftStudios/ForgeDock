---
description: review-pr fragment — post-merge review-finding demilestoning, Phase 8B and 9A (read by /review-pr for milestone→staging PRs; not a user entrypoint)
user-invocable: false
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<!-- Fragment of commands/review-pr.md (forge#3405): read on demand, run exactly as if inline. -->

### 8B: Post-Merge Review Finding Demilestoning (Milestone PRs Only)

**Skip if**: `IS_MILESTONE_TO_STAGING` is false or `MERGE_STATE != "MERGED"`. Runs only when a milestone→staging PR was just successfully merged.

**Purpose**: Review-finding issues created during a milestone PR review (Phase 6C) inherit the milestone. Once the milestone PR merges, those findings should flow through the fast lane independently — not remain stranded on a closed milestone. This step clears their milestone assignment automatically.

```bash
if [ "${IS_MILESTONE_TO_STAGING:-false}" = "true" ] && [ "${MERGE_STATE:-}" = "MERGED" ]; then
    echo "Phase 8B: Clearing milestone from open review-finding issues referencing PR #${PR_NUMBER}..."

    # Find open review-finding issues whose body references this PR number
    # The title template in Phase 6C always includes: "review finding — PR #${PR_NUMBER}"
    FINDINGS_TO_DEMILESTONE=$(gh issue list -R "${REPO}" \
        --state open \
        --label "review-finding" \
        --limit 200 \
        --json number,title,milestone \
        --jq ".[] | select(.milestone != null) | select(.title | test(\"PR #${PR_NUMBER}\")) | .number" \
        2>/dev/null || echo "")

    if [ -z "$FINDINGS_TO_DEMILESTONE" ]; then
        echo "Phase 8B: No open review-finding issues with milestones found referencing PR #${PR_NUMBER}."
    else
        MOVED_COUNT=0
        echo "$FINDINGS_TO_DEMILESTONE" | while IFS= read -r FINDING_NUM; do
            [ -z "$FINDING_NUM" ] && continue
            FINDING_TITLE=$(gh issue view "$FINDING_NUM" -R "${REPO}" --json title --jq '.title' 2>/dev/null || echo "#${FINDING_NUM}")
            gh issue edit "$FINDING_NUM" -R "${REPO}" --milestone "" 2>/dev/null && \
                echo "  Moved to fast lane: #${FINDING_NUM} — ${FINDING_TITLE}" || \
                echo "  WARNING: Failed to clear milestone for #${FINDING_NUM}"
            MOVED_COUNT=$((MOVED_COUNT + 1))
        done
        echo "Phase 8B: Review finding demilestoning complete."
    fi
fi
```

<!-- Added: forge#815 -->

### 9A: Post-Merge Review Finding Demilestoning Fallback (Milestone PRs Only)

**Skip if**: `IS_MILESTONE_TO_STAGING` is false. Runs when `AUTO_MERGE=false` but the PR was merged manually — Phase 8B did not run in this case, so Phase 9 handles cleanup.

**Detection**: Check if the PR is now MERGED. If so and `IS_MILESTONE_TO_STAGING=true`, run the same demilestoning logic as Phase 8B.

```bash
if [ "${IS_MILESTONE_TO_STAGING:-false}" = "true" ]; then
    PR_MERGE_STATE=$(gh pr view "$PR_NUMBER" -R "$REPO" --json state --jq '.state' 2>/dev/null || echo "")
    if [ "$PR_MERGE_STATE" = "MERGED" ]; then
        echo "Phase 9A: Checking for open review-finding issues to demilestone (fallback — manual merge path)..."

        FINDINGS_TO_DEMILESTONE=$(gh issue list -R "${REPO}" \
            --state open \
            --label "review-finding" \
            --limit 200 \
            --json number,title,milestone \
            --jq ".[] | select(.milestone != null) | select(.title | test(\"PR #${PR_NUMBER}\")) | .number" \
            2>/dev/null || echo "")

        if [ -z "$FINDINGS_TO_DEMILESTONE" ]; then
            echo "Phase 9A: No open review-finding issues with milestones found referencing PR #${PR_NUMBER} (already cleared or none created)."
        else
            echo "$FINDINGS_TO_DEMILESTONE" | while IFS= read -r FINDING_NUM; do
                [ -z "$FINDING_NUM" ] && continue
                FINDING_TITLE=$(gh issue view "$FINDING_NUM" -R "${REPO}" --json title --jq '.title' 2>/dev/null || echo "#${FINDING_NUM}")
                gh issue edit "$FINDING_NUM" -R "${REPO}" --milestone "" 2>/dev/null && \
                    echo "  Moved to fast lane: #${FINDING_NUM} — ${FINDING_TITLE}" || \
                    echo "  WARNING: Failed to clear milestone for #${FINDING_NUM}"
            done
            echo "Phase 9A: Fallback demilestoning complete."
        fi
    fi
fi
```

<!-- Added: forge#815 -->
