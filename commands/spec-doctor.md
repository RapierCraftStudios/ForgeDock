---
description: Evidence-backed spec evolution — reads finding concentration for a spec file, drafts a spec diff, opens a spec-evolution PR with per-change citations
argument-hint: "[spec file path | \"auto\"]"
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /spec-doctor — Evidence-Backed Spec Evolution

**Input**: $ARGUMENTS

Closes the feedback loop from `pipeline-health` finding data into self-improving spec PRs.
Reads concentrated review findings for a spec file, drafts a concrete spec diff addressing
the recurring defect classes, and opens a `spec-evolution` PR whose body cites every finding
that motivated each change. The human stays the authority — **spec-evolution PRs are never
auto-merged**, and the eval gate must pass before merge is possible.

<!-- FORGE:SPEC_LOADED — spec-doctor.md loaded and active. Agent is bound by this spec. -->

## HARD RULES — READ BEFORE ANYTHING ELSE

1. **NEVER auto-merge a spec-evolution PR.** `gh pr create` must NEVER include `--auto-merge`.
   The eval gate makes the proposal trustworthy; the human stays the authority.
2. **Every spec change must cite its evidence.** Each changed block in the PR body must list
   the finding issues that motivated it. A spec change with no cited findings is spec drift,
   not spec evolution.
3. **Do not widen scope beyond the concentrated-finding spec file.** One spec-doctor run =
   one spec file. If adjacent specs also need fixes, create separate issues.
4. **The spec diff is a proposal, not a decree.** Post it as a PR for human review. Do NOT
   update `commands/` files directly without going through the PR flow.
5. **NEVER use the Agent tool** — all sub-operations run inline or via `Skill(...)`.

---

## Phase 0: Resolve Target Spec

### 0A: Parse input

If `$ARGUMENTS` is a file path matching `commands/*.md`: use that spec file directly.

If `$ARGUMENTS` is `"auto"` or empty: auto-select the worst offender from the recurrence
data (see Phase 1 — run it with `--auto-select` mode and pick the top-ranked spec file).

```bash
INPUT_ARG="${ARGUMENTS:-auto}"

if echo "$INPUT_ARG" | grep -qE '^commands/'; then
  TARGET_SPEC="$INPUT_ARG"
  SELECT_MODE="explicit"
else
  TARGET_SPEC=""
  SELECT_MODE="auto"
fi
```

### 0B: Load forge.yaml

```bash
GH_REPO=$(yq '.project.owner + "/" + .project.repo' forge.yaml 2>/dev/null)
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' forge.yaml 2>/dev/null || echo ".")
STAGING_BRANCH=$(yq '.branches.staging // "staging"' forge.yaml 2>/dev/null)
```

### 0C: Ensure spec-evolution label exists

```bash
gh label create "spec-evolution" \
  --color "BFD4F2" \
  --description "Spec PR backed by eval corpus. Managed by ForgeDock." \
  --force \
  $GH_FLAG 2>/dev/null || true
```

---

## Phase 1: Query Finding Recurrence by Spec File

### 1A: Collect review findings from the last 30 days

```bash
SINCE=$(date -d "30 days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -v-30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || python3 -c "import datetime; print((datetime.datetime.utcnow() - datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")

# Fetch review-finding issues closed in the 30-day window
FINDINGS_RAW=$(gh issue list $GH_FLAG \
  --label "review-finding" \
  --state closed \
  --limit 200 \
  --json number,title,body,closedAt \
  --jq ".[] | select(.closedAt >= \"$SINCE\")" 2>/dev/null || echo "[]")

TOTAL_FINDINGS=$(echo "$FINDINGS_RAW" | grep -c '"number"' 2>/dev/null || echo "0")
echo "Found $TOTAL_FINDINGS review findings in the last 30 days"
```

### 1B: Group findings by referenced spec file

Findings reference a spec file when their body contains a path matching `commands/*.md` or
a link to a section of a command spec file. Extract the primary spec reference:

