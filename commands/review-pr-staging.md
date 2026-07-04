---
description: Staging review mode — comprehensive review of staging branch before deploy to main
argument-hint: [PR number or "staging"]
allowed-tools: Task, Bash, Read, Grep, Glob, WebFetch
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Staging Review

**Trigger**: Invoked by the orchestrator via `Skill("review-pr-staging", $ARGUMENTS)`, or directly with `$ARGUMENTS` = "staging", a PR number targeting main, or "staging:feature".

Performs comprehensive review of `staging` before merging to `main`. Handles large diffs (1,000-10,000+ lines), diverse changes, deep analysis, and business impact assessment.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`. User can override with `--model <name>`.
**NEVER use plan mode (EnterPlanMode).**
**NEVER use the Agent tool** — this spec uses `Task` for domain agent dispatch. The Agent tool bypasses the allowed-tools constraint declared in this spec's frontmatter and produces opaque output that cannot be structured into the review verdict.

<!-- FORGE:SPEC_LOADED — review-pr-staging.md loaded and active. Agent is bound by this spec. -->

---

## Config Resolution

Read `forge.yaml` to resolve branch names before running any commands:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
DEFAULT_BRANCH=$(yq '.branches.default' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE")

# Test-gate config (Phase 6.5) — read here so vars are available before first use
GATE_POSTURE=$(yq '.verification.test_gate.posture // "blocking"' "$CONFIG_FILE" 2>/dev/null || echo "blocking")
OVERRIDE_PHRASE=$(yq '.verification.test_gate.override_phrase // "OVERRIDE: shipping with test failures —"' "$CONFIG_FILE" 2>/dev/null || echo "OVERRIDE: shipping with test failures —")
```

All `$DEFAULT_BRANCH`, `$STAGING_BRANCH`, `$GATE_POSTURE`, and `$OVERRIDE_PHRASE` references below are populated from `forge.yaml`.

---

## Review Protocol Reference

<!-- FORGE:PROTOCOL_SOURCE — canonical definition lives in docs/spec/review-protocol.md -->

The **Evidence-Based Review Protocol** and **Structured Findings Protocol** are defined in `docs/spec/review-protocol.md`. All agents spawned by this spec MUST follow both protocols as specified there. The full protocol text is embedded in `commands/review-pr-agents.md` for agent use.

**Key protocol rules (summary — see `docs/spec/review-protocol.md` for the normative definition)**:
- Start from the diff. Follow imports. Trace data flows across service boundaries.
- Confidence levels: CONFIRMED (full code-path proof, P1) → LIKELY (pattern + caveat, P2) → POSSIBLE (advisory, P3) → UNFOUNDED (do not report)
- REPRODUCTION GATE: CONFIRMED requires a full code-path trace or concrete input demonstration
- Severity: runtime error → HIGH/CRITICAL; wrong data silently → HIGH; degraded perf → MEDIUM; cosmetic → LOW
- INTERACTION ANALYSIS: never dismiss as "pre-existing" without checking NEW code interactions
- FALSE POSITIVE PREVENTION: trace scope, types, callers before reporting
- Structured findings block MANDATORY at end of every agent comment

---

## Phase -1: Route Assertion

**This phase is MANDATORY and must execute before Phase 0A. No phase may be skipped.**

Resolve the staging→main PR number and post a routing marker immediately. This creates an audit trail — if a staging→main PR has no `FORGE:REVIEW_ROUTE` comment after this command was invoked, the review was bypassed or never started.

