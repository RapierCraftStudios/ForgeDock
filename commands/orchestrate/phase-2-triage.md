---
install: core
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

### Step 2C.5: Collect repository-scoped investigator annotations

For every completed Wave 0 investigation, resolve the exact completed `FORGE:INVESTIGATOR` comment resource. The comment ID and issue URL are the durable handoff; a bounded recommendation excerpt is included for prompt context without copying a reserved annotation body into another annotation. Paginate explicitly so an issue with more than 100 comments cannot hide its latest investigator result.

```bash
# Build a map: investigation_number → exact completed investigator comment + bounded summary.
# The map is keyed by the complete investigation set, not by whether an external artifact exists.
# Every consumer uses the same finite newest-first retrieval contract. The page, byte, and
# timeout limits bound both the API work and the response retained before validation.
declare -A INVESTIGATION_CONTEXT
MAX_COMMENT_PAGES=5
MAX_COMMENT_PAGE_BYTES=1048576
MAX_COMMENT_TOTAL_BYTES=5242880
COMMENT_FETCH_TIMEOUT_SECONDS=15
COMMENT_PAGE_SIZE=100
for INV_NUM in {investigation_numbers}; do
  EXPECTED_ISSUE_URL="https://api.github.com/repos/{GH_REPO}/issues/${INV_NUM}"
  INVESTIGATOR_JSON=""
  COMMENT_BYTES_USED=0
  COMMENT_PAGE=1

  while [ "$COMMENT_PAGE" -le "$MAX_COMMENT_PAGES" ]; do
    if ! PAGE_FILE=$(mktemp "${TMPDIR:-/tmp}/forgedock-comments.XXXXXX"); then
      echo "Investigation #${INV_NUM}: unavailable — could not create bounded response file"
      break
    fi

    # Capture at most one byte beyond the page budget. An oversized response is rejected
    # before jq sees it, while a timeout/API error is surfaced instead of swallowed.
    if timeout "$COMMENT_FETCH_TIMEOUT_SECONDS" gh api \
      "repos/{GH_REPO}/issues/${INV_NUM}/comments?sort=created&direction=desc&per_page=${COMMENT_PAGE_SIZE}&page=${COMMENT_PAGE}" 2>/dev/null \
      | head -c "$((MAX_COMMENT_PAGE_BYTES + 1))" > "$PAGE_FILE"; then
      PAGE_FETCH_STATUS=("${PIPESTATUS[@]}")
    else
      PAGE_FETCH_STATUS=("${PIPESTATUS[@]}")
    fi
    PAGE_BYTES=$(wc -c < "$PAGE_FILE" | tr -d '[:space:]')

    if [ "$PAGE_BYTES" -gt "$MAX_COMMENT_PAGE_BYTES" ] || \
       [ $((COMMENT_BYTES_USED + PAGE_BYTES)) -gt "$MAX_COMMENT_TOTAL_BYTES" ]; then
      echo "Investigation #${INV_NUM}: unavailable — comment response byte budget exceeded"
      rm -f "$PAGE_FILE"
      break
    fi
    if [ "${PAGE_FETCH_STATUS[0]:-1}" -ne 0 ] || [ "${PAGE_FETCH_STATUS[1]:-1}" -ne 0 ]; then
      echo "Investigation #${INV_NUM}: unavailable — bounded comment request failed or timed out"
      rm -f "$PAGE_FILE"
      break
    fi
    COMMENT_BYTES_USED=$((COMMENT_BYTES_USED + PAGE_BYTES))

    if ! PAGE_COUNT=$(jq -r 'if type == "array" then length else error("comment response is not an array") end' "$PAGE_FILE" 2>/dev/null); then
      echo "Investigation #${INV_NUM}: unavailable — bounded comment response was malformed"
      rm -f "$PAGE_FILE"
      break
    fi
    if ! INVESTIGATOR_JSON=$(jq -c --arg expected_issue_url "$EXPECTED_ISSUE_URL" \
      'map(select(.issue_url == $expected_issue_url and ((.body // "") | contains("<!-- FORGE:INVESTIGATOR -->")) and ((.body // "") | contains("<!-- INVESTIGATION:COMPLETE -->")))) | sort_by(.id) | last // empty' \
      "$PAGE_FILE" 2>/dev/null); then
      echo "Investigation #${INV_NUM}: unavailable — could not validate bounded comment response"
      rm -f "$PAGE_FILE"
      break
    fi
    rm -f "$PAGE_FILE"

    [ -n "$INVESTIGATOR_JSON" ] && break
    [ "$PAGE_COUNT" -lt "$COMMENT_PAGE_SIZE" ] && break
    COMMENT_PAGE=$((COMMENT_PAGE + 1))
  done

  if [ -z "$INVESTIGATOR_JSON" ] || [ "$INVESTIGATOR_JSON" = "null" ]; then
    INVESTIGATION_CONTEXT[$INV_NUM]="Investigation #${INV_NUM}: unavailable — the finite newest-first comment window did not establish a validated completed FORGE:INVESTIGATOR resource. Do not substitute external memory; report this missing context explicitly."
    echo "Investigation #${INV_NUM}: completed investigator context unavailable (finite retrieval window)"
    continue
  fi

  COMMENT_ID=$(printf '%s' "$INVESTIGATOR_JSON" | jq -r '.id // empty')
  COMMENT_URL=$(printf '%s' "$INVESTIGATOR_JSON" | jq -r '.html_url // empty')
  if [ -z "$COMMENT_ID" ] || [ -z "$COMMENT_URL" ]; then
    INVESTIGATION_CONTEXT[$INV_NUM]="Investigation #${INV_NUM}: unavailable — the bounded comment did not contain a valid repository comment identity. Do not substitute external memory; report this missing context explicitly."
    echo "Investigation #${INV_NUM}: unavailable — invalid comment identity"
    continue
  fi
  RECOMMENDATION=$(printf '%s' "$INVESTIGATOR_JSON" | jq -r '.body' \
    | awk '/^### Recommendation/{p=1; next} /^### /{p=0} p' \
    | sed -E 's/<!--[^>]*-->//g' \
    | tr '\n' ' ' \
    | cut -c1-1200)
  [ -n "$RECOMMENDATION" ] || RECOMMENDATION="See the exact completed investigator comment for the bounded finding details."

  INVESTIGATION_CONTEXT[$INV_NUM]="Investigation #${INV_NUM} — exact completed FORGE:INVESTIGATOR comment #${COMMENT_ID}: ${COMMENT_URL}
Recommendation excerpt: ${RECOMMENDATION}"
  echo "Investigation #${INV_NUM}: using completed investigator comment #${COMMENT_ID}"
done
```

When spawning agents for implementation issues in Step 4A, include the exact repository comment reference and bounded recommendation from the parent or relevant investigation in the `{GIST_CONTEXT}` context block. The numeric comment identity remains authoritative; workers may fetch that single comment for full details during context gathering. No external-memory lookup is part of this handoff.

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

