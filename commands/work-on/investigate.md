---
description: Investigate a GitHub issue — validate it's real, determine root cause, post findings
argument-hint: [issue number] [--repo {owner}/{repo}] [--gh-flag "-R {owner}/{repo}"]
---

# /work-on:investigate — Issue Investigation Subcommand

**Input**: $ARGUMENTS

Standalone investigation phase for the work-on pipeline. Validates whether an issue is real, determines root cause, posts a structured FORGE:INVESTIGATOR comment to GitHub, and updates workflow labels.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.
**NEVER use plan mode (EnterPlanMode).**

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)

If called from `work-on`, these are passed through. If invoked standalone, defaults apply.

---

## Phase 1A: Load Issue & Check Resume State

```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,comments
gh api repos/{GH_REPO}/issues/{NUMBER}/comments --jq '.[] | {id: .id, body: .body}'
```

**Resume logic**:
- If `<!-- FORGE:INVESTIGATOR -->` comment exists AND `<!-- INVESTIGATION:COMPLETE -->` is present in the SAME comment → investigation already complete, EXIT (return existing verdict to caller)
- If `<!-- FORGE:INVESTIGATOR -->` comment exists BUT `<!-- INVESTIGATION:COMPLETE -->` is ABSENT → investigation was interrupted, delete the partial comment and restart:
  ```bash
  gh api repos/{GH_REPO}/issues/comments/{COMMENT_ID} -X DELETE
  ```
- If no investigator comment → proceed with fresh investigation

**Set label**:
```bash
gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:investigating"
gh issue edit {NUMBER} {GH_FLAG} --remove-label "workflow:ready-to-build,workflow:building,workflow:in-review" 2>/dev/null || true
```

---

## Phase 1B: Investigate

**Mission**: Validate whether the issue is real. Assume description is wrong until proven otherwise.

### Resolve target repo and branch

The target repo is `{GH_REPO}` (resolved from `forge.yaml → project`). The working directory is `{REPO_PATH}` (resolved from `forge.yaml → paths.root`).

**Domain-to-files mapping**: The repo's domain structure depends on the project. Before investigating, read the issue body and labels to identify the affected domain. Then look at the repo's directory structure under `{REPO_PATH}` to locate relevant files. Common entry points:
- Command/prompt files: `commands/`, `.claude/commands/`
- Backend services: any `services/`, `routers/`, `core/` directories
- Frontend: any `web/`, `frontend/`, `src/` directories
- Infrastructure: `.github/workflows/`, `docker-compose*.yml`, `infra/`
- Config: `forge.yaml`, `.env.example`, any `config/` directory

If the issue specifies a **Code branch** (`**Code branch**: \`{branch}\``), check out that branch — the affected files may not be on the default branch.

### Investigation steps

1. **Check the right branch** — read from the branch specified in the issue body (`**Code branch**: \`{branch}\``) if present
2. **Read domain files** — start with the key files for the affected domain
3. **Verify claims** — does the code actually have the problem described?
4. **Git blame** — trace when/why the relevant code was written
5. **Domain context discovery** (narrow scope only, 1–5 files):
   ```bash
   git log --oneline --all -30 -- {affected_files} | grep -oP '#\d+' | sort -u
   gh issue list -R {GH_REPO} --state closed --limit 8 --search "{function_name}"
   ```
   Keep only file/function-level overlap. Max 5 related issues. Everything is a hint to verify, not a fact.
6. **Determine root cause** — what's actually broken or missing?
7. **Identify affected files** — full list of files that need changes
8. **Fix-approach validation** — if the issue proposes a fix, don't adopt it as spec. Trace through the target system's middleware, auth, routing, config. Cross-domain: if fix in domain A interacts with domain B, read domain B's files too.

---

## Phase 1C: Post Investigation Comment

The comment MUST include `<!-- INVESTIGATION:COMPLETE -->` at the very end, AFTER all required sections are present. This marker signals the investigation finished successfully.

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:INVESTIGATOR -->
## Investigation Report

**Verdict**: {CONFIRMED|PARTIAL|INVALID}
**Confidence**: {HIGH|MEDIUM|LOW}
**Severity**: {CRITICAL|HIGH|MEDIUM|LOW}
**Task Type**: {Bug Fix|Feature|Refactor|Maintenance|Investigation}

### What Was Claimed
{summary of what the issue describes}

### What We Found
{what the code actually shows}

### Root Cause
{specific root cause, with file:line references where applicable}

