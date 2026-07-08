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

### 4A.5: Spec-file concentration analysis — spec-doctor trigger <!-- Added: forge#1742 -->

After the check-promotion pass (§4A), scan for spec files whose 30-day review-finding
concentration exceeds the trigger threshold (≥5 findings referencing the same spec file).
When the threshold is met, queue a `/spec-doctor` run by creating a trigger issue.

**Threshold**: 5 findings per spec file in the 30-day window. Higher than §4A's check-promotion
threshold (3) because spec changes carry more risk than static check additions — each proposed
change goes through eval-gate before merge.

```bash
# Group closed review-findings by referenced spec file (last 30 days)
# $SINCE is set in Phase 1 (30-day window)
ALL_FINDINGS=$(gh issue list {GH_FLAG} \
  --label "review-finding" \
  --state closed \
  --limit 200 \
  --json number,title,body,closedAt \
  --jq ".[] | select(.closedAt >= \"$SINCE\")" 2>/dev/null || echo "")

# Extract spec file references from finding bodies (commands/*.md paths)
# Write one "FINDING_NUM|spec/file.md" line per match
SPEC_REFS_FILE=$(mktemp)
echo "$ALL_FINDINGS" | jq -r '
  . |
  (.body | match("commands/[a-z0-9_/-]+\\.md").string // null) as $spec |
  if $spec then "\(.number)|\($spec)" else empty end
' 2>/dev/null > "$SPEC_REFS_FILE" || true

# Build concentration table: count occurrences per spec file
SPEC_CONCENTRATION=$(sort -t'|' -k2 "$SPEC_REFS_FILE" | \
  awk -F'|' '{
    spec[$2]++
    nums[$2] = (nums[$2] ? nums[$2] "," : "") "#"$1
  }
  END {
    for (s in spec) print spec[s] " " s " " nums[s]
  }' | sort -rn)
rm -f "$SPEC_REFS_FILE"

echo "Spec concentration ranking (last 30 days):"
echo "$SPEC_CONCENTRATION" | head -10

# Emit spec-doctor trigger for each spec at or above threshold
SPEC_DOCTOR_THRESHOLD=5

echo "$SPEC_CONCENTRATION" | while IFS=' ' read -r count spec_file finding_nums; do
  [ -z "$spec_file" ] && continue
  [ "${count:-0}" -lt "$SPEC_DOCTOR_THRESHOLD" ] && continue

  # Skip if a spec-doctor trigger issue already exists for this spec (dedup)
  EXISTING_TRIGGER=$(gh issue list {GH_FLAG} \
    --label "spec-doctor-trigger" \
    --state open \
    --search "$spec_file" \
    --limit 3 \
    --json number --jq '.[0].number' 2>/dev/null || echo "")

  if [ -n "$EXISTING_TRIGGER" ]; then
    echo "Spec-doctor trigger already open for '$spec_file' as #${EXISTING_TRIGGER} — skipping."
    continue
  fi

  # Format finding list as markdown links
  FINDING_LINKS=$(echo "$finding_nums" | tr ',' '\n' | \
    awk '{print "- " $0}' | head -20 | tr '\n' '\n')

  gh issue create {GH_FLAG} \
    --title "feat(spec-doctor): queue spec evolution pass for $(basename $spec_file .md) (${count} concentrated findings)" \
    --label "spec-doctor-trigger,priority:P2" \
    --body "$(cat <<TRIGGER_EOF
## Problem

\`$spec_file\` has accumulated **${count} review findings** in the last 30 days.
Finding concentration above the 5-finding threshold triggers an evidence-backed
spec evolution pass via \`/spec-doctor\`.

## Source Findings (last 30 days)

${FINDING_LINKS}

## Task

Run \`/spec-doctor $spec_file\` to:
1. Read the concentrated findings above
2. Identify recurring defect classes
3. Draft a spec diff with per-change finding citations
4. Open a \`spec-evolution\` PR gated by the eval corpus

The spec-evolution PR is **never auto-merged** — the eval gate must pass and a human
must review and approve.

## Acceptance Criteria

- [ ] \`/spec-doctor $spec_file\` produces a \`spec-evolution\` PR
- [ ] PR body cites every finding from the list above that it addresses
- [ ] Eval gate passes on the spec-evolution PR (no regression)
- [ ] Human reviews and merges

## Context

Trigger threshold: **${SPEC_DOCTOR_THRESHOLD} findings / 30 days** per spec file.
This issue was auto-created by \`pipeline-health\` Phase 4A.5.

<!-- AUTO-CREATED: pipeline-health Phase 4A.5 — spec concentration threshold exceeded -->
TRIGGER_EOF
  )"
  echo "Created spec-doctor trigger for '$spec_file' (${count} findings: $finding_nums)"
done
```

**Spec-doctor trigger label**: `spec-doctor-trigger`. Create it if absent:

```bash
gh label create "spec-doctor-trigger" \
  --color "1D76DB" \
  --description "Queued for /spec-doctor pass. Managed by ForgeDock." \
  --force \
  {GH_FLAG} 2>/dev/null || true
```

**Output**: Zero or more `spec-doctor-trigger` issues — one per spec file at threshold.
When multiple specs are above threshold, all get trigger issues. The worst offender (highest
count) is processed first when the `/spec-doctor auto` mode is used.

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

