---
description: Plain-English breakdown of what happened on a GitHub issue — translates FORGE pipeline annotations into a human-readable narrative for teammates and PMs
argument-hint: <issue number or PR#N> [--repo prefix]
install: extras
---

# /explain — FORGE Annotation Translator

**Input**: $ARGUMENTS

You translate the FORGE pipeline's machine-readable annotations on a GitHub issue or PR into a clear, plain-English narrative that anyone can understand — no pipeline knowledge required. This is a read-only command: it never writes to GitHub, never changes labels, and never modifies any state.

Agent policy: see `commands/shared/agent-policies.md` (default-tier model resolution + plan-mode ban) if not already in context.

---

## Config Preamble

Read `forge.yaml` from the project root before executing any phase:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ -f "$CONFIG_FILE" ]; then
  GH_OWNER=$(yq '.project.owner' "$CONFIG_FILE")
  GH_REPO_NAME=$(yq '.project.repo' "$CONFIG_FILE")
  GH_REPO="${GH_OWNER}/${GH_REPO_NAME}"
  GH_FLAG="-R $GH_REPO"
  REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
else
  echo "WARNING: forge.yaml not found — using placeholder values"
  GH_REPO="your-org/your-repo"
  GH_FLAG="-R $GH_REPO"
  REPO_PATH="./"
fi
```

---

## Phase 1: Parse Input

Supported input forms:

| Input | Example | What it explains |
|-------|---------|-----------------|
| Issue number | `616` | GitHub issue #616 |
| Issue prefix | `#616` | GitHub issue #616 |
| PR prefix | `PR#42` or `PR 42` | Pull request #42 |
| Multi-repo prefix | `mcp:616` | Issue #616 in the `mcp` satellite repo |

```bash
INPUT="$ARGUMENTS"

# Strip leading # if present
INPUT=$(echo "$INPUT" | sed 's/^#//')

# Check for repo prefix (e.g. "mcp:616")
REPO_PREFIX=$(echo "$INPUT" | grep -oE '^[a-z]+:' | sed 's/://')
if [ -n "$REPO_PREFIX" ]; then
  INPUT=$(echo "$INPUT" | sed "s/^${REPO_PREFIX}://")
  # Look up satellite repo from forge.yaml
  SAT_REPO=$(yq ".repos.satellites[] | select(.prefix == \"$REPO_PREFIX\") | .repo" "$CONFIG_FILE" 2>/dev/null)
  if [ -n "$SAT_REPO" ]; then
    GH_REPO="$SAT_REPO"
    GH_FLAG="-R $GH_REPO"
  else
    echo "Unknown repo prefix: $REPO_PREFIX — using default repo"
  fi
fi

# Determine if this is an issue or PR
IS_PR=false
if echo "$INPUT" | grep -qiE '^pr[[:space:]]*#?[[:space:]]*[0-9]+$'; then
  NUMBER=$(echo "$INPUT" | grep -oE '[0-9]+')
  IS_PR=true
else
  NUMBER=$(echo "$INPUT" | grep -oE '^[0-9]+')
fi

if [ -z "$NUMBER" ]; then
  echo "ERROR: Could not parse a number from input: $ARGUMENTS"
  echo "Usage: /explain 616  or  /explain PR#42  or  /explain mcp:616"
  exit 1
fi
```

---

## Phase 2: Fetch GitHub Artifacts

Fetch the issue or PR metadata and all its comments.

```bash
if [ "$IS_PR" = "true" ]; then
  # Fetch PR details
  METADATA=$(gh pr view "$NUMBER" $GH_FLAG --json number,title,body,state,mergedAt,baseRefName,headRefName,author,labels 2>/dev/null)
  if [ -z "$METADATA" ]; then
    echo "ERROR: PR #$NUMBER not found in $GH_REPO"
    exit 1
  fi
  TITLE=$(echo "$METADATA" | jq -r '.title')
  STATE=$(echo "$METADATA" | jq -r '.state')
  COMMENTS=$(gh api repos/$GH_REPO/pulls/$NUMBER/comments --jq '.[].body' 2>/dev/null)
  ISSUE_COMMENTS=$(gh api repos/$GH_REPO/issues/$NUMBER/comments --jq '.[].body' 2>/dev/null)
  ALL_COMMENTS=$(printf '%s\n%s' "$COMMENTS" "$ISSUE_COMMENTS")
  # Also check if this PR closes an issue, and fetch that issue's comments
  CLOSES_ISSUE=$(gh pr view "$NUMBER" $GH_FLAG --json body --jq '.body' 2>/dev/null | grep -oiE 'Closes[[:space:]]+#[0-9]+' | grep -oE '[0-9]+' | head -1)
  if [ -n "$CLOSES_ISSUE" ]; then
    ISSUE_COMMENTS_FROM_LINKED=$(gh api repos/$GH_REPO/issues/$CLOSES_ISSUE/comments --jq '.[].body' 2>/dev/null)
    ALL_COMMENTS=$(printf '%s\n%s' "$ALL_COMMENTS" "$ISSUE_COMMENTS_FROM_LINKED")
  fi
else
  # Fetch issue details
  METADATA=$(gh issue view "$NUMBER" $GH_FLAG --json number,title,body,state,labels,milestone 2>/dev/null)
  if [ -z "$METADATA" ]; then
    echo "ERROR: Issue #$NUMBER not found in $GH_REPO"
    exit 1
  fi
  TITLE=$(echo "$METADATA" | jq -r '.title')
  STATE=$(echo "$METADATA" | jq -r '.state')
  ALL_COMMENTS=$(gh api repos/$GH_REPO/issues/$NUMBER/comments --jq '.[].body' 2>/dev/null)
fi

if [ -z "$ALL_COMMENTS" ]; then
  echo "## #$NUMBER — $TITLE"
  echo ""
  echo "**Status**: ${STATE}"
  echo ""
  echo "No FORGE pipeline annotations found on this issue. It may not have been processed by the pipeline yet, or it was handled manually."
  exit 0
fi
```