### Affected Files
{numbered list of files that need changes}

### Evidence
{specific findings — function names, line numbers, behavior observed}

### Recommendation
{what to build/fix, concrete and actionable}

### Related Issues
{if any found via domain context discovery, max 5}

### Decomposition Assessment
**{YES|NO}** — {reason}
{if YES: proposed sub-issues with titles and dependencies}

<!-- INVESTIGATION:COMPLETE -->"
```

---

## Phase 1C.5: Create Knowledge Gist

**Skip if**: A comment containing `<!-- FORGE:KNOWLEDGE_GIST:` already exists on this issue.

After the FORGE:INVESTIGATOR comment is posted, create a structured GitHub Gist containing the investigation findings. The Gist provides a stable, linkable URL that downstream issues (siblings, children) can reference.

**This phase is non-blocking** — if Gist creation fails (auth error, rate limit, network), log the failure and continue to Phase 1D. Do NOT stall the pipeline for a knowledge artifact.

### Step 1: Check for existing Gist annotation

```bash
EXISTING_GIST=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:KNOWLEDGE_GIST:")) | .body' | head -1)

if [ -n "$EXISTING_GIST" ]; then
  echo "Knowledge Gist already exists — skipping creation"
  # → Continue to Phase 1D
fi
```

### Step 2: Extract investigation content

```bash
INVESTIGATION_BODY=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' | head -1)
```

### Step 3: Generate filename and metadata

```bash
ISSUE_TITLE=$(gh issue view {NUMBER} {GH_FLAG} --json title --jq '.title')
MILESTONE=$(gh issue view {NUMBER} {GH_FLAG} --json milestone --jq '.milestone.title // "none"')

# Generate slug from title: lowercase, replace non-alphanumeric with hyphens, collapse, truncate
SLUG=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//' | cut -c1-40)

# Derive repo short name from GH_REPO (e.g., "acme-org/acme-platform" → "acme-platform")
REPO_SHORT=$(echo "{GH_REPO}" | sed 's|.*/||')

GIST_FILENAME="${REPO_SHORT}_${NUMBER}_${SLUG}.md"
```

### Step 4: Build Gist content with frontmatter

Extract verdict, task type, and confidence from the investigation body, then compose the Gist:

```bash
VERDICT=$(echo "$INVESTIGATION_BODY" | grep -oP '(?<=\*\*Verdict\*\*: )\w+' | head -1)
TASK_TYPE=$(echo "$INVESTIGATION_BODY" | grep -oP '(?<=\*\*Task Type\*\*: ).+' | head -1)
CONFIDENCE=$(echo "$INVESTIGATION_BODY" | grep -oP '(?<=\*\*Confidence\*\*: )\w+' | head -1)
SEVERITY=$(echo "$INVESTIGATION_BODY" | grep -oP '(?<=\*\*Severity\*\*: )\w+' | head -1)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

GIST_CONTENT=$(cat <<GIST_EOF
---
issue: ${NUMBER}
repo: {GH_REPO}
milestone: ${MILESTONE}
verdict: ${VERDICT}
task_type: ${TASK_TYPE}
confidence: ${CONFIDENCE}
severity: ${SEVERITY}
created: ${TIMESTAMP}
source: FORGE:INVESTIGATOR
---

# Investigation: ${ISSUE_TITLE} (#${NUMBER})

${INVESTIGATION_BODY}
GIST_EOF
)
```

### Step 5: Create secret Gist

```bash
GIST_URL=$(echo "$GIST_CONTENT" | gh gist create \
  -f "$GIST_FILENAME" \
  -d "Investigation findings for ${REPO_SHORT}#${NUMBER}: ${ISSUE_TITLE}" \
  - 2>/dev/null)

if [ -z "$GIST_URL" ]; then
  echo "WARNING: Gist creation failed — continuing without knowledge artifact"
  # → Continue to Phase 1D (non-blocking)
fi
```

### Step 6: Post Gist URL annotation

```bash
if [ -n "$GIST_URL" ]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:KNOWLEDGE_GIST: ${GIST_URL} -->
## Knowledge Gist Created

Investigation findings persisted as a linkable artifact.

**Gist**: ${GIST_URL}
**Filename**: \`${GIST_FILENAME}\`

_This Gist can be referenced by downstream issues for context transfer._"
fi
```

→ Continue to Phase 1C.6.

---

## Phase 1C.6: Update Milestone Index Gist

