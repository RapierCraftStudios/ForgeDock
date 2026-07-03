---
description: Pre-implementation context gathering — surfaces historical findings, bug patterns, and related code paths before the builder writes any code
argument-hint: [issue number] [affected_files...] [--functions function_names...]
---

# work-on/build/context — Pre-Implementation Context Gathering

**Invoked by**: `work-on.md` Step 3C.5, between Builder Contract and Implement.
**Time budget**: Max 2 minutes of queries. Skip any query that times out.
**Output**: Post `<!-- FORGE:CONTEXT -->` comment on the issue, then return structured briefing to caller.

---

## Mission

Surface what went wrong in this area before the builder writes a single line of code. The builder starts with the investigator report and contract — this step adds institutional memory: what did review agents catch last time someone touched these files, what bugs recurred, what other paths must stay consistent. When prior investigation Gists are linked in the issue body, fetch and summarize them so the builder has cross-issue context without manual lookups. When a milestone-level index Gist exists, use it to discover all investigation Gists for the milestone — providing full cross-issue context from a single URL. <!-- Updated: forge#341 -->

**Principle**: A builder with context produces fewer review findings. Fewer findings = fewer fix cycles = lower token cost.

---

## Inputs

Parse from `$ARGUMENTS`:
- `{NUMBER}` — issue number (positional, required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--repo-path {REPO_PATH}` — local filesystem path to the worktree (e.g. `/path/to/.claude/worktrees/fix/issue-121`); used by Phase C3 grep commands
- `{AFFECTED_FILES}` — space-separated file paths (positional, after `{NUMBER}`, before any `--functions` flag)
- `--functions {FUNCTION_NAMES}` — space-separated function/class names extracted from the Builder Contract deliverables table (optional)

**Graceful skip for empty FUNCTION_NAMES**: If `--functions` is absent or `{FUNCTION_NAMES}` is empty, Phase C3 produces zero for-loop iterations and is effectively skipped — no error, no output for that phase. This is expected behavior when the contract does not name specific functions.

---

## Phase C-1: Authoritative Devdocs

Read project-resident authoritative docs **before** any institutional-memory queries. Devdocs contain binding project knowledge (conventions, architecture, custom instructions) that must inform the builder's mental model from the start.

**Time budget**: 30 seconds. If exceeded, log a skip note and continue to Phase C0.

**Skip if**: `{REPO_PATH}` is not set, devdocs path does not exist, or path contains no markdown files.

### Step 0: Resolve devdocs path

Read `forge.yaml → devdocs.path` from the project root. Default to `devdocs` if the key is absent or unreadable.

```bash
DEVDOCS_PATH=""

# Read forge.yaml directly from repo root (REPO_PATH points to the project root — no directory walk)
FORGE_YAML_PATH="{REPO_PATH}/forge.yaml"

if [ -f "$FORGE_YAML_PATH" ]; then
  # Extract devdocs.path key (simple grep — value is on the same or next line under "devdocs:")
  DEVDOCS_REL=$(grep -A5 '^devdocs:' "$FORGE_YAML_PATH" \
    | grep '^\s*path:' \
    | head -1 \
    | sed 's/.*path:\s*//' \
    | tr -d '"'"'"' \
    | tr -d '[:space:]')
fi

# Default to "devdocs" if not found
DEVDOCS_REL="${DEVDOCS_REL:-devdocs}"
DEVDOCS_PATH="{REPO_PATH}/${DEVDOCS_REL}"

if [ ! -d "$DEVDOCS_PATH" ]; then
  echo "Devdocs path '${DEVDOCS_PATH}' does not exist — skipping Phase C-1 (no blocking)"
  DEVDOCS_PATH=""
fi
```

> **Note**: `devdocs/` must be tracked in git for the worktree to contain it. If the project gitignores `devdocs/`, the path will not exist in the worktree and this phase silently skips — this is by design. Run `git check-ignore -v devdocs/` to confirm tracking status.

### Step 1: Enumerate and filter applicable files

Find all `.md` files under `DEVDOCS_PATH`, parse YAML frontmatter, keep those with `work-on` in `applies_to`. Sort by authority (`required` first, then `recommended`, then `reference`).

```bash
DEVDOCS_APPLICABLE=""  # list of paths that apply

if [ -n "$DEVDOCS_PATH" ]; then
  # Find all markdown files recursively
  while IFS= read -r -d '' mdfile; do
    # Extract frontmatter block (between first two --- markers)
    FRONTMATTER=$(awk '/^---/{c++; if(c==1){next} if(c==2){exit}} c==1{print}' "$mdfile" 2>/dev/null)

    # Check if applies_to contains work-on
    if echo "$FRONTMATTER" | grep -q 'applies_to:.*work-on'; then
      AUTHORITY=$(echo "$FRONTMATTER" | grep 'authority:' | head -1 | sed 's/.*authority:\s*//' | tr -d ' ')
      # Prepend sort key: 1=required, 2=recommended, 3=reference, 4=other
      case "$AUTHORITY" in
        required)    SORT_KEY="1" ;;
        recommended) SORT_KEY="2" ;;
        reference)   SORT_KEY="3" ;;
        *)           SORT_KEY="4" ;;
      esac
      DEVDOCS_APPLICABLE="${DEVDOCS_APPLICABLE}${SORT_KEY}|${mdfile}\n"
    fi
  done < <(find "$DEVDOCS_PATH" -name "*.md" -print0 2>/dev/null)

  # Sort by authority key and extract paths
  DEVDOCS_APPLICABLE=$(printf "$DEVDOCS_APPLICABLE" | sort | cut -d'|' -f2-)
