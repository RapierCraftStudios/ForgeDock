---
description: Bootstrap an existing repo for ForgeDock — triage open issues, apply labels, suggest a starter milestone, and identify first /work-on candidates
argument-hint: [--dry-run | --limit <N> | --milestone | --no-milestone]
---

# /adopt — Repo Bootstrap & Backlog Triage

**Input**: $ARGUMENTS

You onboard an existing repo into the ForgeDock pipeline. Unlike `/forgedock-init` (which generates `forge.yaml`) and `/issue` (which creates new issues), `/adopt` operates on an existing backlog: scanning open issues, classifying them, applying category and priority labels, suggesting a starter milestone, and ranking the best `/work-on` first candidates.

Run `/adopt` once after `npx forgedock init` + `/forgedock-init` to make a legacy backlog pipeline-ready without touching the issues themselves.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — adopt.md loaded and active. Agent is bound by this spec. -->

---

## Argument Parsing

| Flag | Effect |
|------|--------|
| (none) | Full triage — scan issues, apply labels, suggest milestone, report candidates |
| `--dry-run` | Classify and report but do NOT write any labels or create any milestone |
| `--limit <N>` | Cap issue scan to the N most recently updated open issues (default: 200) |
| `--milestone` | After labeling, automatically create the suggested starter milestone (no prompt) |
| `--no-milestone` | Skip milestone suggestion entirely |

Parse `$ARGUMENTS`:
```bash
DRY_RUN=false
ISSUE_LIMIT=200
AUTO_MILESTONE=false
SKIP_MILESTONE=false

for arg in $ARGUMENTS; do
  case "$arg" in
    --dry-run)       DRY_RUN=true ;;
    --milestone)     AUTO_MILESTONE=true ;;
    --no-milestone)  SKIP_MILESTONE=true ;;
    --limit)         NEXT_IS_LIMIT=true ;;
    *)
      if [ "$NEXT_IS_LIMIT" = "true" ]; then
        ISSUE_LIMIT="$arg"
        NEXT_IS_LIMIT=false
      fi
      ;;
  esac
done
```

If `DRY_RUN=true`, prefix all actions with `[DRY RUN]` and skip all `gh label` writes and issue creation.

---

## Config Resolution

Read `forge.yaml` at the project root to resolve all project-specific variables before running any commands:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: forge.yaml not found."
  echo ""
  echo "Run first: npx forgedock init"
  echo "Then:      /forgedock-init"
  echo "Then:      /adopt"
  exit 1
fi

GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE")
DEFAULT_BRANCH=$(yq '.branches.default' "$CONFIG_FILE")
PROJECT_BOARD_OWNER=$(yq '.project_board.owner // .project.owner' "$CONFIG_FILE")
PROJECT_NUMBER=$(yq '.project_board.project_number // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
PROJECT_ID=$(yq '.project_board.project_id // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
```

All `{GH_REPO}`, `{GH_FLAG}`, `{REPO_PATH}`, `{STAGING_BRANCH}`, `{DEFAULT_BRANCH}`, `{PROJECT_BOARD_OWNER}`, `{PROJECT_NUMBER}`, and `{PROJECT_ID}` references below are populated from `forge.yaml`.

---

## Phase 0: Prerequisites

### 0A: GitHub auth check

```bash
if ! gh auth status &>/dev/null; then
  echo "ERROR: GitHub CLI not authenticated. Run: gh auth login"
  exit 1
fi
```

### 0B: Ensure required labels exist

ForgeDock commands depend on canonical label names. Bootstrap them idempotently before any labeling.

```bash
echo "Checking ForgeDock labels on ${GH_REPO}..."
cd "$REPO_PATH" && npx forgedock labels setup --repo "$GH_REPO" 2>&1 | tail -5
echo "Labels ready."
```

If `npx forgedock labels setup` is unavailable (e.g. local dev install), fall back to verifying key labels exist and creating any that are missing:

```bash
# Fallback: verify a sample of key labels exist
MISSING_LABELS=""
for label in "priority:P0" "priority:P1" "priority:P2" "priority:P3" "workflow:investigating" "workflow:ready-to-build" "workflow:building" "workflow:in-review" "workflow:merged" "workflow:invalid" "needs-human"; do
  gh label list ${GH_FLAG} --json name --jq '.[].name' 2>/dev/null | grep -qx "$label" || MISSING_LABELS="$MISSING_LABELS $label"
done
if [ -n "$MISSING_LABELS" ]; then
  echo "WARNING: Missing labels:$MISSING_LABELS"
  echo "Run 'npx forgedock labels setup' from $REPO_PATH to create them."
fi
```

### 0C: Count open issues

```bash
TOTAL_OPEN=$(gh issue list ${GH_FLAG} --state open --limit 1 --json number --jq '. | length' 2>/dev/null || echo "0")
# More accurate count via API
TOTAL_OPEN=$(gh api "repos/${GH_REPO}/issues?state=open&per_page=1" -i 2>/dev/null \
  | grep -i "^link:" | grep -oE 'page=[0-9]+>; rel="last"' | grep -oE '[0-9]+' | tail -1 || echo "$TOTAL_OPEN")
echo "Open issues in ${GH_REPO}: ${TOTAL_OPEN}"
echo "Will process up to ${ISSUE_LIMIT} issues."
```

---

## Phase 1: Issue Scan

### 1A: Fetch all open issues

```bash
echo "Fetching open issues..."
ALL_ISSUES=$(gh issue list ${GH_FLAG} \
  --state open \
  --limit "$ISSUE_LIMIT" \
  --json number,title,body,labels,createdAt,updatedAt \
  --jq '.[]')
```

### 1B: Split into already-adopted and legacy

An issue is "already pipeline-ready" if it has ANY `workflow:` label OR any `priority:` label already applied. These should be skipped — they were either created via `/issue` or previously adopted.

```bash
LEGACY_ISSUES=$(echo "$ALL_ISSUES" | jq -s '
  .[] | select(
    (.labels | map(.name) | any(startswith("workflow:") or startswith("priority:"))) | not
  )
')

ALREADY_READY=$(echo "$ALL_ISSUES" | jq -s '
  .[] | select(
    (.labels | map(.name) | any(startswith("workflow:") or startswith("priority:")))
  )
')

LEGACY_COUNT=$(echo "$LEGACY_ISSUES" | jq -s '. | length')
READY_COUNT=$(echo "$ALREADY_READY" | jq -s '. | length')

echo "Already pipeline-ready: ${READY_COUNT}"
echo "Need triage: ${LEGACY_COUNT}"
```

If `LEGACY_COUNT == 0`:
```
All ${READY_COUNT} open issues already have pipeline labels. Nothing to adopt.
Run /work-on next to start working on the highest-priority issue.
```
→ Skip to Phase 6 (Summary).

---

## Phase 2: Triage — Classify Each Legacy Issue

For each issue in `LEGACY_ISSUES`, analyze the title and body to determine:

### 2A: Type classification

| Type | Label | Signals in title/body |
|------|-------|----------------------|
| Bug | `bug` | "crash", "broken", "fails", "error", "exception", "TypeError", "not working", "regression", "fix" prefix, stack traces |
| Feature | `feature` | "add", "support", "implement", "new", "create", "enable", "feat" prefix |
| Enhancement | `enhancement` | "improve", "better", "update", "upgrade", "enhance" |
| Refactor | `refactor` | "clean", "refactor", "extract", "rename", "simplify", "dead code", "remove" |
| Investigation | `feature` | "investigate", "audit", "research", "evaluate", "why does", "figure out" |
| Documentation | `documentation` | "docs", "document", "README", "guide", "write up" |
| Infrastructure | `bug` (infra) | "deploy", "CI", "docker", "workflow", "pipeline", "kubernetes", "nginx" |

Default to `enhancement` when no signal is clear.

### 2B: Priority classification

| Priority | Label | Signals |
|----------|-------|---------|
| P0 | `priority:P0` | "production down", "data loss", "security breach", "P0", "critical", "outage", "blocked deploy" |
| P1 | `priority:P1` | "broken", "regression", "blocks", "cannot", "P1", "high priority", "urgent", "major bug" |
| P2 | `priority:P2` | "minor", "improve", "enhancement", "feature", P2 |
| P3 | `priority:P3` | "cosmetic", "typo", "nice to have", "polish", "low priority", no severity signals |

Default to `priority:P2` for features and enhancements, `priority:P3` for documentation and cosmetic issues, `priority:P1` for bugs with unclear severity.

### 2C: Build classification table

Build a triage table in memory:

```
TRIAGE_RESULTS = [
  { number, title, type_label, priority_label, type_signal, priority_signal },
  ...
]
```

For each issue: read title + first 500 chars of body, apply the rules from 2A and 2B, record both the assigned labels AND the signal that drove the assignment (for the report).

---

## Phase 3: Apply Labels

**Skip if `DRY_RUN=true`** — report what would be applied instead.

For each issue in TRIAGE_RESULTS:

```bash
# Apply type label and priority label
gh issue edit {NUMBER} ${GH_FLAG} \
  --add-label "{TYPE_LABEL},{PRIORITY_LABEL}" 2>&1

echo "  #${NUMBER}: +{TYPE_LABEL} +{PRIORITY_LABEL} — {TITLE}"
```

**Rate limiting note**: If applying labels to 50+ issues, add a brief pause between batches:
```bash
# After every 20 issues:
BATCH_MOD=$((COUNT % 20))
[ "$BATCH_MOD" -eq 0 ] && sleep 2
```

**Idempotency**: `gh issue edit --add-label` is idempotent — adding a label that already exists is a no-op. No need to pre-check.

---

## Phase 4: Milestone Suggestion

**Skip if `SKIP_MILESTONE=true`** or `DRY_RUN=true`.

### 4A: Detect existing milestones

```bash
EXISTING_MILESTONES=$(gh api "repos/${GH_REPO}/milestones?state=open" \
  --jq '.[] | {number: .number, title: .title, open_issues: .open_issues}' 2>/dev/null)

if [ -n "$EXISTING_MILESTONES" ]; then
  echo "Existing open milestones:"
  echo "$EXISTING_MILESTONES"
fi
```

### 4B: Cluster issues for milestone suggestion

From the TRIAGE_RESULTS, identify the best starter milestone candidates:
- Prefer `bug` and `feature` type issues over documentation
- Prefer issues with `priority:P1` or `priority:P2`
- Group by keyword overlap in titles (e.g., all issues mentioning "auth", "dashboard", "API")
- Target 3–7 issues for the starter milestone — enough to be a meaningful deliverable, small enough to complete quickly

**Clustering heuristic**:
1. Extract top 3 keyword clusters from issue titles (nouns, domain terms — not stop words)
2. For each cluster, list the issues it covers
3. Pick the cluster with the most P1/P2 issues — this is the starter milestone scope
4. If no clear cluster emerges (all issues are unrelated), pick the top 5 P1/P2 bugs as the starter milestone

### 4C: Name the milestone

Derive a title from the cluster:
- If cluster keyword is "auth": "Auth Hardening"
- If cluster keyword is "api": "API Stability"
- If cluster keyword is "dashboard": "Dashboard Polish"
- Otherwise: "Initial Triage — {month} {year}" (e.g., "Initial Triage — Jun 2025")

### 4D: Present suggestion

```
## Suggested Starter Milestone

Title: "{MILESTONE_TITLE}"
Issues ({N}):
  #{N1} [{TYPE}/{PRIORITY}] — {TITLE}
  #{N2} [{TYPE}/{PRIORITY}] — {TITLE}
  ...

This would create milestone "{MILESTONE_TITLE}" in ${GH_REPO} and assign the above issues to it.
```

### 4E: Create milestone (if `--milestone` flag or user confirms)

**With `--milestone` flag**: create automatically.
**Without flag**: ask for confirmation:

```
Create this milestone? [Y/n]
```

Wait for user input. Default: Y.

```bash
# Create the milestone
MILESTONE_NUMBER=$(gh api "repos/${GH_REPO}/milestones" \
  --method POST \
  --field title="{MILESTONE_TITLE}" \
  --field description="Starter milestone generated by /adopt. Covers the first /work-on batch." \
  --field state="open" \
  --jq '.number' 2>&1)

echo "Created milestone #${MILESTONE_NUMBER}: {MILESTONE_TITLE}"

# Assign issues to the milestone
for NUM in {MILESTONE_ISSUE_NUMBERS}; do
  gh api "repos/${GH_REPO}/issues/${NUM}" -X PATCH --field milestone="$MILESTONE_NUMBER" 2>/dev/null
  echo "  Assigned #${NUM} → milestone"
done
```

**Also create the milestone branch** (so `/work-on` feature-lane issues get their own branch):

```bash
cd "$REPO_PATH"
git fetch origin "$DEFAULT_BRANCH"
MILESTONE_SLUG=$(echo "{MILESTONE_TITLE}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')
git branch "milestone/${MILESTONE_SLUG}" "origin/${DEFAULT_BRANCH}" 2>/dev/null \
  && git push origin "milestone/${MILESTONE_SLUG}" \
  && echo "Created branch: milestone/${MILESTONE_SLUG}" \
  || echo "Branch milestone/${MILESTONE_SLUG} already exists — skipping"
```

---

## Phase 5: /work-on Candidate Report

Identify the best first issues for `/work-on`. Rank by:

1. **Priority**: P0 > P1 > P2 > P3
2. **Scope**: Issues with explicit file references in the body score higher (smaller investigation burden)
3. **Clarity**: Issues with "## Acceptance Criteria" or a checklist score higher
4. **Type**: Confirmed bugs score higher than feature requests (bugs are more actionable)

Score each issue in TRIAGE_RESULTS:
```
score = priority_score(priority_label)   # P0=40, P1=30, P2=20, P3=10
      + has_affected_files(body) * 15    # body contains "## Affected Files" or file paths
      + has_acceptance_criteria(body) * 10 # body contains "## Acceptance Criteria" or "- [ ]"
      + is_bug(type_label) * 5           # bug type
```

Report the top 5 (or all if fewer than 5):

```
## Top /work-on Candidates

| Rank | Issue | Type | Priority | Score | Why |
|------|-------|------|----------|-------|-----|
| 1 | #{N} — {title} | {type} | {priority} | {score} | {reason} |
| 2 | #{N} — {title} | {type} | {priority} | {score} | {reason} |
...
```

Where `{reason}` is a brief signal: "confirmed bug + file refs", "P1 + acceptance criteria", etc.

---

## Phase 6: Summary Report

```
## /adopt Complete — {GH_REPO}

### Issues Processed

| Category | Count |
|----------|-------|
| Already pipeline-ready (skipped) | {READY_COUNT} |
| Triaged in this run | {LEGACY_COUNT} |
| Total open issues | {TOTAL_OPEN} |

### Labels Applied

| Issue | Type Label | Priority Label |
|-------|------------|----------------|
| #{N} — {title[:50]} | {type} | {priority} |
...

{If DRY_RUN: "** DRY RUN — no labels were written **"}

### Milestone

{If milestone created: "Created milestone '#{MS_NUMBER}: {TITLE}' with {N} issues. Branch: milestone/{slug}"}
{If milestone skipped: "No milestone created (--no-milestone or skipped by user)"}
{If milestone existed: "Existing milestones detected — no new milestone created"}

### Top /work-on Candidates

#{N1}, #{N2}, #{N3} (see ranking table above)

### Next Steps

1. Review the label assignments above — adjust any misclassifications:
   \`gh issue edit #{N} -R {GH_REPO} --add-label "bug" --remove-label "enhancement"\`

2. Start working on the top candidate:
   \`/work-on {TOP_CANDIDATE_NUMBER}\`

3. Or run the full milestone:
   \`/orchestrate milestone {MILESTONE_SLUG}\` (runs all milestone issues in parallel)

4. To re-run adoption on newly added issues:
   \`/adopt\` (already-labeled issues are skipped automatically)
```

---

## Error Handling

- **`forge.yaml` missing**: Tell the user to run `npx forgedock init` first, then `/forgedock-init`. Stop.
- **GitHub auth failure**: Tell the user to run `gh auth login`. Stop.
- **No open issues**: Report "No open issues found in {GH_REPO}" and stop gracefully.
- **All issues already labeled**: Report "All {N} open issues already have pipeline labels" and suggest `/work-on next`.
- **Label creation fails**: Log the failure, continue with remaining issues. Report failures in Phase 6.
- **Milestone already exists with same title**: Skip milestone creation, report the existing milestone number.
- **Rate limit hit**: Pause and retry with exponential backoff (max 3 retries). If still failing, report the last successfully processed issue number and instruct the user to re-run with `--limit` set to the remaining count.
