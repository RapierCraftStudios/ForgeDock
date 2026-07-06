---
description: Automated CI failure resolution loop — diagnoses failures on a PR, applies targeted fixes, pushes, and loops until green or max attempts reached.
argument-hint: <PR number or URL> [--max-attempts N] [--repo owner/repo]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /fix-ci — Automated CI Failure Resolution

**Input**: $ARGUMENTS

**Invoked by**: `/deploy-pr` (CI gate step) or directly by a user when a PR's CI is failing.

**Output**: Structured result — `{ pr, status, attempts, fixes_applied }` — printed to stdout and available to the calling skill.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. User can override with `--model <name>`. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**
**NEVER force-push or amend commits** — always create new commits.

<!-- FORGE:SPEC_LOADED — fix-ci.md loaded and active. Agent is bound by this spec. -->

---

## Config Preamble

Read `forge.yaml` before running any phase:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: forge.yaml not found. Run: npx forgedock init"
  exit 1
fi
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R ${GH_REPO}"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging // "staging"' "$CONFIG_FILE")
```

## Argument Parsing

Parse `$ARGUMENTS`:

| Argument | Variable | Default |
|----------|----------|---------|
| PR number or URL | `PR_NUMBER` | (required) |
| `--max-attempts N` | `MAX_ATTEMPTS` | `5` |
| `--repo owner/repo` | `GH_REPO` | from forge.yaml |

```bash
# Extract PR number (accept raw number or full GitHub URL)
PR_INPUT=$(echo "$ARGUMENTS" | awk '{print $1}')
if echo "$PR_INPUT" | grep -qE '^https?://'; then
  PR_NUMBER=$(echo "$PR_INPUT" | grep -oE '[0-9]+$')
else
  PR_NUMBER=$(echo "$PR_INPUT" | tr -d '#')
fi

MAX_ATTEMPTS=5
if echo "$ARGUMENTS" | grep -q -- "--max-attempts"; then
  MAX_ATTEMPTS=$(echo "$ARGUMENTS" | grep -oE -- '--max-attempts [0-9]+' | awk '{print $2}')
fi

if [ -z "$PR_NUMBER" ]; then
  echo "ERROR: PR number or URL is required."
  echo "Usage: /fix-ci <PR number or URL> [--max-attempts N]"
  exit 1
fi

echo "fix-ci: PR #${PR_NUMBER}, max attempts: ${MAX_ATTEMPTS}"
```

---

## Phase 0: Assess the PR

### 0A: Load PR state

```bash
PR_DATA=$(gh pr view "$PR_NUMBER" $GH_FLAG \
  --json number,title,headRefName,baseRefName,state,isDraft,url,headRepository 2>/dev/null)

if [ -z "$PR_DATA" ]; then
  echo "ERROR: PR #${PR_NUMBER} not found or not accessible."
  exit 1
fi

PR_HEAD=$(echo "$PR_DATA" | jq -r '.headRefName')
PR_BASE=$(echo "$PR_DATA" | jq -r '.baseRefName')
PR_STATE=$(echo "$PR_DATA" | jq -r '.state')
PR_URL=$(echo "$PR_DATA" | jq -r '.url')

echo "PR #${PR_NUMBER}: ${PR_HEAD} → ${PR_BASE} (${PR_STATE})"

if [ "$PR_STATE" = "MERGED" ]; then
  echo "PR #${PR_NUMBER} is already merged — nothing to fix."
  echo '{"pr": '"$PR_NUMBER"', "status": "already_merged", "attempts": 0, "fixes_applied": []}'
  exit 0
fi

if [ "$PR_STATE" = "CLOSED" ]; then
  echo "PR #${PR_NUMBER} is closed — cannot fix CI on a closed PR."
  exit 1
fi
```

### 0B: Determine fix target branch

The fix target is the branch the PR's **head** points to. CI fixes are committed directly to the PR's head branch — not to the base branch.

```bash
# Smart target detection: where do fixes land?
# - staging → main PRs:   fixes go to staging (the head branch)
# - milestone/* → staging: fixes go to the milestone branch (the head branch)
# - feature/* PRs:         fixes go to the feature branch (the head branch)
# In all cases: FIX_TARGET = PR_HEAD (the PR's source branch)
FIX_TARGET="$PR_HEAD"
echo "Fix target branch: ${FIX_TARGET}"

