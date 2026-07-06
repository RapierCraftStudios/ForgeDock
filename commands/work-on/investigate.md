---
description: Investigate a GitHub issue — validate it's real, determine root cause, post findings
argument-hint: [issue number] [--repo {owner}/{repo}] [--gh-flag "-R {owner}/{repo}"]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /work-on:investigate — Issue Investigation Subcommand

**Input**: $ARGUMENTS

Standalone investigation phase for the work-on pipeline. Validates whether an issue is real, determines root cause, posts a structured FORGE:INVESTIGATOR comment to GitHub, and updates workflow labels.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — work-on/investigate.md loaded and active. Agent is bound by this spec. -->

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)

If called from `work-on`, these are passed through. If invoked standalone, `--repo` and `--gh-flag` are resolved from `forge.yaml → project`.

---

## Phase 0.5: Memory Retrieval — Prior Run Priors <!-- Added: forge#1316 -->

**Goal**: Before investigating, retrieve the top-k relevant prior pipeline runs from the per-repo memory index. Inject confirmed priors into the investigation context so the pipeline compounds intelligence across runs.

**This phase is non-blocking** — if the memory index is absent or retrieval fails, log the reason and proceed to Phase 1A. Never stall the pipeline for memory.

**Note on Gist visibility (forge#1587)**: The memory-index Gist is created **secret** (see `close.md` Phase C5.2 — no `--public` flag). `gh gist list` and `gh gist view` operate against the authenticated user's own Gists by description/id regardless of public/secret status, so the retrieval steps below work unchanged against a secret Gist. No code change is needed here — this note exists only so a future edit doesn't reintroduce a "must be public to be readable" assumption.

### Step 1: Locate memory index Gist

The memory index is a GitHub Gist tagged `<!-- FORGE:MEMORY_INDEX: {GH_REPO} -->`. Find it:

```bash
MEMORY_INDEX_URL=$(gh gist list --limit 100 \
  --jq '.[] | select(.description | contains("FORGE:MEMORY_INDEX: {GH_REPO}")) | .url' 2>/dev/null | head -1)

MEMORY_INDEX_ID=$(gh gist list --limit 100 \
  --jq '.[] | select(.description | contains("FORGE:MEMORY_INDEX: {GH_REPO}")) | .id' 2>/dev/null | head -1)
```

If no memory index found: log `[MEMORY] No memory index for {GH_REPO} — starting fresh` and skip to Phase 1A.

### Step 2: Retrieve relevant priors (top-k similarity)

Read the memory index content:

```bash
MEMORY_CONTENT=$(gh gist view "$MEMORY_INDEX_ID" 2>/dev/null)
```

The memory index is a newline-delimited list of prior run entries, each formatted as:

```
MEMORY_ENTRY: issue={N} title="{TITLE}" domain="{DOMAIN_TAGS}" root_cause="{ROOT_CAUSE_SUMMARY}" outcome="{merged|invalid|blocked}" files="{AFFECTED_FILES}" lesson="{KEY_LESSON_ONE_LINE}" timestamp={ISO}
```

**Retrieve top-3 relevant priors** by matching against the current issue title and body:

1. Extract keywords from the current issue title: lowercase, remove stop words, keep noun/verb tokens
2. Score each memory entry: +2 for a file path overlap, +1 per keyword match in title/root_cause/lesson
3. Return the top-3 highest-scoring entries (minimum score ≥ 1 to filter noise)

If no entries score ≥ 1: log `[MEMORY] No relevant priors found` and skip to Phase 1A.

### Step 3: Inject priors into investigation context

For each retrieved prior, emit a structured block that Phase 1B can reference:

```
[MEMORY PRIOR #{RANK}]
Issue: #{issue} — {title}
Root cause: {root_cause}
Outcome: {outcome}
Key lesson: {lesson}
Affected files: {files}
```

Print these blocks to stdout before Phase 1A begins. During Phase 1B (step 3 — blame analysis and step 5 — pickaxe pass), **explicitly check whether the current issue's suspected symbol or file appears in any prior root cause or affected files**. If a match is found, cite it in the FORGE:INVESTIGATOR comment's History Findings field as a `[MEMORY PRIOR]` hit.

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

### Code Index Query (run BEFORE any grep exploration)

If `scripts/code-index.sh` exists under `{REPO_PATH}`, query the pre-built symbol/import index first. This yields deterministic answers in one tool call and avoids redundant grep exploration across agents.

```bash
# Step 0A: Ensure index is current (cache-hit on unchanged HEAD — zero cost if already built)
bash {REPO_PATH}/scripts/code-index.sh --repo-path {REPO_PATH} 2>/dev/null || true

# Step 0B: Look up the symbol or file named in the issue (replace {SYMBOL} with the relevant name)
bash {REPO_PATH}/scripts/code-index.sh query --symbol {SYMBOL} --repo-path {REPO_PATH} 2>/dev/null || true

# Step 0C: Find all callers of that symbol
bash {REPO_PATH}/scripts/code-index.sh query --callers {SYMBOL} --repo-path {REPO_PATH} 2>/dev/null || true

# Step 0D: Find all importers of an affected file
bash {REPO_PATH}/scripts/code-index.sh query --importers {AFFECTED_FILE} --repo-path {REPO_PATH} 2>/dev/null || true

# Step 0E: Get all files in the affected domain (from issue labels/body)
bash {REPO_PATH}/scripts/code-index.sh query --domain {DOMAIN_LABEL} --repo-path {REPO_PATH} 2>/dev/null || true
```

**Fallback**: If `scripts/code-index.sh` is absent or returns no results, proceed with standard grep exploration below. The index is an acceleration layer — its absence never blocks investigation.

### Investigation steps

1. **Check the right branch** — read from the branch specified in the issue body (`**Code branch**: \`{branch}\``) if present
2. **Read domain files** — start with the key files for the affected domain (use index query results from Step 0E as the file list; fall back to directory inspection if index is absent)
3. **Verify claims** — does the code actually have the problem described?
4. **Git blame** — trace when/why the relevant code was written. Run bounded, local commands (no network round-trip):
   ```bash
   # Introducing commit for each affected file (first commit that added it)
   git log --reverse --format='%h %an %ad %s' --date=short -- {affected_file} | head -1
   # Last-touch commit (most recent change)
   git log -1 --format='%h %an %ad %s' --date=short -- {affected_file}
   # Line-level blame for a specific suspect hunk, if the issue names one
   git blame -L {start},{end} -- {affected_file}
   ```
   Record the introducing commit and last-touch commit for each primary affected file — this feeds the mandatory **History findings** field in Phase 1C.
5. **Domain context discovery** (narrow scope only, 1–5 files):
   ```bash
   git log --oneline --all -30 -- {affected_files} | grep -oP '#\d+' | sort -u
   gh issue list -R {GH_REPO} --state closed --limit 8 --search "{function_name}"
   ```
   Keep only file/function-level overlap. Max 5 related issues. Everything is a hint to verify, not a fact.

   **Pickaxe pass (prior fix / regression detection)** — bounded to one pass, capped at 5 hits: search for prior additions/removals of the suspected symbol or literal string named in the issue (a function name, error string, or config key), independent of whether that fix was ever linked to a filed issue:
   ```bash
   git log -S"{suspected_symbol_or_string}" --oneline -- {affected_files} | head -5
   # Use -G instead of -S when the target is a regex pattern rather than a literal string
   git log -G"{pattern}" --oneline -- {affected_files} | head -5
   ```
   Any hit here is a candidate prior fix or reintroduced defect — read the commit body (`git show {hash}`) to confirm before citing it. Feed confirmed hits into the History findings field and let them inform the verdict (e.g. a defect being reintroduced raises severity).
6. **Determine root cause** — what's actually broken or missing?
7. **Identify affected files** — full list of files that need changes
8. **Fix-approach validation** — if the issue proposes a fix, don't adopt it as spec. Trace through the target system's middleware, auth, routing, config. Cross-domain: if fix in domain A interacts with domain B, read domain B's files too.

---

## Phase 1C: Post Investigation Comment

The comment MUST include `<!-- INVESTIGATION:COMPLETE -->` at the very end, AFTER all required sections are present. This marker signals the investigation finished successfully.

Before posting, resolve the attribution annotation link from `forge.yaml`:

```bash
ATTRIBUTION_ANNOTATION_LINK=$(grep -A5 "^attribution:" forge.yaml 2>/dev/null | grep "annotation_link:" | awk '{print $2}' | tr -d '"' || echo "false")
ANNOTATION_LINK_FOOTER=""
if [ "$ATTRIBUTION_ANNOTATION_LINK" = "true" ]; then
  ANNOTATION_LINK_FOOTER="

---
*Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)*"
fi
```

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

### History Findings
**Introducing commit**: {hash — author — date — subject, per primary affected file}
**Last touched**: {hash — author — date — subject}
**Pickaxe hits (prior fixes / regressions)**: {commit(s) found via \`git log -S\`/\`-G\`, or 'None found' — max 5}
{This field is MANDATORY — populate from the git blame + pickaxe commands in step 4/5. If a file is newly created (no history), write 'New file — no history.'}

### Recommendation
{what to build/fix, concrete and actionable}

### Related Issues
{if any found via domain context discovery, max 5}

### Decomposition Assessment
**{YES|NO}** — {reason}
{if YES: proposed sub-issues with titles and dependencies}

### Acceptance Spec
{For each item in the issue's ## Acceptance Criteria section, emit one machine-checkable check line using the format below. If the issue has no Acceptance Criteria section, derive checks from the Recommendation above. Each check MUST be specific, observable, and testable — not vague prose. Checks are consumed by build/validate Phase B6.5 as the merge gate.}

```
ACCEPTANCE_CHECK: id={ac-1} type={exists|contains|command|behavior} target={file_path|command|url} matcher={string|exit_0|regex} description={one-line human description}
ACCEPTANCE_CHECK: id={ac-2} type={exists|contains|command|behavior} target={file_path|command|url} matcher={string|exit_0|regex} description={one-line human description}
```

**Check types**:
- `exists` — assert a file or directory exists (`target` = path, `matcher` = ignored)
- `contains` — assert a file contains a string or regex (`target` = file path, `matcher` = string/regex)
- `command` — run a shell command and assert exit 0 (`target` = shell command, `matcher` = `exit_0`)
- `behavior` — assert a runtime/observable behavior via shell command (`target` = shell command, `matcher` = expected output string or regex)

**Skipping**: if the issue has no verifiable acceptance criteria and none can be derived from the recommendation, emit a single sentinel: `ACCEPTANCE_CHECK: id=ac-skip type=skipped target=none matcher=none description=No machine-checkable criteria available — human review required`
${ANNOTATION_LINK_FOOTER}
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
    # gh gist edit does not support stdin via '-'; use a temp file instead
    TMPFILE=$(mktemp --suffix=.md)
    echo "$UPDATED_INDEX" > "$TMPFILE"
    gh gist edit "$INDEX_GIST_ID" -f "$INDEX_FILENAME" "$TMPFILE" 2>/dev/null
    EDIT_EXIT=$?
    rm -f "$TMPFILE"
    if [ $EDIT_EXIT -eq 0 ]; then
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

Write machine-readable phase checkpoint (MUST execute immediately after label update, before returning):
```bash
CHECKPOINT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CHECKPOINT -->
\`\`\`json
{\"phase\": \"INVESTIGATION\", \"status\": \"COMPLETE\", \"next_phase\": \"BUILD\", \"timestamp\": \"${CHECKPOINT_TIMESTAMP}\"}
\`\`\`"
```

Return verdict to caller (work-on routing loop proceeds to build).

**CONFIRMED or PARTIAL with decompose: YES**:
```bash
gh issue edit {NUMBER} {GH_FLAG} --remove-label "workflow:investigating"
```
Do NOT add `workflow:ready-to-build` — the routing loop will invoke `work-on:decompose` based on the `decompose: YES` return value.

Write machine-readable phase checkpoint (MUST execute immediately after label update, before returning):
```bash
CHECKPOINT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:CHECKPOINT -->
\`\`\`json
{\"phase\": \"INVESTIGATION\", \"status\": \"COMPLETE\", \"next_phase\": \"DECOMPOSE\", \"timestamp\": \"${CHECKPOINT_TIMESTAMP}\"}
\`\`\`"
```

Return verdict to caller (work-on routing loop proceeds to decompose).

**INVALID**:
```bash
gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:invalid" --remove-label "workflow:investigating"
gh issue close {NUMBER} {GH_FLAG} --comment "Closing as invalid: {reason from investigation}"
```
Return INVALID to caller (work-on stops). No checkpoint written — INVALID is terminal.

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