```bash
# Resolve PR_NUMBER from $ARGUMENTS
# $ARGUMENTS may be: a PR number, "staging", "feature", or "staging:feature"
if echo "$ARGUMENTS" | grep -qE '^[0-9]+$'; then
  PR_NUMBER="$ARGUMENTS"
else
  # Find the open staging→main PR
  PR_NUMBER=$(gh pr list ${GH_FLAG} \
    --head "$STAGING_BRANCH" \
    --base "$DEFAULT_BRANCH" \
    --state open \
    --json number \
    --jq '.[0].number' 2>/dev/null || echo "")
fi

REVIEW_SHA_STAGING=$(gh pr view "$PR_NUMBER" ${GH_FLAG} --json headRefOid --jq '.headRefOid' 2>/dev/null | cut -c1-7 || echo "n/a")

if [ -n "$PR_NUMBER" ]; then
  gh pr comment "$PR_NUMBER" ${GH_FLAG} --body "<!-- FORGE:REVIEW_ROUTE mode=staging-deploy spec=review-pr-staging.md sha=${REVIEW_SHA_STAGING} -->"
else
  echo "WARNING: Could not resolve staging→main PR number. FORGE:REVIEW_ROUTE marker not posted."
fi
```

`$PR_NUMBER` is now set for all downstream phases that conditionally post gate comments to the PR.

---

## Phase 0A: Open Review-Finding Gate (BLOCKING — runs before scope analysis)

**Purpose**: Prevent deploying commits that have known, unfixed review findings. The review system catches bugs before merging; this gate ensures the merge path acts on that information.

**Why this matters**: Review findings are filed before the originating PR merges to staging. Without this gate, a staging→main bundle can include commits with known unfixed bugs — the review system caught the issue, but the deploy path ignored it. This gate closes the gap between issue discovery and deploy execution. <!-- Added: forge#303 -->

```bash
git fetch origin $DEFAULT_BRANCH $STAGING_BRANCH

# Step 1: Find all PR numbers in the staging→main bundle
# These are the PRs whose commits are included in staging but not yet in main
BUNDLE_PRS=$(git log origin/$DEFAULT_BRANCH..origin/$STAGING_BRANCH --oneline \
  | grep -oP '#\d+' \
  | sort -u \
  | tr -d '#')

# Also extract PR numbers from merge commit subjects (most reliable)
MERGE_PRS=$(git log origin/$DEFAULT_BRANCH..origin/$STAGING_BRANCH --merges --oneline \
  | grep -oP '(?<=pull request #)\d+' \
  | sort -u)

ALL_PR_NUMBERS=$(echo "$BUNDLE_PRS $MERGE_PRS" | tr ' ' '\n' | sort -u | grep -E '^[0-9]+$')

echo "PRs in staging→main bundle: $(echo $ALL_PR_NUMBERS | tr '\n' ' ')"

# Step 2: For each PR in the bundle, check for open review-finding issues
BLOCKING_FINDINGS=""
for pr_num in $ALL_PR_NUMBERS; do
  # Search for open review-finding issues that reference this PR
  OPEN_FINDINGS=$(gh issue list -R {GH_REPO} \
    --label "review-finding" \
    --state open \
    --search "PR #${pr_num}" \
    --limit 20 \
    --json number,title \
    --jq ".[] | \"  - #\(.number): \(.title)\"" 2>/dev/null)

  if [ -n "$OPEN_FINDINGS" ]; then
    BLOCKING_FINDINGS="${BLOCKING_FINDINGS}
**PR #${pr_num}** has open review findings:
${OPEN_FINDINGS}"
  fi
done

# Step 3: Block deploy if open findings exist (unless human override present)
if [ -n "$BLOCKING_FINDINGS" ]; then
  # Check for human override comment on the staging→main PR
  if [ -n "$PR_NUMBER" ]; then
    OVERRIDE=$(gh pr view "$PR_NUMBER" -R {GH_REPO} \
      --json comments \
      --jq '[.comments[].body | select(startswith("OVERRIDE: shipping with open findings"))] | length' 2>/dev/null)
  else
    OVERRIDE=0
  fi

  if [ "${OVERRIDE:-0}" -eq 0 ]; then
    echo "⛔ DEPLOY BLOCKED — Open review-finding issues exist for PRs in this bundle."
    echo ""
    echo "$BLOCKING_FINDINGS"
    echo ""
    echo "Options:"
    echo "  1. Wait for the open findings to be fixed and merged to staging first."
    echo "  2. Post a comment on this PR starting with \"OVERRIDE: shipping with open findings — <reason>\" to bypass this gate."
    echo ""
    echo "This gate exists to prevent deploying commits with known unfixed review findings."
    echo "RESULT: BLOCK DEPLOY"

    # Post structured FORGE:GATE_FAILURE comment for pipeline-health tracking
    FINDING_COUNT=$(echo "$BLOCKING_FINDINGS" | grep -c '^\s*- #' || echo "unknown")
    GATE_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    if [ -n "$PR_NUMBER" ]; then
      gh pr comment "$PR_NUMBER" -R {GH_REPO} --body "<!-- FORGE:GATE_FAILURE -->
## Deploy Gate: BLOCKED

**Gate**: open-review-finding
**Timestamp**: ${GATE_TIMESTAMP}
**Blocking findings**: ${FINDING_COUNT}

### Open Review-Finding Issues

${BLOCKING_FINDINGS}

### Resolution

Fix the open findings above and merge fixes to staging before retrying the staging→main deploy.
To override (ship known issues with documented reason), post a comment starting with:
\`OVERRIDE: shipping with open findings — <reason>\`

<!-- FORGE:GATE_FAILURE:TYPE=open-review-finding|FINDINGS=${FINDING_COUNT} -->" 2>/dev/null || true
    fi
    exit 1
  else
    echo "⚠️  Open review findings exist but human override detected — proceeding with deploy."
    echo "$BLOCKING_FINDINGS"
    echo "Override comment found on PR #${PR_NUMBER}. Continuing."
  fi
else
  echo "✅ Open review-finding gate: PASSED — no open findings for PRs in this bundle."
  # Post FORGE:GATE_PASS for symmetric observability — bypass is indistinguishable from clean pass without this
  if [ -n "$PR_NUMBER" ]; then
    gh pr comment "$PR_NUMBER" -R {GH_REPO} --body "<!-- FORGE:GATE_PASS -->
## Deploy Gate: PASSED

**Gate**: open-review-finding check
**Result**: PASS — no open \`review-finding\` issues exist for PRs in this bundle.
**Bundle PRs**: ${ALL_PR_NUMBERS}
**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

<!-- FORGE:GATE_PASS:TYPE=open-review-finding -->" 2>/dev/null || true
  fi
fi
```