# HARD RULE: never target main directly
if [ "$FIX_TARGET" = "main" ] || [ "$FIX_TARGET" = "master" ]; then
  echo "ERROR: fix-ci refuses to commit fixes directly to '${FIX_TARGET}'."
  echo "This PR's head branch is a protected branch — something is wrong with the PR setup."
  exit 1
fi
```

### 0C: Check initial CI status

```bash
LATEST_RUN=$(gh run list $GH_FLAG --branch "$PR_HEAD" --limit 1 \
  --json databaseId,status,conclusion,name,createdAt 2>/dev/null | jq '.[0] // empty')

if [ -z "$LATEST_RUN" ]; then
  echo "No CI runs found for branch ${PR_HEAD} — CI may not have triggered yet."
  echo "Waiting up to 60s for CI to start..."
  sleep 15
  LATEST_RUN=$(gh run list $GH_FLAG --branch "$PR_HEAD" --limit 1 \
    --json databaseId,status,conclusion,name,createdAt 2>/dev/null | jq '.[0] // empty')
fi

RUN_STATUS=$(echo "$LATEST_RUN" | jq -r '.status // "unknown"')
RUN_CONCLUSION=$(echo "$LATEST_RUN" | jq -r '.conclusion // "unknown"')
RUN_ID=$(echo "$LATEST_RUN" | jq -r '.databaseId // ""')

echo "Latest CI run ${RUN_ID}: status=${RUN_STATUS}, conclusion=${RUN_CONCLUSION}"

if [ "$RUN_CONCLUSION" = "success" ]; then
  echo "CI is already green on PR #${PR_NUMBER} — no fixes needed."
  echo '{"pr": '"$PR_NUMBER"', "status": "success", "attempts": 0, "fixes_applied": []}'
  exit 0
fi
```

---

## Phase 1: CI Fix Loop

Initialize tracking state:

```bash
ATTEMPT=0
FIXES_APPLIED="[]"
LOOP_STATUS="pending"

cd "$REPO_PATH"
git fetch origin
```

Execute up to `MAX_ATTEMPTS` iterations:

```
while ATTEMPT < MAX_ATTEMPTS:
    ATTEMPT += 1
    echo "=== fix-ci: Attempt ${ATTEMPT}/${MAX_ATTEMPTS} ==="

    → Phase 1A: Wait for CI to finish
    → Phase 1B: Check CI result — if green, exit loop with success
    → Phase 1C: Diagnose failure
    → Phase 1D: Apply fix
    → Phase 1E: Format, commit, push
    → Loop back (CI re-triggers on new commit)

if loop exits without success AND ATTEMPT == MAX_ATTEMPTS:
    → Phase 2: Report max-attempts failure
```

### Phase 1A: Wait for CI

Poll the latest run on the PR's head branch. Poll every 20 seconds, timeout at 10 minutes.

```bash
POLL_TIMEOUT=600  # 10 minutes
POLL_START=$(date +%s)
POLL_INTERVAL=20

echo "Waiting for CI run to complete (timeout: ${POLL_TIMEOUT}s)..."

while true; do
  CURRENT_RUN=$(gh run list $GH_FLAG --branch "$PR_HEAD" --limit 1 \
    --json databaseId,status,conclusion 2>/dev/null | jq '.[0] // empty')

  CURRENT_STATUS=$(echo "$CURRENT_RUN" | jq -r '.status // "unknown"')
  CURRENT_CONCLUSION=$(echo "$CURRENT_RUN" | jq -r '.conclusion // "unknown"')
  CURRENT_RUN_ID=$(echo "$CURRENT_RUN" | jq -r '.databaseId // ""')

  if [ "$CURRENT_STATUS" = "completed" ]; then
    echo "CI run ${CURRENT_RUN_ID} completed: ${CURRENT_CONCLUSION}"
    break
  fi

  NOW=$(date +%s)
  ELAPSED=$((NOW - POLL_START))
  if [ "$ELAPSED" -ge "$POLL_TIMEOUT" ]; then
    echo "Timeout waiting for CI after ${POLL_TIMEOUT}s — run ${CURRENT_RUN_ID} is still ${CURRENT_STATUS}"
    LOOP_STATUS="timeout"
    break
  fi

  echo "  CI run ${CURRENT_RUN_ID} is ${CURRENT_STATUS} (${ELAPSED}s elapsed) — polling again in ${POLL_INTERVAL}s..."
  sleep "$POLL_INTERVAL"
