---
description: Decompose subcommand — break a complex issue into ordered sub-issues, post FORGE:DECOMPOSED, stop
argument-hint: [issue number] [--repo GH_REPO] [--gh-flag GH_FLAG]
---

# work-on/decompose — Decomposition Subcommand

**Input**: $ARGUMENTS

**Invoked by**: `work-on.md` routing loop, when `INVESTIGATE_RESULT.decompose = YES`.
**Output**: Create sub-issues, update parent tracker, post `<!-- FORGE:DECOMPOSED -->` comment, set labels. STOP — each sub-issue runs its own /work-on.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.
**NEVER use plan mode (EnterPlanMode).**

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `RapierCraftStudios/forge`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R RapierCraftStudios/forge`)

---

## Phase D0: Load State from GitHub (MANDATORY)

Re-read current state before doing anything:

```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,milestone

# Read investigation report (required — contains decomposition plan)
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | (contains("FORGE:INVESTIGATOR") or contains("ALTERLAB:INVESTIGATOR"))) | .body'
```

**Validation**:
- If FORGE:INVESTIGATOR / ALTERLAB:INVESTIGATOR comment is absent → EXIT with `DECOMPOSE_RESULT: status: BLOCKED`, blocker: "No investigation report found — run investigate first"
- If investigation report has no Decomposition Assessment section, OR the assessment does not list any sub-issues → EXIT with `DECOMPOSE_RESULT: status: BLOCKED`, blocker: "Investigation report has no decomposition plan — re-run investigate with explicit decomposition scope"

Extract from investigation report:
- Decomposition Assessment section: list of proposed sub-issues with titles and dependencies
- Milestone (from issue metadata)
- Priority label (P0/P1/P2) from issue labels

Extract milestone title for sub-issue creation:
```bash
MILESTONE_TITLE=$(gh issue view {NUMBER} {GH_FLAG} --json milestone --jq '.milestone.title // empty')
```

---

## Phase D1: Resume Check

```bash
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | (contains("FORGE:DECOMPOSED") or contains("ALTERLAB:DECOMPOSED"))) | .body'
```

- If `<!-- FORGE:DECOMPOSED -->` or `<!-- ALTERLAB:DECOMPOSED -->` comment exists → decomposition already complete. EXIT with `DECOMPOSE_RESULT: status: ALREADY_DONE`.

---

## Phase D1.5: Collect Parent Knowledge Gist URLs

Query the parent issue's comments for `FORGE:KNOWLEDGE_GIST` annotations created by Phase 1C.5 of the investigation. These URLs will be embedded in each sub-issue body so downstream agents can fetch prior investigation context.

```bash
GIST_URLS=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | test("<!-- FORGE:KNOWLEDGE_GIST: https://")) | .body | capture("<!-- FORGE:KNOWLEDGE_GIST: (?<url>https://[^ ]+) -->").url] | unique | .[]')

if [ -n "$GIST_URLS" ]; then
  echo "Found Knowledge Gist URL(s) on parent issue #${NUMBER}:"
  echo "$GIST_URLS"
else
  echo "No Knowledge Gist annotations found on parent issue #${NUMBER} — sub-issues will not include Prior Investigation section"
fi
```

If `GIST_URLS` is non-empty, a `## Prior Investigation` section will be appended to each sub-issue body in Phase D3.

---

## Phase D2: Design Sub-Issues

From the Decomposition Assessment in the investigation report, extract:
1. Sub-issue titles (in dependency order — independent issues first)
2. Dependencies between sub-issues (if issue B depends on issue A, A is created first)
3. Brief description for each sub-issue body

For each sub-issue, prepare:
- **Title**: from investigation report's proposed sub-issue title
- **Body**: brief description of scope + `**Parent**: #{NUMBER}` + dependency note if applicable
- **Labels**: inherit priority label (P0/P1/P2) from parent; do NOT copy workflow labels
- **Milestone**: same milestone title as parent (if parent has one)

**Ordering rule**: Create independent sub-issues first. If sub-issue B depends on A, create A first so its issue number can be referenced in B's body.

---

## Phase D3: Create Sub-Issues

For each sub-issue (in dependency order):