If the gate exits with `RESULT: BLOCK DEPLOY` → **STOP**. Do NOT proceed to Phase 0B or any downstream phases. A `<!-- FORGE:GATE_FAILURE -->` structured comment is automatically posted on the staging→main PR (if `$PR_NUMBER` is set) for pipeline-health tracking. Report the blocking finding list.

If the gate exits with `RESULT: PASS` → a `<!-- FORGE:GATE_PASS -->` structured comment is posted on the staging→main PR so that `/pipeline-health` can distinguish a clean gate from a silently skipped one. A PR with no gate comment at all indicates a gate bypass — not a clean pass.

---

## Phase 0B: Scope Analysis

```bash
git fetch origin $DEFAULT_BRANCH $STAGING_BRANCH
git diff origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH --stat | tail -20
git diff origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH --numstat | awk '{add+=$1; del+=$2} END {print "Added:", add, "Deleted:", del, "Total:", add+del}'
git diff origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH --name-only | sort | uniq
```

Categorize by service (API, Worker, Web, Shared, Infra). Identify high-risk files (billing, credits, pricing, auth, security, migration, scraper).

Create review chunks by priority: Billing/Pricing (CRITICAL) → Security/Auth (CRITICAL) → Scraper Core (HIGH) → API Routers (HIGH) → Worker (HIGH) → Web (MEDIUM) → Shared (MEDIUM) → Infra (MEDIUM) → Other (LOW).

---

## Phase 1: Automated Checks

### 1A: Python Linting

Read `forge.yaml → verification.commands.python` for project-specific tool commands:

```bash
PYTHON_FORMAT=$(yq '.verification.commands.python.format // ""' forge.yaml 2>/dev/null || echo '')
PYTHON_LINT=$(yq '.verification.commands.python.lint // ""' forge.yaml 2>/dev/null || echo '')

if [ -n "$PYTHON_FORMAT" ]; then
    eval "$PYTHON_FORMAT" 2>&1 | head -30
else
    echo "SKIPPED — python.format not configured in verification.commands"
fi

if [ -n "$PYTHON_LINT" ]; then
    eval "$PYTHON_LINT" 2>&1 | head -30
else
    echo "SKIPPED — python.lint not configured in verification.commands"
fi
```

### 1B: TypeScript Type-Check + Build (MANDATORY)

Read `forge.yaml → verification.commands.typescript` for project-specific tool commands:

```bash
TS_TYPECHECK=$(yq '.verification.commands.typescript.typecheck // ""' forge.yaml 2>/dev/null || echo '')
TS_BUILD=$(yq '.verification.commands.typescript.build // ""' forge.yaml 2>/dev/null || echo '')

if [ -n "$TS_TYPECHECK" ]; then
    eval "$TS_TYPECHECK" 2>&1
    TS_EXIT=$?
    [ "$TS_EXIT" -ne 0 ] && echo "BLOCKING: typecheck failed — deploy WILL fail"
else
    echo "SKIPPED — typescript.typecheck not configured in verification.commands"
    TS_EXIT=0
fi

if [ -n "$TS_BUILD" ]; then
    eval "$TS_BUILD" 2>&1 | tail -50
    BUILD_EXIT=$?
    [ "$BUILD_EXIT" -ne 0 ] && echo "BLOCKING: build failed — deploy WILL fail"
else
    echo "SKIPPED — typescript.build not configured in verification.commands"
fi
```
Build failure is BLOCKING — deploy WILL fail. Typecheck alone misses SSG/prerender failures — configure `typescript.build` in `verification.commands`.

### 1C: Python Tests

Read `forge.yaml → verification.commands.python.test`:

```bash
PYTHON_TEST=$(yq '.verification.commands.python.test // ""' forge.yaml 2>/dev/null || echo '')

if [ -n "$PYTHON_TEST" ]; then
    eval "$PYTHON_TEST" 2>&1 | tail -50
else
    echo "SKIPPED — python.test not configured in verification.commands"
fi
```

### 1D: Secrets Scan
```bash
git diff origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH | grep -iE "(api[_-]?key|secret|password|token|credential)" | grep -vE "(#|//|\.example|placeholder)" | head -20
```

### 1E: CI Status Gate (BLOCKING)
```bash
gh pr checks ${PR_NUMBER} 2>&1
```
Any CI failure → BLOCK DEPLOY (unless autofixed in Phase 1F).

### Phase 1F: CI Autofix

If CI fails, attempt automatic fix before blocking:

| Failure Pattern | Category | Autofixable? |
|----------------|----------|--------------|
| Black/isort formatting | FORMATTING | Yes |
| Type error in next build | TYPE_ERROR | Yes |
| Module not found | IMPORT_ERROR | Yes |
| Prerender error | PRERENDER | Maybe |
| Test assertion failure | TEST_FAILURE | No |
| Infrastructure flake | FLAKE | No |

For fixable failures: checkout staging, apply fix, verify locally, commit as `fix(ci): ...`, push, wait for CI re-run (max 10 min). Max 1 autofix attempt. If it fails → BLOCK DEPLOY.

---

## Phase 2: Material Change Analysis

Launch agent (model: sonnet) to analyze all commits since last deploy. Categorize as: NEW FEATURE, ENHANCEMENT, BUG FIX, REFACTOR, SECURITY, PERFORMANCE, INFRASTRUCTURE, DEPENDENCY. Separate user-facing vs internal. Document breaking changes and required pre-deploy actions.

---

## Phase 3: Bug Hunter Review (Per-Service)

Launch Bug Hunter agents for each service with changes:

**API Bug Hunter** (services/api/): Logic errors, error handling, type issues, resource leaks, state issues, auth bugs, data flow tracing. Prefix: BUG/AUTH.

**Worker Bug Hunter** (services/worker/): Job processing bugs, queue issues, tier escalation, reconciliation errors, scraping logic, async issues, Cortex integration. Prefix: BUG/SCRP/CONC.

**Web Bug Hunter** (web/src/): React issues (keys, closures, hydration), data fetching, security (XSS), UX, build-breaking patterns, type issues. Prefix: FE.

Each reads the service diff, hunts for bugs, traces context across imports, posts findings with structured block.

---

## Phase 4: Code Quality Review

Agent hunts for: dead code, duplicate logic, complexity (>50 line functions), naming issues, missing abstractions, logging quality, magic numbers. Prefix: QA.

---

## Phase 5: Security & Billing Deep Dive

Read agent catalog from `.claude/commands/review-pr-agents.md`. Launch domain-specific agents based on which domains have changes. Substitute PR diff commands with staging diff commands. Agents: General Security (always), Auth, Billing, Concurrency, Scraper, API Design, Database, Infrastructure.

---

## Phase 6: Regression Risk Assessment

Agent maps dependencies, assesses integration points (service boundaries, env vars, Docker changes, workflow sibling drift between ci.yml and deploy-production.yml), evaluates rollback difficulty (easy/hard/destructive/state-dependent), checks test coverage. Posts risk matrix with rollback plan. Prefix: REG.

**Workflow sibling drift (MANDATORY)**: Deep-diff ci.yml and deploy-production.yml shared jobs. Compare PYTHONPATH, dependency install steps, step names. Pre-existing drift is invisible until deploy fails.

**Database container restart risk (MANDATORY when `docker-compose*.yml` changes touch `postgres` or `redis` service)**: Any change to a stateful container's `command:`, `image:`, `volumes:`, or `environment:` forces container recreation on deploy. Auto-escalate to HIGH risk. Verify: `stop_grace_period` is sufficient (≥30s for PG), `full_page_writes = on`, `fsync = on`, no active long-running transactions will be interrupted. Recommend maintenance window — stateful container restarts must NOT happen as a side effect of routine deploys. A Postgres restart under active write load can corrupt btree indexes and bypass UNIQUE constraints. <!-- Added: forge#146 -->

---

## Phase 6.5: Runtime Test Gate (BLOCKING — runs after static analysis, before finding triage)

**Purpose**: Verify the integrated bundle's acceptance criteria against running code before the deploy verdict. Catches runtime defects (cross-PR interactions, container/startup failures, regression in tested behaviour) that static review cannot surface.

**Why here**: Phase 6 completes all static analysis (regression risk, security, quality). Phase 6.5 adds the runtime dimension before Phase 7 triages findings — so any test-gate failures can be filed as `test-failure` issues by `/test-gate` itself, then surface in Phase 7's triage pass.

**Posture**: Controlled by `verification.test_gate.posture` in `forge.yaml` (resolved in Config Resolution as `$GATE_POSTURE`). Default: `blocking`. Set to `advisory` to surface failures without preventing deploy. <!-- Added: forge#906 -->

```bash
echo "=== Phase 6.5: Runtime Test Gate ==="
echo "Bundle PRs: $(echo $ALL_PR_NUMBERS | tr '\n' ' ')"
echo "Posture: ${GATE_POSTURE}"

# Initialize test-gate verdict (default SKIP — safe if Phase 6.5 is bypassed)
TEST_GATE_VERDICT="SKIP"
TEST_GATE_REASON="Phase 6.5 not yet run"

# Invoke /test-gate with the bundle PRs already computed in Phase 0A
# ALL_PR_NUMBERS is the de-duplicated union of both scan methods (commit log + merge subjects)
GATE_OUTPUT=$(Skill("test-gate", "--prs \"$(echo $ALL_PR_NUMBERS | tr '\n' ' ' | xargs)\" --base $DEFAULT_BRANCH"))

# Extract machine-readable verdict from Skill output
TEST_GATE_VERDICT=$(echo "$GATE_OUTPUT" | grep -oP '(?<=FORGE:TEST_GATE:RESULT=)(BLOCK|PASS|SKIP)' | tail -1 || echo "SKIP")

echo "Test-gate verdict: ${TEST_GATE_VERDICT}"
```