```bash
# For each finding, extract the first commands/*.md reference from the body
# Pattern: `commands/foo.md`, commands/foo/bar.md, or "commands/foo" in prose
echo "$FINDINGS_RAW" | jq -r '
  . |
  (.body | match("commands/[a-z0-9_/-]+\\.md").string // null) as $spec |
  if $spec then "\(.number)|\($spec)" else empty end
' 2>/dev/null | sort | uniq > /tmp/findings_by_spec.txt

# Build concentration table: spec file → count, finding numbers
declare -A SPEC_COUNTS
declare -A SPEC_FINDINGS
while IFS='|' read -r num spec; do
  [ -z "$spec" ] && continue
  SPEC_COUNTS["$spec"]=$(( ${SPEC_COUNTS["$spec"]:-0} + 1 ))
  SPEC_FINDINGS["$spec"]="${SPEC_FINDINGS[$spec]:+${SPEC_FINDINGS[$spec]},}#$num"
done < /tmp/findings_by_spec.txt

# Rank by count descending
for spec in "${!SPEC_COUNTS[@]}"; do
  echo "${SPEC_COUNTS[$spec]} $spec"
done | sort -rn > /tmp/spec_ranked.txt

echo "Spec file recurrence ranking (last 30 days):"
cat /tmp/spec_ranked.txt | head -10
```

### 1C: Resolve target spec (auto-select or validate explicit)

```bash
if [ "$SELECT_MODE" = "auto" ]; then
  # Pick the top-ranked spec file with ≥ 5 findings
  TARGET_SPEC=$(awk '$1 >= 5 {print $2; exit}' /tmp/spec_ranked.txt || echo "")
  if [ -z "$TARGET_SPEC" ]; then
    echo "No spec file has ≥5 findings in the last 30 days. Top offender:"
    head -1 /tmp/spec_ranked.txt
    # Use top offender even if below threshold for explicit runs
    TARGET_SPEC=$(awk 'NR==1{print $2}' /tmp/spec_ranked.txt || echo "")
    if [ -z "$TARGET_SPEC" ]; then
      echo "ERROR: No finding data available. Run pipeline-health first to accumulate findings."
      exit 1
    fi
    echo "Using top offender: $TARGET_SPEC (below 5-finding threshold — proceeding with explicit run)"
  else
    echo "Auto-selected worst offender: $TARGET_SPEC (${SPEC_COUNTS[$TARGET_SPEC]} findings)"
  fi
else
  # Validate explicit spec file exists
  if [ ! -f "$REPO_PATH/$TARGET_SPEC" ]; then
    echo "ERROR: Spec file not found: $REPO_PATH/$TARGET_SPEC"
    exit 1
  fi
  echo "Explicit target spec: $TARGET_SPEC"
fi

FINDING_COUNT=${SPEC_COUNTS["$TARGET_SPEC"]:-0}
FINDING_NUMBERS=${SPEC_FINDINGS["$TARGET_SPEC"]:-""}
echo "Target: $TARGET_SPEC — $FINDING_COUNT findings: $FINDING_NUMBERS"
```

### 1D: Load full finding bodies for the target spec

```bash
# Fetch full bodies for each finding that references TARGET_SPEC
IFS=',' read -ra FINDING_LIST <<< "$FINDING_NUMBERS"
FINDINGS_DETAIL=""
for finding_ref in "${FINDING_LIST[@]}"; do
  num=$(echo "$finding_ref" | tr -d '#')
  [ -z "$num" ] && continue
  body=$(gh issue view "$num" $GH_FLAG --json number,title,body \
    --jq '"\(.number)|\(.title)|\(.body)"' 2>/dev/null || echo "")
  FINDINGS_DETAIL="${FINDINGS_DETAIL}
${body}"
done

echo "Loaded finding details for: $FINDING_NUMBERS"
```

---

## Phase 2: Draft Spec Diff

### 2A: Read the target spec file

```bash
TARGET_SPEC_CONTENT=$(cat "$REPO_PATH/$TARGET_SPEC" 2>/dev/null)
if [ -z "$TARGET_SPEC_CONTENT" ]; then
  echo "ERROR: Cannot read $REPO_PATH/$TARGET_SPEC"
  exit 1
fi
echo "Loaded target spec: $TARGET_SPEC ($(echo "$TARGET_SPEC_CONTENT" | wc -l) lines)"
```

### 2B: Analyze findings and identify defect classes

Read all finding bodies loaded in Phase 1D. Group them by defect class:

For each finding, identify:
- **What the builder did wrong** (the behavioral description, not the symptom)
- **Which section of the spec** was missing or ambiguous (or absent entirely)
- **What rule, check, or constraint** would prevent recurrence

Group findings by defect class — findings that share the same root behavioral failure
belong to one class even if their surface symptoms differ (e.g., three findings about
"missing predecessor check" are one class).

**Defect class analysis output** (produce for each class):
```
Class: {NAME}
Count: {N} (from findings: {#NNN, #NNN, ...})
Root behavioral failure: {what the agent does wrong — action-level}
Spec gap: {section name or "absent"} — {what's missing}
Proposed fix: {concrete spec rule/check/constraint — one paragraph max}
Evidence citations: {finding numbers that prove this class exists}
```

