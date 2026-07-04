---
install: internal
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Phase 2: Investigation-First Triage

## Phase 2: Investigation-First Triage

**Purpose**: Investigation issues produce NEW GitHub issues as their output. If the batch contains investigations, they must run FIRST so their output can be folded into the execution plan.

**If no investigations are found in Step 2A, skip this entire phase and proceed directly to Phase 3.**

### Step 2A: Classify each issue

For each issue in the resolved set, read its title and body to classify it:

```bash
for NUM in {issue_numbers}; do
  gh issue view $NUM --json title,body,labels --jq '{title: .title, labels: [.labels[].name], body_preview: (.body[:500])}'
done
```

**Classification rules:**

| Signal | Classification |
|--------|---------------|
| Title contains "Investigate", "Audit", "Research", "Evaluate", "Assess", "Deep dive" | **Investigation** |
| Issue body is primarily questions (`- [ ]` checklist) with no concrete code changes | **Investigation** |
| Issue body says "Deliverable: execution plan" or "create issues" | **Investigation** |
| Issue has `enhancement` label + title starts with "Enable" + body describes toggling a feature flag | **Implementation** |
| Issue has `bug`, `refactor`, `dead-code`, or `feature` label | **Implementation** |

Tag each issue internally as `INVESTIGATION` or `IMPLEMENTATION`.

### Step 2B: Run investigations first (Wave 0)

If ANY issues are classified as `INVESTIGATION`:

1. **Move them to Wave 0** — they run BEFORE all implementation issues
2. **Spawn Wave 0 agents** using the same agent template as Phase 4A, but emphasize that `/work-on` will detect the investigation task type and produce issues (not code)
3. **Wait for ALL Wave 0 agents to complete** before proceeding to Phase 3

### Step 2C: Collect newly created issues

After Wave 0 completes, each investigation agent will have created new GitHub issues. Collect them:

```bash
# For each investigation issue that completed successfully:
# Read the FORGE:BUILDER comment to find created issue numbers
for INV_NUM in {investigation_numbers}; do
  gh api repos/{GH_REPO}/issues/${INV_NUM}/comments \
    --jq '.[] | select(.body | contains("<!-- FORGE:BUILDER -->")) | .body' \
    | grep -oP '#\K\d+' | sort -u
done

# Also check: if the investigation issue had a milestone, the new issues should too
# Verify milestone assignment:
for NEW_NUM in {newly_created_numbers}; do
  gh issue view $NEW_NUM --json milestone --jq '.milestone.title // "NO MILESTONE"'
done
```

### Step 2C.5: Collect Knowledge Gist URLs from investigations

For each completed investigation issue, query its comments for `FORGE:KNOWLEDGE_GIST` annotations. Store the mapping of investigation issue number → Gist URL(s) so the agent template in Step 4A can include prior investigation context.

```bash
# Build a map: investigation_number → gist_url(s)
declare -A INVESTIGATION_GISTS
for INV_NUM in {investigation_numbers}; do
  GIST_URLS=$(gh api repos/{GH_REPO}/issues/${INV_NUM}/comments \
    --jq '[.[] | select(.body | test("<!-- FORGE:KNOWLEDGE_GIST: https://")) | .body | capture("<!-- FORGE:KNOWLEDGE_GIST: (?<url>https://[^ ]+) -->").url] | unique | .[]')
  if [ -n "$GIST_URLS" ]; then
    INVESTIGATION_GISTS[$INV_NUM]="$GIST_URLS"
    echo "Investigation #${INV_NUM}: found Gist URL(s)"
  fi
done
```

When spawning agents for implementation issues in Step 4A, include any Gist URLs from parent/sibling investigations in the agent prompt's context block. See the `{GIST_CONTEXT}` variable in the agent template.

**Milestone index Gist**: If the milestone has a `<!-- FORGE:MILESTONE_INDEX: {url} -->` annotation in its description, read the index URL and store it for inclusion in agent context. The milestone index aggregates all investigation Gist URLs for the milestone into a single reference.

```bash
# Read milestone index URL from milestone description (if milestone exists)
MILESTONE_INDEX_URL=""
if [ -n "$MILESTONE_NUM" ]; then
  MILESTONE_DESC=$(gh api repos/{GH_REPO}/milestones/${MILESTONE_NUM} --jq '.description // ""' 2>/dev/null)
  MILESTONE_INDEX_URL=$(echo "$MILESTONE_DESC" | grep -oP '(?<=<!-- FORGE:MILESTONE_INDEX: )https://[^ ]+(?= -->)' | head -1)
  if [ -n "$MILESTONE_INDEX_URL" ]; then
    echo "Milestone index Gist found: ${MILESTONE_INDEX_URL}"
  fi
fi
```

### Step 2D: Merge new issues into the batch

Add the newly created issues to the issue set. Re-check each one:
- Filter out any that are already ineligible (same rules as Phase 1)
- Tag them as `IMPLEMENTATION` (investigations don't spawn more investigations)
- They inherit the milestone from their parent investigation if applicable

**Issue body standard**: Any new issues created by investigation agents MUST use the **Pipeline Issue Template** from `issue.md` Phase 3D as their body structure. Investigation agents that produce issues as output should be prompted to use that template — not ad-hoc body formats — so every spawned issue enters the pipeline with the correct structure (Problem, Root Cause, Affected Files, Acceptance Criteria). Verify spawned issues have all mandatory sections before adding them to the batch; if sections are missing, the `/issue` body-validation step (Phase 4C.5) will repair them. <!-- Added: forge#293 -->

**Updated issue set** = original `IMPLEMENTATION` issues + newly spawned issues from investigations.

### Step 2E: Report Wave 0 results to user

```
## Wave 0: Investigations Complete

| # | Investigation | Result | Issues Created |
|---|--------------|--------|---------------|
| #{INV1} | {title} | ✓ Closed | #{N1}, #{N2}, #{N3} |
| #{INV2} | {title} | ✓ Closed | #{N4}, #{N5} |

**New issues added to batch**: {count}
**Updated total**: {original_count} → {new_total} issues

Proceeding to dependency analysis with the expanded issue set...
```

---