**Verdict handling**:

```bash
case "$TEST_GATE_VERDICT" in

  SKIP)
    echo "ℹ️  Test gate: SKIP — no executable changes or tests not configured."
    echo "   This gap will appear in the Phase 8 summary. No deploy impact."
    TEST_GATE_REASON="SKIP — no runtime tests ran (docs-only bundle, no integration tests configured, or manual-only criteria)"
    ;;

  PASS)
    echo "✅ Test gate: PASS — all test clusters passed. Deploy may proceed."
    TEST_GATE_REASON="PASS — all automated test clusters passed"
    # Post FORGE:GATE_PASS for symmetric observability
    if [ -n "$PR_NUMBER" ]; then
      gh pr comment "$PR_NUMBER" ${GH_FLAG} --body "<!-- FORGE:GATE_PASS -->
## Deploy Gate: PASSED

**Gate**: test-gate (runtime acceptance criteria)
**Result**: PASS — all test clusters passed. Deploy may proceed.
**Bundle PRs**: ${ALL_PR_NUMBERS}
**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

<!-- FORGE:GATE_PASS:TYPE=test-gate|BUNDLE=$(echo $ALL_PR_NUMBERS | tr '\n' ' ' | xargs) -->" 2>/dev/null || true
    fi
    ;;

  BLOCK)
    # Check for override comment on the staging→main PR (mirrors Phase 0A pattern)
    if [ -n "$PR_NUMBER" ]; then
      TG_OVERRIDE=$(gh pr view "$PR_NUMBER" ${GH_FLAG} \
        --json comments \
        --jq "[.comments[].body | select(startswith(\"${OVERRIDE_PHRASE}\"))] | length" 2>/dev/null || echo 0)
    else
      TG_OVERRIDE=0
    fi

    if [ "${TG_OVERRIDE:-0}" -gt 0 ]; then
      OVERRIDE_REASON=$(gh pr view "$PR_NUMBER" ${GH_FLAG} \
        --json comments \
        --jq "[.comments[].body | select(startswith(\"${OVERRIDE_PHRASE}\"))] | last" 2>/dev/null || echo "(reason not captured)")
      echo "⚠️  Test gate: BLOCK — but override comment detected on PR #${PR_NUMBER}."
      echo "   Override: ${OVERRIDE_REASON}"
      echo "   Proceeding with deploy. Override is logged in Phase 8 summary."
      TEST_GATE_VERDICT="PASS"
      TEST_GATE_REASON="BLOCK downgraded to PASS by override: ${OVERRIDE_REASON}"

    elif [ "$GATE_POSTURE" = "advisory" ]; then
      echo "⚠️  Test gate: BLOCK (advisory posture) — runtime failures detected but deploy is NOT prevented."
      echo "   Switch verification.test_gate.posture to 'blocking' in forge.yaml to enforce this gate."
      TEST_GATE_REASON="BLOCK (advisory) — runtime failures detected; deploy allowed by advisory posture"

    else
      # blocking posture (default) — STOP
      echo "⛔ DEPLOY BLOCKED — /test-gate returned BLOCK verdict."
      echo ""
      echo "Runtime failures were detected in the staging→${DEFAULT_BRANCH} bundle."
      echo "The failures were batch-introduced (not pre-existing on ${DEFAULT_BRANCH} baseline)."
      echo ""
      echo "Options:"
      echo "  1. Fix the failing tests and merge fixes to staging before retrying the deploy."
      echo "  2. Post a comment on this PR starting with \"${OVERRIDE_PHRASE} <reason>\" to bypass this gate."
      echo "  3. Set verification.test_gate.posture: advisory in forge.yaml to downgrade to a warning."
      echo ""
      echo "RESULT: BLOCK DEPLOY"

      # Post structured FORGE:GATE_FAILURE comment for pipeline-health tracking
      GATE_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      if [ -n "$PR_NUMBER" ]; then
        gh pr comment "$PR_NUMBER" ${GH_FLAG} --body "<!-- FORGE:GATE_FAILURE -->
## Deploy Gate: BLOCKED

**Gate**: test-gate
**Timestamp**: ${GATE_TIMESTAMP}
**Bundle PRs**: $(echo $ALL_PR_NUMBERS | tr '\n' ' ')
**Posture**: ${GATE_POSTURE}

### What Happened

\`/test-gate\` detected runtime failures in the staging→\`${DEFAULT_BRANCH}\` bundle that were NOT present on the \`${DEFAULT_BRANCH}\` baseline. These are batch-introduced regressions.

\`/test-gate\` has filed \`test-failure\` issues for each failing cluster — check the issue tracker for details.

### Resolution

1. Fix the failing tests and merge fixes to staging.
2. Retry the staging→\`${DEFAULT_BRANCH}\` deploy.

To override (ship known failures with documented reason), post a comment containing:
\`${OVERRIDE_PHRASE} <reason>\`

<!-- FORGE:GATE_FAILURE:TYPE=test-gate|BUNDLE=$(echo $ALL_PR_NUMBERS | tr '\n' ' ' | xargs) -->" 2>/dev/null || true
      fi
      exit 1
    fi
    ;;

  *)
    echo "⚠️  Test gate: unrecognised verdict '${TEST_GATE_VERDICT}' — treating as SKIP."
    TEST_GATE_VERDICT="SKIP"
    TEST_GATE_REASON="SKIP — unrecognised verdict from /test-gate (treated as SKIP)"
    ;;

esac
```