fi

if [ -z "$DEVDOCS_APPLICABLE" ]; then
  echo "No devdocs files with 'applies_to: work-on' found — skipping Phase C-1 content read"
fi
```

### Step 2: Read content of applicable files

For each applicable file: read its content (max 200 lines; truncate with note if longer). Accumulate for output.

```bash
DEVDOCS_CONTENT=""

while IFS= read -r mdfile; do
  [ -z "$mdfile" ] && continue
  TOTAL_LINES=$(wc -l < "$mdfile" 2>/dev/null || echo 0)
  if [ "$TOTAL_LINES" -gt 200 ]; then
    FILE_CONTENT=$(head -200 "$mdfile")
    TRUNCATION_NOTE="_[Truncated at 200 lines — ${TOTAL_LINES} total. Read full file for complete context.]_"
  else
    FILE_CONTENT=$(cat "$mdfile")
    TRUNCATION_NOTE=""
  fi

  # Relative path for display
  REL_PATH="${mdfile#${DEVDOCS_PATH}/}"

  DEVDOCS_CONTENT="${DEVDOCS_CONTENT}

#### \`${REL_PATH}\`
${FILE_CONTENT}
${TRUNCATION_NOTE}"
done <<< "$DEVDOCS_APPLICABLE"
```

### Step 3: Store for output

`DEVDOCS_CONTENT` is used in the `### Authoritative Devdocs` section of the FORGE:CONTEXT comment output. If empty (path absent or no applicable files), the section is replaced with a skip note.

---

## Phase C0: Prior Investigation Findings (from Gists)

Scan the issue body for `<!-- FORGE:PRIOR_GIST: {url} -->` annotations embedded by the decompose or orchestrate phases (GIST-02). Also check for `<!-- FORGE:MILESTONE_INDEX: {url} -->` annotations — these reference a milestone-level index Gist (GIST-04) that aggregates all investigation Gist URLs for a milestone into a single reference. Both annotation types reference Knowledge Gists created during upstream investigation (GIST-01) and contain structured findings — verdict, root cause, recommendation, affected files — that the builder needs before writing code.

**Time budget**: 30 seconds total for all Gist fetches. Each individual fetch times out after 15 seconds.

**Skip if**: Issue body contains no `FORGE:PRIOR_GIST` or `FORGE:MILESTONE_INDEX` annotations, AND the issue's milestone description contains no `FORGE:MILESTONE_INDEX` annotation. Zero iterations, no output — this is expected for issues without prior investigation context.

### Step 0: Check for milestone index Gist

Before scanning individual Gist annotations, check if the issue's milestone has an index Gist. If so, fetch the index and extract individual Gist URLs from the table rows.