---

## Phase 3: Parse FORGE Annotations

Extract each annotation block from the comments. Each `<!-- FORGE:TYPE -->` block is a structured comment posted by the pipeline agent.

```bash
# Helper: extract comment body containing a FORGE marker
extract_forge() {
  local marker="$1"
  echo "$ALL_COMMENTS" | awk "
    /<!-- ${marker}(:[A-Z]*)? -->/{found=1; buffer=\"\"}
    found {buffer = buffer \$0 ORS}
    /<!-- ${marker}[^>]*:COMPLETE -->/{if(found){print buffer; found=0; buffer=\"\"}}
    END {if(found && length(buffer)>0) print buffer}
  "
}

INVESTIGATOR=$(echo "$ALL_COMMENTS" | awk '/<!-- FORGE:INVESTIGATOR -->/{found=1} found{print} /<!-- INVESTIGATION:COMPLETE -->/{found=0}')
CONTRACT=$(echo "$ALL_COMMENTS" | grep -A 1000 "<!-- FORGE:CONTRACT -->" | head -80)
CONTEXT_COMMENT=$(echo "$ALL_COMMENTS" | grep -A 1000 "<!-- FORGE:CONTEXT -->" | head -80)
ARCHITECT=$(echo "$ALL_COMMENTS" | grep -A 1000 "<!-- FORGE:ARCHITECT -->" | head -100)
BUILDER=$(echo "$ALL_COMMENTS" | grep -A 1000 "<!-- FORGE:BUILDER -->" | head -100)
TRAJECTORY=$(echo "$ALL_COMMENTS" | grep -A 1000 "<!-- FORGE:TRAJECTORY -->" | head -60)
DECOMPOSED=$(echo "$ALL_COMMENTS" | grep -A 1000 "<!-- FORGE:DECOMPOSED -->" | head -40)
```

---

## Phase 4: Produce Plain-English Narrative

Output a clean, human-readable explanation. Do NOT include raw HTML comment markers in the output. Translate each FORGE annotation section into plain English.

```
## What happened on #$NUMBER: $TITLE
```

### 4A: Issue at a glance

Show the basics: title, current state, labels, and a one-sentence summary from the issue body.

```bash
LABELS=$(echo "$METADATA" | jq -r '[.labels[].name] | join(", ")' 2>/dev/null || echo "none")
BODY_SUMMARY=$([ "$IS_PR" = "true" ] && \
  gh pr view "$NUMBER" $GH_FLAG --json body --jq '.body' 2>/dev/null | head -5 || \
  gh issue view "$NUMBER" $GH_FLAG --json body --jq '.body' 2>/dev/null | head -5)

echo "**Type**: $([ "$IS_PR" = "true" ] && echo "Pull Request" || echo "Issue") #$NUMBER"
echo "**Status**: $STATE"
echo "**Labels**: $LABELS"
echo ""
```

### 4B: Investigation

If a `FORGE:INVESTIGATOR` annotation exists, extract and present:
- What the pipeline investigated
- What it found (verdict and confidence)
- Root cause (in plain English)
- What files were affected

```
### What Was Investigated

Read the FORGE:INVESTIGATOR comment and present:
- **Verdict**: was the issue real? (Confirmed/Partial/Invalid) and confidence level
- **What was found**: the actual state of the code, in plain English
- **Root cause**: what specifically was wrong or missing
- **Affected files**: which files the pipeline identified as needing changes

If not present: "Investigation not yet run."
```

### 4C: What the team decided to build