done

RUN_CONCLUSION="$CURRENT_CONCLUSION"
RUN_ID="$CURRENT_RUN_ID"
```

### Phase 1B: Check CI result

```bash
if [ "$RUN_CONCLUSION" = "success" ]; then
  echo "CI is green after ${ATTEMPT} attempt(s)."
  LOOP_STATUS="success"
  break  # exit the fix loop
fi

if [ "$LOOP_STATUS" = "timeout" ]; then
  break  # exit the fix loop — reported in Phase 2
fi

echo "CI failed (run ${RUN_ID}, conclusion: ${RUN_CONCLUSION}) — diagnosing..."
```

### Phase 1C: Diagnose the failure

Download failed job logs and pattern-match against known failure classes.

```bash
# Download logs from the failed run
RUN_LOG=$(gh run view "$RUN_ID" $GH_FLAG --log-failed 2>/dev/null | head -500)

if [ -z "$RUN_LOG" ]; then
  echo "WARNING: Could not retrieve logs for run ${RUN_ID}"
  RUN_LOG="(logs unavailable)"
fi

echo "--- Failed run log (first 500 lines) ---"
echo "$RUN_LOG" | head -100
echo "---"
```

**Pattern-match against known failure classes** (in priority order — first match wins):

```bash
FAILURE_CLASS="unknown"
FAILURE_DETAIL=""

# 1. Format errors (prettier, black, ruff, eslint --fix-dry-run)
if echo "$RUN_LOG" | grep -qiE "(formatting|format check|prettier|black|ruff.*would reformat|eslint.*fixable)"; then
  FAILURE_CLASS="format"
  FAILURE_DETAIL=$(echo "$RUN_LOG" | grep -iE "(formatting|would reformat|fixable)" | head -5)

# 2. Import/module errors (missing imports, circular imports, unresolved modules)
elif echo "$RUN_LOG" | grep -qiE "(ImportError|ModuleNotFoundError|Cannot find module|import.*error|no module named)"; then
  FAILURE_CLASS="import"
  FAILURE_DETAIL=$(echo "$RUN_LOG" | grep -iE "(ImportError|ModuleNotFoundError|Cannot find module|no module named)" | head -5)

# 3. Syntax errors (Python, JS/TS, YAML)
elif echo "$RUN_LOG" | grep -qiE "(SyntaxError|syntax error|Unexpected token|unexpected end of|ParseError)"; then
  FAILURE_CLASS="syntax"
  FAILURE_DETAIL=$(echo "$RUN_LOG" | grep -iE "(SyntaxError|syntax error|Unexpected token|ParseError)" | head -5)

# 4. TypeScript/type errors
elif echo "$RUN_LOG" | grep -qiE "(TS[0-9]+:|type error|TypeScript error|tsc.*error|type '.*' is not assignable)"; then
  FAILURE_CLASS="types"
  FAILURE_DETAIL=$(echo "$RUN_LOG" | grep -iE "(TS[0-9]+:|type error|tsc.*error)" | head -5)

# 5. Test failures (pytest, jest, mocha)
elif echo "$RUN_LOG" | grep -qiE "(FAILED|test.*failed|AssertionError|expect.*received|FAIL .*\.test\.)"; then
  FAILURE_CLASS="tests"
  FAILURE_DETAIL=$(echo "$RUN_LOG" | grep -iE "(FAILED|AssertionError|expect.*received)" | head -5)

