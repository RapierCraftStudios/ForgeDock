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

**Engine coverage** (forge#2379): this subcommand's `command` name (`work-on/decompose`) and completion marker (`FORGE:DECOMPOSED:COMPLETE`) are now registered as a real phase in the headless engine's phase table — `decompose` in `packages/protocol/src/phases.js`'s `PHASE_IDS`/`PHASE_MARKERS`, and the matching `decompose` entry in `bin/engine/phases.mjs`'s `PHASES` array. The engine's `investigate` phase hands off to it on `DECOMPOSE:YES` instead of terminating in place, so a headless `runIssue()` walk now actually dispatches this subcommand rather than stopping short.

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

## Phase D1.5: Resolve Parent Investigator Comment

Resolve one completed `FORGE:INVESTIGATOR` comment on the parent issue and propagate its exact repository-scoped identity. The numeric comment resource is authoritative; the rendered GitHub URL is informational. The request is intentionally bounded to the first 100 comments so a missing older comment fails closed rather than triggering an unbounded scan.

```bash
PARENT_CONTEXT_COMMENT_ID=$(gh api "repos/{GH_REPO}/issues/{NUMBER}/comments?per_page=100&page=1" \
  --jq '[.[] | select((.body | contains("<!-- FORGE:INVESTIGATOR -->")) and (.body | contains("<!-- INVESTIGATION:COMPLETE -->"))) | .id] | last // empty')

# WIRE:PROVEN — a missing or malformed parent comment fails closed before any child is created.
if ! [[ "$PARENT_CONTEXT_COMMENT_ID" =~ ^[0-9]+$ ]]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:DECOMPOSE:BLOCKED -->
## Decomposition Blocked

The parent issue has no bounded, completed `FORGE:INVESTIGATOR` comment resource to propagate. Decomposition will not guess from other comments or external artifacts; re-run investigation and retry.

<!-- FORGE:DECOMPOSE:BLOCKED:COMPLETE -->"
  gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human"
  echo "BLOCKED: completed parent investigator comment not found in the bounded comment page"
  exit 1
fi

PARENT_CONTEXT_REFERENCE="<!-- FORGE:PARENT_CONTEXT: repo={GH_REPO} issue={NUMBER} comment=${PARENT_CONTEXT_COMMENT_ID} marker=FORGE:INVESTIGATOR -->"
PARENT_CONTEXT_URL="https://github.com/{GH_REPO}/issues/{NUMBER}#issuecomment-${PARENT_CONTEXT_COMMENT_ID}"
echo "Parent context reference: ${PARENT_CONTEXT_REFERENCE}"
echo "Parent context URL: ${PARENT_CONTEXT_URL}"
```

`PARENT_CONTEXT_REFERENCE` and `PARENT_CONTEXT_URL` are appended once to each child body in Phase D3. No Gist URL or retired prior-investigation annotation is emitted.

---

## Phase D2: Design Sub-Issues

From the Decomposition Assessment in the investigation report, extract:
1. Sub-issue titles (in dependency order — independent issues first)
2. Dependencies between sub-issues (if issue B depends on issue A, A is created first)
3. Brief description for each sub-issue body

For each sub-issue, prepare:
- **Title**: from investigation report's proposed sub-issue title, including the final `{fix|feat|refactor}: ` prefix used in Phase D3
- **Body**: brief description of scope + `**Parent**: #{NUMBER}` + dependency note if applicable
- **Labels**: inherit priority label (P0/P1/P2) from parent; do NOT copy workflow labels
- **Milestone**: same milestone title as parent (if parent has one)

**Ordering rule**: Create independent sub-issues first. If sub-issue B depends on A, create A first so its issue number can be referenced in B's body.

---

## Phase D2.5: Equivalent Set Check

Before creating any sub-issue, check whether the complete planned title set already exists for this parent. This covers an interrupted earlier decomposition: its child issues may exist even though it never reached the `FORGE:DECOMPOSED` comment checked in D1.

```bash
# SUB_TITLES contains the final, ordered titles prepared in D2.
EXPECTED_TITLES=$(printf '%s\n' "${SUB_TITLES[@]}" | jq -Rsc 'split("\n") | map(select(length > 0)) | sort')
PARENT_SUB_ISSUES=$(gh issue list {GH_FLAG} --state all \
  --search "\"**Parent**: #{NUMBER}\" in:body" --limit 100 --json number,title,body)

# Keep the earliest child for each title as canonical. This also collapses a
# previously duplicated set without creating a third copy.
CANONICAL_SUB_ISSUES=$(jq --arg parent "**Parent**: #{NUMBER}" --argjson expected "$EXPECTED_TITLES" '
  ([.[] | select(.body | contains($parent)) | {number, title}]
    | sort_by(.number) | group_by(.title) | map(.[0])) as $canonical
  | ($canonical | map(.title) | sort) as $actual
  | if $actual == $expected then $canonical else empty end
' <<< "$PARENT_SUB_ISSUES")
```

If `CANONICAL_SUB_ISSUES` is non-empty, the decomposition has already created an equivalent set. Do **not** create issues, edit the parent body, or post another decomposition comment. Preserve those original sub-issues and EXIT with:

```
DECOMPOSE_RESULT:
  status: ALREADY_DONE
  sub_issues: {CANONICAL_SUB_ISSUES}
```

If no exact title-set match exists, continue. A partial set is not equivalent: let `/issue` dedup protect its existing children while creating only the missing work.

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

**Append Parent Context reference**:

After creating each sub-issue, append the exact bounded parent-comment reference. This is the single machine-readable context handoff consumed by build context; the URL is informational and the numeric comment resource remains authoritative.

```bash
SUB_BODY=$(gh issue view {SUB_NUMBER} {GH_FLAG} --json body --jq '.body')
PARENT_CONTEXT_SECTION="

## Parent Context

${PARENT_CONTEXT_REFERENCE}
Parent investigator comment: ${PARENT_CONTEXT_URL}
"
gh issue edit {SUB_NUMBER} {GH_FLAG} --body "${SUB_BODY}${PARENT_CONTEXT_SECTION}"
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