**Skip if**: The issue has no milestone (`MILESTONE` is `"none"` or empty).

After the per-issue Knowledge Gist is created (Phase 1C.5), update the milestone-level index Gist. The index aggregates all investigation Gist URLs for a milestone into a single reference document. Any agent working on a milestone issue can fetch one index URL to get full context across all investigations.

**This phase is non-blocking** — if index creation or update fails, log the warning and continue to Phase 1D. Do NOT stall the pipeline for the index.

### Step 1: Check milestone and skip conditions

```bash
MILESTONE=$(gh issue view {NUMBER} {GH_FLAG} --json milestone --jq '.milestone.title // "none"')
MILESTONE_NUM=$(gh issue view {NUMBER} {GH_FLAG} --json milestone --jq '.milestone.number // empty')

if [ "$MILESTONE" = "none" ] || [ -z "$MILESTONE_NUM" ]; then
  echo "No milestone on issue #${NUMBER} — skipping milestone index update"
  # → Continue to Phase 1D
fi
```

### Step 2: Read milestone description for existing index

```bash
MILESTONE_DESC=$(gh api repos/{GH_REPO}/milestones/${MILESTONE_NUM} --jq '.description // ""')
EXISTING_INDEX_URL=$(echo "$MILESTONE_DESC" | grep -oP '(?<=<!-- FORGE:MILESTONE_INDEX: )https://[^ ]+(?= -->)' | head -1)
```

### Step 3: Build index entry for this issue

```bash
ISSUE_TITLE=$(gh issue view {NUMBER} {GH_FLAG} --json title --jq '.title')
VERDICT=$(echo "$INVESTIGATION_BODY" | grep -oP '(?<=\*\*Verdict\*\*: )\w+' | head -1)
SEVERITY=$(echo "$INVESTIGATION_BODY" | grep -oP '(?<=\*\*Severity\*\*: )\w+' | head -1)
TASK_TYPE=$(echo "$INVESTIGATION_BODY" | grep -oP '(?<=\*\*Task Type\*\*: ).+' | head -1)
RECOMMENDATION=$(echo "$INVESTIGATION_BODY" | sed -n '/^### Recommendation/,/^### /p' | head -5 | tail -n +2 | tr '\n' ' ' | cut -c1-120)

# GIST_URL comes from Phase 1C.5 (may be empty if Gist creation failed)
INDEX_ENTRY="| #${NUMBER} | ${ISSUE_TITLE} | ${VERDICT} / ${SEVERITY} | ${TASK_TYPE} | ${GIST_URL:-_no gist_} | ${RECOMMENDATION:-_see investigation_} |"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
```

### Step 4a: Create new index Gist (no existing index)

```bash
if [ -z "$EXISTING_INDEX_URL" ]; then
  MILESTONE_SLUG=$(echo "$MILESTONE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//' | cut -c1-40)
  REPO_SHORT=$(echo "{GH_REPO}" | sed 's|.*/||')
  INDEX_FILENAME="${REPO_SHORT}_milestone_${MILESTONE_SLUG}_index.md"

  INDEX_CONTENT=$(cat <<INDEX_EOF
---
type: milestone-index
repo: {GH_REPO}
milestone: ${MILESTONE}
milestone_number: ${MILESTONE_NUM}
last_updated: ${TIMESTAMP}
---

# Milestone Index: ${MILESTONE}

Investigation findings index for all issues in this milestone.

| Issue | Title | Verdict / Severity | Task Type | Gist URL | Key Finding |
|-------|-------|--------------------|-----------|----------|-------------|
${INDEX_ENTRY}
INDEX_EOF
)

  INDEX_URL=$(echo "$INDEX_CONTENT" | gh gist create \
    -f "$INDEX_FILENAME" \
    -d "Milestone index: ${MILESTONE} (${REPO_SHORT})" \
    - 2>/dev/null)

  if [ -z "$INDEX_URL" ]; then
    echo "WARNING: Milestone index Gist creation failed — continuing without index"
    # → Continue to Phase 1D (non-blocking)
  fi
fi
```

### Step 4b: Update existing index Gist (index already exists)