# 6. Build errors (webpack, vite, esbuild, cargo, maven)
elif echo "$RUN_LOG" | grep -qiE "(Build failed|build error|compilation failed|error\[E[0-9]+\]|BUILD FAILURE)"; then
  FAILURE_CLASS="build"
  FAILURE_DETAIL=$(echo "$RUN_LOG" | grep -iE "(Build failed|compilation failed|BUILD FAILURE)" | head -5)

# 7. Linting errors (eslint, pylint, flake8)
elif echo "$RUN_LOG" | grep -qiE "(eslint.*error|pylint|flake8|linting.*error|lint.*fail)"; then
  FAILURE_CLASS="lint"
  FAILURE_DETAIL=$(echo "$RUN_LOG" | grep -iE "(eslint|pylint|flake8)" | head -5)

# 8. YAML/config validation errors
elif echo "$RUN_LOG" | grep -qiE "(yaml.*error|YAML parse|invalid yaml|config.*invalid|schema.*error)"; then
  FAILURE_CLASS="config"
  FAILURE_DETAIL=$(echo "$RUN_LOG" | grep -iE "(yaml.*error|config.*invalid|schema.*error)" | head -5)
fi

echo "Failure class: ${FAILURE_CLASS}"
echo "Failure detail: ${FAILURE_DETAIL}"
```

### Phase 1D: Apply targeted fix

Work on the PR's head branch directly. Check out the branch in the repo root (not a worktree — we push to the existing PR head):

```bash
git checkout "$FIX_TARGET" 2>/dev/null || git checkout -b "$FIX_TARGET" "origin/${FIX_TARGET}" 2>/dev/null
git pull origin "$FIX_TARGET" --rebase 2>/dev/null || true
```

**Apply fix based on failure class**:

```
case FAILURE_CLASS:

  "format":
    Read forge.yaml → verification.commands for configured formatters.
    Run all configured formatters:
      PYTHON_FORMAT=$(yq '.verification.commands.python.format // ""' forge.yaml 2>/dev/null)
      TS_FORMAT=$(yq '.verification.commands.typescript.format // ""' forge.yaml 2>/dev/null)
      [ -n "$PYTHON_FORMAT" ] && eval "$PYTHON_FORMAT" 2>&1 || true
      [ -n "$TS_FORMAT" ]     && eval "$TS_FORMAT" 2>&1     || true
    If no formatters configured, try auto-detection:
      - Python files changed → try: black . 2>/dev/null || ruff format . 2>/dev/null || true
      - JS/TS files changed  → try: npx prettier --write . 2>/dev/null || true
    FIX_DESCRIPTION="auto-format: run configured formatters"

  "import":
    Read FAILURE_DETAIL to identify the missing module name.
    Search the codebase for the module to determine if it is:
      a) A typo in the import → fix the import path
      b) A missing dependency in package.json / requirements.txt → add it
      c) A file that was moved or deleted → update the import path
    Apply the targeted fix with Read + Edit tools.
    FIX_DESCRIPTION="fix import: ${FAILURE_DETAIL}"

  "syntax":
    Read FAILURE_DETAIL to identify the file and line number.
    Read the affected file with the Read tool.
    Apply targeted fix for the syntax error (missing comma, bracket, quote, etc.).
    FIX_DESCRIPTION="fix syntax error: ${FAILURE_DETAIL}"

  "types":
    Read FAILURE_DETAIL to extract TS error code and location (file:line).
    Read the affected file.
    Apply targeted type fix: add missing type annotation, correct mismatched type,
    add type assertion, or widen/narrow the type as appropriate.
    FIX_DESCRIPTION="fix type error: ${FAILURE_DETAIL}"

  "tests":
    Read FAILURE_DETAIL to find failing test name and assertion.
    Read the test file and the source file it tests.
    Determine if the failure is:
      a) A test expectation that needs updating (API changed) → update the expectation
      b) A regression in source code → fix the source code
    NEVER delete or skip a failing test without understanding the root cause.
    FIX_DESCRIPTION="fix failing test: ${FAILURE_DETAIL}"

  "build":
    Read full build log for the specific error message and file.
    Read the affected file.
    Fix the build error: resolve missing dependency, fix webpack config,
    resolve circular import, fix incompatible API usage.
    FIX_DESCRIPTION="fix build error: ${FAILURE_DETAIL}"

  "lint":
    Read FAILURE_DETAIL to identify specific lint rule and file.
    Read the affected file.
    Apply targeted lint fix respecting the project's lint configuration.
    Do NOT use disable comments unless the lint rule is a false positive.
    FIX_DESCRIPTION="fix lint error: ${FAILURE_DETAIL}"

  "config":
    Read FAILURE_DETAIL to identify the config file and the parse error.
    Read the config file.
    Fix the YAML/JSON/TOML syntax error or schema violation.
    FIX_DESCRIPTION="fix config error: ${FAILURE_DETAIL}"

  "unknown":
    Read the full log (first 200 lines) and attempt to identify the error manually.
    If the error is identifiable: apply a targeted fix and describe it.
    If the error is not fixable automatically:
      LOOP_STATUS="undiagnosable"
      break  # exit the fix loop — Phase 2 will report
    FIX_DESCRIPTION="fix unclassified CI error (see log)"
