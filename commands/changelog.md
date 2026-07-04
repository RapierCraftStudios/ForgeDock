---
description: Auto-generate release notes from merged PRs and FORGE:TRAJECTORY annotations — grouped by conventional commit type
argument-hint: [v1.0.0..v1.1.0 | since:YYYY-MM-DD | last-N]
install: extras
---

# /changelog — Release Notes Generator

**Input**: $ARGUMENTS (default: last 30 merged PRs on the staging branch)

Generate a structured markdown changelog from merged PRs and their FORGE:TRAJECTORY annotations. Groups entries by conventional commit type (feat, fix, refactor, docs, chore) and enriches each entry with task type and investigation verdict from the pipeline's annotation layer.

**Agent model policy**: `model: "haiku"`, `effort: low` (mechanical tier — annotation reading, changelog generation). Fallback: `model: "sonnet"` if rate-limited. Feature gate: pass `effort` only on Claude Code >= 2.1.154.

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

---

## Config Resolution

Read `forge.yaml` before running any phase. If missing, stop and tell the user to run `npx forgedock init`.

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: forge.yaml not found. Run: npx forgedock init"
  exit 1
fi

GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE")

echo "Repo:    $GH_REPO"
echo "Branch:  $STAGING_BRANCH"
```

---

## Phase 1: Parse Arguments

Resolve the date/commit range from `$ARGUMENTS`.

```bash
ARGUMENTS="${ARGUMENTS:-}"

# Default: last 30 merged PRs
MODE="count"
COUNT=30
SINCE_DATE=""
TAG_FROM=""
TAG_TO=""

if [ -z "$ARGUMENTS" ]; then
  MODE="count"
  COUNT=30
  echo "Mode: last $COUNT merged PRs (default)"

elif echo "$ARGUMENTS" | grep -qE '^last-[0-9]+$'; then
  # last-N: last N merged PRs
  COUNT=$(echo "$ARGUMENTS" | grep -oE '[0-9]+')
  MODE="count"
  echo "Mode: last $COUNT merged PRs"

elif echo "$ARGUMENTS" | grep -qE '^since:[0-9]{4}-[0-9]{2}-[0-9]{2}'; then
  # since:YYYY-MM-DD: all PRs merged after this date
  SINCE_DATE=$(echo "$ARGUMENTS" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}')
  MODE="since"
  echo "Mode: since $SINCE_DATE"

elif echo "$ARGUMENTS" | grep -qE '^v?[A-Za-z0-9._-]+ *\.\. *v?[A-Za-z0-9._-]+'; then
  # tag-to-tag: v1.0.0..v1.1.0
  TAG_FROM=$(echo "$ARGUMENTS" | sed 's/ *\.\..*//')
  TAG_TO=$(echo "$ARGUMENTS" | sed 's/.*\.\. *//')
  MODE="tag-range"
  echo "Mode: $TAG_FROM..$TAG_TO"

else
  echo "WARNING: Unrecognized argument format: '$ARGUMENTS'"
  echo "Falling back to: last 30 merged PRs"
  MODE="count"
  COUNT=30
fi
```

---

## Phase 2: Collect Merged PRs

Collect PRs merged to the staging branch in the resolved range. Use `while read` for all iteration — never `for VAR in $(command)`.

```bash
echo ""
echo "=== Collecting merged PRs ==="

case "$MODE" in
  count)
    # Last N merged PRs on the staging branch
    PR_JSON=$(gh pr list $GH_FLAG \
      --state merged \
      --base "$STAGING_BRANCH" \
      --limit "$COUNT" \
      --json number,title,mergedAt,body \
      --jq 'sort_by(.mergedAt) | reverse | .[]')
    ;;

  since)
    # All merged PRs since SINCE_DATE
    PR_JSON=$(gh pr list $GH_FLAG \
      --state merged \
      --base "$STAGING_BRANCH" \
      --limit 200 \
      --json number,title,mergedAt,body \
      --jq "[.[] | select(.mergedAt >= \"${SINCE_DATE}T00:00:00Z\")] | sort_by(.mergedAt) | reverse | .[]")
    ;;

  tag-range)
    # PRs merged between two git tags — derive date window from tag commit dates
    cd "$REPO_PATH"

    if ! git rev-parse --verify "$TAG_FROM" >/dev/null 2>&1; then
      echo "ERROR: Tag '$TAG_FROM' not found in git history."
      echo "Available tags: $(git tag --sort=-version:refname | head -10 | tr '\n' ' ')"
      exit 1
    fi
    if ! git rev-parse --verify "$TAG_TO" >/dev/null 2>&1; then
      echo "ERROR: Tag '$TAG_TO' not found in git history."
      echo "Available tags: $(git tag --sort=-version:refname | head -10 | tr '\n' ' ')"
      exit 1
    fi

    TAG_FROM_DATE=$(git log -1 --format="%aI" "$TAG_FROM")
    TAG_TO_DATE=$(git log -1 --format="%aI" "$TAG_TO")

    echo "Tag range: $TAG_FROM ($TAG_FROM_DATE) → $TAG_TO ($TAG_TO_DATE)"

    PR_JSON=$(gh pr list $GH_FLAG \
      --state merged \
      --base "$STAGING_BRANCH" \
      --limit 200 \
      --json number,title,mergedAt,body \
      --jq "[.[] | select(.mergedAt > \"$TAG_FROM_DATE\" and .mergedAt <= \"$TAG_TO_DATE\")] | sort_by(.mergedAt) | reverse | .[]")
    ;;