```bash
gh issue create {GH_FLAG} \
  --title "{fix|feat|refactor}: {SUB_ISSUE_TITLE}" \
  --body "$(cat <<'SUB_BODY_EOF'
## Problem

{1-3 sentences: what this sub-issue specifically addresses. What's wrong or what needs to be built for this sub-task.}

## Root Cause (if known)

{Specific root cause for this sub-task from the parent investigation. If unknown: "Root cause unknown — investigation needed."}

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific, testable criterion}
- [ ] {Specific, testable criterion}
- [ ] No regression in {related feature}

## Context

**Parent**: #{NUMBER}
{If depends on another sub-issue: "**Depends on**: #{SUB_ISSUE_N} — {reason}"}
SUB_BODY_EOF
)" \
  --label "{PRIORITY_LABEL}" \
  --milestone "{MILESTONE_TITLE}"
```

**Append Prior Investigation section** (conditional — only if `GIST_URLS` from Phase D1.5 is non-empty):

After creating each sub-issue, append the `## Prior Investigation` section containing all parent Gist URLs. This keeps the Gist references machine-readable for downstream agents.

```bash
if [ -n "$GIST_URLS" ]; then
  SUB_BODY=$(gh issue view {SUB_NUMBER} {GH_FLAG} --json body --jq '.body')

  PRIOR_SECTION="

## Prior Investigation

Investigation findings from the parent issue are available as Knowledge Gists:
"
  while IFS= read -r url; do
    PRIOR_SECTION="${PRIOR_SECTION}
<!-- FORGE:PRIOR_GIST: ${url} -->
- ${url}"
  done <<< "$GIST_URLS"

  gh issue edit {SUB_NUMBER} {GH_FLAG} --body "${SUB_BODY}${PRIOR_SECTION}"
fi
```

Capture the created issue number from the output URL for the tracker checklist.

If `--milestone` flag fails (milestone not found by name): omit the flag and note in the FORGE:DECOMPOSED comment that milestone assignment was skipped.

---

## Phase D4: Update Parent Issue Body

Add a tracker checklist to the parent issue body showing all sub-issues in dependency order:

```bash
CURRENT_BODY=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body')

TRACKER="

---

## Sub-Issue Tracker

{if sub-issue B depends on A, note it inline}
- [ ] #{SUB_ISSUE_1_NUMBER} — {SUB_ISSUE_1_TITLE}
- [ ] #{SUB_ISSUE_2_NUMBER} — {SUB_ISSUE_2_TITLE} _(depends on #{SUB_ISSUE_1_NUMBER})_
..."

gh issue edit {NUMBER} {GH_FLAG} --body "${CURRENT_BODY}${TRACKER}"
```

---

## Phase D5: Post FORGE:DECOMPOSED Comment

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:DECOMPOSED -->
## Decomposition Complete

This issue has been broken into sub-issues. Each sub-issue runs through its own /work-on pipeline independently.

### Sub-Issues Created

{for each sub-issue, in dependency order:}
- #{SUB_ISSUE_NUMBER}: {TITLE}{if has dependency: _(depends on #{DEP_NUMBER})_}

### Decomposition Rationale

{brief summary of why this issue was decomposed and the dependency ordering chosen}

<!-- FORGE:DECOMPOSED:COMPLETE -->"
```

---

## Phase D6: Update Labels

```bash
gh issue edit {NUMBER} {GH_FLAG} \
  --add-label "workflow:decomposed" \
  --remove-label "workflow:ready-to-build,workflow:building,workflow:investigating" 2>/dev/null || true
```

---

## Phase D7: STOP

Decomposition is a terminal route for the parent issue. Each sub-issue will be picked up separately by /work-on.

Return structured output to the router:

```
DECOMPOSE_RESULT:
  status: COMPLETE | ALREADY_DONE | BLOCKED
  sub_issues: [{number}, ...]
  comment_url: {url of FORGE:DECOMPOSED comment}
  blocker: {description if status=BLOCKED}
```

**Router behavior after DECOMPOSE_RESULT**: `break` — do not continue to build/review/close for the parent issue.

---

## Output

The subcommand writes its results to GitHub (FORGE:DECOMPOSED comment + sub-issues created). The router breaks after this subcommand returns.

```
DECOMPOSE_RESULT:
  status: COMPLETE | ALREADY_DONE | BLOCKED
  sub_issues: [{number}, ...]
  comment_url: {url of posted FORGE:DECOMPOSED comment}
  blocker: {description if status=BLOCKED}
```