### 2C: Draft spec changes

For each defect class from 2B, draft the specific spec text change:

**Rules for spec text changes**:
- Describe the **bug class**, not a specific incident: write "When X condition, verify Y" not
  "In PR #1234, the builder failed to..."
- One brief HTML comment `<!-- Added: forge#1742 -->` per new check (traceability)
- Evidence block (if used) describes the vulnerability **pattern** — not a historical narrative
- New checks go into the most specific relevant section (e.g., a builder check → Phase 3F
  of work-on.md, not the header)
- Prefer adding a **MANDATORY** inline check over a prose warning — prose warnings are ignored
- If the spec section is absent: propose a new section; position it where an agent would
  encounter it at the right moment (just-in-time)

Produce a structured diff description (not a literal `diff` output — a human-readable
description of what changes where):

```
### Change 1 — {SECTION_NAME}
**Type**: {Add check | Add section | Strengthen rule | Correct contradiction}
**Location**: {line range or section heading}
**Evidence**: Findings {#NNN, #NNN} — {one sentence: what recurs}
**Before**: {current text snippet or "section absent"}
**After**: {proposed text or new section content}
```

### 2D: Validate proposed changes against the spec

Before committing to the PR, validate:
- [ ] Each change addresses a defect class with ≥1 cited finding
- [ ] No change contradicts an existing HARD RULE in the same spec
- [ ] No change widens scope beyond the targeted spec file
- [ ] All inline checks are placed where an agent encounters them during execution
- [ ] Spec style matches surrounding content (heading levels, bash blocks, HTML comment conventions)

---

## Phase 3: Open Spec-Evolution PR

### 3A: Create branch and apply changes

```bash
cd "$REPO_PATH"
git fetch origin

# Branch slug: spec-doctor/{spec-slug}-{issue-or-timestamp}
SPEC_SLUG=$(echo "$TARGET_SPEC" | sed 's|commands/||;s|\.md$||;s|/|-|g' | cut -c1-40)
DOCTOR_BRANCH="spec-doctor/${SPEC_SLUG}-$(date +%Y%m%d)"

# Branch from staging (fast lane — spec-evolution PRs never auto-merge,
# so they are reviewed by a human before reaching main via staging→main)
mkdir -p ".forgedock/worktrees/$(dirname "$DOCTOR_BRANCH")"
git worktree add ".forgedock/worktrees/${DOCTOR_BRANCH}" -b "$DOCTOR_BRANCH" "origin/$STAGING_BRANCH" 2>/dev/null \
  || git worktree add ".forgedock/worktrees/${DOCTOR_BRANCH}" "$DOCTOR_BRANCH"

DOCTOR_WORKTREE="$REPO_PATH/.forgedock/worktrees/${DOCTOR_BRANCH}"
echo "Created worktree: $DOCTOR_WORKTREE on branch $DOCTOR_BRANCH"
```

### 3B: Apply spec changes

Apply each change from Phase 2C to the target spec file in the worktree:

```bash
TARGET_SPEC_WORKTREE="$DOCTOR_WORKTREE/$TARGET_SPEC"
cp "$REPO_PATH/$TARGET_SPEC" "$TARGET_SPEC_WORKTREE"
```

For each change from Phase 2C:
- Use the Edit tool to apply the change at the correct location
- Verify the edit was applied correctly (read back the modified section)
- Do NOT introduce changes beyond the scoped defect classes from Phase 2C

### 3C: Commit

```bash
cd "$DOCTOR_WORKTREE"
git add "$TARGET_SPEC"
git commit -s -m "fix($(basename $TARGET_SPEC .md)): address $(echo $FINDING_NUMBERS | tr ',' '\n' | wc -l | tr -d ' ') concentrated review findings (#1742)

Evidence-backed spec evolution. Defect classes addressed:
$(for class in "${DEFECT_CLASS_NAMES[@]}"; do echo "- $class"; done)

Cited findings: $FINDING_NUMBERS

Generated by /spec-doctor. PR is a proposal — not auto-merged.
Eval gate must pass before merge."
```

### 3D: Push and open PR