esac

# Empty-state guard: if no PRs matched the range, emit informative message and exit cleanly
if [ -z "$PR_JSON" ]; then
  echo "No merged PRs found for this range."
  exit 0
fi

# Write PR list to a temp file so we can iterate without subshell word-splitting
TMPFILE=$(mktemp)
echo "$PR_JSON" > "$TMPFILE"

PR_COUNT=$(gh pr list $GH_FLAG --state merged --base "$STAGING_BRANCH" --limit "$COUNT" --json number --jq 'length' 2>/dev/null || echo "?")
echo "Collected PRs for changelog."
```

---

## Phase 3: Enrich with FORGE:TRAJECTORY Annotations

For each PR, extract the linked issue number and read its FORGE:TRAJECTORY comment.

```bash
echo ""
echo "=== Reading FORGE:TRAJECTORY annotations ==="

# Accumulators — one line per group, tab-separated: PREFIX|PR_NUM|PR_TITLE|ISSUE_NUM|TASK_TYPE
declare -a GROUP_FEAT
declare -a GROUP_FIX
declare -a GROUP_REFACTOR
declare -a GROUP_DOCS
declare -a GROUP_CHORE
declare -a GROUP_OTHER

# Read each PR as a JSON object from the temp file using jq line-by-line
while IFS= read -r PR_OBJ; do
  [ -z "$PR_OBJ" ] && continue

  PR_NUM=$(echo "$PR_OBJ" | jq -r '.number')
  PR_TITLE=$(echo "$PR_OBJ" | jq -r '.title')
  PR_BODY=$(echo "$PR_OBJ" | jq -r '.body // ""')
  PR_MERGED_AT=$(echo "$PR_OBJ" | jq -r '.mergedAt')

  # Extract conventional commit prefix from title
  # Matches: fix(scope): ..., feat: ..., refactor(scope): ..., etc.
  PREFIX=$(echo "$PR_TITLE" | grep -oE '^(feat|fix|refactor|docs|chore|test|ci|build|perf|style)(\([^)]+\))?' | grep -oE '^[a-z]+' | head -1)
  [ -z "$PREFIX" ] && PREFIX="other"

  # Extract linked issue number from PR body (Closes #N, Fixes #N, Refs #N)
  ISSUE_NUM=$(echo "$PR_BODY" | grep -oiE '(closes?|fixes?|resolves?|refs?)[[:space:]]+#[0-9]+' | grep -oE '[0-9]+' | head -1)

  # Read FORGE:TRAJECTORY from linked issue (when present)
  TASK_TYPE=""
  VERDICT=""
  if [ -n "$ISSUE_NUM" ]; then
    TRAJ=$(gh api "repos/$GH_REPO/issues/$ISSUE_NUM/comments" \
      --jq '.[] | select(.body | contains("FORGE:TRAJECTORY")) | .body' 2>/dev/null | head -1)

    if [ -n "$TRAJ" ]; then
      # Extract task type from "Task type: Feature" in the Notes column
      TASK_TYPE=$(echo "$TRAJ" | grep -oE 'Task type: [^|<]+' | sed 's/Task type: //' | tr -d ' ' | head -1)
      # Extract verdict from "✅ CONFIRMED (HIGH)" or "✅ PARTIAL (MEDIUM)"
      VERDICT=$(echo "$TRAJ" | grep -oE 'Investigation \| ✅ (CONFIRMED|PARTIAL|INVALID)' | grep -oE '(CONFIRMED|PARTIAL|INVALID)' | head -1)
    fi
  fi

  # Build entry line: "- prefix(scope): description (#PR_NUM) — closes #ISSUE_NUM [TASK_TYPE]"
  SCOPE_PART=$(echo "$PR_TITLE" | grep -oE '^[a-zA-Z0-9_]+\([^)]+\)' | head -1)
  if [ -n "$SCOPE_PART" ]; then
    DESCRIPTION=$(echo "$PR_TITLE" | sed "s|^${SCOPE_PART}: *||")
  else
    DESCRIPTION=$(echo "$PR_TITLE" | sed 's/^[a-z]*: *//')
  fi

  ENTRY="- ${PR_TITLE} ([#${PR_NUM}](https://github.com/${GH_REPO}/pull/${PR_NUM}))"
  if [ -n "$ISSUE_NUM" ]; then
    ENTRY="${ENTRY} — closes [#${ISSUE_NUM}](https://github.com/${GH_REPO}/issues/${ISSUE_NUM})"
  fi
  if [ -n "$TASK_TYPE" ]; then
    ENTRY="${ENTRY} _(${TASK_TYPE})_"
  fi

  # Add to appropriate group
  case "$PREFIX" in
    feat)     GROUP_FEAT+=("$ENTRY") ;;
    fix)      GROUP_FIX+=("$ENTRY") ;;
    refactor) GROUP_REFACTOR+=("$ENTRY") ;;
    docs)     GROUP_DOCS+=("$ENTRY") ;;
    chore|ci|build|test|perf|style) GROUP_CHORE+=("$ENTRY") ;;
    *)        GROUP_OTHER+=("$ENTRY") ;;
  esac