```bash
if [ -n "$EXISTING_INDEX_URL" ]; then
  INDEX_GIST_ID=$(echo "$EXISTING_INDEX_URL" | grep -oP '[a-f0-9]{20,}' | tail -1)

  if [ -z "$INDEX_GIST_ID" ]; then
    echo "WARNING: Could not extract Gist ID from index URL — skipping update"
    # → Continue to Phase 1D
  fi

  # Fetch current index content
  CURRENT_INDEX=$(gh gist view "$INDEX_GIST_ID" --raw 2>/dev/null)

  if [ -z "$CURRENT_INDEX" ]; then
    echo "WARNING: Could not fetch existing index Gist — skipping update"
    # → Continue to Phase 1D
  fi

  # Check if this issue is already in the index
  if echo "$CURRENT_INDEX" | grep -q "| #${NUMBER} |"; then
    echo "Issue #${NUMBER} already in milestone index — skipping"
    INDEX_URL="$EXISTING_INDEX_URL"
    # → Continue to Phase 1D
  else
    # Update the last_updated timestamp in frontmatter
    UPDATED_INDEX=$(echo "$CURRENT_INDEX" | sed "s|^last_updated:.*|last_updated: ${TIMESTAMP}|")

    # Append new entry to the table
    UPDATED_INDEX="${UPDATED_INDEX}
${INDEX_ENTRY}"

    # Determine the filename from the existing Gist
    INDEX_FILENAME=$(gh api gists/${INDEX_GIST_ID} --jq '.files | keys[0]' 2>/dev/null)
    if [ -z "$INDEX_FILENAME" ]; then
      INDEX_FILENAME="milestone_index.md"
    fi

    # Update the Gist
    echo "$UPDATED_INDEX" | gh gist edit "$INDEX_GIST_ID" -f "$INDEX_FILENAME" - 2>/dev/null
    if [ $? -eq 0 ]; then
      INDEX_URL="$EXISTING_INDEX_URL"
      echo "Milestone index Gist updated: ${INDEX_URL}"
    else
      echo "WARNING: Failed to update milestone index Gist — continuing"
      INDEX_URL="$EXISTING_INDEX_URL"
    fi
  fi
fi
```

### Step 5: Store index URL in milestone description

```bash
if [ -n "$INDEX_URL" ]; then
  if [ -n "$EXISTING_INDEX_URL" ]; then
    # Replace existing annotation with updated URL (in case Gist was recreated)
    UPDATED_DESC=$(echo "$MILESTONE_DESC" | sed "s|<!-- FORGE:MILESTONE_INDEX: [^ ]* -->|<!-- FORGE:MILESTONE_INDEX: ${INDEX_URL} -->|")
  else
    # Append annotation to milestone description
    UPDATED_DESC="${MILESTONE_DESC}

<!-- FORGE:MILESTONE_INDEX: ${INDEX_URL} -->"
  fi

  gh api repos/{GH_REPO}/milestones/${MILESTONE_NUM} \
    -X PATCH \
    -f description="$UPDATED_DESC" 2>/dev/null

  if [ $? -eq 0 ]; then
    echo "Milestone description updated with index URL: ${INDEX_URL}"
  else
    echo "WARNING: Failed to update milestone description — index URL not stored"
  fi
fi
```

→ Continue to Phase 1D.

---

## Phase 1D: Update Labels & Return Verdict

**CONFIRMED or PARTIAL with decompose: NO**:
```bash
gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:ready-to-build" --remove-label "workflow:investigating"
```
Return verdict to caller (work-on routing loop proceeds to build).

**CONFIRMED or PARTIAL with decompose: YES**:
```bash
gh issue edit {NUMBER} {GH_FLAG} --remove-label "workflow:investigating"
```
Do NOT add `workflow:ready-to-build` — the routing loop will invoke `work-on:decompose` based on the `decompose: YES` return value.
Return verdict to caller (work-on routing loop proceeds to decompose).

**INVALID**:
```bash
gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:invalid" --remove-label "workflow:investigating"
gh issue close {NUMBER} {GH_FLAG} --comment "Closing as invalid: {reason from investigation}"
```
Return INVALID to caller (work-on stops).

---

## Output

The subcommand writes its results to GitHub (FORGE:INVESTIGATOR comment). Output this structured block — the routing loop in `work-on.md` will read this result, re-evaluate state, and continue to the next phase. This subcommand is complete; control returns to the router's loop iteration.

```
INVESTIGATE_RESULT:
  verdict: {CONFIRMED|PARTIAL|INVALID}
  confidence: {HIGH|MEDIUM|LOW}
  decompose: {YES|NO}
  comment_url: {url of posted comment}
  gist_url: {url of knowledge gist, or null if creation failed/skipped}
  milestone_index_url: {url of milestone index gist, or null if no milestone/creation failed}
```