If the gate exits with `RESULT: BLOCK DEPLOY` → **STOP**. A `<!-- FORGE:GATE_FAILURE -->` structured comment is automatically posted on the staging→main PR (if `$PR_NUMBER` is set) for pipeline-health tracking. `/test-gate` will have filed `test-failure` issues for each failing cluster before returning BLOCK.

---

## Phase 7: Finding Triage & Issue Creation

### 7A: Extract Findings
From PR comments, extract structured findings (`<!-- FINDING:... -->`). If none found, scan for unstructured findings. If still 0 → skip to Phase 8.

### 7B: Filter & Deduplicate
Keep ALL findings (CONFIRMED/LIKELY/POSSIBLE). Deduplicate by file:line (keep higher confidence). Sort: CONFIRMED first, then by severity.

### 7C: Ensure Labels
```bash
# Colors match the canonical ForgeDock label manifest (bin/labels.json).
# Run `npx forgedock labels setup` to bootstrap all managed labels at once.
gh label create "review-finding" --color "D93F0B" --description "Defect or improvement found during automated PR review. Managed by ForgeDock." --force -R {GH_REPO} 2>/dev/null
gh label create "needs-validation" --color "FBCA04" --description "Review finding awaiting human validation. Managed by ForgeDock." --force -R {GH_REPO} 2>/dev/null
gh label create "staging-review" --color "1D76DB" --description "Finding from a staging branch review before deploy to main. Managed by ForgeDock." --force -R {GH_REPO} 2>/dev/null
```