done < <(cat "$TMPFILE" | jq -c '.')

rm -f "$TMPFILE"
echo "Annotation pass complete."
```

---

## Phase 4: Output Changelog

Render grouped markdown. Omit sections with no entries.

```bash
echo ""
echo "========================================"
echo ""

# Determine header date range for display
case "$MODE" in
  count)   RANGE_LABEL="last ${COUNT} merged PRs" ;;
  since)   RANGE_LABEL="since ${SINCE_DATE}" ;;
  tag-range) RANGE_LABEL="${TAG_FROM} → ${TAG_TO}" ;;
esac

TODAY=$(date +%Y-%m-%d)
echo "## Changelog — ${RANGE_LABEL} (generated ${TODAY})"
echo ""
echo "> Generated by [ForgeDock /changelog](https://github.com/${GH_REPO}) from merged PRs on \`${STAGING_BRANCH}\`"
echo ""

# Features
if [ ${#GROUP_FEAT[@]} -gt 0 ]; then
  echo "### Features"
  printf '%s\n' "${GROUP_FEAT[@]}"
  echo ""
fi

# Bug Fixes
if [ ${#GROUP_FIX[@]} -gt 0 ]; then
  echo "### Bug Fixes"
  printf '%s\n' "${GROUP_FIX[@]}"
  echo ""
fi

# Refactors
if [ ${#GROUP_REFACTOR[@]} -gt 0 ]; then
  echo "### Refactors"
  printf '%s\n' "${GROUP_REFACTOR[@]}"
  echo ""
fi

# Documentation
if [ ${#GROUP_DOCS[@]} -gt 0 ]; then
  echo "### Documentation"
  printf '%s\n' "${GROUP_DOCS[@]}"
  echo ""
fi

# Maintenance (chore, ci, build, test, perf, style)
if [ ${#GROUP_CHORE[@]} -gt 0 ]; then
  echo "### Maintenance"
  printf '%s\n' "${GROUP_CHORE[@]}"
  echo ""
fi

# Uncategorized (no conventional commit prefix)
if [ ${#GROUP_OTHER[@]} -gt 0 ]; then
  echo "### Other"
  printf '%s\n' "${GROUP_OTHER[@]}"
  echo ""
fi

# Summary line
TOTAL_PRS=$(( ${#GROUP_FEAT[@]} + ${#GROUP_FIX[@]} + ${#GROUP_REFACTOR[@]} + ${#GROUP_DOCS[@]} + ${#GROUP_CHORE[@]} + ${#GROUP_OTHER[@]} ))
echo "---"
echo ""
echo "**${TOTAL_PRS} changes** across: ${#GROUP_FEAT[@]} features, ${#GROUP_FIX[@]} fixes, ${#GROUP_REFACTOR[@]} refactors, ${#GROUP_DOCS[@]} docs, ${#GROUP_CHORE[@]} maintenance, ${#GROUP_OTHER[@]} other."
echo ""
echo "========================================"
```

---

## Error Handling

- **forge.yaml missing**: Stop immediately with message to run `npx forgedock init`.
- **Tag not found**: List available tags, exit with non-zero status.
- **No PRs in range**: Emit "No merged PRs found for this range." and exit cleanly.
- **Issue has no FORGE:TRAJECTORY**: Skip gracefully — use PR title and number only. Do NOT crash.
- **gh CLI not authenticated**: `gh auth status` and `gh auth login` to fix.
- **Large date ranges**: Default limit is 200 PRs for `since:` mode — adjust `--limit` if more are expected.

---

## Usage Examples

```bash
# Default: last 30 merged PRs
/changelog

# Last 50 merged PRs
/changelog last-50

# All PRs merged since a specific date
/changelog since:2024-06-01

# PRs between two release tags
/changelog v1.0.0..v1.1.0
```

## Output Notes

The changelog is printed to stdout. Pipe or copy-paste into:
- A `CHANGELOG.md` file
- A GitHub release body (`gh release create v1.x.x --notes "..."`)
- A PR description for a staging → main deploy

FORGE:TRAJECTORY annotations are read on a best-effort basis. Issues closed outside the ForgeDock pipeline (no trajectory comment) will appear with PR title and number only, without the task type annotation.
