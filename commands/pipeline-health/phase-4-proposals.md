---
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /pipeline-health — Phase 4: Generate Improvement Proposals

## Phase 4: Generate Improvement Proposals

### 4A: Pattern recurrence analysis — check-promotion threshold <!-- Added: forge#1331 -->

Before the general improvement proposals, scan for `FORGE:PATTERN` tags in review-finding issues closed in the analysis window. When the same pattern slug appears on 3+ distinct issues, emit a check-promotion issue:

```bash
# Collect all review-finding issues closed in the window with FORGE:PATTERN annotations
# {GH_FLAG} and {GH_REPO} are resolved from forge.yaml (see Config Resolution at top of file)
PATTERN_ISSUES=$(gh issue list {GH_FLAG} \
  --label "review-finding" \
  --state closed \
  --search "FORGE:PATTERN" \
  --limit 100 \
  --json number,title,body,closedAt \
  --jq ".[] | select(.closedAt >= \"$SINCE\") | {number: .number, title: .title, body: .body}" 2>/dev/null || echo "[]")

# Extract pattern slugs from FORGE:PATTERN HTML comments in issue bodies
# Format in issue body: <!-- FORGE:PATTERN: {slug} -->
PATTERN_LIST=$(echo "$PATTERN_ISSUES" | jq -r '
  .body |
  scan("<!-- FORGE:PATTERN: ([^\\s>]+) -->") |
  .[0]
' 2>/dev/null | sort | uniq -c | sort -rn)

# For each pattern that appears 3+ times, emit a check-promotion issue
while IFS= read -r line; do
  COUNT=$(echo "$line" | awk '{print $1}')
  SLUG=$(echo "$line" | awk '{print $2}')
  [ -z "$SLUG" ] && continue
  [ "$COUNT" -lt 3 ] && continue

  # Check if a promotion issue already exists for this slug (avoid duplicates)
  EXISTING_PROMOTION=$(gh issue list {GH_FLAG} \
    --label "check-promotion" \
    --state open \
    --search "FORGE:PATTERN: $SLUG" \
    --limit 5 \
    --json number --jq '.[0].number' 2>/dev/null || echo "")

  if [ -n "$EXISTING_PROMOTION" ]; then
    echo "Check-promotion already open for pattern '$SLUG' as #${EXISTING_PROMOTION} — skipping."
    continue
  fi

  # Collect the source finding issue numbers for this pattern
  SOURCE_FINDINGS=$(echo "$PATTERN_ISSUES" | jq -r --arg slug "$SLUG" '
    select(.body | test("<!-- FORGE:PATTERN: " + $slug + " -->")) |
    "#\(.number)"
  ' 2>/dev/null | head -10 | tr '\n' ' ')

  gh issue create {GH_FLAG} \
    --title "feat(quality-gate): promote pattern '$SLUG' to deterministic registry check (recurred ${COUNT}x)" \
    --label "check-promotion,priority:P2" \
    --body "$(cat <<CHECK_EOF
## Problem

The review-finding pattern \`$SLUG\` has recurred ${COUNT} times in the analysis window ($(date -u +%Y-%m-%d) window). Each recurrence costs a full investigate→build→review→merge cycle. A static check catches this in milliseconds.

## Source Findings

${SOURCE_FINDINGS}

## Task

1. Read the source findings above to understand the defect class mechanically.
2. Write \`scripts/check-registry/${SLUG}.sh\` following the check contract in \`scripts/check-registry/README.md\`.
3. Add an entry to \`scripts/check-registry/manifest.json\` referencing the new script.
4. Verify the check: test it by reintroducing the defect pattern and confirm the gate blocks.
5. PR, review, merge — the check runs on all subsequent quality-gate invocations.

## Acceptance Criteria

- [ ] \`scripts/check-registry/${SLUG}.sh\` exists, exits 1 on match with correct output format
- [ ] Manifest entry added: \`{ "slug": "${SLUG}", "script": "...", "source_findings": [...], ... }\`
- [ ] Seeded repo test: reintroduce the \`$SLUG\` pattern → quality gate blocks with REGISTRY-${SLUG} finding
- [ ] Gate runtime increase ≤5s for the registered check batch
- [ ] No regression: a clean changeset (no pattern) → gate passes

## Pattern Tag

<!-- FORGE:PATTERN: ${SLUG} -->

<!-- AUTO-CREATED: pipeline-health Phase 4A — pattern recurrence threshold exceeded -->
CHECK_EOF
  )"
  echo "Created check-promotion issue for pattern '$SLUG' (recurred ${COUNT}x from: $SOURCE_FINDINGS)"
done <<< "$PATTERN_LIST"
```

**Recurrence threshold**: 3 occurrences in the analysis window. The threshold is intentionally low — the cost of a false positive is one extra check that rarely fires; the cost of a false negative is another full pipeline cycle for a defect that a grep already knows about.

---

### 4B: General improvement proposals

For each of the top 3 defect categories:

1. **Diagnose**: Why is the builder producing these defects? Read the relevant section of `work-on.md` — is there a check for this category? Is it too vague? Missing entirely?

2. **Prescribe**: What specific change to which command file would reduce these defects?
   - If the builder lacks a check → propose adding one to `work-on.md` or `quality-gate.md`
   - If the review agent misses things → propose tightening the agent template in `review-pr-agents.md`
   - If the orchestrator doesn't catch integration failures → propose a new inter-wave check

3. **Scope**: Estimate the change size (lines added/modified) and risk level.

---

