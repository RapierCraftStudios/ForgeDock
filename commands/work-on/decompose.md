---
description: Decompose subcommand — break a complex issue into ordered sub-issues, post FORGE:DECOMPOSED, stop
argument-hint: "[issue number] [--repo GH_REPO] [--gh-flag GH_FLAG]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/decompose — Decomposition Subcommand

**Input**: $ARGUMENTS

**Invoked by**: `work-on.md` routing loop, when `INVESTIGATE_RESULT.decompose = YES`.
**Output**: Create sub-issues, update parent tracker, post `<!-- FORGE:DECOMPOSED -->` comment, set labels. STOP — each sub-issue runs its own /work-on.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154. This file's mechanical bits (label transitions, sub-issue creation) stay at this tier because they're interleaved with the reasoning-heavy sub-issue design steps in the same `Skill()` invocation — see `work-on.md` section "Model and Effort Tiering — What Actually Applies". <!-- Added: forge#1827 -->
**NEVER use plan mode (EnterPlanMode).**

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)

---

## Phase D0: Load State from GitHub (MANDATORY)

Re-read current state before doing anything:

```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,milestone

# Read investigation report (required — contains decomposition plan)
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'
```

**Validation**:
- If FORGE:INVESTIGATOR comment is absent → EXIT with `DECOMPOSE_RESULT: status: BLOCKED`, blocker: "No investigation report found — run investigate first"
- If investigation report has no Decomposition Assessment section, OR the assessment does not list any sub-issues → EXIT with `DECOMPOSE_RESULT: status: BLOCKED`, blocker: "Investigation report has no decomposition plan — re-run investigate with explicit decomposition scope"

> **Shared Scoping Convention**: This investigation gate (blocks without a `FORGE:INVESTIGATOR` comment) is the **reference pattern** for investigation-gated issue creation across the pipeline. `milestone.md` Step 4 and `orchestrate.md` MUST apply the same principle: read code and identify all affected call sites BEFORE writing any issue body. Sub-issue bodies created in Phase D3 MUST use the Pipeline Issue Template defined in `issue.md` Phase 3D — that template is the single canonical standard for all automated issue creation. <!-- Added: forge#293 -->

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
  --jq '.[] | select(.body | contains("FORGE:DECOMPOSED")) | .body'
```

- If `<!-- FORGE:DECOMPOSED -->` comment exists → decomposition already complete. EXIT with `DECOMPOSE_RESULT: status: ALREADY_DONE`.

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

For each sub-issue (in dependency order), route creation through the `/issue` create-hook's programmatic invocation contract (`commands/issue.md` Programmatic Invocation Contract, added in #2085) instead of calling `gh issue create` directly. `/issue`'s Phase 2D runs the same `scripts/issue-dedup.sh` check this file used to run manually — the standalone pre-check below is removed; dedup is now enforced inside the create-hook on every call, with no bypass path. <!-- Changed: forge#2086 — route through /issue create-hook -->

**Compose the sub-issue body to a temp file** (avoids quoting issues when passed as `--body-file`):

```bash
SUB_TITLE="{fix|feat|refactor}: {SUB_ISSUE_TITLE}"
SUB_BODY_FILE="$(mktemp)"
cat > "$SUB_BODY_FILE" <<'SUB_BODY_EOF'
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
```

**Invoke `/issue` in programmatic mode**:

```
ISSUE_SKILL_OUTPUT=$(Skill(skill="issue", args="--title \"${SUB_TITLE}\" --body-file \"${SUB_BODY_FILE}\" --label \"{PRIORITY_LABEL}\" --milestone \"{MILESTONE_TITLE}\""))
```

`/issue` runs Phase 2D dedup, Phase 3F body validation, then creates the issue (Phase 4) — no separate pre-check needed on this side.

**Extract the created sub-issue number from the Skill output** (see `commands/issue.md` Phase 4C/4E — it echoes `Created: {url}` and reports `**#{NUMBER}**: {title}`):

```bash
# Match either the "Created: {url}" line (extract trailing /issues/N) or the "**#{NUMBER}**" bold report line.
SUB_NUMBER=$(echo "$ISSUE_SKILL_OUTPUT" | grep -oE 'issues/[0-9]+' | head -1 | grep -oE '[0-9]+')
[ -z "$SUB_NUMBER" ] && SUB_NUMBER=$(echo "$ISSUE_SKILL_OUTPUT" | grep -oE '\*\*#[0-9]+\*\*' | head -1 | grep -oE '[0-9]+')

if [ -z "$SUB_NUMBER" ]; then
  echo "WARNING: /issue did not report a created issue number for sub-issue '${SUB_TITLE}' — likely a Phase 2D dedup STOP (near-duplicate found) or a usage error. Skipping this sub-issue: do not reference it in the parent tracker or in dependent sub-issue bodies. Review the Skill output above and, if a near-duplicate exists, comment on the existing issue instead."
fi
```

If `SUB_NUMBER` is empty, treat this sub-issue as not created — do not add it to the parent tracker checklist (Phase D4) and do not reference it as a dependency in later sub-issues.

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

**Before posting, read the attribution config**:
```bash
SHOW_ATTRIBUTION=$(yq '.branding.show_attribution // "true"' forge.yaml 2>/dev/null || echo "true")
[ "$SHOW_ATTRIBUTION" = "false" ] && ATTRIBUTION_LINE="" || ATTRIBUTION_LINE="
> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)"
```

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:DECOMPOSED -->
## Decomposition Complete

This issue has been broken into sub-issues. Each sub-issue runs through its own /work-on pipeline independently.

### Sub-Issues Created

{for each sub-issue, in dependency order:}
- #{SUB_ISSUE_NUMBER}: {TITLE}{if has dependency: _(depends on #{DEP_NUMBER})_}

### Decomposition Rationale

{brief summary of why this issue was decomposed and the dependency ordering chosen}
${ATTRIBUTION_LINE}
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