If a `FORGE:CONTRACT` annotation exists, extract:
- Task type (Bug Fix / Feature / Refactor)
- The proposed approach in plain language
- Key deliverables (what files were changed and why)
- What was explicitly left out of scope

```
### What Was Planned

Read the FORGE:CONTRACT comment and present:
- **Task type**: e.g. "Feature — adding a new slash command"
- **Approach**: the implementation strategy chosen, in one to two sentences
- **Deliverables**: a plain list of files changed and the reason for each
- **Out of scope**: what the team consciously decided NOT to do

If not present: "No build contract posted — build phase not started."
```

### 4D: Implementation context reviewed

If a `FORGE:CONTEXT` annotation exists, summarize:
- Known pitfalls that were checked before coding
- Relevant past bugs or review findings
- Related code paths that needed to stay consistent

```
### What History Was Checked

Read the FORGE:CONTEXT comment and present:
- Any known pitfalls or gotchas the team reviewed
- Past bugs or review findings relevant to the changed files
- Related code the team needed to keep consistent

If not present: "No context review posted." (Omit this section entirely if absent to keep the output concise.)
```

### 4E: Architecture decisions

If a `FORGE:ARCHITECT` annotation exists, extract:
- The ordered implementation plan
- Key architectural decisions
- Risks identified and how they were mitigated

```
### How the Implementation Was Planned

Read the FORGE:ARCHITECT comment and present:
- The implementation order chosen and why
- Key architectural decisions (e.g. "Schema changes before logic, to avoid import errors")
- Risks identified and their mitigations

If not present: "No architecture plan posted." (Omit this section if absent.)
```

### 4F: What was built

If a `FORGE:BUILDER` annotation exists, extract:
- The branch and commit(s)
- What was actually changed (file list)
- Whether each acceptance criterion passed
- Any testing scenarios the team identified

```
### What Was Built

Read the FORGE:BUILDER comment and present:
- **Branch**: the feature/fix branch name
- **Files changed**: plain list of what was modified and why
- **Acceptance criteria**: which criteria passed, which (if any) did not
- **Testing checklist**: scenarios the reviewer should verify

If not present: "Build not yet completed."
```

### 4G: Pipeline performance

If a `FORGE:TRAJECTORY` annotation exists, extract:
- Which phases ran and whether each succeeded
- Any anomalies or skipped steps
- The overall outcome (merged, invalid, needs-human)

```
### How the Pipeline Performed

Read the FORGE:TRAJECTORY comment and present:
- A simple table or bullet list: which phases ran (Investigation / Build / Review / Close) and the result for each
- Any phases that were skipped and why
- Anomalies flagged (e.g. quality gate needed multiple iterations)
- Final outcome

If not present: "Pipeline trajectory not yet recorded — issue is still in progress."
```

### 4H: Sub-task breakdown (if decomposed)

If a `FORGE:DECOMPOSED` annotation exists:

```
### How the Work Was Split

This issue was decomposed into sub-tasks:
Read the FORGE:DECOMPOSED comment and list the sub-issues created with their titles and dependency order.
```

### 4I: Final summary

Close with a one-paragraph summary covering:
- What problem was solved (or found to be invalid)
- How it was solved
- Current status

```
### Summary

{One to three sentences covering: the problem, the solution, and the current status.}
```

---

## Output Format Rules

When producing the narrative, follow these rules:

1. **Never include raw HTML comment markers** — no `<!-- FORGE:* -->` tags in the output
2. **Use plain language** — avoid pipeline jargon like "investigator", "quality gate", "worktree". Say "the team checked", "the code was reviewed", "the change was validated"
3. **Omit empty sections** — if an annotation is absent, skip its section (don't show "not run" unless it's meaningful context)
4. **Verdicts in plain English** — "CONFIRMED" → "Yes, the issue was real"; "INVALID" → "On investigation, no problem was found"; "PARTIAL" → "The issue was partially confirmed"
5. **Confidence in plain English** — "HIGH" → "with high confidence"; "MEDIUM" → "with moderate confidence"; "LOW" → "with low confidence — further review may be needed"
6. **File paths as code** — wrap file paths in backticks
7. **Keep it concise** — the goal is a 2-minute read for a non-technical stakeholder, not a full audit report

---

## Error Handling

| Situation | Response |
|-----------|----------|
| Issue not found | Print error: "Issue #N not found in {GH_REPO}" |
| PR not found | Print error: "PR #N not found in {GH_REPO}" |
| No FORGE annotations present | Print: "No pipeline annotations found on #N. It may not have run through the ForgeDock pipeline yet." |
| Unknown repo prefix | Warn and fall back to default repo |
| `forge.yaml` missing | Warn with placeholder values; still attempt to run if `$ARGUMENTS` contains a fully-qualified `owner/repo:N` reference |