```

Record the fix applied:
```bash
FIX_ENTRY=$(jq -nc \
  --arg attempt "$ATTEMPT" \
  --arg class "$FAILURE_CLASS" \
  --arg desc "$FIX_DESCRIPTION" \
  --arg run_id "$RUN_ID" \
  '{"attempt": ($attempt|tonumber), "failure_class": $class, "description": $desc, "run_id": $run_id}')
FIXES_APPLIED=$(echo "$FIXES_APPLIED" | jq ". + [$FIX_ENTRY]")
```

### Phase 1E: Format, commit, push

**Format** (always run before committing, regardless of failure class):

```bash
# Run formatters unconditionally before commit
PYTHON_FORMAT=$(yq '.verification.commands.python.format // ""' forge.yaml 2>/dev/null || echo '')
TS_FORMAT=$(yq '.verification.commands.typescript.format // ""' forge.yaml 2>/dev/null || echo '')

[ -n "$PYTHON_FORMAT" ] && eval "$PYTHON_FORMAT" 2>&1 | tail -5 || true
[ -n "$TS_FORMAT" ]     && eval "$TS_FORMAT" 2>&1     | tail -5 || true
```

**Commit** (new commit only — no amend, no force-push):

```bash
git add -u
CHANGED=$(git diff --cached --name-only)

if [ -z "$CHANGED" ]; then
  echo "No changes after fix attempt ${ATTEMPT} — fix did not produce a diff."
  echo "This may indicate the fix was already applied or the failure class is misdiagnosed."
  LOOP_STATUS="no_diff"
  break
fi

git commit -s -m "fix(ci): attempt ${ATTEMPT}/${MAX_ATTEMPTS} — ${FIX_DESCRIPTION} (PR #${PR_NUMBER})"
echo "Committed fix for attempt ${ATTEMPT}"
```

**Push** (normal push only — no force):

```bash
git push origin "$FIX_TARGET" 2>&1
PUSH_EXIT=$?

if [ "$PUSH_EXIT" -ne 0 ]; then
  echo "Push failed (exit ${PUSH_EXIT}) — attempting pull-rebase then re-push..."
  git pull origin "$FIX_TARGET" --rebase 2>&1 && \
    git push origin "$FIX_TARGET" 2>&1
  PUSH_EXIT=$?
fi

if [ "$PUSH_EXIT" -ne 0 ]; then
  echo "ERROR: Push failed after retry. Manual intervention required."
  LOOP_STATUS="push_failed"
  break
fi

