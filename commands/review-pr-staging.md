---
description: Staging review mode — comprehensive review of staging branch before deploy to main
argument-hint: [PR number or "staging"]
allowed-tools: Task, Bash, Read, Grep, Glob, WebFetch
---

# Staging Review

**Trigger**: Invoked by the orchestrator via `Skill("review-pr-staging", $ARGUMENTS)`, or directly with `$ARGUMENTS` = "staging", a PR number targeting main, or "staging:feature".

Performs comprehensive review of `staging` before merging to `main`. Handles large diffs (1,000-10,000+ lines), diverse changes, deep analysis, and business impact assessment.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`. User can override with `--model <name>`.

---

## Evidence-Based Review Protocol (ALL Agents)

### Diff-First Approach
```bash
git fetch origin main staging
git diff origin/main...origin/staging
```

### Dynamic Exploration
From each changed file, follow imports and function calls. Trace data flows across service boundaries (API → Redis → Worker).

### Validation Before Reporting

| Confidence | Criteria | Action |
|------------|----------|--------|
| CONFIRMED | Traced full code path, found specific proof | Report as P1 |
| LIKELY | Pattern suggests issue, mitigations might exist | Report as P2 |
| POSSIBLE | Suspicious but couldn't trace fully | Report as P3 |
| UNFOUNDED | Found correct handling | Do NOT report |

### Severity Decision Tree
1. Runtime error → HIGH/CRITICAL
2. Wrong data silently → HIGH
3. Degraded performance → MEDIUM
4. Genuinely cosmetic after tracing all consumers → LOW

### Interaction Analysis
NEVER dismiss as "pre-existing" without checking whether NEW code interacts with it to create a bug. List every new line referencing the pre-existing construct; if any would fail at runtime → CONFIRMED finding.

### False Positive Prevention
- Variable scope: Read FULL function, count indentation, check if/else structure
- Type mismatches: Trace variable to source, check naming
- Missing functions: `grep -rn "functionName" .` — check re-exports/aliases
- Unreachable code: Check all callers, dynamic dispatch, tests
- Redundant imports: In Python, local `import X` makes X local for entire function scope — check for UnboundLocalError

### Report Format
Every finding: File:Line, code snippet, evidence, confidence, files checked.

---

## Structured Findings Protocol

Append at end of every agent comment:
```
<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:PREFIX-N|CONFIDENCE|SEVERITY|file.py:line|One-line summary -->
<!-- REVIEW-FINDINGS-END -->
```

Include ALL findings (CONFIRMED, LIKELY, POSSIBLE). One line per finding, sequential numbering.

**Prefixes**: SEC, AUTH, BILL, CONC, SCRP, FE, API, DB, INFRA, BUG, QA, REG

---

## Phase 0A: Open Review-Finding Gate (BLOCKING — runs before scope analysis)

**Purpose**: Prevent deploying commits that have known, unfixed review findings. The review system catches bugs before merging; this gate ensures the merge path acts on that information.

**Why this matters**: Review findings are filed before the originating PR merges to staging. Without this gate, a staging→main bundle can include commits with known unfixed bugs — the review system caught the issue, but the deploy path ignored it. This gate closes the gap between issue discovery and deploy execution. <!-- Added: forge#303 -->

```bash
git fetch origin main staging

# Step 1: Find all PR numbers in the staging→main bundle
# These are the PRs whose commits are included in staging but not yet in main
BUNDLE_PRS=$(git log origin/main..origin/staging --oneline \
  | grep -oP '#\d+' \
  | sort -u \
  | tr -d '#')