```bash
ISSUE_BODY=$(gh issue view {NUMBER} -R {GH_REPO} --json body --jq '.body')
MILESTONE_NUM=$(gh issue view {NUMBER} -R {GH_REPO} --json milestone --jq '.milestone.number // empty')

MILESTONE_INDEX_URL=""
INDEX_GIST_URLS=""

# Check issue body for milestone index annotation
MILESTONE_INDEX_URL=$(echo "$ISSUE_BODY" \
  | grep -oP '(?<=<!-- FORGE:MILESTONE_INDEX: )https://[^ ]+(?= -->)' \
  | head -1)

# If not in issue body, check milestone description
if [ -z "$MILESTONE_INDEX_URL" ] && [ -n "$MILESTONE_NUM" ]; then
  MILESTONE_DESC=$(gh api repos/{GH_REPO}/milestones/${MILESTONE_NUM} --jq '.description // ""' 2>/dev/null)
  MILESTONE_INDEX_URL=$(echo "$MILESTONE_DESC" \
    | grep -oP '(?<=<!-- FORGE:MILESTONE_INDEX: )https://[^ ]+(?= -->)' \
    | head -1)
fi

# If found, fetch the index and extract individual Gist URLs from table rows
if [ -n "$MILESTONE_INDEX_URL" ]; then
  INDEX_GIST_ID=$(echo "$MILESTONE_INDEX_URL" | grep -oP '[a-f0-9]{20,}' | tail -1)
  if [ -n "$INDEX_GIST_ID" ]; then
    INDEX_CONTENT=$(timeout 15 gh gist view "$INDEX_GIST_ID" --raw 2>/dev/null)
    if [ -n "$INDEX_CONTENT" ]; then
      # Extract Gist URLs from table rows (format: | ... | https://gist.github.com/... | ... |)
      INDEX_GIST_URLS=$(echo "$INDEX_CONTENT" \
        | grep -oP 'https://gist\.github\.com/[a-f0-9/]+' \
        | head -10)
      echo "Milestone index fetched: found $(echo "$INDEX_GIST_URLS" | wc -l) investigation Gist(s)"
    else
      echo "WARNING: Failed to fetch milestone index Gist — falling back to individual annotations"
    fi
  fi
fi
```

### Step 1: Detect Gist URLs in issue body

```bash
GIST_URLS=$(echo "$ISSUE_BODY" \
  | grep -oP '(?<=<!-- FORGE:PRIOR_GIST: )https://[^ ]+(?= -->)' \
  | head -5)

# Merge with any URLs discovered from milestone index (deduplicate)
if [ -n "$INDEX_GIST_URLS" ]; then
  GIST_URLS=$(echo -e "${GIST_URLS}\n${INDEX_GIST_URLS}" | sort -u | head -5)
fi

if [ -z "$GIST_URLS" ]; then
  echo "No FORGE:PRIOR_GIST or FORGE:MILESTONE_INDEX annotations found — skipping Phase C0"
  # → Continue to Phase C1
fi
```

**Max Gists**: 5 per issue. If more than 5 are present (from combined individual + index sources), process only the first 5 to stay within time budget.

### Step 2: Fetch and summarize each Gist

For each Gist URL, extract the Gist ID (last path segment) and fetch the raw content:

```bash
GIST_SUMMARIES=""

for url in $GIST_URLS; do
  # Extract Gist ID from URL (last path segment, strip any trailing slash)
  GIST_ID=$(echo "$url" | grep -oP '[a-f0-9]{20,}' | tail -1)

  if [ -z "$GIST_ID" ]; then
    echo "WARNING: Could not extract Gist ID from URL: $url — skipping"
    continue
  fi

  # Fetch Gist content with timeout
  GIST_CONTENT=$(timeout 15 gh gist view "$GIST_ID" --raw 2>/dev/null)

  if [ -z "$GIST_CONTENT" ]; then
    echo "WARNING: Failed to fetch Gist $GIST_ID — skipping (deleted, private, or network error)"
    GIST_SUMMARIES="${GIST_SUMMARIES}
- **Gist ${GIST_ID}** (${url}): _Fetch failed — Gist may be deleted or inaccessible_"
    continue
  fi

  # Extract key sections for summary (~2K chars target per Gist)
  VERDICT=$(echo "$GIST_CONTENT" | grep -oP '(?<=verdict: )\w+' | head -1)
  TASK_TYPE=$(echo "$GIST_CONTENT" | grep -oP '(?<=task_type: ).+' | head -1)
  SEVERITY=$(echo "$GIST_CONTENT" | grep -oP '(?<=severity: )\w+' | head -1)
  SOURCE_ISSUE=$(echo "$GIST_CONTENT" | grep -oP '(?<=issue: )\d+' | head -1)

  # Extract structured sections: Root Cause, Recommendation, Affected Files
  ROOT_CAUSE=$(echo "$GIST_CONTENT" \
    | sed -n '/^### Root Cause/,/^### /p' \
    | head -10 | tail -n +2 | head -8)
  RECOMMENDATION=$(echo "$GIST_CONTENT" \
    | sed -n '/^### Recommendation/,/^### /p' \
    | head -10 | tail -n +2 | head -8)
  AFFECTED_FILES=$(echo "$GIST_CONTENT" \
    | sed -n '/^### Affected Files/,/^### /p' \
    | head -10 | tail -n +2 | head -8)

  GIST_SUMMARIES="${GIST_SUMMARIES}

#### Investigation #${SOURCE_ISSUE:-unknown} (${VERDICT:-unknown} / ${SEVERITY:-unknown})
**Source**: ${url}
**Task type**: ${TASK_TYPE:-unknown}

**Root Cause**:
${ROOT_CAUSE:-_Not extracted — read Gist directly_}

**Recommendation**:
${RECOMMENDATION:-_Not extracted — read Gist directly_}

**Affected Files**:
${AFFECTED_FILES:-_Not extracted — read Gist directly_}"
done
```