echo "Pushed fix commit for attempt ${ATTEMPT} — CI will re-trigger on ${FIX_TARGET}"
```

**Wait briefly for CI to pick up the new commit** before looping:

```bash
sleep 10
```

→ Loop back to Phase 1A with `ATTEMPT += 1`.

---

## Phase 2: Result Report

After the loop exits, determine the final status and report.

### 2A: Determine final status

```bash
case "$LOOP_STATUS" in
  "success")
    FINAL_STATUS="success"
    FINAL_MESSAGE="CI is green after ${ATTEMPT} fix attempt(s)."
    ;;
  "timeout")
    FINAL_STATUS="timeout"
    FINAL_MESSAGE="CI did not complete within the polling timeout (${POLL_TIMEOUT}s) on attempt ${ATTEMPT}."
    ;;
  "no_diff")
    FINAL_STATUS="blocked"
    FINAL_MESSAGE="Fix attempt ${ATTEMPT} produced no diff — the failure class '${FAILURE_CLASS}' may require manual intervention."
    ;;
  "push_failed")
    FINAL_STATUS="blocked"
    FINAL_MESSAGE="Push failed on attempt ${ATTEMPT} — manual intervention required."
    ;;
  "undiagnosable")
    FINAL_STATUS="blocked"
    FINAL_MESSAGE="CI failure on attempt ${ATTEMPT} could not be automatically diagnosed. Full log required."
    ;;
  "pending"|*)
    # Loop exhausted MAX_ATTEMPTS without success
    FINAL_STATUS="max_attempts"
    FINAL_MESSAGE="CI still failing after ${MAX_ATTEMPTS} fix attempt(s). Manual intervention required."
    ;;
esac
```

### 2B: Post result to PR

Post a comment on the PR summarizing what was attempted:

```bash
REPORT_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
FIXES_SUMMARY=$(echo "$FIXES_APPLIED" | jq -r '.[] | "- Attempt \(.attempt): \(.failure_class) — \(.description) (run \(.run_id))"')

gh pr comment "$PR_NUMBER" $GH_FLAG --body "<!-- FORGE:FIX_CI -->
## /fix-ci Result

**Status**: \`${FINAL_STATUS}\`
**Attempts**: ${ATTEMPT}/${MAX_ATTEMPTS}
**Branch**: \`${FIX_TARGET}\`
**Timestamp**: ${REPORT_TIMESTAMP}

### Summary
${FINAL_MESSAGE}

### Fixes Applied
${FIXES_SUMMARY:-_No fixes applied_}

$([ "$FINAL_STATUS" != "success" ] && echo "### Next Steps
The CI failure was not resolved automatically. Recommended actions:
1. Review the latest CI run logs: \`gh run view --log-failed -R ${GH_REPO}\`
2. Check the failure class: \`${FAILURE_CLASS}\`
3. Apply a manual fix and push to \`${FIX_TARGET}\`
4. Re-run \`/fix-ci ${PR_NUMBER}\` after the manual fix")"
```

### 2C: Return structured result

Print the machine-readable result to stdout for the calling skill (`/deploy-pr`, `/autopilot`):

```bash
RESULT=$(jq -nc \
  --argjson pr "$PR_NUMBER" \
  --arg status "$FINAL_STATUS" \
  --argjson attempts "$ATTEMPT" \
  --argjson fixes_applied "$FIXES_APPLIED" \
  '{pr: $pr, status: $status, attempts: $attempts, fixes_applied: $fixes_applied}')

echo ""
echo "=== fix-ci result ==="
echo "$RESULT"
echo "====================="

# Exit with success (0) only if CI is green; non-zero for all other terminal states
if [ "$FINAL_STATUS" = "success" ]; then
  exit 0
else
  exit 1
fi
```

---

## Error Handling

| Condition | Behavior |
|-----------|----------|
| PR not found | Error with message, exit 1 |
| PR already merged | Report `already_merged`, exit 0 |
| PR is closed | Error with message, exit 1 |
| Fix target is `main`/`master` | Hard error — refuses to commit to protected branch |
| CI timeout | Reports `timeout` status, exits 1 |
| Push fails after retry | Reports `blocked` status, exits 1 |
| Unknown failure class | Attempts manual diagnosis; if undiagnosable, reports `blocked` |
| Max attempts reached | Reports `max_attempts`, exits 1 |
| No diff after fix | Reports `blocked` with hint, exits 1 |