# Also extract PR numbers from merge commit subjects (most reliable)
MERGE_PRS=$(git log origin/main..origin/staging --merges --oneline \
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
fi
```

If the gate exits with `RESULT: BLOCK DEPLOY` → **STOP**. Do NOT proceed to Phase 0B or any downstream phases. A `<!-- FORGE:GATE_FAILURE -->` structured comment is automatically posted on the staging→main PR (if `$PR_NUMBER` is set) for pipeline-health tracking. Report the blocking finding list.

---

## Phase 0B: Scope Analysis

```bash
git fetch origin main staging
git diff origin/main...origin/staging --stat | tail -20
git diff origin/main...origin/staging --numstat | awk '{add+=$1; del+=$2} END {print "Added:", add, "Deleted:", del, "Total:", add+del}'
git diff origin/main...origin/staging --name-only | sort | uniq
```

Categorize by service (API, Worker, Web, Shared, Infra). Identify high-risk files (billing, credits, pricing, auth, security, migration, scraper).

Create review chunks by priority: Billing/Pricing (CRITICAL) → Security/Auth (CRITICAL) → Scraper Core (HIGH) → API Routers (HIGH) → Worker (HIGH) → Web (MEDIUM) → Shared (MEDIUM) → Infra (MEDIUM) → Other (LOW).

---

## Phase 1: Automated Checks

### 1A: Python Linting
```bash
cd services/api && poetry run black --check app/ && poetry run isort --check app/
cd services/worker && poetry run black --check worker/ && poetry run isort --check worker/
```

### 1B: TypeScript Type-Check + Build (MANDATORY)
```bash
cd web && npx tsc --noEmit 2>&1
cd web && npx next build 2>&1 | tail -50
```
`next build` failure is BLOCKING — deploy WILL fail. `tsc` alone misses SSG prerender failures.

### 1C: Python Tests
```bash
cd services/api && poetry run pytest tests/ -x -q --tb=short 2>&1 | tail -50
```

### 1D: Secrets Scan
```bash
git diff origin/main...origin/staging | grep -iE "(api[_-]?key|secret|password|token|credential)" | grep -vE "(#|//|\.example|placeholder)" | head -20
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

## Phase 7: Finding Triage & Issue Creation

### 7A: Extract Findings
From PR comments, extract structured findings (`<!-- FINDING:... -->`). If none found, scan for unstructured findings. If still 0 → skip to Phase 8.

### 7B: Filter & Deduplicate
Keep ALL findings (CONFIRMED/LIKELY/POSSIBLE). Deduplicate by file:line (keep higher confidence). Sort: CONFIRMED first, then by severity.

### 7C: Ensure Labels
```bash
gh label create "review-finding" --color "D93F0B" --force 2>/dev/null
gh label create "needs-validation" --color "FBCA04" --force 2>/dev/null
gh label create "staging-review" --color "1D76DB" --force 2>/dev/null
```

### 7D: Milestone Detection
Only assign milestone if reviewing a milestone/* branch. Plain staging reviews get no milestone.

### 7E: Deduplicate Against Existing Issues
Check for open review-finding issues at same file:line → skip. Closed issues at same location → potential regression (elevate priority).

### 7F: Create Issues
Sequential creation. Title: `Staging Review: {summary} (staging → main)`. Labels: review-finding, needs-validation, staging-review, P1/P2/P3. Body includes: source branch context (`staging`), code context, evidence, validation checklist.

**No pre-filtering**: Every finding becomes an issue. Validation agents sort out false positives downstream.

### 7G: Add to Project Board
### 7H: Update PR Description with Findings Table

---

## Phase 8: Final Summary & Deployment Checklist

Post summary with verdict:
1. CI failed + autofix failed → BLOCK DEPLOY
2. CI failed + autofix succeeded → continue
3. CONFIRMED CRITICAL (non-CI) → BLOCK DEPLOY
4. CONFIRMED HIGH blocking (crashes, data loss) → NEEDS FIXES FIRST
5. All else → APPROVE FOR DEPLOY

Include: Material Changes Summary, Risk Matrix (CI, Build, Bugs, Security, Billing, Quality, Regression), Finding Triage Results, Blocking Issues, Deployment Checklist (pre-deploy, deploy, post-deploy verification, rollback triggers), Stats.

**CRITICAL**: This review NEVER merges staging → main. User makes deploy decision via GitHub web UI.