### 7D: Milestone Detection
Only assign milestone if reviewing a milestone/* branch. Plain staging reviews get no milestone.

### 7E: Deduplicate Against Existing Issues
Check for open review-finding issues at same file:line → skip. Closed issues at same location → potential regression (elevate priority).

### 7F: Create Issues
Sequential creation. Title: `Staging Review: {summary} (staging → main)`. Labels: review-finding, needs-validation, staging-review, priority:P1/priority:P2/priority:P3. Body includes: source branch context (`staging`), code context, evidence, validation checklist.

**For each finding** (that passes dedup), create issue:
```bash
ISSUE_NUM=$(gh issue create \
  -R {GH_REPO} \
  --title "chore: [summary] (staging review — PR #${PR_NUMBER})" \
  --label "review-finding,needs-validation,staging-review,{priority}" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

[One sentence: what bug or issue was found. Where it occurs (`file:line`) and what it causes.]

**Source**: PR #[PR_NUMBER] — [TITLE]
**Confidence**: [CONFIRMED/LIKELY/POSSIBLE]
**Severity**: [CRITICAL/HIGH/MEDIUM/LOW]
**Review comment**: [permalink to agent comment]

## Affected Files

Files that need changes:
1. `[file:line]` — [what needs to change to fix this finding]

## Source Branch Context

**Code branch**: `staging`
**Worktree base**: `origin/staging`

> When fixing: `git worktree add ../fix-{slug} -b fix/{slug} origin/staging`

## Code Context
[10 lines around finding]

## Evidence
[From agent comment]

## Acceptance Criteria

- [ ] Finding validated: VALIDATED / FALSE_POSITIVE / INCONCLUSIVE
- [ ] If VALIDATED: fix implemented and tested on correct branch
ISSUE_EOF
)" --json number --jq '.number')
```

Labels: `review-finding` + `needs-validation` + `staging-review` + priority (`priority:P1` CONFIRMED, `priority:P2` LIKELY, `priority:P3` POSSIBLE).

**No pre-filtering**: Every finding becomes an issue. Validation agents sort out false positives downstream.

### 7G: Add to Project Board
### 7H: Update PR Description with Findings Table

---

## Phase 8: Final Summary & Deployment Checklist

Post summary with verdict:
1. CI failed + autofix failed → BLOCK DEPLOY
2. CI failed + autofix succeeded → continue
2.5. Test gate returned BLOCK (blocking posture, no override) → BLOCK DEPLOY *(handled in Phase 6.5 — if Phase 8 is reached, BLOCK was either overridden or posture is advisory)*
3. CONFIRMED CRITICAL (non-CI) → BLOCK DEPLOY
4. CONFIRMED HIGH blocking (crashes, data loss) → NEEDS FIXES FIRST
5. All else → APPROVE FOR DEPLOY

Include: Material Changes Summary, Risk Matrix (CI, Build, Bugs, Security, Billing, Quality, Regression, **Test Gate**), Finding Triage Results, Blocking Issues, Deployment Checklist (pre-deploy, deploy, post-deploy verification, rollback triggers), Stats.

**Risk Matrix must include a Test Gate row** (use `$TEST_GATE_VERDICT` and `$TEST_GATE_REASON` set in Phase 6.5):

| Domain | Result | Notes |
|--------|--------|-------|
| CI | ... | ... |
| Build | ... | ... |
| Bugs | ... | ... |
| Security | ... | ... |
| Billing | ... | ... |
| Quality | ... | ... |
| Regression | ... | ... |
| **Test Gate** | `${TEST_GATE_VERDICT:-SKIP}` | `${TEST_GATE_REASON:-Phase 6.5 not run}` |

If `TEST_GATE_VERDICT` is `SKIP`, surface the gap explicitly in the summary:

> **Test Gate: SKIP** — No runtime tests ran for this bundle. This means acceptance criteria were NOT verified against running code before deploy. Cause: `${TEST_GATE_REASON}`. To enable runtime testing, configure `verification.integration_tests` in `forge.yaml`.

If `TEST_GATE_VERDICT` is `PASS`, note it as a positive signal:

> **Test Gate: PASS** — Acceptance criteria verified against running code. No batch-introduced runtime failures detected.

If `TEST_GATE_VERDICT` is `BLOCK` and Phase 8 was reached (advisory posture or override active), note it as a risk:

> **Test Gate: BLOCK (override/advisory)** — Runtime failures were detected but deploy is proceeding. Reason: `${TEST_GATE_REASON}`. Filed `test-failure` issues track the failures.

**CRITICAL**: This review NEVER merges staging → main. User makes deploy decision via GitHub web UI.