```bash
cd "$DOCTOR_WORKTREE"
git push -u origin "$DOCTOR_BRANCH"

# Build the PR body with per-change finding citations
PR_BODY=$(cat <<PR_BODY_EOF
## Spec Evolution Proposal

**Target spec**: \`$TARGET_SPEC\`
**Source findings** (30-day window): $FINDING_NUMBERS ($FINDING_COUNT findings)
**Generated by**: /spec-doctor (#1742)

> ⚠️ This PR is **never auto-merged**. The eval gate must pass, and a human must review and merge.
> See [eval-gate runbook](docs/design/eval-gate-runbook.md) for baseline update procedure.

## Changes

$(for change in "${CHANGES_SUMMARY[@]}"; do echo "$change"; done)

## Evidence Trail

For each change, the cited findings prove the defect class exists and recurs:

$(for finding_ref in "${FINDING_LIST[@]}"; do
  num=$(echo "$finding_ref" | tr -d '#')
  title=$(gh issue view "$num" $GH_FLAG --json title --jq '.title' 2>/dev/null || echo "finding $num")
  echo "- **#$num**: $title"
done)

## Eval Gate

The CI eval gate (\`.github/workflows/eval-gate.yml\`) will run automatically because this PR
carries the \`spec-evolution\` label. The gate replays the relevant corpus slice with old vs
new spec and blocks merge on outcome regression (threshold: 5 percentage points).

See \`scripts/eval-gate-scorecard.mjs\` for the gate comparator implementation.

## Merge Criteria

- [ ] Eval gate passes (no regression on outcome scores)
- [ ] Human reviewer confirms each cited finding is addressed
- [ ] No new spec contradictions introduced (HARD RULES consistent with changes)
- [ ] Baseline update procedure followed after merge (see runbook)

---
Part of #1742 — evidence-backed spec evolution PRs gated by eval corpus
PR_BODY_EOF
)

# NEVER use --auto-merge here — spec-evolution PRs require human review
gh pr create $GH_FLAG \
  --base "$STAGING_BRANCH" \
  --head "$DOCTOR_BRANCH" \
  --title "fix($(basename $TARGET_SPEC .md)): evidence-backed spec evolution — $FINDING_COUNT findings addressed" \
  --body "$PR_BODY" \
  --label "spec-evolution"

DOCTOR_PR_NUMBER=$(gh pr list $GH_FLAG --head "$DOCTOR_BRANCH" --json number --jq '.[0].number')
echo "Spec-evolution PR created: #$DOCTOR_PR_NUMBER"
echo "Auto-merge: EXCLUDED (structural) — eval gate must pass, human must review"
```

### 3E: Post completion annotation

```bash
gh issue comment {ORIGINATING_ISSUE_NUMBER:-1742} $GH_FLAG --body "<!-- FORGE:SPEC_DOCTOR_COMPLETE -->
## Spec Doctor Run Complete

**Target spec**: \`$TARGET_SPEC\`
**Findings addressed**: $FINDING_NUMBERS ($FINDING_COUNT findings)
**PR**: #$DOCTOR_PR_NUMBER
**Branch**: \`$DOCTOR_BRANCH\`
**Auto-merge**: EXCLUDED — eval gate must pass, human reviews and merges

### Defect Classes Addressed
$(for class in "${DEFECT_CLASS_NAMES[@]}"; do echo "- $class"; done)

The eval gate will run automatically on the \`spec-evolution\` PR. Monitor:
\`gh pr view $DOCTOR_PR_NUMBER $GH_FLAG --json statusCheckRollup\`"
```

### 3F: Worktree cleanup note

The spec-doctor worktree is retained until the PR is merged or closed.
After merge, clean up with:

```bash
cd "$REPO_PATH"
git worktree remove ".forgedock/worktrees/${DOCTOR_BRANCH}" --force
git branch -D "$DOCTOR_BRANCH" 2>/dev/null || true
```

---

## Usage Examples

```bash
# Auto-select worst offender from 30-day window
/spec-doctor auto

# Target a specific spec file
/spec-doctor commands/orchestrate.md

# The first real run targets commands/orchestrate.md (worst offender per issue #1742)
/spec-doctor commands/orchestrate.md
```

---

## Integration Points

- **Pipeline trigger**: `pipeline-health/phase-4-proposals.md §4A.5` queues a spec-doctor
  run when a spec file's 30-day finding concentration exceeds threshold (≥5 findings)
- **Eval gate**: `.github/workflows/eval-gate.yml` triggers on the `spec-evolution` label —
  runs the eval corpus against old vs new spec and blocks merge on regression
- **Auto-merge exclusion**: `review-pr.md` Phase -1 detects `spec-evolution` label and sets
  `AUTO_MERGE=false` + adds `needs-human` — this cannot be overridden by callers
- **Knowledge index**: `scripts/build-knowledge-index.mjs` indexes REVIEWER cards; finding
  queries in Phase 1 use `gh issue list` directly (no script dependency)