### Step 3: Store for output

If `GIST_SUMMARIES` is non-empty, it will be included in the `### Prior Investigation Findings` section of the FORGE:CONTEXT comment (see Output Format below). If empty (all fetches failed or no annotations found), the section is omitted from the output.

---

## Phase C1: Past Review Findings on These Files

Query closed issues with `review-finding` label, searching by filename:

```bash
for file in {AFFECTED_FILES}; do
  basename=$(basename "$file" .py)
  gh issue list -R {GH_REPO} \
    --state closed \
    --label "review-finding" \
    --search "$basename" \
    --limit 10 \
    --json number,title,body \
    --jq '.[] | {
      number,
      title,
      pattern:    (.body | capture("\\*\\*Pattern\\*\\*: *(?<p>[^\\n]+)").p    // null),
      prevention: (.body | capture("\\*\\*Prevention\\*\\*: *(?<v>[^\\n]+)").v // null),
      root_cause: (.body | capture("\\*\\*Root cause\\*\\*: *(?<rc>[^\\n]+)").rc // (.body | capture("Root Cause[^\\n]*\\n(?<rc>[^\\n]+)").rc // "see body"))
    }'
done
```

Keep findings where the filename or function name appears in the title or body. Discard false matches (same word, different module).

**Pattern extraction note**: Issues created by `/review-pr` after the feedback-loop feature include structured `**Pattern**`, `**Root cause**`, and `**Prevention**` fields in the `## Pattern Metadata` section. Extract all three when present — they are the primary signal. Fall back to `root_cause` regex for older issues that predate this feature.

**Max results**: 10 findings total across all files.

---

## Phase C2: Past Bugs in the Same Module

Mine git log for commit messages referencing issues, then fetch those issues:

```bash
# Step 1: find issue numbers from git history on affected files
git log --oneline -30 -- {AFFECTED_FILES} \
  | grep -oP '#\d+' \
  | sort -u \
  | head -8

# Step 2: for each issue number found, fetch title and any root cause annotation
gh issue view {RELATED_NUMBER} -R {GH_REPO} \
  --json number,title,body,labels \
  --jq '{number, title, labels: [.labels[].name], snippet: (.body[:300])}'
```

Filter: keep only `bug`, `fix`, or `review-finding` labeled issues. Skip feature issues — they add noise without bug signal.

**Max results**: 5 issues.

---

## Phase C3: Related Code Paths

Identify callers, importers, and sibling implementations that must stay consistent with the changed code:

```bash
# Python: find importers of modified functions/classes
for fn in {FUNCTION_NAMES}; do
  grep -r "$fn" {REPO_PATH} \
    --include="*.py" \
    -l \
    | grep -v "__pycache__" \
    | grep -v {AFFECTED_FILES} \
    | head -5
done

# TypeScript: find usages
for fn in {FUNCTION_NAMES}; do
  grep -r "$fn" {REPO_PATH}/web/src \
    --include="*.ts" --include="*.tsx" \
    -l \
    | head -5
done
```

For each related file found: note the file path and the nature of the relationship (caller, sibling, test).

**Max results**: 8 related files.

---

## Phase C4: Successful Similar Implementations

Find merged PRs that touched the same domain with a successful outcome — use as a positive pattern reference:

```bash
gh pr list -R {GH_REPO} \
  --state merged \
  --search "{domain_keywords}" \
  --limit 5 \
  --json number,title,files \
  --jq '.[] | {number, title, file_count: (.files | length)}'
```

Use 2-3 keywords from the issue title. If no results, skip this phase — do not block on it.

---

## Output Format

Post the following as a GitHub comment on `{NUMBER}`:

```bash
gh issue comment {NUMBER} -R {GH_REPO} --body "<!-- FORGE:CONTEXT -->
## Implementation Context for #{NUMBER}

### Authoritative Devdocs
<!-- Project-resident authoritative knowledge read from devdocs/ (Phase C-1).
     These files have the highest precedence — they override agent defaults and memory.
     custom-instructions.md directives are BINDING and MUST be followed exactly.
     If devdocs path was absent or no files matched applies_to: work-on — write:
     'No devdocs found at {DEVDOCS_PATH} — skipping. Run `npx forgedock docs init` to scaffold.' -->
{DEVDOCS_CONTENT}

### Prior Investigation Findings
<!-- Summarized Knowledge Gist content from upstream investigations (Phase C0).
     If no FORGE:PRIOR_GIST annotations were found in the issue body: omit this section entirely.
     If Gist fetches failed: include the failure note so the builder knows context was attempted. -->
{GIST_SUMMARIES}

### Known Pitfalls for This Area
<!-- Structured prevention rules extracted from past review-finding issues (Pattern Metadata section).
     If a finding has a Prevention field, list it here. Builder MUST read these before writing code.
     If none: 'No structured pitfalls recorded — first time these files are touched or all findings predate the feedback loop.' -->
- **{PATTERN}** (`{FILE}`): {PREVENTION}

### Historical Findings on These Files
<!-- List of past review-finding issues from C1. If none: 'No prior findings.' -->
- #{NUM}: \"{TITLE}\" — root cause: {ROOT_CAUSE}

### Past Bugs in This Module
<!-- List of closed bug issues from git log mining. If none: 'No prior bugs found in git history.' -->
- #{NUM}: \"{TITLE}\" — root cause: {SNIPPET}

### Related Code Paths (must stay consistent)
<!-- Files that import or call the changed functions. Builder must read and validate these. -->
- \`{FILE}\` — {RELATIONSHIP}

### Patterns That Cause Bugs Here
<!-- Synthesize from C1+C2: recurring bug types (e.g. 'String/int coercion at JSON boundaries — 3 prior incidents'). If none: 'No recurring patterns identified.' -->

### Successful Similar Implementations
<!-- Positive patterns from C4. If none: 'No similar merged PRs found.' -->
- PR #{NUM}: \"{TITLE}\" — {FILE_COUNT} files, notes: {OBSERVATION}

<!-- FORGE:CONTEXT:COMPLETE -->
"
```

---

## Timing Rules

- Phase C-1 devdocs read: 30s total budget (file enumeration + content reads combined); skip if exceeded
- Phase C0 `gh gist view` calls: timeout after 15s each, 30s total budget for all Gist fetches
- Each `gh issue list` call: timeout after 20s, skip if exceeded
- Each `gh pr list` call: timeout after 20s, skip if exceeded
- Each `grep -r` call: timeout after 10s, skip if exceeded
- Total wall time budget: **2 minutes** (C-1 through C4 combined). If budget exceeded, post partial results with `<!-- FORGE:CONTEXT:PARTIAL -->` marker instead of `COMPLETE`.

---

## Skip Conditions

Skip this entire step (post nothing, return empty briefing) if:
- Issue is a 1-file config or docs edit with no code logic
- The affected files have zero git history (new files being created)
- `{AFFECTED_FILES}` is empty (investigation produced no file list)

---

## Integration Point in work-on.md

This module runs at **Step 3C.5** — after Builder Contract is posted, before Implement:

```
3C   → Builder Contract posted
3C.5 → [THIS MODULE] Context gathering (max 2 min)
         Phase C-1: Authoritative Devdocs (project-resident knowledge — highest precedence)
         Phase C0:  Prior Investigation Findings (from Gists)
         Phase C1:  Past Review Findings on These Files
         Phase C2:  Past Bugs in the Same Module
         Phase C3:  Related Code Paths
         Phase C4:  Successful Similar Implementations
3F   → Implement (builder now has context briefing)
```

The builder agent reads the `<!-- FORGE:CONTEXT -->` comment before writing any code. If the context step was skipped, the builder proceeds with investigation report + contract only.

**Devdocs precedence** (Phase C-1): Content from `project/custom-instructions.md` has the HIGHEST precedence of all context sources. Directives there override agent defaults, training knowledge, and all other devdocs. Other `project/*.md` and `agent/*.md` files with `applies_to: work-on` provide authoritative project conventions and ForgeDock usage guidance. <!-- Added: forge#259 -->

When prior investigation Gists are available (Phase C0), the `### Prior Investigation Findings` section gives the builder cross-issue context — root causes, recommendations, and affected files from upstream investigations — without requiring manual Gist lookups. When a milestone-level index Gist exists (GIST-04), Phase C0 can resolve the index to discover all investigation Gists for the milestone from a single URL — providing full milestone-wide context automatically. <!-- Updated: forge#341 -->
