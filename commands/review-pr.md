---
description: Context-aware PR review — analyzes what the PR touches, spawns domain-specific agents with project conventions. Supports staging reviews.
argument-hint: "[PR number, URL, \"open\", or \"staging\" for feature→main review]"
allowed-tools: Task, Agent, Bash, Read, Grep, Glob, WebFetch, Skill
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# PR Review — Orchestrator

**Input**: $ARGUMENTS

**NEVER use plan mode (EnterPlanMode)** during review — it breaks execution context.
**Sub-agent dispatch tool: `Task` preferred, `Agent` is the documented fallback.** review-pr dispatches domain review agents via a sub-agent-spawning tool. Resolve which one is available ONCE per invocation, before Phase 3C, per the **Sub-Agent Dispatch Tool Resolution** rule below — do not halt to ask the operator which tool to use. Never fall back to reviewing inline in the orchestrator's own context; inline self-review is a strictly weaker substitute for an isolated fresh-context reviewer and is not a permitted fallback.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier); the General Security & Quality reviewer spawned as always-runs Task uses `effort: xhigh` (deep tier). Fallback: `model: "opus"` if rate-limited. User can override with `--model <name>`. Pass model and effort explicitly in every `Task` tool call. Feature gate: pass `effort` only on Claude Code >= 2.1.154. **The domain-review Task agents this file dispatches** (per `commands/review-pr-agents/*.md`) resolve via `model: "{SUBAGENT_MODEL}"` — forge.yaml `agents.subagent_model`, else `agents.default_model`, else `"sonnet"` — not `{DEFAULT_MODEL}` directly.

<!-- FORGE:SPEC_LOADED — review-pr.md loaded and active. Agent is bound by this spec. -->

## HARD RULES — READ BEFORE ANYTHING ELSE

1. **Use the resolved `{DISPATCH_TOOL}(...)` for ALL domain agent launches.** Resolve `{DISPATCH_TOOL}` once, per the **Sub-Agent Dispatch Tool Resolution** section below: `Task` when available, `Agent` as the documented fallback when `Task` is absent from the environment. Every dispatch call in this run uses the same resolved tool — do not mix. Whichever tool is used, each agent MUST run in an isolated, fresh-context sub-agent (not inline in the orchestrator's own context) and post findings to the PR via `gh pr comment` in structured form.

2. **Post the FORGE:REVIEW verdict regardless of finding severity.** A review that completes but posts no `<!-- FORGE:REVIEW -->` comment is invisible to the pipeline. Even a PASS verdict must be posted.

3. **Review findings do NOT block merge UNLESS they meet the Blocking Criteria in §7B** (a CONFIRMED HIGH/CRITICAL finding, a purpose regression, a merge conflict, or a build/type/test failure) **or the calibration threshold check in §7B.5 sets `CALIBRATION_NEEDS_HUMAN=true`** (HIGH-confidence task type with historical survival < 80%). File every finding as a GitHub issue with the `review-finding` label regardless of severity. Minor/style findings never block; §7B's and §7B.5's blocking conditions always do — including under `--auto-merge`. <!-- forge#1741 -->

4. **Route correctly at Phase 0.** If the input is "staging" or the PR targets `main`, invoke `Skill("review-pr-staging", ...)` — do NOT run the standard PR review pipeline against a staging→main PR.

5. **`spec-evolution` PRs are NEVER auto-merged.** When a PR carries the `spec-evolution` label (created by `/spec-doctor`), Phase -1 MUST set `AUTO_MERGE=false` and add `needs-human` before any other processing. This cannot be overridden by the caller — the eval gate plus human review are the only permitted merge path. See Phase -1 `spec-evolution guard` block. <!-- Added: forge#1742 -->

## Sub-Agent Dispatch Tool Resolution (MANDATORY — run once, before Phase 3C)

This spec dispatches domain review agents via a sub-agent-spawning tool. Different runtimes expose different tools for this — resolve deterministically, once per invocation, and use the same tool for every dispatch call in this run:

1. **If `Task` is available in the current environment**: set `{DISPATCH_TOOL} = Task`. This is the preferred tool — tightest `allowed-tools` scoping.
2. **Else if `Agent` is available**: set `{DISPATCH_TOOL} = Agent`. This is the documented fallback, not a degraded path — use it exactly as you would `Task`: one call per selected domain agent, same prompt template, `subagent_type: "general-purpose"` (or the closest equivalent the environment offers), same requirement that each agent posts its own findings directly to the PR via `gh pr comment`. Isolation and fresh-context review are preserved either way.
3. **Neither tool is available**: this is a genuine setup defect, not a routing decision — HARD STOP, post a PR/issue comment explaining that no sub-agent dispatch tool is available, add `needs-human`, and exit without posting a verdict. Do NOT fall back to reviewing inline in the orchestrator's own context — inline self-review is strictly weaker than an isolated fresh-context reviewer and is never a substitute for a missing dispatch tool.

**Do not halt to ask the operator which tool to use.** Steps 1–2 are deterministic and fully resolve the common case; only step 3 (both absent) requires a stop, and even then the action is HARD STOP + `needs-human`, not a question back to the operator.

Everywhere this file (and `review-pr-agents.md` / the `review-pr-agents/*.md` persona files) says `Task(...)`, read it as `{DISPATCH_TOOL}(...)` using the value resolved here.

## Forbidden Tools Self-Check

**Before executing any phase**, verify you are NOT using any of these:

| Tool/Pattern | Status | Reason |
|------|--------|--------|
| `Agent`, when `Task` is available | **FORBIDDEN** | `Task` is preferred whenever present — `Agent` is only the fallback for when `Task` is absent, not a free substitute |
| Inline self-review (no sub-agent spawn at all) | **FORBIDDEN** | Bypasses isolated fresh-context review entirely — always spawn via the resolved `{DISPATCH_TOOL}`, never review directly in the orchestrator's own context |
| `EnterPlanMode` | **FORBIDDEN** | Breaks execution context; must run phases, not plan them |

If you find yourself about to call `Agent(...)` while `Task` is available, stop and use `Task(...)` instead. If neither `Task` nor `Agent` is available, do not fall through to inline review — follow step 3 of Sub-Agent Dispatch Tool Resolution above. If you find yourself about to use `EnterPlanMode`, stop and execute the next phase directly.

## Architecture — How This Command Works

This is the **orchestrator**. It routes to the right review mode, runs automated checks, spawns domain-specific agents, triages findings, and posts the verdict.

**Sub-files** (loaded on demand — NOT auto-loaded):

| File | What | How to invoke |
|------|------|---------------|
| `${FORGE_HOME:-$REPO_PATH}/commands/review-pr-agents/protocols.md` | Shared review protocols (Evidence-Based + Structured Findings + Input Scoping) | `Read` tool during Phase 3C (always) |
| `${FORGE_HOME:-$REPO_PATH}/commands/review-pr-agents/<persona>.md` | Per-persona agent prompt templates (9 files) | `Read` tool during Phase 3C (selected agents only) |
| `${FORGE_HOME:-$REPO_PATH}/commands/review-pr-staging.md` | Full staging→main review pipeline | `Skill("review-pr-staging", ...)` during Phase 0 |

`$FORGE_HOME` defaults to `~/.claude` (the directory where `npx forgedock` symlinks commands). When unset, every resolution in this file falls back to `$REPO_PATH` (the repo root, from `forge.yaml → paths.root`) rather than degrading to a bare root-anchored path — see the `TEMPLATE_BASE` tiered guard in Phase 3C and the verification-script resolution in Step 2.5B for the actual fallback chains. Never resolve a missing file via a filesystem-wide `find` — see the guardrail in `commands/review-pr-agents/protocols.md`.

**Invocation flow:**
```
/review-pr 5428          → Phase 0 detects single PR → runs Phases 1-9 inline
/review-pr staging       → Phase 0 detects staging mode → Skill("review-pr-staging", "staging")
/review-pr 5500          → Phase 0 auto-detects staging→main PR → Skill("review-pr-staging", "5500")
/review-pr 3126 --auto-merge --issue 3124 --base staging  → single PR + auto-merge after approval
```

---

### Auto-Merge Flag

If `$ARGUMENTS` contains `--auto-merge`, this review was invoked from `/work-on` and must merge the PR after approval. Parse:

```
Example: "3126 --auto-merge --issue 3124 --base staging --gh-flag -R $GH_REPO --worktree /path/to/worktree"
```

Extract: `PR_NUMBER`, `AUTO_MERGE=true`, `MERGE_ISSUE`, `MERGE_BASE`, `MERGE_GH_FLAG`, `MERGE_WORKTREE` (optional — the absolute path to the git worktree to clean up after merge)

If `--auto-merge` is NOT present, `AUTO_MERGE=false` — Phase 8 (Auto-Merge) will be skipped.

### Thoroughness Flag

If `$ARGUMENTS` contains `--thorough`, set `THOROUGH=true`. This restores full union-dispatch (all matched domain agents run) for release-critical PRs. Default is `THOROUGH=false` — risk-scaled dispatch (2-3 agents).

```bash
THOROUGH=false
echo "$ARGUMENTS" | grep -q "\-\-thorough" && THOROUGH=true
```

---

## Phase -1: Route Assertion

**This phase is MANDATORY and must execute BEFORE Phase 0. No phase may be skipped.**

Resolve the PR number and post a routing marker immediately. This creates an audit trail — if a PR has no `FORGE:REVIEW_ROUTE` comment after a review command was run, the review was bypassed or never started.

```bash
# Determine REVIEW_MODE from $ARGUMENTS before any routing decision
REVIEW_MODE_RAW="$ARGUMENTS"
if echo "$ARGUMENTS" | grep -qE '^(staging|feature|staging:feature)$'; then
  REVIEW_MODE="staging-keyword"
  ROUTE_PR_NUMBER="(resolved by staging sub-command)"
elif echo "$ARGUMENTS" | grep -qE '^(open|all)$'; then
  REVIEW_MODE="multi-pr"
  ROUTE_PR_NUMBER="(list mode)"
else
  # Single PR number or URL — resolve HEAD/BASE now
  PR_ROUTE_INFO=$(gh pr view $ARGUMENTS --json number,baseRefName,headRefName --jq '{number:.number,base:.baseRefName,head:.headRefName}')
  ROUTE_PR_NUMBER=$(echo "$PR_ROUTE_INFO" | jq -r '.number')
  ROUTE_HEAD=$(echo "$PR_ROUTE_INFO" | jq -r '.head')
  ROUTE_BASE=$(echo "$PR_ROUTE_INFO" | jq -r '.base')
  if [ "$ROUTE_HEAD" = "staging" ] && [ "$ROUTE_BASE" = "main" ] || [ "$ROUTE_HEAD" = "feature" ] && [ "$ROUTE_BASE" = "main" ]; then
    REVIEW_MODE="staging-auto"
  else
    REVIEW_MODE="single-pr"
  fi
fi

REVIEW_SHA_ROUTE=$(gh pr view ${ROUTE_PR_NUMBER:-$ARGUMENTS} --json headRefOid --jq '.headRefOid' 2>/dev/null | cut -c1-7 || echo "n/a")

# spec-evolution guard — MUST run before posting FORGE:REVIEW_ROUTE <!-- Added: forge#1742 -->
# spec-evolution PRs are produced by /spec-doctor and require eval-gate + human review.
# Auto-merge is structurally excluded regardless of how review-pr was invoked.
# This guard activates for single-PR mode only (staging/multi-pr modes don't auto-merge anyway).
IS_SPEC_EVOLUTION=false
if [ "$REVIEW_MODE" = "single-pr" ] && [ -n "$ROUTE_PR_NUMBER" ] && [ "$ROUTE_PR_NUMBER" != "(list mode)" ] && [ "$ROUTE_PR_NUMBER" != "(resolved by staging sub-command)" ]; then
  SPEC_EVOL_CHECK=$(gh pr view "$ROUTE_PR_NUMBER" --json labels \
    --jq '[.labels[].name] | any(. == "spec-evolution")' 2>/dev/null || echo "false")
  if [ "$SPEC_EVOL_CHECK" = "true" ]; then
    IS_SPEC_EVOLUTION=true
    AUTO_MERGE=false
    # Add needs-human label to the associated issue (if --issue was passed in $ARGUMENTS)
    SPEC_EVOL_ISSUE=$(echo "$ARGUMENTS" | grep -oP '(?<=--issue )\d+' || echo "")
    if [ -n "$SPEC_EVOL_ISSUE" ]; then
      GH_FLAG_SPEC=$(echo "$ARGUMENTS" | grep -oP '(?<=-R )\S+' | head -1 | sed 's/^/-R /' || echo "")
      gh issue edit "$SPEC_EVOL_ISSUE" $GH_FLAG_SPEC --add-label "needs-human" 2>/dev/null || true
    fi
    echo "SPEC-EVOLUTION GUARD: PR #${ROUTE_PR_NUMBER} carries 'spec-evolution' label."
    echo "AUTO_MERGE forced to false. Human review + eval gate required before merge."
    echo "HARD RULE 5: This cannot be overridden by the caller."
  fi
fi

# Post the routing assertion marker to the PR (skip for list/keyword modes where no PR# is known yet)
# CODEC PATH (forge#1727): REVIEW_ROUTE is a custom (non-RESERVED) annotation type; emit() tolerates
# unknown types. Use the codec CLI to produce the opening tag for any FORGE: annotation.
# For single-line control markers like REVIEW_ROUTE, the inline heredoc is acceptable as long
# as field values contain no untrusted content (here: REVIEW_MODE and REVIEW_SHA_ROUTE are
# pipeline-internal values, not user-supplied text). For annotations with user-supplied fields,
# route through: forge-annotation.sh write REVIEWER --field Verdict=APPROVED ...
if [ "$REVIEW_MODE" != "staging-keyword" ] && [ "$REVIEW_MODE" != "multi-pr" ]; then
  if [ "$IS_SPEC_EVOLUTION" = "true" ]; then
    gh pr comment "$ROUTE_PR_NUMBER" --body "<!-- FORGE:REVIEW_ROUTE mode=spec-evolution-blocked spec=review-pr.md sha=${REVIEW_SHA_ROUTE} -->
⚠️ **spec-evolution PR**: auto-merge is structurally excluded (HARD RULE 5). Eval gate must pass and a human must review and merge. See \`docs/design/eval-gate-runbook.md\`."
  else
    gh pr comment "$ROUTE_PR_NUMBER" --body "<!-- FORGE:REVIEW_ROUTE mode=${REVIEW_MODE} spec=review-pr.md sha=${REVIEW_SHA_ROUTE} -->"
  fi
fi
```

**Invariant**: After this phase, `REVIEW_MODE` and (where applicable) `ROUTE_PR_NUMBER` are set. Any sub-invocation of `Skill("review-pr-staging", ...)` should immediately post its own `FORGE:REVIEW_ROUTE` marker scoped to the PR it resolves.

---

## Phase 0: Route to Review Mode

Check input to determine which mode:

**CRITICAL — NO DELTA REVIEWS**: If PR was reviewed before, always run the FULL pipeline. Prior findings are already in GitHub issues. Full re-review catches build failures and prerender crashes.

### MODE 1: Staging Review

If `$ARGUMENTS` is "staging", "feature", or "staging:feature":

```
>>> INVOKE: Skill("review-pr-staging", "$ARGUMENTS")
>>> THEN STOP — the staging command handles the full flow.
```

### MODE 2: Multiple PR Review ("open", "all")

```bash
gh pr list --state open --json number,title,author,createdAt,headRefName
```

Show list, ask user which to review, then loop through each with full review.

### MODE 3: Single PR (number or URL)

**Auto-detect staging mode:**
```bash
PR_INFO=$(gh pr view $ARGUMENTS --json baseRefName,headRefName,additions,deletions,title)
HEAD=$(echo $PR_INFO | jq -r '.headRefName')
BASE=$(echo $PR_INFO | jq -r '.baseRefName')
```

If `HEAD = "staging" AND BASE = "main"` OR `HEAD = "feature" AND BASE = "main"`:
```
>>> INVOKE: Skill("review-pr-staging", "$ARGUMENTS")
>>> THEN STOP.
```

If `HEAD starts with "milestone/" AND BASE = "staging"`:
```
>>> This is a milestone shipping PR. It has a large accumulated diff from many feat/* PRs.
>>> Run the FULL inline multi-agent review pipeline (Phases 1-9), NOT a single-PR review.
>>> The diff is large — treat it like a staging review in terms of thoroughness.
>>> Proceed to Phase 1.
```

Otherwise → proceed to Phase 1.

---

## Phase 1: PR Context & Classification

### 1A: Fetch PR Data
```bash
gh pr view $ARGUMENTS --json number,title,body,author,baseRefName,headRefName,files,additions,deletions
REVIEW_SHA=$(gh pr view $ARGUMENTS --json headRefOid --jq '.headRefOid')
REVIEW_SHA_SHORT=$(echo "$REVIEW_SHA" | cut -c1-7)
gh pr diff $ARGUMENTS --name-only
gh pr diff $ARGUMENTS

# Mergeability check — GitHub computes this asynchronously; retry up to 3× on UNKNOWN
# <!-- Added: forge#194 -->
MERGE_HEALTH_RESULT=$(gh pr view $ARGUMENTS --json mergeable,mergeStateStatus --jq '"\\(.mergeable)|\\(.mergeStateStatus)"')
MERGE_HEALTH=${MERGE_HEALTH_RESULT%%|*}
MERGE_HEALTH_STATE=${MERGE_HEALTH_RESULT##*|}
MERGE_RETRY=0
while [ "$MERGE_HEALTH" = "UNKNOWN" ] && [ "$MERGE_RETRY" -lt 3 ]; do
    MERGE_RETRY=$((MERGE_RETRY + 1))
    sleep 5
    MERGE_HEALTH_RESULT=$(gh pr view $ARGUMENTS --json mergeable,mergeStateStatus --jq '"\\(.mergeable)|\\(.mergeStateStatus)"')
    MERGE_HEALTH=${MERGE_HEALTH_RESULT%%|*}
    MERGE_HEALTH_STATE=${MERGE_HEALTH_RESULT##*|}
done
# MERGE_HEALTH: MERGEABLE | CONFLICTING | UNKNOWN (still async after retries)
# MERGE_HEALTH_STATE: CLEAN | DIRTY | BLOCKED | UNSTABLE | UNKNOWN

# Resolve repo name early — used in Phases 5, 6, 8B, 9A (clean-review skip path bypasses Phase 6A) <!-- Added: forge#820 -->
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')

# First-time contributor detection <!-- Added: forge#960 -->
# Requires REPO to be set (line above). Checks whether the PR author has any prior merged PRs in this repo.
# IS_FIRST_TIME_CONTRIBUTOR is consumed in Phase 9 to conditionally post an onboarding welcome comment.
PR_AUTHOR=$(gh pr view "$ARGUMENTS" -R "$REPO" --json author --jq '.author.login')
PRIOR_MERGED_COUNT=$(gh pr list -R "$REPO" --author "$PR_AUTHOR" --state merged --limit 1 --json number --jq 'length' 2>/dev/null || echo "1")
IS_FIRST_TIME_CONTRIBUTOR="false"
[ "$PRIOR_MERGED_COUNT" -eq 0 ] && IS_FIRST_TIME_CONTRIBUTOR="true"
```

### 1B: Classify
```bash
FILES=$(gh pr diff $ARGUMENTS --name-only)
DIFF=$(gh pr diff $ARGUMENTS)

echo "=== SERVICES ==="
# Service detection is path-agnostic — matches project-specific and generic structures
echo "$FILES" | grep -cE "(^services/api/|/api/|/backend/)" && echo "API" || true
echo "$FILES" | grep -cE "(^services/worker/|/worker/|/jobs/|/tasks/)" && echo "WORKER" || true
echo "$FILES" | grep -cE "(^web/|/frontend/|/app/|\.tsx?$|\.jsx?$)" && echo "WEB" || true
echo "$FILES" | grep -cE "(^shared/|/shared/|/common/|/lib/)" && echo "SHARED" || true
echo "$FILES" | grep -cE "^(docker|infra/|\.github|Makefile|traefik|k8s/|terraform/)" && echo "INFRA" || true

echo "=== DOMAINS ==="
echo "$DIFF" | grep -cE "get_current_user|jwt|oauth|login|logout|require_auth|authenticated_user|x.forwarded.for|x_forwarded_for|forwarded_for|rate.limit.*ip|ip.*rate.limit|algorithm.*HS256|algorithm.*RS256|NEXTAUTH_SECRET|JWT_SECRET" && echo "AUTH" || true
echo "$DIFF" | grep -cE "credit|balance|debit|reconcil|pricing|charge|refund|stripe|subscription|payment" && echo "BILLING" || true
# SCRAPING: only match browser-automation/scraping keywords, NOT bare "playwright" (avoids E2E test repos)
echo "$DIFF" | grep -cE "scrape|tier.*escalat|anti_bot|stealth|playwright.*scrape|scrape.*playwright|playbook_min_tier|browser.*pool|proxy.*scrape|web.*scrape" && echo "SCRAPING" || true
echo "$DIFF" | grep -cE "FOR UPDATE|atomic|transaction|pipeline|MULTI|distributed_lock|acquire_lock|reserved_by|promo.*claim|voucher.*redeem" && echo "CONCURRENCY" || true
echo "$FILES" | grep -cE "migration|\.sql$" && echo "DATABASE" || true
echo "$DIFF" | grep -cE "create_async_engine|AsyncSession|connect_args|pool_size|prepared_statement|engine_from_config|sessionmaker" && echo "DB_CONFIG" || true
echo "$FILES" | grep -cE "router|routes" && echo "API_DESIGN" || true
```

### 1C: Document
Record: services touched, domains detected, PR scope (1-2 sentences), change categories.

---

## Phase 2: Automated Checks (Run ALL in Parallel)

### 2A: Python Linting (if Python changed)

Read `forge.yaml → verification.commands.python` for project-specific tool commands:

```bash
# Read toolchain commands from forge.yaml
PYTHON_FORMAT=$(yq '.verification.commands.python.format // ""' forge.yaml 2>/dev/null || echo '')
PYTHON_LINT=$(yq '.verification.commands.python.lint // ""' forge.yaml 2>/dev/null || echo '')
PYTHON_TYPECHECK=$(yq '.verification.commands.python.typecheck // ""' forge.yaml 2>/dev/null || echo '')

# Run format check
if [ -n "$PYTHON_FORMAT" ]; then
    eval "$PYTHON_FORMAT" 2>&1 | head -30
else
    echo "SKIPPED — python.format not configured in verification.commands"
fi

# Run lint
if [ -n "$PYTHON_LINT" ]; then
    eval "$PYTHON_LINT" 2>&1 | head -30
else
    echo "SKIPPED — python.lint not configured in verification.commands"
fi

# Run typecheck
if [ -n "$PYTHON_TYPECHECK" ]; then
    eval "$PYTHON_TYPECHECK" 2>&1 | head -50
else
    echo "SKIPPED — python.typecheck not configured in verification.commands"
fi

# Always run compile check on changed Python files (fast, language-universal)
gh pr diff $ARGUMENTS --name-only | grep '\.py$' | while IFS= read -r f; do
    python3 -m py_compile "$f" 2>&1
done
```

### 2B: TypeScript/JS (if TypeScript/JS changed)

Read `forge.yaml → verification.commands.typescript` for project-specific tool commands:

```bash
TS_FORMAT=$(yq '.verification.commands.typescript.format // ""' forge.yaml 2>/dev/null || echo '')
TS_LINT=$(yq '.verification.commands.typescript.lint // ""' forge.yaml 2>/dev/null || echo '')
TS_TYPECHECK=$(yq '.verification.commands.typescript.typecheck // ""' forge.yaml 2>/dev/null || echo '')

# Run format check
if [ -n "$TS_FORMAT" ]; then
    eval "$TS_FORMAT" 2>&1 | head -30
else
    echo "SKIPPED — typescript.format not configured in verification.commands"
fi

# Run lint
if [ -n "$TS_LINT" ]; then
    eval "$TS_LINT" 2>&1 | head -30
else
    echo "SKIPPED — typescript.lint not configured in verification.commands"
fi

# Run typecheck
if [ -n "$TS_TYPECHECK" ]; then
    eval "$TS_TYPECHECK" 2>&1 | head -50
    TS_TYPECHECK_EXIT=$?
else
    echo "SKIPPED — typescript.typecheck not configured in verification.commands"
    TS_TYPECHECK_EXIT=0
fi
```

### 2C: Static Type Checking (if Python changed)

Covered by `PYTHON_TYPECHECK` command in 2A above. If `verification.commands.python.typecheck` is unset, this step is explicitly skipped with a log line — it does not silently pass.

### 2D: Environment Variable Audit
```bash
gh pr diff $ARGUMENTS | grep -E "os\.getenv|os\.environ|process\.env" | head -30
```
Flag if new env vars not in `.env.example`.

### 2E: Secrets Detection (CRITICAL — BLOCKING if found)
```bash
gh pr diff $ARGUMENTS | grep -iE "(api[_-]?key|secret[_-]?key|password|token|credential|private[_-]?key)" | grep -vE "(#|//|\.example|placeholder|PLACEHOLDER|YOUR_|<|>)" | head -20
gh pr diff $ARGUMENTS | grep -oE "['\"][A-Za-z0-9+/=]{40,}['\"]" | head -10
```

### 2F: SQL Migration Validation (if *.sql changed)
```bash
gh pr diff $ARGUMENTS --name-only | grep "\.sql$" | while IFS= read -r sql_file; do
    grep -E "FOR UPDATE" "$sql_file" | grep -qE "(SUM|COUNT|AVG|MIN|MAX)\s*\(" && echo "ERROR: FOR UPDATE with aggregate"
    grep -qE "DROP (TABLE|COLUMN|INDEX)" "$sql_file" && ! grep -qE "IF EXISTS" "$sql_file" && echo "WARNING: DROP without IF EXISTS"
    grep -qE "ALTER TABLE.*ADD COLUMN.*NOT NULL" "$sql_file" && ! grep -qE "DEFAULT" "$sql_file" && echo "WARNING: NOT NULL without DEFAULT"
done
```

### 2G: Dependency Audit (if pyproject.toml or package.json changed)
```bash
git diff origin/main...HEAD -- "**/pyproject.toml" | grep -E "^\+" | grep -v "^\+\+\+" | head -20
git diff origin/main...HEAD -- "**/package.json" | grep -E "^\+" | grep -v "^\+\+\+" | head -20
```

### 2H: Tests

Read `forge.yaml → verification.commands.{lang}.test` for the project's test command.

**Before running tests**: check the quarantine manifest for known pre-broken and flaky tests:

```bash
# Load quarantine manifest if present — used below to suppress known-bad tests from blocking.
QUARANTINE_MANIFEST=".forgedock/quarantine.jsonl"
QUARANTINED_TESTS=""
if [ -f "$QUARANTINE_MANIFEST" ]; then
    QUARANTINED_TESTS=$(grep -oP '"test":"[^"]*"' "$QUARANTINE_MANIFEST" 2>/dev/null | sed 's/"test":"//;s/"//' | sort -u)
    QUARANTINE_COUNT=$(echo "$QUARANTINED_TESTS" | grep -c . || echo 0)
    echo "Quarantine manifest: ${QUARANTINE_COUNT} known-bad test(s) — these will not block the review if they fail."
    echo "$QUARANTINED_TESTS" | sed 's/^/  - /'
fi
```

```bash
# Check each configured language for a test command
for lang in python typescript go rust; do
    TEST_CMD=$(yq ".verification.commands.${lang}.test // \"\"" forge.yaml 2>/dev/null || echo '')
    if [ -n "$TEST_CMD" ]; then
        echo "=== Running tests (${lang}): ${TEST_CMD} ==="
        eval "$TEST_CMD" 2>&1 | tail -30
        TEST_EXIT=$?
        if [ "$TEST_EXIT" -ne 0 ]; then
            # Attempt to cross-reference with quarantine manifest.
            # If ALL failing test names appear in $QUARANTINED_TESTS, suppress the block.
            # Without per-test granularity from the test runner, fall back to treating
            # any failure as blocking unless the classifier script is available.
            CLASSIFIER="${FORGEDOCK_SCRIPTS:-scripts}/flaky-quarantine.sh"
            [ -f "$CLASSIFIER" ] || CLASSIFIER="scripts/flaky-quarantine.sh"
            if [ -f "$CLASSIFIER" ]; then
                CL_RESULT=$(bash "$CLASSIFIER" \
                    --test "$TEST_CMD" \
                    --base "$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|origin/||' || echo main)" \
                    --retries 3 2>&1)
                echo "$CL_RESULT"
                CL=$(echo "$CL_RESULT" | grep '^CLASSIFICATION:' | awk '{print $2}')
                if [ "$CL" = "PRE_BROKEN" ] || [ "$CL" = "FLAKY" ]; then
                    echo "ADVISORY (not blocking): ${lang} tests classified ${CL} — quarantined, does not block this review"
                else
                    echo "BLOCKING: ${lang} tests failed (exit $TEST_EXIT) — classified REAL"
                fi
            else
                echo "BLOCKING: ${lang} tests failed (exit $TEST_EXIT)"
            fi
        fi
    fi
done

# If no test commands were configured, log explicitly
PYTHON_TEST=$(yq '.verification.commands.python.test // ""' forge.yaml 2>/dev/null || echo '')
TS_TEST=$(yq '.verification.commands.typescript.test // ""' forge.yaml 2>/dev/null || echo '')
if [ -z "$PYTHON_TEST" ] && [ -z "$TS_TEST" ]; then
    echo "SKIPPED — no test commands configured in verification.commands"
fi
```
**BLOCKING only for REAL test failures** (deterministically caused by this PR). Pre-broken and flaky failures are surfaced as advisories and do not block approval.

### 2I: Build Verification (MANDATORY for staging→main AND milestone→staging)

```bash
CHANGED_FILES=$(gh pr diff $ARGUMENTS --name-only)
HAS_TS=$(echo "$CHANGED_FILES" | grep -E '\.(tsx?|jsx?)$' | head -1)
HAS_PY=$(echo "$CHANGED_FILES" | grep -E '\.py$' | head -1)
# Use POSIX-portable if/else (avoid bash-only [[ ]])
IS_STAGING_TO_MAIN="false"
if [ "$HEAD" = "staging" ] && [ "$BASE" = "main" ]; then IS_STAGING_TO_MAIN="true"; fi
IS_MILESTONE_TO_STAGING="false"
case "$HEAD" in milestone/*) if [ "$BASE" = "staging" ]; then IS_MILESTONE_TO_STAGING="true"; fi ;; esac
REQUIRES_FULL_BUILD="false"
if [ "$IS_STAGING_TO_MAIN" = "true" ] || [ "$IS_MILESTONE_TO_STAGING" = "true" ]; then REQUIRES_FULL_BUILD="true"; fi
```

**TypeScript files changed:**

Read `forge.yaml → verification.commands.typescript.typecheck` and `.build`:

```bash
gh pr checkout $ARGUMENTS --detach 2>/dev/null

TS_TYPECHECK=$(yq '.verification.commands.typescript.typecheck // ""' forge.yaml 2>/dev/null || echo '')
TS_BUILD=$(yq '.verification.commands.typescript.build // ""' forge.yaml 2>/dev/null || echo '')

if [ -n "$TS_TYPECHECK" ]; then
    eval "$TS_TYPECHECK" 2>&1
    TSC_EXIT=$?
else
    echo "SKIPPED — typescript.typecheck not configured in verification.commands"
    TSC_EXIT=0
fi

if [ -n "$TS_BUILD" ] && { [ "$REQUIRES_FULL_BUILD" = "true" ] || [ "$TSC_EXIT" -eq 0 ]; }; then
    eval "$TS_BUILD" 2>&1 | tail -30
    BUILD_EXIT=$?
elif [ -z "$TS_BUILD" ]; then
    echo "SKIPPED — typescript.build not configured in verification.commands"
fi

git checkout - 2>/dev/null
```

If `TSC_EXIT != 0`: **CONFIRMED blocking** — type errors.
If `BUILD_EXIT != 0`: **CONFIRMED blocking** — build/prerender failure.

**CRITICAL**: typecheck alone is NOT sufficient for staging→main or milestone→staging — configure `typescript.build` in `verification.commands` to catch SSG/prerender failures that typecheck misses.

**Python files changed:**

Read `forge.yaml → verification.commands.python.format` and `.build`:

```bash
gh pr checkout $ARGUMENTS --detach 2>/dev/null

# Compile-check all changed Python files (language-universal — no config needed)
echo "$CHANGED_FILES" | grep '\.py$' | while IFS= read -r f; do python3 -m py_compile "$f" 2>&1; done

if [ "$REQUIRES_FULL_BUILD" = "true" ]; then
    PYTHON_FORMAT=$(yq '.verification.commands.python.format // ""' forge.yaml 2>/dev/null || echo '')
    if [ -n "$PYTHON_FORMAT" ]; then
        eval "$PYTHON_FORMAT" 2>&1
    else
        echo "SKIPPED — python.format not configured in verification.commands (full-build format check skipped)"
    fi
fi

git checkout - 2>/dev/null
```

**BLOCKING if any check fails.** Fix before merge — do not approve with known build/format failures.

### 2J: Builder Contract Scope Check (if PR is from /work-on pipeline)

Check whether the PR's actual changes match what the builder committed to in its contract:

```bash
# Find the contract comment on the linked issue
ISSUE_NUM=$(gh pr view $ARGUMENTS --json body --jq '.body | gsub("(?s).*?(?:Closes #|#)(?<n>[0-9]+).*"; "\(.n)") // empty' 2>/dev/null | head -1)
if [ -n "$ISSUE_NUM" ]; then
    CONTRACT_FILES=$(gh api repos/${REPO}/issues/${ISSUE_NUM}/comments --jq '[.[] | select(.body | contains("FORGE:CONTRACT"))] | .[0].body' 2>/dev/null | grep -E '`[^`]+\.(py|tsx?|sql|sh|yml|yaml|json)`' | grep -oE '`[^`]+\.(py|tsx?|sql|sh|yml|yaml|json)`' | tr -d '`' | sort -u)
    PR_FILES=$(gh pr diff $ARGUMENTS --name-only | sort -u)

    # Files in PR but NOT in contract
    SCOPE_CREEP=$(comm -23 <(echo "$PR_FILES") <(echo "$CONTRACT_FILES") 2>/dev/null | grep -vE '\.(md|txt|example)$')
    if [ -n "$SCOPE_CREEP" ]; then
        echo "SCOPE: PR changes files not in builder contract:"
        echo "$SCOPE_CREEP"
        echo "This is informational — may be legitimate (discovered during implementation). Flag if suspicious."
    fi
fi
```

This is not blocking — scope expansion during implementation is normal. But large unexplained scope creep (5+ uncontracted files) should be flagged in the review summary.

---

## Phase 2.5: Assumption Verification (Integration Integrity)

**WHY THIS EXISTS**: Code review catches logic bugs inside changed files. But bugs increasingly come from correct code that doesn't execute because another system layer blocks, shadows, or reroutes it. As the system grows more layers (nginx → next.config → route handlers → middleware → business logic → Redis → Postgres), the probability of "correct but unreachable" code increases combinatorially.

This phase asks: **"What must be true in the rest of the system for each changed file to actually work? Are those assumptions true?"**

### How It Works

For each changed file, identify its **activation path** — how does execution reach this code? Then verify the path is intact by checking unchanged system files.

### Step 2.5A: Identify File Types and Their Registration Points

Map each changed file to its activation requirements.

**Layout path resolution** — Before applying the table below, read your project's layout from `forge.yaml → review.layout` and substitute the values into the pattern column. Defaults (used when the key is absent) are the ForgeDock install defaults:

| `forge.yaml` key | Default | Used in table as |
|-----------------|---------|-----------------|
| `review.layout.pages` | `web/src/app` | `{PAGES_ROOT}` |
| `review.layout.api_routers` | `services/api/app/routers` | `{API_ROUTERS}` |
| `review.layout.api_main` | `services/api/app/main.py` | `{API_MAIN}` |
| `review.layout.api_middleware` | `services/api/app/middleware` | `{API_MIDDLEWARE}` |
| `review.layout.migrations` | `infra/migrations` | `{MIGRATIONS}` |
| `review.layout.worker` | `services/worker` | `{WORKER}` |

| Changed File Pattern | Assumption | Verification Target |
|---------------------|------------|---------------------|
| `{PAGES_ROOT}/api/**/*.ts` (Route Handler) | Requests reach this handler | Check `web/next.config.js` rewrites don't shadow it; check `infra/nginx/nginx.conf` routes path to Next.js |
| `{API_ROUTERS}/*.py` (API Router) | Router is registered in app | Check `{API_MAIN}` includes this router |
| `{API_MIDDLEWARE}/*.py` | Middleware is in the stack | Check `{API_MAIN}` middleware registration order |
| `{MIGRATIONS}/*.sql` | Migration runs on current schema | Check previous migration's end state matches assumptions |
| `shared/**/*.py` | Imported by consumer services | Verify import paths exist in api/worker; check Docker volume mounts |
| `{WORKER}/**/*.py` (Consumer) | Queue consumer is registered | Check consumer registration in worker startup |
| Any file using `os.getenv("NEW_VAR")` | Env var is set at runtime | Check `docker-compose.yml`, `.env.example`, `{API_MAIN}` env validation module |
| `scripts/decrypt-secrets.sh` (ENV_MAPPING) | Secret reaches running container | Trace full chain: SOPS key → ENV_MAPPING → deploy workflow SCP target → merge script path → `docker-compose.prod.yml` env_file. See Step 2.5B SOPS deploy chain check. |
| `.secrets/prod.enc.yaml` | SOPS key maps to ENV_MAPPING | Verify key path in YAML matches the tuple in `decrypt-secrets.sh` ENV_MAPPING |
| `.github/workflows/deploy-production.yml` | Deploy paths are consistent | Verify SCP target + merge script `PROJECT` var resolve to same dir as `docker-compose.prod.yml` env_file |
| `web/src/components/**/*.tsx` | Component is imported somewhere | Check for at least one import of this component |
| `services/*/config/*.json` | Config is baked into image | Check Dockerfile COPY or volume mount in `docker-compose.yml` |
| `infra/nginx/*.conf` | Nginx loads this config | Check `docker-compose.yml` volume mount for nginx |
| `infra/**/*.sh`, `scripts/**/*.sh` with `curl`/`wget` to internal services | HTTP request is accepted by target service | Read target service's middleware stack (`main.py` for API: TrustedHostMiddleware, CORS, auth). Verify Host header, auth headers, and URL path will produce the expected status code. |
| `web/src/app/**/*-client.tsx`, `web/src/components/**/*.tsx`, `web/src/lib/*.ts` (Client-side code with `fetch()`/`useSWR()`) | Client requests go through Next.js proxy (`/api/...`), never directly to FastAPI (`/api/v1/...`) | Grep changed `.tsx`/`.ts` files (excluding `route.ts` proxy handlers) for `fetch("/api/v1/` or `` `/api/v1/ `` in template literals or `useSWR.*"/api/v1/`. Any match is a **CONFIRMED BLOCKING** integration bug — direct calls bypass session auth (admin proxy JWT, session-to-bearer conversion) and fail locally (no nginx). |
| `.github/workflows/*.yml` (Workflow with test/build jobs) | Sibling workflows with same-named jobs stay in sync | For each job name in the changed workflow, check if the same job name exists in sibling workflows (`ci.yml` ↔ `deploy-production.yml` ↔ `hotfix-deploy.yml`). Compare env vars, PYTHONPATH, working-directory, and run commands for meaningful drift. |
| `docker-compose*.yml` changes to `postgres` or `redis` service (`command:`, `image:`, `volumes:`, `environment:`) | Stateful container will NOT be recreated during deploy, OR restart is safe | **Auto-escalate to HIGH risk.** Changing `command:` args, `image:` tag, or `volumes:` forces container recreation on `docker-compose up`. For stateful services (postgres, redis), verify: (1) `stop_grace_period` is set and sufficient (≥30s for PG); (2) `full_page_writes = on` in PG config (protects against partial page writes on crash); (3) `fsync = on` (ensures write durability); (4) No long-running transactions will be interrupted. If container recreation is unavoidable, recommend scheduling during a maintenance window — NOT as a side effect of a routine deploy. **This check prevents the class of incident documented in issue #146**: a PG `command:` arg change triggered container restart under active load, corrupting btree indexes. |
| `docker-compose*.yml` changes `entrypoint:` or `command:` to reference a script (`.sh` file) | Env vars used inside the entrypoint script are available inside the container at runtime | **Run `verify-env-vars.sh`** which detects shell `${VAR}` references in entrypoint scripts and cross-checks against the service's `environment:` section. Docker Compose `${VAR}` in YAML `command:` is parsed at Compose load time (host-side) — the var doesn't need to be in the container. But `${VAR}` inside an entrypoint `.sh` script runs at container runtime — it MUST be injected via `environment:` or `env_file:`. **This check prevents the class of incident where a service migrates from `command:` args (Compose interpolation) to an entrypoint script (container runtime) without adding the env var to `environment:`, causing a restart loop on deploy.** <!-- Added: forge#185 --> |
| **ANY staging→main PR** (regardless of files changed) | `ci.yml` and `deploy-production.yml` test jobs are in sync | **ALWAYS runs for staging→main PRs.** Pre-existing drift is invisible until deploy. Deep-diff shared jobs (test-api, test-web): compare PYTHONPATH values, dependency install steps, and step names. A missing PYTHONPATH or install step in deploy is CONFIRMED BLOCKING — CI passes but deploy fails (PR #11356 incident). |

### Step 2.5B: Run Verification

For each changed file, execute the relevant checks using the standalone verification scripts in `${FORGE_HOME:-$SCRIPTS_HOME}/scripts/`. These scripts can also be run independently outside the review context (e.g., from `/quality-gate` or `/work-on` builder steps).

**Platform note**: The verify-*.sh scripts require bash and standard POSIX tools. On Windows without bash (Git Bash / WSL / MSYS2), these checks are skipped with an explicit message — the review continues without them.

```bash
CHANGED_FILES=$(gh pr diff $ARGUMENTS --name-only)
REPO_ROOT="."  # Assumes cwd is the repo root

# Resolve the verify-*.sh scripts source directory with the same deterministic
# fallback as the Phase 3C TEMPLATE_BASE guard: $FORGE_HOME first (the installed
# ForgeDock location), then this repo's own root (forge.yaml -> paths.root, or
# git top-level). A bare/unset $FORGE_HOME must never be used directly in a path —
# that degrades to a root-anchored path (/scripts/verify-*.sh) and silently skips
# every check below. Never fall back to a filesystem-wide `find`.
# <!-- Added: forge#2035 -->
if [ -n "$FORGE_HOME" ] && [ -f "$FORGE_HOME/scripts/verify-route-registration.sh" ]; then
    SCRIPTS_HOME="$FORGE_HOME"
else
    FORGE_YAML="${FORGE_CONFIG:-$(git rev-parse --show-toplevel 2>/dev/null)/forge.yaml}"
    SCRIPTS_HOME=$(yq '.paths.root' "$FORGE_YAML" 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null || pwd)
fi

# --- Platform / bash capability guard ---
# The verify-*.sh scripts require bash. Detect availability before invoking.
# On Windows without Git Bash/WSL, skip gracefully rather than crash.
BASH_AVAILABLE=false
if command -v bash >/dev/null 2>&1 && bash -c 'echo ok' >/dev/null 2>&1; then
    BASH_AVAILABLE=true
fi

if [ "$BASH_AVAILABLE" = "true" ]; then
    # Write changed files and diff to temp files for script consumption.
    # Use PID-based names instead of mktemp for cross-platform compatibility.
    CHANGED_FILES_TMP="/tmp/forge-review-changed-$$.tmp"
    DIFF_TMP="/tmp/forge-review-diff-$$.tmp"
    echo "$CHANGED_FILES" > "$CHANGED_FILES_TMP"
    gh pr diff $ARGUMENTS > "$DIFF_TMP"

    # --- Script-based checks (reusable, testable, deterministic) ---
    # Each script exits 0 (pass), 1 (blocking findings), or 2 (warnings only).
    # Output is structured: "BLOCKING: ...", "WARNING: ...", "OK: ..." per line.

    # 1. Route/router/middleware/shared-module/component registration
    # Export forge.yaml layout overrides so verify-route-registration.sh uses project-configured
    # paths instead of project defaults. The script supports these env vars (lines 36-44 of
    # verify-route-registration.sh) but requires the caller to set them. <!-- Added: forge#1349 -->
    if [ -f "$REPO_ROOT/forge.yaml" ]; then
        _PAGES_ROOT=$(grep -A10 'layout:' "$REPO_ROOT/forge.yaml" 2>/dev/null \
            | grep -E '^\s*pages:' | head -1 | sed 's/.*pages:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs)
        _API_ROUTERS=$(grep -A10 'layout:' "$REPO_ROOT/forge.yaml" 2>/dev/null \
            | grep -E '^\s*api_routers_dir:' | head -1 | sed 's/.*api_routers_dir:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs)
        _API_MAIN=$(grep -A10 'layout:' "$REPO_ROOT/forge.yaml" 2>/dev/null \
            | grep -E '^\s*api_main:' | head -1 | sed 's/.*api_main:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs)
        _API_MIDDLEWARE=$(grep -A10 'layout:' "$REPO_ROOT/forge.yaml" 2>/dev/null \
            | grep -E '^\s*api_middleware_dir:' | head -1 | sed 's/.*api_middleware_dir:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs)
        [ -n "$_PAGES_ROOT" ] && export FORGE_PAGES_ROOT="$_PAGES_ROOT"
        [ -n "$_API_ROUTERS" ] && export FORGE_API_ROUTERS_DIR="$_API_ROUTERS"
        [ -n "$_API_MAIN" ] && export FORGE_API_MAIN="$_API_MAIN"
        [ -n "$_API_MIDDLEWARE" ] && export FORGE_API_MIDDLEWARE_DIR="$_API_MIDDLEWARE"
    fi
    echo "=== Running: verify-route-registration.sh ==="
    bash "$SCRIPTS_HOME/scripts/verify-route-registration.sh" "$CHANGED_FILES_TMP" "$REPO_ROOT" || true

    # 2. Environment variable wiring (checks .env.example, docker-compose, env_validation, SOPS mapping)
    echo "=== Running: verify-env-vars.sh ==="
    bash "$SCRIPTS_HOME/scripts/verify-env-vars.sh" "$DIFF_TMP" "$REPO_ROOT" || true

    # 3. Host headers in shell scripts + client-side proxy bypass check
    # Read project-specific internal service patterns from forge.yaml (if present)
    FORGE_INTERNAL_PATTERNS=""
    if [ -f "$REPO_ROOT/forge.yaml" ]; then
        FORGE_INTERNAL_PATTERNS=$(grep -A 999 'internal_service_patterns:' "$REPO_ROOT/forge.yaml" \
            | grep -E '^\s*-\s+' \
            | sed 's/^\s*-\s*//' \
            | tr -d '"'"'" \
            | awk 'NR>1{printf "|"}{printf $0}END{print ""}')
    fi
    export FORGE_INTERNAL_PATTERNS
    echo "=== Running: verify-host-headers.sh ==="
    bash "$SCRIPTS_HOME/scripts/verify-host-headers.sh" "$CHANGED_FILES_TMP" "$REPO_ROOT" || true

    # 4. SOPS deploy chain (ENV_MAPPING consistency, deploy path drift, hotfix sync)
    echo "=== Running: verify-sops-chain.sh ==="
    bash "$SCRIPTS_HOME/scripts/verify-sops-chain.sh" "$DIFF_TMP" "$CHANGED_FILES_TMP" "$REPO_ROOT" || true

    # Cleanup temp files
    rm -f "$CHANGED_FILES_TMP" "$DIFF_TMP"
else
    echo "=== Phase 2.5B: verify-*.sh skipped — bash not available on this platform ==="
    echo "    The verify-*.sh scripts require bash (POSIX shell)."
    echo "    Install Git Bash (Windows) or WSL to enable these checks."
    echo "    The review continues — integration assumptions should be verified manually."
fi

# --- Inline checks (not yet extracted to scripts) ---

# Python scoping hazard check — local imports that shadow module-level names
# A local `import X` makes X a local variable for the ENTIRE function scope.
# Any reference to X ABOVE the local import will crash with UnboundLocalError.
echo "$CHANGED_FILES" | grep -E '\.py$' | while IFS= read -r f; do
    echo "=== Python Scoping Check: $f ==="
    # Find function-scoped imports (indented import statements)
    grep -nE "^\s+import [a-z]" "$f" 2>/dev/null | while read line; do
        LINENO=$(echo "$line" | cut -d: -f1)
        MODULE=$(echo "$line" | grep -oE "import [a-z_]+" | awk '{print $2}')
        # Check if the same module is used BEFORE this line in the same function
        # (simplified check — agents should do full scope analysis)
        [ -n "$MODULE" ] && head -n $((LINENO-1)) "$f" 2>/dev/null | grep -qE "^\s+.*\b${MODULE}\." && \
            echo "WARNING: Local 'import $MODULE' at line $LINENO may shadow module-level import — check for UnboundLocalError on references above this line"
    done
done

# Config file assumption check (baked into Docker image vs volume-mounted)
echo "$CHANGED_FILES" | grep -E "config/.*\.(json|yaml|yml)$" | while IFS= read -r f; do
    echo "=== Config File: $f ==="
    grep -n "$(dirname $f)" docker-compose.yml 2>/dev/null || echo "WARNING: Config dir may not be mounted — changes may require --build"
    grep -n "$(dirname $f)" services/*/Dockerfile 2>/dev/null || true
done

# Sibling workflow drift check — ALWAYS runs for staging→main PRs.
# Also runs when any workflow file changes on non-staging PRs.
#
# The class of bug this catches: ci.yml has PYTHONPATH + worker deps,
# deploy-production.yml doesn't. CI passes, deploy fails.
# PR #11356 was approved with green CI but deploy pipeline broke.
#
# CRITICAL: This check must NOT be gated on workflow files being in the
# diff. Pre-existing drift is the most dangerous kind — it lurks until
# staging→main and then blocks the deploy.
WORKFLOW_FILES=$(echo "$CHANGED_FILES" | grep -E "^\.github/workflows/.*\.yml$" || true)
# Use POSIX-portable conditional (avoid bash-only [[ ]])
IS_STAGING_PR="false"
if [ "$HEAD" = "staging" ] && [ "$BASE" = "main" ]; then IS_STAGING_PR="true"; fi

if [ -n "$WORKFLOW_FILES" ] || [ "$IS_STAGING_PR" = "true" ]; then
    echo "=== Sibling Workflow Drift Check (MANDATORY for staging→main) ==="

    CI_WF=".github/workflows/ci.yml"
    DEPLOY_WF=".github/workflows/deploy-production.yml"

    if [ -f "$CI_WF" ] && [ -f "$DEPLOY_WF" ]; then
        # Deep comparison: extract the full test step (name + run + env) from
        # each shared job and diff them. Keyword grepping missed the PR #11356
        # failure — PYTHONPATH was present in CI but absent in deploy.
        for JOB in test-api test-web; do
            CI_HAS=$(grep -c "name: Test.*${JOB#test-}" "$CI_WF" 2>/dev/null || echo 0)
            DEPLOY_HAS=$(grep -c "name: Test.*${JOB#test-}" "$DEPLOY_WF" 2>/dev/null || echo 0)
            [ "$CI_HAS" -eq 0 ] || [ "$DEPLOY_HAS" -eq 0 ] && continue

            echo "--- Comparing '$JOB' job between ci.yml and deploy-production.yml ---"

            # Extract env vars from ALL steps in the job (not just pytest).
            # Flag-based awk avoids the range-collapse bug: /pat1/,/pat2/ collapses
            # to a single line when the header (e.g. "  test-api:") matches both
            # patterns simultaneously. The flag form sets p=1 on the header line,
            # prints body lines while p=1, and clears p when the next sibling job
            # header (same indentation, lowercase start) is seen. <!-- Added: forge#310 -->
            CI_ENVS=$(awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $0~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$CI_WF" 2>/dev/null | grep -E "PYTHONPATH|DATABASE_URL|REDIS_URL|TESTING" | sed 's/^ *//' | sort)
            DEPLOY_ENVS=$(awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $0~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$DEPLOY_WF" 2>/dev/null | grep -E "PYTHONPATH|DATABASE_URL|REDIS_URL|TESTING" | sed 's/^ *//' | sort)

            # Check for PYTHONPATH specifically — the exact var that caused the #11356 failure
            CI_PYPATH=$(echo "$CI_ENVS" | grep "PYTHONPATH" || echo "(not set)")
            DEPLOY_PYPATH=$(echo "$DEPLOY_ENVS" | grep "PYTHONPATH" || echo "(not set)")
            if [ "$CI_PYPATH" != "$DEPLOY_PYPATH" ]; then
                echo "  BLOCKING: PYTHONPATH differs between ci.yml and deploy-production.yml for job '$JOB'"
                echo "    ci.yml:              $CI_PYPATH"
                echo "    deploy-production:   $DEPLOY_PYPATH"
                echo "  This WILL cause deploy failure — CI passes but deploy test step uses different Python path."
            fi

            # Check for dependency installation steps that exist in one but not the other
            CI_INSTALLS=$(awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $0~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$CI_WF" 2>/dev/null | grep -c "poetry install\|pip install\|npm install" || echo 0)
            DEPLOY_INSTALLS=$(awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $0~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$DEPLOY_WF" 2>/dev/null | grep -c "poetry install\|pip install\|npm install" || echo 0)
            if [ "$CI_INSTALLS" != "$DEPLOY_INSTALLS" ]; then
                echo "  WARNING: Different number of dependency install steps in '$JOB' — ci.yml has $CI_INSTALLS, deploy has $DEPLOY_INSTALLS"
                echo "  ACTION: Read both files and verify all dependencies needed by tests are installed in both workflows."
            fi

            # Check step names — if CI has a step that deploy doesn't, flag it
            CI_STEPS=$(awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $0~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$CI_WF" 2>/dev/null | grep "- name:" | sed 's/.*- name: //' | sort)
            DEPLOY_STEPS=$(awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $0~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$DEPLOY_WF" 2>/dev/null | grep "- name:" | sed 's/.*- name: //' | sort)
            MISSING_IN_DEPLOY=$(comm -23 <(echo "$CI_STEPS") <(echo "$DEPLOY_STEPS") 2>/dev/null || true)
            if [ -n "$MISSING_IN_DEPLOY" ]; then
                echo "  WARNING: Steps in ci.yml '$JOB' missing from deploy-production.yml:"
                echo "$MISSING_IN_DEPLOY" | sed 's/^/    - /'
            fi
        done
    fi
fi
```

### Step 2.5C: Record Broken Assumptions

Any WARNING from the checks above is a **CONFIRMED finding** — the changed code may not execute as intended. Record these as pre-found issues that will be included in the agent context (Phase 3) and in the final findings (Phase 6).

Format: `INTEG-N|CONFIRMED|HIGH|file:line|Changed code may be unreachable: {reason}`

**This phase is NOT optional.** It runs for every review, regardless of PR size or domain. A 3-line route handler change that fails this check is more dangerous than a 500-line refactor that passes.

---

## Phase 3: Agent Selection & Launch

### 3A: Risk Assessment

**NEVER scale review depth by line count.** A 5-line shell script processing LLM output is more dangerous than a 500-line React component.

```bash
DIFF=$(gh pr diff $ARGUMENTS)
FILES=$(gh pr diff $ARGUMENTS --name-only)
echo "=== RISK SIGNALS ==="
echo "$DIFF" | grep -cE "subprocess|exec|eval|system\(|popen|heredoc" && echo "  UNTRUSTED_INPUT_PROCESSING" || true
echo "$DIFF" | grep -cE "\.sh$|bash|shell|cron" && echo "  SHELL_SCRIPT" || true
echo "$DIFF" | grep -cE "credit|balance|debit|charge|refund|stripe" && echo "  FINANCIAL" || true
echo "$DIFF" | grep -cE "jwt|oauth|password|token|secret|x.forwarded.for|x_forwarded_for|forwarded_for|rate.limit.*ip|ip.*rate.limit|algorithm.*HS256|algorithm.*RS256|NEXTAUTH_SECRET|JWT_SECRET|get_current_user|require_auth" && echo "  AUTH_SENSITIVE" || true
echo "$DIFF" | grep -cE "\.sql$|migration|DROP|ALTER|DELETE FROM" && echo "  DATABASE_MUTATION" || true
echo "$DIFF" | grep -cE "docker|deploy|traefik|nginx|\.yml.*service" && echo "  INFRASTRUCTURE" || true
echo "$DIFF" | grep -cE "docker-compose.*postgres|docker-compose.*redis|postgres.*command:|redis.*command:|image:.*postgres|image:.*redis" && echo "  DATABASE_CONTAINER" || true
echo "$DIFF" | grep -cE "create_async_engine|AsyncSession|connect_args|pool_size|prepared_statement|engine_from_config|sessionmaker" && echo "  DB_CONFIG" || true
echo "$DIFF" | grep -cE "subprocess|os\.system|eval\(|exec\(|pickle|yaml\.load[^_]" && echo "  CODE_EXECUTION" || true
echo "$FILES" | grep -cE "^sdk/|openapi.*\.json$|openapi-versions/" && echo "  SDK_OPENAPI" || true
```

**Churn (hot-spot) signal**: The signals above are all derived from the current diff content — none of them measure historical change frequency or defect density. Compute both commit-churn tier and finding-density tier for the PR's changed files and carry them forward as `CHURN_CONTEXT` for Phase 3C: <!-- Finding-density signal: forge#1738 -->

```bash
CHURN_WINDOW="90 days ago"   # named constant — must match the same window used in architect.md Phase A5
CHURN_CONTEXT=""

# Load danger-zones index for finding-density signal (non-blocking — absent index is not an error).
# The index is produced by scripts/danger-zones.mjs and updated on each merge via
# build-knowledge-index.mjs --with-danger-zones. When absent, only commit-count signal is used.
DANGER_ZONES_INDEX="${HOME}/.forge/index/danger-zones.json"
DZ_DATA=""
if [ -f "$DANGER_ZONES_INDEX" ]; then
  DZ_DATA=$(cat "$DANGER_ZONES_INDEX" 2>/dev/null || true)
fi

# Herestring (not a piped `| while read`) — a pipe would run the loop body in a
# subshell in bash, silently discarding CHURN_CONTEXT once the loop exits. $FILES
# is one path per line (gh pr diff --name-only), so `read -r` per line is safe
# even when a path contains embedded spaces.
while IFS= read -r FILE; do
  [ -z "$FILE" ] && continue

  # Commit-churn signal (unchanged from original)
  COMMITS=$(git log --oneline --since="$CHURN_WINDOW" -- "$FILE" 2>/dev/null | wc -l)
  COMMIT_TAG=""
  if [ "$COMMITS" -ge 15 ]; then
    COMMIT_TAG=" — HOT (${COMMITS} commits/90d)"
  fi

  # Finding-density signal (new — reads from danger-zones index when available)
  FINDING_TAG=""
  if [ -n "$DZ_DATA" ]; then
    FINDING_COUNT=$(echo "$DZ_DATA" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
files = d.get('files', {})
entry = files.get('${FILE}', None)
if entry:
    print(entry.get('findingCount90d', 0))
else:
    print(0)
" 2>/dev/null || echo "0")
    if [ "${FINDING_COUNT:-0}" -ge 3 ]; then
      FINDING_TAG=" — HOT-FINDINGS (${FINDING_COUNT} findings/90d)"
    fi
  fi

  # Append to CHURN_CONTEXT when either signal fires
  if [ -n "$COMMIT_TAG" ] || [ -n "$FINDING_TAG" ]; then
    # Real newline appended via $'\n' (ANSI-C quoting), not a literal backslash-n.
    # A literal "\n" would only be interpreted by `echo -e` — it survives
    # unprocessed into Phase 3C's raw template substitution ([CHURN_CONTEXT] ->
    # $CHURN_CONTEXT), which does not reprocess escapes, so with 2+ HOT files
    # multi-hotspot PRs would render squished in the agent prompt. A real
    # newline here makes the variable correct for every consumer.
    CHURN_CONTEXT="${CHURN_CONTEXT}${FILE}${COMMIT_TAG}${FINDING_TAG}"$'\n'
  fi
done <<< "$FILES"
if [ -z "$CHURN_CONTEXT" ]; then
  CHURN_CONTEXT="No hot-spot files detected (all changed files under 15 commits and under 3 findings in the last 90 days)."
fi
echo "$CHURN_CONTEXT"
```

Tiers (fixed thresholds, identical to `architect.md` Phase A5): **HOT** = 15+ commits / 90 days, **MEDIUM** = 5–14, **LOW** = 0–4. **HOT-FINDINGS** = 3+ confirmed findings in 90 days (from Forge Ledger danger-zones index). Only files where at least one signal fires are listed in `CHURN_CONTEXT` — this keeps the agent prompt signal short and high-value. A file can appear with both tags (e.g., `commands/orchestrate.md — HOT (20 commits/90d) — HOT-FINDINGS (18 findings/90d)`). This does not change agent selection (3B) — it is a scrutiny prior surfaced to whichever agents are already selected, substituted as `[CHURN_CONTEXT]` in Phase 3C. When the danger-zones index is absent (cold start or pre-1738 install), `CHURN_CONTEXT` falls back to commit-count-only behavior (no HOT-FINDINGS tags). <!-- Added: forge#1738 -->

### 3B: Select Agents — Risk-Scaled Dispatch

**Default: 2-3 agents.** General Security always runs. Select the top 1-2 domain agents by relevance score, then apply escalation triggers to add more only when signals warrant it. Use `--thorough` to restore full union dispatch for release-critical PRs.

#### Step 1: Score Each Domain by Signal Strength

Assign a relevance score to each domain based on signals detected in Phase 3A. Higher score = higher priority for inclusion.

```bash
# Relevance scoring — accumulate points per domain from Phase 3A signals
SCORE_AUTH=0
SCORE_BILLING=0
SCORE_CONCURRENCY=0
SCORE_DATABASE=0
SCORE_INFRA=0
SCORE_SECURITY=0
SCORE_SCRAPING=0
SCORE_FRONTEND=0
SCORE_API=0

# AUTH domain signals
echo "$DIFF" | grep -qE "jwt|oauth|login|logout|password|NEXTAUTH_SECRET|JWT_SECRET|auth_token|access_token|refresh_token" && SCORE_AUTH=$((SCORE_AUTH + 3))
echo "$DIFF" | grep -qE "get_current_user|Depends\(get_|x.forwarded.for|forwarded_for|rate.limit.*ip|ip.*rate.limit" && SCORE_AUTH=$((SCORE_AUTH + 2))
echo "$DIFF" | grep -qE "algorithm.*HS256|algorithm.*RS256|admin.proxy" && SCORE_AUTH=$((SCORE_AUTH + 2))

# BILLING domain signals
echo "$DIFF" | grep -qE "credit|balance|debit|charge|refund|stripe|subscription" && SCORE_BILLING=$((SCORE_BILLING + 3))
echo "$DIFF" | grep -qE "pricing|tier_cost|reconcil" && SCORE_BILLING=$((SCORE_BILLING + 2))

# CONCURRENCY domain signals
echo "$DIFF" | grep -qE "FOR UPDATE|atomic|transaction|pipeline|MULTI|distributed_lock|acquire_lock" && SCORE_CONCURRENCY=$((SCORE_CONCURRENCY + 3))
echo "$DIFF" | grep -qE "reserved_by|promo.*claim|voucher.*redeem" && SCORE_CONCURRENCY=$((SCORE_CONCURRENCY + 2))

# DATABASE domain signals
echo "$FILES" | grep -qE "migration|\.sql$" && SCORE_DATABASE=$((SCORE_DATABASE + 3))
echo "$DIFF" | grep -qE "DROP|ALTER|DELETE FROM" && SCORE_DATABASE=$((SCORE_DATABASE + 2))
echo "$DIFF" | grep -qE "create_async_engine|AsyncSession|pool_size|prepared_statement|sessionmaker" && SCORE_DATABASE=$((SCORE_DATABASE + 2))

# INFRASTRUCTURE domain signals
echo "$DIFF" | grep -qE "docker-compose.*postgres|docker-compose.*redis|postgres.*command:|redis.*command:" && SCORE_INFRA=$((SCORE_INFRA + 3))
echo "$DIFF" | grep -qE "docker|deploy|traefik|nginx" && SCORE_INFRA=$((SCORE_INFRA + 1))
echo "$FILES" | grep -qE "^\.github/workflows/" && SCORE_INFRA=$((SCORE_INFRA + 2))
echo "$FILES" | grep -qE "Dockerfile|docker-compose" && SCORE_INFRA=$((SCORE_INFRA + 2))

# SECURITY domain signals (always baseline)
SCORE_SECURITY=1
echo "$DIFF" | grep -qE "subprocess|exec|eval|system\(|popen" && SCORE_SECURITY=$((SCORE_SECURITY + 3))
echo "$DIFF" | grep -qE "os\.system|eval\(|exec\(|pickle|yaml\.load[^_]" && SCORE_SECURITY=$((SCORE_SECURITY + 3))
echo "$DIFF" | grep -qE "\.sh$|bash|shell|cron" && SCORE_SECURITY=$((SCORE_SECURITY + 2))

# SCRAPING domain signals — only match browser-automation/scraping context, NOT bare "playwright"
echo "$DIFF" | grep -qE "scrape|tier.*escalat|anti_bot|stealth|playwright.*scrape|scrape.*playwright|playbook_min_tier|browser.*pool|web.*scrape" && SCORE_SCRAPING=$((SCORE_SCRAPING + 3))

# FRONTEND domain signals
echo "$FILES" | grep -qE "^web/src/" && SCORE_FRONTEND=$((SCORE_FRONTEND + 1))
echo "$FILES" | grep -qcE "^web/src/app/|^web/src/components/" | grep -qv "^0$" && SCORE_FRONTEND=$((SCORE_FRONTEND + 2))

# API domain signals
echo "$FILES" | grep -qE "router|routes" && SCORE_API=$((SCORE_API + 2))
echo "$FILES" | grep -qE "^sdk/|openapi.*\.json$|openapi-versions/" && SCORE_API=$((SCORE_API + 3))

echo "=== DOMAIN SCORES ==="
echo "AUTH=$SCORE_AUTH BILLING=$SCORE_BILLING CONCURRENCY=$SCORE_CONCURRENCY DATABASE=$SCORE_DATABASE INFRA=$SCORE_INFRA SECURITY=$SCORE_SECURITY SCRAPING=$SCORE_SCRAPING FRONTEND=$SCORE_FRONTEND API=$SCORE_API"
```

#### Step 2: Read Architect CONTRACT for Risk Flags (if PR is from /work-on)

```bash
CONTRACT_RISK_FLAGS=""
ISSUE_NUM=$(gh pr view $ARGUMENTS --json body --jq '.body | gsub("(?s).*?(?:Closes #|#)(?<n>[0-9]+).*"; "\(.n)") // empty' 2>/dev/null | head -1)
if [ -n "$ISSUE_NUM" ]; then
    CONTRACT_BODY=$(gh api repos/${REPO}/issues/${ISSUE_NUM}/comments \
        --jq '[.[] | select(.body | contains("FORGE:CONTRACT"))] | .[0].body' 2>/dev/null || echo "")
    # Extract risk level from CONTRACT — look for "HIGH" or "CRITICAL" risk markers
    if echo "$CONTRACT_BODY" | grep -qiE "\*\*Risk\*\*.*HIGH|\*\*Risk\*\*.*CRITICAL|Risk.*:\s*(HIGH|CRITICAL)"; then
        CONTRACT_RISK_FLAGS="HIGH_RISK"
    fi
    # Extract cross-domain touches flagged in CONTRACT
    echo "$CONTRACT_BODY" | grep -qiE "auth|session|jwt" && CONTRACT_RISK_FLAGS="${CONTRACT_RISK_FLAGS} CONTRACT_AUTH"
    echo "$CONTRACT_BODY" | grep -qiE "billing|credit|payment" && CONTRACT_RISK_FLAGS="${CONTRACT_RISK_FLAGS} CONTRACT_BILLING"
    echo "$CONTRACT_BODY" | grep -qiE "migration|schema|database" && CONTRACT_RISK_FLAGS="${CONTRACT_RISK_FLAGS} CONTRACT_DATABASE"
fi
echo "=== CONTRACT FLAGS: ${CONTRACT_RISK_FLAGS:-none} ==="
```

#### Step 3: Compute CHURN_ESCALATION

Check whether churn hot-spots exist (computed in Phase 3A `$CHURN_CONTEXT`):

```bash
CHURN_ESCALATION=false
echo "$CHURN_CONTEXT" | grep -q "HOT" && CHURN_ESCALATION=true
echo "=== CHURN_ESCALATION: $CHURN_ESCALATION ==="
```

#### Step 4: Build Selected Agent Roster

**If `THOROUGH=true`** (user passed `--thorough`, or `IS_MILESTONE_TO_STAGING=true`): run full union dispatch — all agents matching any signal. Skip to "Full union dispatch" below.

**Default (THOROUGH=false):**

Start with the baseline roster: `SELECTED_AGENTS="Security"` (General Security always runs).

Pick the top 1-2 domain agents by score:

```bash
# Build sorted list: "score:domain"
DOMAIN_SCORES="$SCORE_AUTH:AUTH $SCORE_BILLING:BILLING $SCORE_CONCURRENCY:CONCURRENCY $SCORE_DATABASE:DATABASE $SCORE_INFRA:INFRA $SCORE_SCRAPING:SCRAPING $SCORE_FRONTEND:FRONTEND $SCORE_API:API"

# Sort descending by score, pick top 2 with score > 0
TOP_DOMAINS=$(echo "$DOMAIN_SCORES" | tr ' ' '\n' | sort -t: -k1 -rn | head -2 | awk -F: '$1 > 0 {print $2}' | tr '\n' ' ')
for DOMAIN in $TOP_DOMAINS; do
    SELECTED_AGENTS="$SELECTED_AGENTS $DOMAIN"
done
echo "=== BASELINE ROSTER (top domains): $SELECTED_AGENTS ==="
```

**Apply escalation triggers** — each adds agents if not already included:

| Trigger | Condition | Added Agents |
|---------|-----------|--------------|
| Critical auth path | `SCORE_AUTH >= 3` | Auth (if not already selected) |
| Critical billing path | `SCORE_BILLING >= 3` | Billing + Concurrency |
| Migration/schema change | `SCORE_DATABASE >= 3` | Database |
| Stateful container change | `SCORE_INFRA >= 3` AND `DATABASE_CONTAINER` signal | Infrastructure |
| Code execution risk | `SCORE_SECURITY >= 4` (deep scan signals) | Security runs in deep mode (already selected) |
| Churn hot-spot | `CHURN_ESCALATION=true` AND top-scoring domain | Top domain gets added if not already in roster |
| CONTRACT high-risk | `CONTRACT_RISK_FLAGS` contains `HIGH_RISK` | All CONTRACT-flagged domain agents |
| First-pass finding severity | Phase 3 re-entry after a CONFIRMED/HIGH finding posted to PR | Add all agents for the domain of the finding |
| Scraping domain | `SCORE_SCRAPING >= 3` AND `review.domains.scraping` is set in forge.yaml | Scraping (optional domain pack — never in default catalog) |
| Cross-critical domains | `SCORE_AUTH >= 2` AND `SCORE_BILLING >= 2` | Auth + Billing + Concurrency |
| Cross-critical domains | `SCORE_AUTH >= 2` AND `SCORE_DATABASE >= 3` | Auth + Database |
| Cross-critical domains | `SCORE_BILLING >= 2` AND `SCORE_CONCURRENCY >= 2` | Billing + Concurrency + Database |

```bash
# Apply escalation triggers
add_agent() {
    local AGENT="$1"
    echo "$SELECTED_AGENTS" | grep -qw "$AGENT" || SELECTED_AGENTS="$SELECTED_AGENTS $AGENT"
}

[ "$SCORE_AUTH" -ge 3 ] && add_agent "Auth"
[ "$SCORE_BILLING" -ge 3 ] && { add_agent "Billing"; add_agent "Concurrency"; }
[ "$SCORE_DATABASE" -ge 3 ] && add_agent "Database"
[ "$SCORE_INFRA" -ge 3 ] && echo "$DIFF" | grep -qE "docker-compose.*postgres|docker-compose.*redis|postgres.*command:|redis.*command:" && add_agent "Infrastructure"
# Scraping agent is opt-in: only spawns when review.domains.scraping is configured in forge.yaml
[ "$SCORE_SCRAPING" -ge 3 ] && [ -n "$DOMAIN_CONTEXT_SCRAPING" ] && add_agent "Scraping"
[ "$CHURN_ESCALATION" = "true" ] && {
    # Add the top-scoring domain for deeper churn scrutiny if not already selected
    TOP_CHURN_DOMAIN=$(echo "$DOMAIN_SCORES" | tr ' ' '\n' | sort -t: -k1 -rn | head -1 | awk -F: '{print $2}')
    [ -n "$TOP_CHURN_DOMAIN" ] && add_agent "$TOP_CHURN_DOMAIN"
}
echo "$CONTRACT_RISK_FLAGS" | grep -q "HIGH_RISK" && {
    echo "$CONTRACT_RISK_FLAGS" | grep -q "CONTRACT_AUTH" && add_agent "Auth"
    echo "$CONTRACT_RISK_FLAGS" | grep -q "CONTRACT_BILLING" && { add_agent "Billing"; add_agent "Concurrency"; }
    echo "$CONTRACT_RISK_FLAGS" | grep -q "CONTRACT_DATABASE" && add_agent "Database"
}
# Cross-critical domain escalation
{ [ "$SCORE_AUTH" -ge 2 ] && [ "$SCORE_BILLING" -ge 2 ]; } && { add_agent "Auth"; add_agent "Billing"; add_agent "Concurrency"; }
{ [ "$SCORE_AUTH" -ge 2 ] && [ "$SCORE_DATABASE" -ge 3 ]; } && { add_agent "Auth"; add_agent "Database"; }
{ [ "$SCORE_BILLING" -ge 2 ] && [ "$SCORE_CONCURRENCY" -ge 2 ]; } && { add_agent "Billing"; add_agent "Concurrency"; add_agent "Database"; }
# SDK/OpenAPI always adds API agent
echo "$FILES" | grep -qE "^sdk/|openapi.*\.json$|openapi-versions/" && add_agent "API"

echo "=== FINAL ROSTER (after escalation): $SELECTED_AGENTS ==="
AGENT_COUNT=$(echo "$SELECTED_AGENTS" | wc -w)
echo "=== AGENT COUNT: $AGENT_COUNT ==="
```

### 3B.5: Provenance-Based Trust Escalation (Conditional)

**Skip if**: `THOROUGH=true` OR `IS_MILESTONE_TO_STAGING=true` — these modes already run full union dispatch; provenance de-escalation must not narrow an already-thorough review. This skip is enforced in code at the Step 4 application block (not merely relied upon via a downstream overwrite). <!-- forge#1804 -->


**Purpose**: Adjust the agent roster based on the PR's verifiable track record. Proven `(task-type × module-set)` combinations may drop optional judgment agents; novel combinations escalate to full panel plus `needs-human` on merge. The hard floor (Security agent + all Phase 2 automated checks) runs at every intensity tier, unconditionally.

**HARD FLOOR (non-negotiable)**: Security agent always stays in `SELECTED_AGENTS`. Phase 2 automated checks (linting, typecheck, secrets scan, SQL validation) run regardless of intensity tier. Trust only modulates optional LLM judgment breadth.

#### Step 1: Declare defaults (fail-safe initialization)

```bash
# Default: SHADOW — no roster change, log the decision only.
# This ensures that any error path (absent table, parse failure, git error)
# falls back to the current static behavior — never looser, never tighter.
INTENSITY_TIER="SHADOW"
TABLE_CELL_KEY="(unavailable)"
PROVENANCE_TABLE_LOADED=false
TRUST_SHADOW_MODE=$(yq '.review.trust_shadow_mode // "true"' "${FORGE_YAML:-forge.yaml}" 2>/dev/null || echo "true")
```

#### Step 2: Read provenance table from forge-knowledge branch

```bash
# Single bounded git-show read — no network round-trip if the branch is local.
# Fail-safe: any non-zero exit or parse error → PROVENANCE_JSON stays empty.
PROVENANCE_JSON=""
if git show-ref --quiet "refs/remotes/origin/forge-knowledge" 2>/dev/null || \
   git show-ref --quiet "refs/heads/forge-knowledge" 2>/dev/null; then
  PROVENANCE_JSON=$(git show "forge-knowledge:calibration/provenance.json" 2>/dev/null || \
                    git show "origin/forge-knowledge:calibration/provenance.json" 2>/dev/null || echo "")
fi

if [ -n "$PROVENANCE_JSON" ] && echo "$PROVENANCE_JSON" | jq -e '.rows' >/dev/null 2>&1; then
  PROVENANCE_TABLE_LOADED=true
  echo "=== PROVENANCE TABLE: loaded ($(echo "$PROVENANCE_JSON" | jq '.rows | length') cells) ==="
else
  echo "=== PROVENANCE TABLE: absent or invalid — intensity tier defaults to SHADOW (no roster change) ==="
fi
```

#### Step 3: Compute module key and look up cell

```bash
if [ "$PROVENANCE_TABLE_LOADED" = "true" ]; then
  # Normalize changed files to module key (mirrors normalizeModules() in calibration.mjs):
  # Take the top-level directory of each file; for two-level prefixes (services/*, apps/*,
  # packages/*, clients/*, sdk/*) include the second directory segment too.
  # Sort + deduplicate + join with "|".
  TWO_LEVEL="services apps packages clients sdk"
  RAW_PREFIXES=$(echo "$FILES" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    top=$(echo "$f" | cut -d/ -f1)
    second=$(echo "$f" | cut -d/ -f2)
    two_level_match=false
    for prefix in $TWO_LEVEL; do
      [ "$top" = "$prefix" ] && two_level_match=true && break
    done
    if [ "$two_level_match" = "true" ] && [ -n "$second" ]; then
      echo "${top}/${second}"
    else
      echo "$top"
    fi
  done | sort -u | tr '\n' '|' | sed 's/|$//')

  # Determine task type from FORGE:INVESTIGATOR annotation on the linked issue (if available)
  ISSUE_NUM_FOR_TRUST=$(gh pr view "$ARGUMENTS" --json body \
    --jq '.body | gsub("(?s).*?(?:Closes #|#)(?<n>[0-9]+).*"; "\(.n)") // ""' 2>/dev/null | head -1)
  TASK_TYPE_FOR_TRUST=""
  if [ -n "$ISSUE_NUM_FOR_TRUST" ]; then
    TASK_TYPE_FOR_TRUST=$(gh api "repos/${REPO}/issues/${ISSUE_NUM_FOR_TRUST}/comments" \
      --jq '[.[] | select(.body | contains("FORGE:INVESTIGATOR"))] | last | .body' 2>/dev/null \
      | grep -oP '(?<=\*\*Task Type\*\*: )[\w /]+' | head -1 | xargs || echo "")
  fi
  # Fall back to title-based inference if INVESTIGATOR comment absent
  if [ -z "$TASK_TYPE_FOR_TRUST" ]; then
    PR_TITLE=$(gh pr view "$ARGUMENTS" --json title --jq '.title' 2>/dev/null || echo "")
    case "$PR_TITLE" in
      fix*|Fix*)   TASK_TYPE_FOR_TRUST="Bug Fix" ;;
      feat*|Feat*) TASK_TYPE_FOR_TRUST="Feature" ;;
      refactor*)   TASK_TYPE_FOR_TRUST="Refactor" ;;
      docs*|chore*)TASK_TYPE_FOR_TRUST="Maintenance" ;;
      *)           TASK_TYPE_FOR_TRUST="Feature" ;;
    esac
  fi

  TABLE_CELL_KEY="${TASK_TYPE_FOR_TRUST}::${RAW_PREFIXES}"
  echo "=== PROVENANCE CELL KEY: ${TABLE_CELL_KEY} ==="

  # Look up the cell in the provenance table
  CELL_DATA=$(echo "$PROVENANCE_JSON" | jq -r \
    --arg key "$TABLE_CELL_KEY" \
    '.rows[] | select(.key == $key)' 2>/dev/null || echo "")

  if [ -z "$CELL_DATA" ]; then
    INTENSITY_TIER="NOVEL"
    echo "=== PROVENANCE: cell not found — NOVEL (no prior data for this task-type × module-set) ==="
  else
    CELL_TRUSTED=$(echo "$CELL_DATA" | jq -r '.trusted' 2>/dev/null || echo "false")
    CELL_TIER=$(echo "$CELL_DATA" | jq -r '.intensityTier' 2>/dev/null || echo "NOVEL")
    CELL_SURVIVAL=$(echo "$CELL_DATA" | jq -r '.survivalRate // "null"' 2>/dev/null || echo "null")
    CELL_SAMPLES=$(echo "$CELL_DATA" | jq -r '.sampleCount' 2>/dev/null || echo "0")

    if [ "$CELL_TRUSTED" = "true" ]; then
      INTENSITY_TIER="$CELL_TIER"
      echo "=== PROVENANCE: cell found (${CELL_SAMPLES} samples, survival ${CELL_SURVIVAL}) — tier: ${INTENSITY_TIER} ==="
    else
      INTENSITY_TIER="NOVEL"
      echo "=== PROVENANCE: cell found but not yet trusted (${CELL_SAMPLES} samples < min_samples) — tier: NOVEL ==="
    fi
  fi
fi
```

#### Step 4: Apply intensity tier (shadow-mode gated)

```bash
echo "=== TRUST_SHADOW_MODE: ${TRUST_SHADOW_MODE} ==="
echo "=== INTENSITY_TIER (pre-application): ${INTENSITY_TIER} ==="

# Explicit skip guard (enforces the "Skip if" prose above in code): in THOROUGH or
# milestone mode the full union dispatch is authoritative — provenance MUST NOT narrow
# the roster here. Enforcing it at the application point means correctness no longer
# depends on a downstream overwrite re-widening SELECTED_AGENTS. <!-- forge#1804 -->
if [ "$THOROUGH" = "true" ] || [ "$IS_MILESTONE_TO_STAGING" = "true" ]; then
  echo "=== TRUST ESCALATION: skipped (THOROUGH/milestone mode — full union dispatch is authoritative) ==="
# Shadow mode: log the decision but do NOT modify SELECTED_AGENTS.
# Set review.trust_shadow_mode: "false" in forge.yaml to enforce after the 30-day window.
elif [ "$TRUST_SHADOW_MODE" != "false" ]; then
  echo "=== TRUST ESCALATION: shadow-mode active — logging decision, roster unchanged ==="
  # SELECTED_AGENTS is NOT modified — current behavior preserved
else
  case "$INTENSITY_TIER" in
    PROVEN)
      # PROVEN tier: may drop optional judgment agents, but NEVER the hard floor.
      # The Security agent and any agents added by hard-signal escalation triggers
      # (SCORE_AUTH >= 3, SCORE_BILLING >= 3, SCORE_DATABASE >= 3, SCORE_INFRA >= 3)
      # are part of the floor — provenance trust MUST NOT remove them.
      #
      # Only agents added by the top-1/2-domain scoring (Step 1 baseline selection)
      # that are NOT flagged by a hard escalation trigger are eligible for removal.
      # For safety in the initial enforcement window, we only remove agents that
      # scored exactly 1 (informational — file-presence only) and were not triggered
      # by any cross-critical or churn escalation.
      FLOOR_AGENTS="Security"
      [ "$SCORE_AUTH"     -ge 3 ] && FLOOR_AGENTS="$FLOOR_AGENTS Auth"
      [ "$SCORE_BILLING"  -ge 3 ] && FLOOR_AGENTS="$FLOOR_AGENTS Billing Concurrency"
      [ "$SCORE_DATABASE" -ge 3 ] && FLOOR_AGENTS="$FLOOR_AGENTS Database"
      [ "$SCORE_INFRA"    -ge 3 ] && FLOOR_AGENTS="$FLOOR_AGENTS Infrastructure"
      [ "$CHURN_ESCALATION" = "true" ] && FLOOR_AGENTS="$FLOOR_AGENTS $TOP_CHURN_DOMAIN"
      # Deduplicate floor
      FLOOR_AGENTS=$(echo "$FLOOR_AGENTS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
      # PROVEN: keep only floor agents (drop optional judgment-only agents)
      SELECTED_AGENTS="$FLOOR_AGENTS"
      echo "=== TRUST ESCALATION: PROVEN — roster narrowed to floor: ${SELECTED_AGENTS} ==="
      ;;
    NOVEL|NOVEL_NEEDS_HUMAN)
      # NOVEL tier: escalate to full affected-domain panel (add all scored domains)
      for DOMAIN in AUTH BILLING CONCURRENCY DATABASE INFRA FRONTEND API; do
        SCORE_VAR="SCORE_${DOMAIN}"
        [ "${!SCORE_VAR:-0}" -gt 0 ] && add_agent "$DOMAIN"
      done
      SELECTED_AGENTS=$(echo "$SELECTED_AGENTS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
      echo "=== TRUST ESCALATION: ${INTENSITY_TIER} — roster widened to full panel: ${SELECTED_AGENTS} ==="
      if [ "$INTENSITY_TIER" = "NOVEL_NEEDS_HUMAN" ]; then
        echo "=== TRUST ESCALATION: NOVEL_NEEDS_HUMAN — needs-human will be added on merge ==="
        TRUST_NEEDS_HUMAN=true
      fi
      ;;
    SHADOW|*)
      # SHADOW or unknown: no change
      echo "=== TRUST ESCALATION: ${INTENSITY_TIER} — roster unchanged ==="
      ;;
  esac
fi

# Record TRUST_NEEDS_HUMAN default (set to false if not already set by NOVEL_NEEDS_HUMAN branch)
TRUST_NEEDS_HUMAN="${TRUST_NEEDS_HUMAN:-false}"

echo "=== FINAL ROSTER (after trust escalation): $SELECTED_AGENTS ==="
echo "=== INTENSITY_TIER: ${INTENSITY_TIER} | TABLE_CELL_KEY: ${TABLE_CELL_KEY} | SHADOW: ${TRUST_SHADOW_MODE} | NEEDS_HUMAN: ${TRUST_NEEDS_HUMAN} ==="
```

<!-- Added: forge#1745 -->

**Full union dispatch (THOROUGH=true or IS_MILESTONE_TO_STAGING=true):**

```bash
if [ "$THOROUGH" = "true" ] || [ "$IS_MILESTONE_TO_STAGING" = "true" ]; then
    SELECTED_AGENTS="Security"
    [ "$SCORE_AUTH" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Auth"
    [ "$SCORE_BILLING" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Billing Concurrency"
    [ "$SCORE_DATABASE" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Database"
    [ "$SCORE_INFRA" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Infrastructure"
    # Scraping agent only added in thorough mode when review.domains.scraping is configured
    SCRAPING_ENABLED=$(yq '.review.domains.scraping' "$FORGE_YAML" 2>/dev/null || echo "")
    [ "$SCORE_SCRAPING" -gt 0 ] && [ -n "$SCRAPING_ENABLED" ] && SELECTED_AGENTS="$SELECTED_AGENTS Scraping"
    [ "$SCORE_FRONTEND" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Frontend"
    [ "$SCORE_API" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS API"
    # Deduplicate
    SELECTED_AGENTS=$(echo "$SELECTED_AGENTS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
    echo "=== THOROUGH mode: FULL UNION DISPATCH — $SELECTED_AGENTS ==="
fi
```

**Why cross-critical domain pairs always escalate**: A 2-file PR touching both `services/api/app/core/auth.py` and `services/api/app/routers/billing.py` creates interaction bugs that single-domain reviewers cannot catch. Never rely on a single agent for multi-domain risk.

**General Security agent ALWAYS runs.** If BILLING is selected, Concurrency is always added. If SHARED module is touched, add agents for all importing services.

#### Domain-to-File Mapping (for diff slicing in Phase 3C)

Each agent receives only its domain-relevant diff slice rather than the full changeset. Compute per-domain file filters:

```bash
# Domain file patterns — used in Phase 3C to scope each agent's input
DOMAIN_FILES_AUTH=$(echo "$FILES" | grep -iE "auth|session|login|logout|jwt|oauth|token|user|permission|middleware" || echo "")
DOMAIN_FILES_BILLING=$(echo "$FILES" | grep -iE "billing|credit|payment|charge|refund|subscription|pricing|tier" || echo "")
DOMAIN_FILES_CONCURRENCY=$(echo "$FILES" | grep -iE "lock|queue|atomic|transaction|worker|job|task|celery|redis" || echo "")
DOMAIN_FILES_DATABASE=$(echo "$FILES" | grep -iE "migration|\.sql$|model|schema|db|database|alembic" || echo "")
DOMAIN_FILES_INFRA=$(echo "$FILES" | grep -iE "docker|nginx|traefik|\.github|Makefile|deploy|infra" || echo "")
DOMAIN_FILES_SCRAPING=$(echo "$FILES" | grep -iE "scrape|crawler|stealth|browser.*pool|headless|anti.bot|detection.*keyword|captcha" || echo "")
DOMAIN_FILES_FRONTEND=$(echo "$FILES" | grep -iE "^web/|\.tsx?$|\.jsx?$|component|page|layout|style|css" || echo "")
DOMAIN_FILES_API=$(echo "$FILES" | grep -iE "router|route|endpoint|openapi|sdk|api" || echo "")

# Fallback: if a domain has no specific files matched, give it the full file list
# (happens for Security — which reviews everything — and for edge cases)
[ -z "$DOMAIN_FILES_AUTH" ] && DOMAIN_FILES_AUTH="$FILES"
[ -z "$DOMAIN_FILES_BILLING" ] && DOMAIN_FILES_BILLING="$FILES"
[ -z "$DOMAIN_FILES_DATABASE" ] && DOMAIN_FILES_DATABASE="$FILES"
```

### 3C: Load Agent Templates & Launch

**>>> MANDATORY TEMPLATE-RESOLUTION GUARD — run BEFORE any Read of persona templates:**

Missing persona templates are a fatal setup error, not permission to skip multi-agent review. Resolve the template source through this ordered chain and STOP if none resolve — never fall through to reviewing inline in the main context:

```bash
# Tier 1: $FORGE_HOME (the installed location — the common case)
TEMPLATE_BASE=""
if [[ -f "$FORGE_HOME/commands/review-pr-agents/protocols.md" ]]; then
  TEMPLATE_BASE="$FORGE_HOME/commands/review-pr-agents"
  TEMPLATE_SOURCE="forge_home"
else
  # Tier 2: repo-path fallback — same resolution already used for the code index below.
  # FORGE_YAML is resolved independently here (not yet loaded — that happens further
  # down in this phase) so the guard does not depend on later-phase ordering.
  FORGE_YAML="${FORGE_CONFIG:-$(git rev-parse --show-toplevel 2>/dev/null)/forge.yaml}"
  REPO_PATH=$(yq '.paths.root' "$FORGE_YAML" 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null || pwd)
  if [[ -f "$REPO_PATH/commands/review-pr-agents/protocols.md" ]]; then
    TEMPLATE_BASE="$REPO_PATH/commands/review-pr-agents"
    TEMPLATE_SOURCE="repo_path"
  elif [[ -f "$REPO_PATH/commands/review-pr-agents.md" ]] && grep -q "^### Agent:" "$REPO_PATH/commands/review-pr-agents.md" 2>/dev/null; then
    # Tier 3: monolithic catalog — last resort, contains all personas + protocols in one file.
    # The content check (`### Agent:` headers) is required, not just file existence: a
    # post-split repo still ships a small router stub at this same path that only points
    # BACK to the (missing) commands/review-pr-agents/ directory — reading it would not
    # provide any actual protocol/persona content, silently reproducing the original bug
    # one tier deeper. <!-- Added: forge#1849 -->
    TEMPLATE_BASE=""
    MONOLITHIC_CATALOG="$REPO_PATH/commands/review-pr-agents.md"
    TEMPLATE_SOURCE="monolithic_catalog"
  else
    TEMPLATE_SOURCE="none"
  fi
fi

if [[ "$TEMPLATE_SOURCE" == "none" ]]; then
  echo "FATAL: no review-pr-agents template source resolved (checked \$FORGE_HOME, repo-path fallback, monolithic catalog)."
  # HARD STOP — post error, add needs-human, do NOT review
fi
```

**If `TEMPLATE_SOURCE` is `none`**: HARD STOP. Post a PR comment explaining the setup is broken (`gh pr comment $ARGUMENTS --body "..."`) instructing the user to run `npx forgedock update` to repair the install, add `needs-human`, and exit Phase 3 without posting any findings or a `FORGE:REVIEW` verdict. **NEVER perform the review inline in the main agent context as a substitute.** A degraded solo review that presents itself as complete is worse than no review — missing templates must fail loudly, not silently.

**If `TEMPLATE_SOURCE` is `forge_home` or `repo_path`** (the normal cases — behavior unchanged from before this guard existed):
```
Read: $TEMPLATE_BASE/protocols.md
Read: $TEMPLATE_BASE/<persona>.md   (one per selected agent from Phase 3B)
```

**If `TEMPLATE_SOURCE` is `monolithic_catalog`** (last-resort fallback):
```
Read: $MONOLITHIC_CATALOG
```
Then extract the shared protocols section and each selected persona's section from within that single file — same content, different packaging.

Persona file names: `security.md` (always), `auth.md`, `billing.md`, `concurrency.md`, `scraper.md`, `frontend.md`, `api.md`, `database.md`, `infra.md`.
See `review-pr-agents.md` for the full routing table mapping domains → persona files.

(`$FORGE_HOME` defaults to `~/.claude`)

**>>> LOAD CONFIG: Read forge.yaml for project context:**
```bash
# Read review config from forge.yaml (if present in project root)
FORGE_YAML="${FORGE_CONFIG:-$(git rev-parse --show-toplevel 2>/dev/null)/forge.yaml}"
PROJECT_NAME=$(yq '.project.name' "$FORGE_YAML" 2>/dev/null || echo "this project")
PROJECT_CONTEXT=$(yq '.review.context' "$FORGE_YAML" 2>/dev/null || echo "")
# Domain-specific context (keyed by agent name)
DOMAIN_CONTEXT_AUTH=$(yq '.review.domains.auth' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_BILLING=$(yq '.review.domains.billing' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_CONCURRENCY=$(yq '.review.domains.concurrency' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_INFRA=$(yq '.review.domains.infra' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_DATABASE=$(yq '.review.domains.database' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_FRONTEND=$(yq '.review.domains.frontend' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_SECURITY=$(yq '.review.domains.security' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_API=$(yq '.review.domains.api' "$FORGE_YAML" 2>/dev/null || echo "")
# Scraping domain context also gates spawning: agent only runs when this key is set
DOMAIN_CONTEXT_SCRAPING=$(yq '.review.domains.scraping' "$FORGE_YAML" 2>/dev/null || echo "")
```

If `forge.yaml` is absent or a field is empty/null, agents fall back to generic checks (no project-specific context injected — agents still function correctly, just without project conventions).

**Code Index Slice (inject per agent — replaces full-repo search space with domain-scoped facts):**

Before launching agents, query the code index to build a domain-scoped file list and symbol map for each agent's diff domain. This replaces full-repo search with deterministic pre-computed data:

```bash
REPO_PATH=$(yq '.paths.root' "$FORGE_YAML" 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null || pwd)
CODE_INDEX_SCRIPT="${REPO_PATH}/scripts/code-index.sh"

# Ensure index is current (cache-hit on unchanged HEAD — instant if already built)
if [[ -x "$CODE_INDEX_SCRIPT" ]]; then
  bash "$CODE_INDEX_SCRIPT" --repo-path "$REPO_PATH" 2>/dev/null || true
fi

# Build domain-scoped index slices for each selected agent's domain
# Replace {DOMAIN} with the agent's domain label (auth, billing, database, api, frontend, etc.)
build_index_slice() {
  local domain="$1"
  if [[ -x "$CODE_INDEX_SCRIPT" ]]; then
    local files
    files=$(bash "$CODE_INDEX_SCRIPT" query --domain "$domain" --repo-path "$REPO_PATH" 2>/dev/null | awk -F'\t' '{print $1}' | head -30 | tr '\n' ' ')
    echo "Domain files (${domain}): ${files:-none}"
  else
    echo "Code index not available — agent will use grep exploration"
  fi
}

# Compute slices for selected agents (only the domains that are actually running)
INDEX_SLICE_AUTH=$(build_index_slice "auth")
INDEX_SLICE_BILLING=$(build_index_slice "billing")
INDEX_SLICE_DATABASE=$(build_index_slice "database")
INDEX_SLICE_API=$(build_index_slice "api")
INDEX_SLICE_FRONTEND=$(build_index_slice "frontend")
INDEX_SLICE_INFRA=$(build_index_slice "infrastructure")
```

**Absence is not an error**: If `scripts/code-index.sh` is absent, `INDEX_SLICE_*` variables will contain the fallback message and agents proceed with their standard grep-based exploration.

**>>> COMPUTE: Per-domain diff slices (input-scoping — do this BEFORE launching agents):**

Each domain agent receives only the diff slice relevant to its domain, not the full PR changeset. This caps per-child input cost on large PRs. Compute slices once here; substitute `[DOMAIN_DIFF_SLICE]` per agent below.

```bash
# Full diff fetched once — agents do NOT re-fetch it
FULL_DIFF=$(gh pr diff $ARGUMENTS)
FULL_FILES=$(gh pr diff $ARGUMENTS --name-only)

# --- Security agent: always receives the full diff (cross-cutting domain) ---
DIFF_SLICE_SECURITY="$FULL_DIFF"

# --- Auth agent: auth, session, jwt, oauth, middleware, permission files ---
DIFF_SLICE_AUTH=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(auth|session|jwt|oauth|permission|middleware|login|token)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_AUTH" ] && DIFF_SLICE_AUTH="$FULL_DIFF"

# --- Billing agent: billing, payment, credit, pricing, stripe, subscription files ---
DIFF_SLICE_BILLING=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(billing|payment|credit|pricing|stripe|subscription|invoice|charge|refund)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_BILLING" ] && DIFF_SLICE_BILLING="$FULL_DIFF"

# --- Concurrency agent: transaction, lock, queue, async, worker, race-condition files ---
DIFF_SLICE_CONCURRENCY=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(worker|queue|task|async|lock|transaction|pipeline|job)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_CONCURRENCY" ] && DIFF_SLICE_CONCURRENCY="$FULL_DIFF"

# --- Database agent: migration, model, schema, ORM, SQL files ---
DIFF_SLICE_DATABASE=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(migration|model|schema|\.sql$|orm|database|db)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_DATABASE" ] && DIFF_SLICE_DATABASE="$FULL_DIFF"

# --- Frontend agent: web/src, components, pages, styles, tsx/jsx files ---
DIFF_SLICE_FRONTEND=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*(web\/src|components|pages|styles|\.tsx|\.jsx|\.css|\.scss)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_FRONTEND" ] && DIFF_SLICE_FRONTEND="$FULL_DIFF"

# --- API Design agent: router, endpoint, openapi, schema, serializer files ---
DIFF_SLICE_API=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(router|route|endpoint|openapi|serializer|schema|api)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_API" ] && DIFF_SLICE_API="$FULL_DIFF"

# --- Infrastructure agent: docker, nginx, ci, deploy, infra, workflow files ---
DIFF_SLICE_INFRA=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(docker|nginx|infra|\.github|deploy|ci|traefik|k8s|helm)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_INFRA" ] && DIFF_SLICE_INFRA="$FULL_DIFF"

# --- Domain Logic agent: scraping/browser-automation files (does not match bare playwright/E2E test files) ---
DIFF_SLICE_SCRAPER=$(echo "$FULL_DIFF" | awk '
  /^diff --git/ { in_block=0 }
  /^diff --git.*\/(scrape|scraper|stealth|browser_pool|headless|anti_bot|captcha|crawl)/ { in_block=1 }
  in_block { print }
')
[ -z "$DIFF_SLICE_SCRAPER" ] && DIFF_SLICE_SCRAPER="$FULL_DIFF"
```

**Tool-result truncation discipline**: All `gh pr diff` and file-read outputs piped to agents MUST be capped at ~100K characters. This mirrors the runner's built-in 100K-char tool-result cap (`bin/runner.mjs`). Any diff slice exceeding 100K chars must be truncated before substitution — agents that receive oversized context perform worse, not better.

```bash
# Truncate any slice exceeding 100K chars before passing to agent
truncate_slice() {
  local slice="$1"
  local limit=102400
  if [ "${#slice}" -gt "$limit" ]; then
    echo "${slice:0:$limit}"
    echo "... [TRUNCATED — diff exceeded 100K chars; focus on the files listed above]"
  else
    echo "$slice"
  fi
}
DIFF_SLICE_SECURITY=$(truncate_slice "$DIFF_SLICE_SECURITY")
DIFF_SLICE_AUTH=$(truncate_slice "$DIFF_SLICE_AUTH")
DIFF_SLICE_BILLING=$(truncate_slice "$DIFF_SLICE_BILLING")
DIFF_SLICE_CONCURRENCY=$(truncate_slice "$DIFF_SLICE_CONCURRENCY")
DIFF_SLICE_DATABASE=$(truncate_slice "$DIFF_SLICE_DATABASE")
DIFF_SLICE_FRONTEND=$(truncate_slice "$DIFF_SLICE_FRONTEND")
DIFF_SLICE_API=$(truncate_slice "$DIFF_SLICE_API")
DIFF_SLICE_INFRA=$(truncate_slice "$DIFF_SLICE_INFRA")
DIFF_SLICE_SCRAPER=$(truncate_slice "$DIFF_SLICE_SCRAPER")
```

The `protocols.md` file contains the Evidence-Based Review Protocol, Structured Findings Protocol, Per-Agent Input Scoping rules, and Tool-Result Truncation Discipline. Each persona file contains that agent's full prompt template. For each agent in `$SELECTED_AGENTS` (computed in Phase 3B):
1. Extract its template from the persona file (`review-pr-agents/<persona>.md`)
2. Substitute: `[PR_NUMBER]`, `[REVIEW_SHA]`, `[REVIEW_SHA_SHORT]`, `[TITLE]`, relevant files list
3. Substitute: `[PROJECT_NAME]` → `$PROJECT_NAME`, `[PROJECT_CONTEXT]` → `$PROJECT_CONTEXT`
4. Substitute per-agent domain context: `[DOMAIN_CONTEXT]` → the agent's matching key from `forge.yaml → review.domains` (e.g., `$DOMAIN_CONTEXT_AUTH` for the auth agent, `$DOMAIN_CONTEXT_BILLING` for the billing agent, `$DOMAIN_CONTEXT_CONCURRENCY` for the concurrency agent, `$DOMAIN_CONTEXT_SCRAPING` for the scraping agent)
5. Substitute the shared hot-spot prior: `[CHURN_CONTEXT]` → `$CHURN_CONTEXT` (computed once in Phase 3A, same value for every agent — this is a PR-level fact, not a per-domain config value, so it is NOT read from `forge.yaml`)
6. Substitute code index slice: `[INDEX_SLICE]` → the matching `$INDEX_SLICE_{DOMAIN}` variable for this agent (e.g., `$INDEX_SLICE_AUTH` for the auth agent). Agents MUST query index data first; fall back to grep only when index slice is empty or unavailable.
7. Substitute per-agent diff slice: `[DOMAIN_DIFF_SLICE]` → the matching `$DIFF_SLICE_*` variable (e.g., `$DIFF_SLICE_AUTH` for the auth agent, `$DIFF_SLICE_SECURITY` for the security agent). This replaces any `gh pr diff [PR_NUMBER]` call inside the agent template — the agent works from the pre-computed slice, not the full changeset.
8. If Phase 2.5 found broken assumptions, append them to the agent's prompt as "Pre-found integration issues to verify"
9. Launch via the resolved `{DISPATCH_TOOL}` (see Sub-Agent Dispatch Tool Resolution above) with `model: "{SUBAGENT_MODEL}"` (forge.yaml `agents.subagent_model`, else `agents.default_model`, else `"sonnet"`; fallback `"opus"` if rate-limited)

**CRITICAL**: Launch ALL selected agents in a SINGLE message using multiple `{DISPATCH_TOOL}` calls. Each agent posts findings directly to the PR via `gh pr comment`.

#### Domain Diff Slicing

Each agent's prompt receives `[FILE_LIST]` scoped to its domain-relevant files (computed in Phase 3B as `DOMAIN_FILES_*`). This reduces per-agent token cost — each agent reads only the diff slice relevant to its domain, not the full changeset.

- **Security agent**: receives the full file list and full diff (it must see everything)
- **Domain agents**: receive `DOMAIN_FILES_<DOMAIN>` as `[FILE_LIST]`; if a domain's file list is empty (fallback), pass the full list

When substituting `[FILE_LIST]` in each agent's template:
- Auth agent → `$DOMAIN_FILES_AUTH`
- Billing agent → `$DOMAIN_FILES_BILLING`
- Concurrency agent → `$DOMAIN_FILES_CONCURRENCY`
- Database agent → `$DOMAIN_FILES_DATABASE`
- Infrastructure agent → `$DOMAIN_FILES_INFRA`
- Scraping agent → `$DOMAIN_FILES_SCRAPING`
- Frontend agent → `$DOMAIN_FILES_FRONTEND`
- API agent → `$DOMAIN_FILES_API`
- Security agent → `$FILES` (full list)

**Note**: Domain agents still run `gh pr diff $PR_NUMBER` inside their execution context. The scoped `[FILE_LIST]` tells each agent which files are most relevant to its domain — it is a focused starting point, not a hard restriction. Agents should follow code paths beyond their slice if those paths are needed to complete a trace.

---

## Phase 4: Wait for Agents

```bash
gh pr view $ARGUMENTS --json comments --jq '.comments | length'
gh api repos/{owner}/{repo}/issues/$ARGUMENTS/comments --jq '.[-10:] | .[].body[:100]'
```

**Do NOT proceed until ALL launched agent comments are visible on the PR.**

---

## Phase 5: Synthesis (Multi-Agent Arbitration)

**Skip if**: Only 1 agent OR total findings ≤ 3.

```bash
# Extract structured finding IDs from FINDING HTML comments.
# Uses jq's scan() (POSIX-portable, no grep -oP required).
ALL_FINDINGS=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" \
    --jq '[.[].body | scan("<!-- FINDING:([^>]+) -->") | .[0]] | join("\n")')
AGENT_COUNT=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" --jq '[.[] | select(.body | test("REVIEW-FINDINGS-START"))] | length')
FINDING_COUNT=$(echo "$ALL_FINDINGS" | grep -c '.' || echo 0)
```

If synthesis needed, launch a `general-purpose` Task (model: `"{SUBAGENT_MODEL}"`, fallback `"opus"` if rate-limited):
- Deduplicate findings by file + line range ±5 (keep higher confidence)
- Resolve contradictions by reading disputed code
- Dismiss false positives with evidence
- Post synthesis comment with `<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->` block
- Do NOT add new findings — only triage existing ones

**IMPORTANT**: When synthesized block exists, Phase 6 MUST use it instead of raw findings.

---

## Phase 6: Finding Triage & Issue Creation (MANDATORY)

**STOP. DO NOT skip this phase. DO NOT post summary first.** Every finding MUST become a GitHub issue BEFORE the summary.

### 6A: Extract Findings

```bash
HAS_SYNTHESIS=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" --jq '.[].body' | grep -c 'REVIEW-FINDINGS-SYNTHESIZED-START' || echo 0)

if [ "$HAS_SYNTHESIS" -gt 0 ]; then
    # Extract finding IDs from synthesized block using jq scan() — no grep -oP needed
    FINDINGS=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" \
        --jq '[.[] | select(.body | test("REVIEW-FINDINGS-SYNTHESIZED-START")) | .body | scan("<!-- FINDING:([^>]+) -->") | .[0]] | join("\n")')
else
    # Extract finding IDs from all agent comments using jq scan() — portable, no grep -oP
    FINDINGS=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" \
        --jq '[.[].body | scan("<!-- FINDING:([^>]+) -->") | .[0]] | join("\n")')
fi
```

Also include any `INTEG-N` findings from Phase 2.5 that weren't already covered by agents.

If 0 structured findings: scan agent comments for unstructured findings (lines starting with "Finding", "Issue", "Bug", "Warning"; sections titled "Findings", "Issues Found"). Extract manually.

If still 0: review is clean — skip to Phase 7.

### 6B: Deduplicate
- Keep ALL confidence levels (CONFIRMED, LIKELY, POSSIBLE)
- Dedup by file + line range ±5 — keep higher confidence (covers off-by-one from upstream insertions)
- Also dedup by title similarity: if two findings share the same file and 3+ title keywords, keep the higher confidence one
- Sort: CONFIRMED first, then LIKELY, then POSSIBLE; within group by severity

### 6C: Create Issues

```bash
# Colors match the canonical ForgeDock label manifest (bin/labels.json).
# Run `npx forgedock labels setup` to bootstrap all managed labels at once.
gh label create "review-finding" --color "D93F0B" --description "Defect or improvement found during automated PR review. Managed by ForgeDock." --force -R {GH_REPO} 2>/dev/null
gh label create "needs-validation" --color "FBCA04" --description "Review finding awaiting human validation. Managed by ForgeDock." --force -R {GH_REPO} 2>/dev/null
gh label create "validated" --color "0E8A16" --description "Review finding confirmed as a real issue. Managed by ForgeDock." --force -R {GH_REPO} 2>/dev/null
gh label create "false-positive" --color "CCCCCC" --description "Review finding dismissed as a false positive. Managed by ForgeDock." --force -R {GH_REPO} 2>/dev/null
```

**Milestone detection:**
```bash
# BASE_BRANCH is what the finding template stamps as **Code branch** below
# (see the rationale comment at that template block) — HEAD_BRANCH is no
# longer needed here; derive-finding-milestone.sh resolves its own
# base/head branch lookup internally for its Tier 3 slug match.
BASE_BRANCH=$(gh pr view ${PR_NUMBER} --json baseRefName --jq '.baseRefName')
MILESTONE_FLAG=""

# scripts/derive-finding-milestone.sh is the single source of truth for
# milestone derivation — commands/review-pr.md and commands/review-pr-staging.md
# both call it identically so the two specs cannot independently drift the
# way they did before this fix (forge#2443 Instance B/C: findings from a
# milestone-lane PR sometimes inherited the milestone and sometimes didn't,
# depending on incidental inheritance rather than an explicit step). The
# script's 3-tier resolution (PR's own milestone -> originating issue's
# milestone via Closes/Fixes/Resolves #N -> branch-slug match against
# milestone/* branches) supersedes the old base/head-branch-only slug match
# that used to be hand-rolled here.
MILESTONE_TITLE=$(bash scripts/derive-finding-milestone.sh "${PR_NUMBER}" -R "${REPO}")
# Quoted so multi-word milestone titles (e.g. "Watch & Fleet Observability") survive
# as a single value wherever MILESTONE_FLAG is later interpolated — matches the
# quoting convention already used for --title/--body-file/--label below.
[ -n "$MILESTONE_TITLE" ] && MILESTONE_FLAG="--milestone \"$MILESTONE_TITLE\""
```

**Dedup against existing issues (MANDATORY before creating):**

Run the deterministic dedup script first, then fall through to the line-range check:

```bash
# Step 0: Deterministic title dedup — catches near-duplicates before line-range check
# See scripts/issue-dedup.sh for the token-overlap algorithm. <!-- Added: forge#1335 -->
FINDING_TITLE_DEDUP="fix: brief description of finding (review finding — PR #${PR_NUMBER})"
DEDUP_RESULT=$(scripts/issue-dedup.sh "$FINDING_TITLE_DEDUP" "$GH_FLAG" 2>&1)
DEDUP_EXIT=$?
if [ "$DEDUP_EXIT" -eq 1 ]; then
  echo "DEDUP: Skipping — $DEDUP_RESULT"
  # Skip this finding — do NOT create a duplicate issue
  # Add a comment on the existing issue referencing this recurrence in PR #${PR_NUMBER}
elif [ "$DEDUP_EXIT" -eq 2 ]; then
  echo "DEDUP: Usage error — $DEDUP_RESULT"
  # Skip this finding — do NOT fall through to issue creation on a usage error
fi
```

```bash
# For each finding (that passes the title dedup above), check line-range overlap
FINDING_FILE="path/to/file.py"
FINDING_LINE="123"
FINDING_TITLE="fix: brief description of finding (review finding — PR #${PR_NUMBER})"

# Build line-range bounds: ±5 tolerance covers typical off-by-one from upstream insertions
LINE_MIN=$((FINDING_LINE - 5))
LINE_MAX=$((FINDING_LINE + 5))

# Check open issues for line-range overlap OR title similarity on the same file
CANDIDATES=$(gh issue list --state open --label "review-finding" --limit 100 --json number,title,body \
  --jq "[.[] | select(.body | test(\"${FINDING_FILE}\"))]" 2>/dev/null)

EXISTING=$(echo "$CANDIDATES" | jq -r --arg file "$FINDING_FILE" --argjson min "$LINE_MIN" --argjson max "$LINE_MAX" --arg title "$FINDING_TITLE" '
  .[] |
  # Extract line number from issue body (pattern: `file.py:NNN`)
  ((.body | capture($file + ":(?<ln>[0-9]+)") .ln // "0") | tonumber) as $existing_line |
  if $existing_line >= $min and $existing_line <= $max then
    .number
  # Fallback: title keyword overlap (3+ shared words of length >3 → likely same finding)
  elif ([($title | ascii_downcase | split(" ") | .[] | select(length > 3))] -
        [(.title | ascii_downcase | split(" ") | .[] | select(length > 3))]) |
       length <= ([$title | ascii_downcase | split(" ") | .[] | select(length > 3)] | length) - 3 then
    .number
  else empty end
' 2>/dev/null | head -1)

if [ -n "$EXISTING" ]; then
    echo "DEDUP: Skipping — open issue #${EXISTING} already covers ${FINDING_FILE}:${FINDING_LINE} (range/title match)"
    # Skip this finding — do NOT create a duplicate issue
else
    # Check if a CLOSED issue exists at the same location ±5 lines (regression)
    CLOSED_CANDIDATES=$(gh issue list --state closed --label "review-finding" --limit 100 --json number,title,body \
      --jq "[.[] | select(.body | test(\"${FINDING_FILE}\"))]" 2>/dev/null)

    REGRESSION=$(echo "$CLOSED_CANDIDATES" | jq -r --arg file "$FINDING_FILE" --argjson min "$LINE_MIN" --argjson max "$LINE_MAX" '
      .[] |
      ((.body | capture($file + ":(?<ln>[0-9]+)") .ln // "0") | tonumber) as $existing_line |
      if $existing_line >= $min and $existing_line <= $max then
        .number
      else empty end
    ' 2>/dev/null | head -1)
    if [ -n "$REGRESSION" ]; then
        echo "REGRESSION: Previously fixed in #${REGRESSION} — elevating priority"
        # Create with regression warning and priority:P1 label
    fi
fi
```

**Rules:**
- Open `review-finding` issue at same file within ±5 lines → **skip** (do not create duplicate)
- Open `review-finding` issue at same file with similar title (3+ shared keywords) → **skip** (likely same finding despite line drift)
- Closed `review-finding` at same file within ±5 lines → create with regression warning, elevate to `priority:P1`

**For each finding** (that passes dedup), create issue through the `/issue` create-hook's programmatic invocation contract (see `commands/issue.md` § "Programmatic Invocation Contract") — this preserves the bespoke line-range/title dedup above as a precise pre-check, while `/issue`'s own Phase 2D dedup runs as a coarser second pass:
```bash
FINDING_ISSUE_TITLE="fix: [summary] (review finding — PR #${PR_NUMBER})"
# Defense-in-depth: /issue's arg tokenizer (commands/issue.md Argument Parsing,
# forge#2094) uses an xargs-based tokenizer that never expands backtick/$(...)
# substitution, so this is no longer required for safety — but strip it anyway
# so the raw title stays readable if it round-trips through any other
# eval-based consumer.
FINDING_ISSUE_TITLE=$(printf '%s' "$FINDING_ISSUE_TITLE" | tr '`' "'" | sed 's/\$(/$ (/g')
FINDING_ISSUE_BODY_FILE=$(mktemp)
cat <<'ISSUE_EOF' > "$FINDING_ISSUE_BODY_FILE"
## Problem

[One sentence: what bug or issue was found. Where it occurs (`file:line`) and what it causes.]

**Source**: PR #[PR_NUMBER] — [TITLE]
**Agent**: [name] ([domain])
**Confidence**: [CONFIRMED/LIKELY/POSSIBLE]
**Severity**: [CRITICAL/HIGH/MEDIUM/LOW]
**Review comment**: [permalink to agent comment]

## Pattern Metadata

**Pattern**: [short slug identifying the bug class, e.g. type-coercion-at-boundary, missing-auth-check, n+1-query]
**Files**: [affected file path(s)]
**Root cause**: [one sentence — why the bug occurs mechanically]
**Prevention**: [one sentence — what the builder must do to avoid this class of bug]

<!-- FORGE:PATTERN: [pattern-slug] -->
<!-- This machine-readable tag is used by pipeline-health Phase 4A to count pattern recurrences.
     When this slug appears on 3+ findings, a check-promotion issue is automatically filed.
     Keep the slug consistent across all findings for the same defect class. --> <!-- Added: forge#1331 -->

## Affected Files

Files that need changes:
1. `[file:line]` — [what needs to change to fix this finding]

## Source Branch Context

<!--
  BASE_BRANCH, not HEAD_BRANCH, is correct here (forge#2443). This looks like
  a revert of forge#1391 ("review-finding template stamps BASE_BRANCH instead
  of HEAD_BRANCH — fixes target wrong code state") but is NOT: forge#1391's
  scenario was a staging->main review where HEAD (staging) is a long-lived
  branch that already had the bug's code, while BASE (main) had not yet
  received it. review-pr.md's scenario is different — HEAD here is a
  short-lived feat/*|fix/* branch that Phase 6E deletes once the auto-merge
  step completes, which happens SYNCHRONOUSLY within this same /review-pr run,
  before any downstream consumer (a human, or /work-on) ever reads this
  finding. By the time the finding is read, HEAD no longer exists but BASE
  does, and BASE now contains the merged code the finding is about.
  commands/review-pr-staging.md keeps HEAD_BRANCH semantics (as a dynamic
  ${CODE_BRANCH}, not a hardcoded literal) because ITS reviewed branches
  (staging, milestone/*) are long-lived — consistent with forge#1391.
-->
**Code branch**: `[BASE_BRANCH]`
**Worktree base**: `origin/[BASE_BRANCH]`

> When fixing: `git worktree add ../fix-{slug} -b fix/{slug} origin/[BASE_BRANCH]`

## Code Context
[10 lines around finding]

## Evidence
[From agent comment]

## Acceptance Criteria

- [ ] Finding validated: VALIDATED / FALSE_POSITIVE / INCONCLUSIVE
- [ ] If VALIDATED: fix implemented and tested on correct branch
- [ ] Read code at location on correct branch
- [ ] Trace code path to verify issue
- [ ] Check existing mitigations
- [ ] Reproduce or construct proof-of-concept
[BATCHABLE_ANNOTATION]
ISSUE_EOF

# FINDING_SEVERITY is extracted from the finding's own **Severity** body field
# (set above in the heredoc) — example assignment shown here for clarity, same
# convention as FINDING_ISSUE_TITLE etc.
FINDING_SEVERITY="LOW"

# priority:* label is a deterministic function of the finding's **Severity**
# (CRITICAL/HIGH/MEDIUM/LOW) — NEVER of its Confidence
# (CONFIRMED/LIKELY/POSSIBLE). scripts/severity-to-priority.sh is the single
# source of truth for this mapping; commands/review-pr-staging.md calls the
# identical script so the two specs cannot independently drift. <!-- forge#2447 -->
FINDING_PRIORITY=$(bash scripts/severity-to-priority.sh "$FINDING_SEVERITY")
FINDING_PRIORITY_EXIT=$?

# Exit code MUST be checked before use — severity-to-priority.sh exits 1 (empty stdout)
# on a missing/unrecognized severity, mirroring the DEDUP_EXIT idiom above. Proceeding
# with an empty $FINDING_PRIORITY would call Skill(issue, --label "") instead of aborting
# issue creation for this finding. <!-- forge#2479 -->
if [ "$FINDING_PRIORITY_EXIT" -ne 0 ]; then
  echo "PRIORITY: severity-to-priority.sh failed (exit $FINDING_PRIORITY_EXIT) for severity '$FINDING_SEVERITY' — skipping finding issue creation"
  # Skip this finding — do NOT fall through to issue creation with an empty label
else

# --label is repeatable (not comma-joined) per the /issue programmatic contract.
Skill(skill="issue", args="--title \"$FINDING_ISSUE_TITLE\" --body-file \"$FINDING_ISSUE_BODY_FILE\" --label review-finding --label needs-validation --label \"$FINDING_PRIORITY\" ${MILESTONE_FLAG}")
rm -f "$FINDING_ISSUE_BODY_FILE"

# /issue has no machine-readable return contract (it's a user-facing command, not a work-on
# subcommand) — resolve the created issue's number by exact-title search immediately after
# the call. The title embeds ${PR_NUMBER} and the finding summary, making it unique enough
# for a reliable single-match lookup. Retry to absorb GitHub Search API indexing lag.
ISSUE_NUM=""
for _resolve_attempt in 1 2 3; do
  ISSUE_NUM=$(gh issue list -R ${REPO} --search "in:title \"${FINDING_ISSUE_TITLE}\"" --state open --limit 1 --json number --jq '.[0].number // empty')
  [ -n "$ISSUE_NUM" ] && break
  sleep 2
done
fi
```

Labels: `review-finding` + `needs-validation` + priority. `priority:*` is derived from the finding's `**Severity**` field via `scripts/severity-to-priority.sh` (single documented mapping — see that script's header comment): `CRITICAL` → `priority:P0`, `HIGH` → `priority:P1`, `MEDIUM` → `priority:P2`, `LOW` → `priority:P3`. **Never derive `priority:*` from Confidence** (CONFIRMED/LIKELY/POSSIBLE) — Confidence and Severity are independent axes; conflating them previously mislabeled LOW-severity CONFIRMED findings as `priority:P1`, defeating the P3 batching rule below. <!-- forge#2447 -->

**P3 batchable annotation** — <!-- Added: forge#1333 --> When priority resolves to `priority:P3` (i.e. `**Severity**: LOW`), check whether the finding qualifies for batching. If the affected file does NOT touch a security or billing path, substitute `[BATCHABLE_ANNOTATION]` with the `<!-- FORGE:BATCHABLE -->` marker. This signals the orchestrator's Phase 1 batching rule that this finding can be grouped with other P3s in the same domain:

```bash
# Determine batchable eligibility for this finding
# $FINDING_PRIORITY was already computed above (severity-to-priority.sh) — reuse it, do not re-derive.
BATCHABLE_ANNOTATION=""

if [ "$FINDING_PRIORITY" = "priority:P3" ]; then
  # Check for security/billing exclusions
  IS_SECURITY_PATH=0
  IS_BILLING_PATH=0
  # Test affected file path
  echo "$FINDING_FILE" | grep -qiE 'security|billing|payment|stripe|charge|invoice' && IS_SECURITY_PATH=1
  echo "$FINDING_TITLE" | grep -qiE 'security|billing|payment|stripe|charge|invoice' && IS_BILLING_PATH=1

  if [ "$IS_SECURITY_PATH" -eq 0 ] && [ "$IS_BILLING_PATH" -eq 0 ]; then
    BATCHABLE_ANNOTATION="<!-- FORGE:BATCHABLE -->"
    echo "INFO: P3 finding eligible for batching — appending FORGE:BATCHABLE annotation"
  else
    BATCHABLE_ANNOTATION=""
    echo "INFO: P3 finding touches security/billing path — NOT batchable, keeping individual pipeline"
  fi
fi
# When priority is P1 or P2: BATCHABLE_ANNOTATION stays empty (never batched)
```

**Add to project board:**
```bash
for FINDING_NUM in {numbers}; do
  # GH_REPO and board IDs are read from forge.yaml → project_board section
  # OWNER = forge.yaml → project_board.owner (or project.owner)
  # PROJECT_NUMBER = forge.yaml → project_board.project_number
  # PROJECT_ID = forge.yaml → project_board.project_id
  # STATUS_FIELD_ID = forge.yaml → project_board.field_ids.status
  # LANE_FIELD_ID = forge.yaml → project_board.field_ids.lane
  # REVIEW_FINDING_OPTION_ID = forge.yaml → project_board.option_ids.workflow.in_review
  ITEM_ID=$(gh project item-add ${PROJECT_NUMBER} --owner ${OWNER} --url "https://github.com/${GH_REPO}/issues/${FINDING_NUM}" --format json --jq '.id' 2>/dev/null)
  [ -n "$ITEM_ID" ] && {
    [ -n "$STATUS_FIELD_ID" ] && gh project item-edit --project-id ${PROJECT_ID} --id "$ITEM_ID" --field-id ${STATUS_FIELD_ID} --single-select-option-id ${REVIEW_FINDING_OPTION_ID} 2>/dev/null || true
    [ -n "$LANE_FIELD_ID" ] && gh project item-edit --project-id ${PROJECT_ID} --id "$ITEM_ID" --field-id ${LANE_FIELD_ID} --single-select-option-id ${LANE_OPTION_ID} 2>/dev/null || true
  }
done
```

### 6D: Update PR Description

Append `## Review Findings` table to PR body with finding summaries and issue links.

---

## Phase 7: Official Review Action

### 7A: Purpose Regression Gate (Milestone PRs Only)

**Skip if**: `IS_MILESTONE_TO_STAGING` is false (i.e., HEAD branch does NOT start with `milestone/`). This gate fires ONLY for milestone→staging PRs.

**Why this exists**: For milestone PRs, a CONFIRMED finding can be a functional regression even if it doesn't cause a runtime crash. A stealth milestone shipping a detectable signal is the stealth equivalent of a crash — the milestone's entire purpose is negated. The orchestrator's default heuristic (crash or data corruption = blocking) is insufficient here. This gate adds an explicit purpose-aware blocking criterion.

**Step 1 — Extract milestone purpose:**
```bash
# PR title and milestone name were fetched in Phase 1A
# Examples: "Stealth Engine Overhaul", "Session Intelligence", "Billing Reconciliation"
# Derive the capability domain from the milestone/PR title:
#   "stealth" → detection avoidance, fingerprint consistency, proxy signal coherence
#   "performance" → latency, throughput, resource utilization
#   "billing" → charge accuracy, credit calculation, subscription state
#   "auth" → session validity, token correctness, permission enforcement
#   "session" → session state consistency, persistence, expiry
```

**Step 2 — Evaluate each finding for purpose regression:**

For each finding that is CONFIRMED or LIKELY at MEDIUM+ severity (already created as a GitHub issue in Phase 6), apply the purpose regression test:

> **The test**: "If someone described this milestone's goal in one sentence (e.g., 'Improve stealth to avoid bot detection'), would this finding represent the opposite of that goal?"
>
> - A **stealth milestone** + a CONFIRMED finding about a detectable signal/fingerprint mismatch → **PURPOSE REGRESSION** → BLOCKING
> - A **performance milestone** + a CONFIRMED finding about increased latency or higher resource usage → **PURPOSE REGRESSION** → BLOCKING
> - A **billing milestone** + a CONFIRMED finding about incorrect charge calculation or credit leak → **PURPOSE REGRESSION** → BLOCKING
> - A **stealth milestone** + a CONFIRMED finding about a formatting inconsistency or a missing log line → **NOT a purpose regression** → advisory only (still gets a GitHub issue, but does not block)

**Step 3 — Set verdict flag:**
```bash
HAS_PURPOSE_REGRESSION=false

# For each CONFIRMED/LIKELY finding at MEDIUM+ severity:
# Read the finding's title/description from the GitHub issue created in Phase 6.
# Apply the purpose regression test above.
# If the finding contradicts the milestone's stated capability improvement:
HAS_PURPOSE_REGRESSION=true
PURPOSE_REGRESSION_FINDINGS+=("Finding ID: ..., Reason: ...")
```

**Step 4 — Log result:**

If `HAS_PURPOSE_REGRESSION=true`:
```
PURPOSE REGRESSION GATE: BLOCKED
Reason: [finding] contradicts milestone goal "[milestone name]"
Verdict escalated to CHANGES REQUESTED.
```

If no purpose regression found:
```
PURPOSE REGRESSION GATE: PASSED
No findings contradict the milestone's stated purpose.
Verdict determined by standard blocking criteria.
```

---

### 7B: Post Verdict

`gh pr review --approve` fails for self-reviews. Always use `--comment`.

**Blocking criteria** — a finding is BLOCKING if ANY of the following are true:
1. Phase 2 automated checks failed (build error, type error, test failure)
2. Agent finding is CONFIRMED at HIGH or CRITICAL severity
3. **[Milestone PRs only]** Phase 7A Purpose Regression Gate flagged `HAS_PURPOSE_REGRESSION=true` for this finding — regardless of whether it causes a runtime error
4. `MERGE_HEALTH == "CONFLICTING"` OR `MERGE_HEALTH_STATE` in {`DIRTY`, `BLOCKED`} — PR cannot be merged cleanly into its base branch <!-- Added: forge#194 -->
   - Verdict: CHANGES REQUESTED. Message: "Merge conflict with `{base}`. Rebase `{head}` onto `origin/{base}`, resolve the conflicting files, then re-run /review-pr."
   - If `MERGE_HEALTH == "UNKNOWN"` after retries: emit a WARNING in the verdict body (do NOT treat as a block — GitHub may still be computing it).

```bash
# Determine if mergeability is a blocker (MERGE_HEALTH/MERGE_HEALTH_STATE set in Phase 1A; BASE/HEAD set in Phase 0 Mode 3)
HAS_MERGE_CONFLICT=false
MERGE_CONFLICT_MSG=""
if [ "$MERGE_HEALTH" = "CONFLICTING" ] || [ "$MERGE_HEALTH_STATE" = "DIRTY" ] || [ "$MERGE_HEALTH_STATE" = "BLOCKED" ]; then
    HAS_MERGE_CONFLICT=true
    MERGE_CONFLICT_MSG="Merge conflict with \`${BASE}\`. Rebase \`${HEAD}\` onto \`origin/${BASE}\`, resolve the conflicting files, then re-run /review-pr."
fi

# Resolve attribution footer (forge.yaml → attribution.pr_footer)
ATTRIBUTION_PR_FOOTER=$(grep -A5 "^attribution:" forge.yaml 2>/dev/null | grep "pr_footer:" | awk '{print $2}' | tr -d '"' || echo "false")
ATTRIBUTION_FOOTER_LINE=""
if [ "$ATTRIBUTION_PR_FOOTER" = "true" ]; then
  ATTRIBUTION_FOOTER_LINE="
---
> ⚒️ Orchestrated with [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) — state, scheduling, review, and memory on GitHub."
fi

# Build trust annotation line for verdict body — always included so the decision is auditable.
# INTENSITY_TIER and TABLE_CELL_KEY are set in Phase 3B.5 (defaults: SHADOW / unavailable).
TRUST_ANNOTATION="**Intensity tier**: ${INTENSITY_TIER:-SHADOW} | **Cell**: \`${TABLE_CELL_KEY:-(unavailable)}\` | **Shadow mode**: ${TRUST_SHADOW_MODE:-true}"

# Stale review:
gh pr review $ARGUMENTS --comment --body "Review of commit $REVIEW_SHA_SHORT is stale — PR HEAD changed. Re-run /review-pr."

# Clean (no blocking issues):
gh pr review $ARGUMENTS --comment --body "APPROVED: commit $REVIEW_SHA_SHORT after context-aware review ([N] agents: [names]). [M] findings created as issues. Safe to merge.
${TRUST_ANNOTATION}
$([ "$MERGE_HEALTH" = "UNKNOWN" ] && echo "
⚠ Mergeability: GitHub is still computing merge state (UNKNOWN after retries). Verify manually before merging.")${ATTRIBUTION_FOOTER_LINE}"

# Blocking issues (including merge conflicts and purpose regressions):
gh pr review $ARGUMENTS --comment --body "CHANGES REQUESTED: commit $REVIEW_SHA_SHORT — [N] blocking issues found. See GitHub issues.
${TRUST_ANNOTATION}
$([ "$HAS_MERGE_CONFLICT" = "true" ] && echo "
🔴 Merge Conflict: ${MERGE_CONFLICT_MSG}")
$([ "$HAS_PURPOSE_REGRESSION" = "true" ] && echo "
⚠ Purpose Regression: [N] finding(s) contradict the milestone's stated goal and are automatically blocking regardless of runtime impact. See: ${PURPOSE_REGRESSION_FINDINGS[@]}")${ATTRIBUTION_FOOTER_LINE}"
```

---

## Phase 7B.5: Calibration Threshold Consultation (Conditional) <!-- Added: forge#1741 -->

**Skip if**: `AUTO_MERGE=false` AND no calibration-based routing is needed (this phase is informational even when not auto-merging — run it to populate `CALIBRATION_NEEDS_HUMAN` for Phase 8).

**Purpose**: Read the confidence calibration table (published to the `forge-knowledge` branch by `scripts/calibration.mjs`) and check whether the current PR's task-type × confidence combination has a survival rate below the overconfidence threshold. If the table says HIGH-confidence in this task type has historically performed poorly (< 80% survival), route to needs-human regardless of the agent verdict.

**Fail-safe**: ANY error reading the calibration table (branch absent, file missing, JSON parse error, git failure) MUST result in `CALIBRATION_NEEDS_HUMAN=false` and the current static blocking criteria (Phase 7B verdict) remaining authoritative. The calibration table can ONLY tighten behavior (add needs-human); it NEVER loosens behavior below the current static baseline.

```bash
# Phase 7B.5: Calibration threshold consultation
CALIBRATION_NEEDS_HUMAN=false
CALIBRATION_CELL=""
CALIBRATION_NOTE=""

# Read task type from FORGE:INVESTIGATOR on the linked issue
# (MERGE_ISSUE is the issue number; passed from --auto-merge args)
ISSUE_NUMBER="${MERGE_ISSUE:-}"

if [ -n "$ISSUE_NUMBER" ]; then
  INVESTIGATOR_BODY=$(gh api "repos/{GH_REPO}/issues/${ISSUE_NUMBER}/comments" \
    --jq '[.[] | select(.body | contains("FORGE:INVESTIGATOR"))] | last | .body // ""' 2>/dev/null || echo '')
  TASK_TYPE=$(echo "$INVESTIGATOR_BODY" | grep -oP '(?<=\*\*Task Type\*\*: )[^\n]+' | head -1 | tr -d ' \r')
  CONFIDENCE=$(echo "$INVESTIGATOR_BODY" | grep -oP '(?<=\*\*Confidence\*\*: )[^\n]+' | head -1 | tr -d ' \r')
  echo "Phase 7B.5: task_type=${TASK_TYPE:-unknown} confidence=${CONFIDENCE:-unknown} (from issue #${ISSUE_NUMBER})"
fi

# Read calibration table from forge-knowledge branch (fail-safe: any error → skip)
if [ -n "${TASK_TYPE:-}" ] && [ -n "${CONFIDENCE:-}" ]; then
  CALIB_RAW=$(git show "origin/forge-knowledge:calibration/table.json" 2>/dev/null || echo '')

  if [ -n "$CALIB_RAW" ]; then
    # Look up the task-type × confidence cell
    CALIB_CELL=$(echo "$CALIB_RAW" | jq -r --arg tt "$TASK_TYPE" --arg c "$CONFIDENCE" \
      '.rows[] | select(.taskType == $tt and .confidence == $c and .trusted == true)' 2>/dev/null || echo '')

    if [ -n "$CALIB_CELL" ]; then
      SURVIVAL_RATE=$(echo "$CALIB_CELL" | jq -r '.survivalRate // "null"' 2>/dev/null || echo 'null')
      SAMPLE_COUNT=$(echo "$CALIB_CELL" | jq -r '.sampleCount // 0' 2>/dev/null || echo '0')
      CELL_FLAG=$(echo "$CALIB_CELL" | jq -r '.flag // "null"' 2>/dev/null || echo 'null')

      CALIBRATION_CELL="${TASK_TYPE} × ${CONFIDENCE}: survival=${SURVIVAL_RATE} (n=${SAMPLE_COUNT})"
      echo "Phase 7B.5: calibration cell found — ${CALIBRATION_CELL} flag=${CELL_FLAG}"

      # Check overconfidence threshold: HIGH confidence with survival < 0.8
      if [ "$CONFIDENCE" = "HIGH" ] && [ "$CELL_FLAG" = "overconfidence" ]; then
        CALIBRATION_NEEDS_HUMAN=true
        CALIBRATION_NOTE="Calibration table: ${TASK_TYPE} × HIGH confidence has ${SURVIVAL_RATE} survival rate (< 0.80 threshold, n=${SAMPLE_COUNT}). Routing to needs-human per forge#1741 policy."
        echo "Phase 7B.5: CALIBRATION_NEEDS_HUMAN=true — ${CALIBRATION_NOTE}"
      else
        CALIBRATION_NOTE="Calibration cell: ${CALIBRATION_CELL} — within acceptable threshold"
        echo "Phase 7B.5: CALIBRATION_NEEDS_HUMAN=false — ${CALIBRATION_NOTE}"
      fi
    else
      # Cell not found or not trusted (below min-samples) — static behavior applies
      CALIBRATION_NOTE="Calibration cell for ${TASK_TYPE} × ${CONFIDENCE} is absent or untrusted — using static behavior"
      echo "Phase 7B.5: no trusted cell — ${CALIBRATION_NOTE}"
    fi
  else
    CALIBRATION_NOTE="forge-knowledge:calibration/table.json not found — using static behavior"
    echo "Phase 7B.5: calibration table unavailable — ${CALIBRATION_NOTE}"
  fi
else
  CALIBRATION_NOTE="task type or confidence not resolved from FORGE:INVESTIGATOR — using static behavior"
  echo "Phase 7B.5: could not resolve task type/confidence — ${CALIBRATION_NOTE}"
fi

# Log threshold decision in TRAJECTORY (append to existing issue comment or note for Phase 6)
# This satisfies the acceptance criterion: "Threshold adjustments appear in TRAJECTORY with the cell that justified them"
if [ -n "$ISSUE_NUMBER" ]; then
  gh issue comment "${ISSUE_NUMBER}" {MERGE_GH_FLAG} --body "<!-- FORGE:CALIBRATION_CHECK -->
**Phase 7B.5 — Calibration Threshold Check**
**Cell**: ${CALIBRATION_CELL:-not found}
**CALIBRATION_NEEDS_HUMAN**: ${CALIBRATION_NEEDS_HUMAN}
**Note**: ${CALIBRATION_NOTE}

**Phase 3B.5 — Provenance Trust Decision**
**Intensity tier**: ${INTENSITY_TIER:-SHADOW}
**Provenance cell**: \`${TABLE_CELL_KEY:-(unavailable)}\`
**Shadow mode**: ${TRUST_SHADOW_MODE:-true}
**TRUST_NEEDS_HUMAN**: ${TRUST_NEEDS_HUMAN:-false}
**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null || true
fi
```

---

## Phase 8: Auto-Merge (Conditional)

**Skip if** `AUTO_MERGE=false`.

```bash
# §7B verdict + purpose-regression + calibration + trust-escalation guard — check before any merge attempt <!-- Added: forge#1601, forge#1741, forge#1745 -->
# HARD RULE 3 requires that VERDICT=CHANGES REQUESTED, HAS_PURPOSE_REGRESSION=true,
# CALIBRATION_NEEDS_HUMAN=true, AND TRUST_NEEDS_HUMAN=true all block merge, including under --auto-merge.
# These vars are set in Phase 7A/7B/7B.5/3B.5 earlier in the same agent session.
# An unset/empty VERDICT is safe — it evaluates to "" which does not equal "CHANGES REQUESTED".
# TRUST_NEEDS_HUMAN: set to true by Phase 3B.5 when INTENSITY_TIER=NOVEL_NEEDS_HUMAN AND shadow mode is off.
if [ "$VERDICT" = "CHANGES REQUESTED" ] || [ "$HAS_PURPOSE_REGRESSION" = "true" ] || [ "$CALIBRATION_NEEDS_HUMAN" = "true" ] || [ "${TRUST_NEEDS_HUMAN:-false}" = "true" ]; then
    BLOCK_REASON=""
    [ "$VERDICT" = "CHANGES REQUESTED" ] && BLOCK_REASON="review verdict is CHANGES REQUESTED (blocking finding confirmed by Phase 7B)"
    [ "$HAS_PURPOSE_REGRESSION" = "true" ] && BLOCK_REASON="${BLOCK_REASON:+${BLOCK_REASON}; }purpose regression detected by Phase 7A (\`HAS_PURPOSE_REGRESSION=true\`)"
    [ "$CALIBRATION_NEEDS_HUMAN" = "true" ] && BLOCK_REASON="${BLOCK_REASON:+${BLOCK_REASON}; }calibration threshold: ${CALIBRATION_NOTE}"
    [ "${TRUST_NEEDS_HUMAN:-false}" = "true" ] && BLOCK_REASON="${BLOCK_REASON:+${BLOCK_REASON}; }provenance trust: NOVEL_NEEDS_HUMAN tier for cell \`${TABLE_CELL_KEY}\` — no sufficient prior data (forge#1745)"
    gh issue comment {MERGE_ISSUE} {MERGE_GH_FLAG} --body "⛔ Auto-merge aborted for PR #{PR_NUMBER}: ${BLOCK_REASON}. Manual review required before merging."
    gh issue edit {MERGE_ISSUE} {MERGE_GH_FLAG} --add-label "needs-human" 2>/dev/null || true
    # STOP — do not attempt gh pr merge when §7B/7B.5 blocking conditions are active
else

# Pre-merge mergeability guard — re-fetch fresh state before attempting merge <!-- Added: forge#194 -->
# A PR that was MERGEABLE at Phase 1A may have become CONFLICTING if the base branch
# received commits while the review was running. Re-check before every auto-merge.
PRE_MERGE_RESULT=$(gh pr view {PR_NUMBER} {MERGE_GH_FLAG} --json mergeable,mergeStateStatus --jq '"\\(.mergeable)|\\(.mergeStateStatus)"')
PRE_MERGE_HEALTH=${PRE_MERGE_RESULT%%|*}
PRE_MERGE_HEALTH_STATE=${PRE_MERGE_RESULT##*|}

if [ "$PRE_MERGE_HEALTH" = "CONFLICTING" ] || [ "$PRE_MERGE_HEALTH_STATE" = "DIRTY" ] || [ "$PRE_MERGE_HEALTH_STATE" = "BLOCKED" ]; then
    gh issue comment {MERGE_ISSUE} {MERGE_GH_FLAG} --body "⛔ Auto-merge aborted for PR #{PR_NUMBER}: PR is not mergeable (\`mergeable=${PRE_MERGE_HEALTH}\`, \`mergeStateStatus=${PRE_MERGE_HEALTH_STATE}\`). Rebase the branch onto \`{MERGE_BASE}\` and resolve conflicts, then re-run /review-pr."
    gh issue edit {MERGE_ISSUE} {MERGE_GH_FLAG} --add-label "needs-human" 2>/dev/null || true
    # STOP — do not attempt gh pr merge on a CONFLICTING/DIRTY PR
else

# Previously-escalated re-review guard <!-- Added: forge#1810; base-scoped: forge#2570 -->
# If the linked issue currently carries needs-human, this PR was escalated at some
# earlier point (VERDICT/purpose-regression/calibration/trust/mergeability) and has
# now been remediated + re-reviewed back to a clean, mergeable APPROVED state above.
#
# forge#2570: the hold is now scoped by the PR's target branch. This PR still transitions
# to workflow:awaiting-merge (clearing needs-human) in BOTH cases below — the transition is
# unchanged; only who acts next differs:
#   - `main` / deploy gate (or an unresolved base — fail closed): held for a HUMAN merge
#     decision, because `staging → main` is the genuine human gate no agent performs.
#   - any other base (staging, milestone/* — reversible integration branches): NOT held for
#     a human. It is parked for remediate.md Phase M7's base-scoped auto-land bar (bot APPROVED
#     + quality-gate pass), which merges it on the SAME condition the normal /work-on fast lane
#     uses for the same target branch — no manual click. This reconciles the asymmetry where a
#     bot-only re-review (authorAssociation=NONE) could never satisfy the strict ≥2 verified-
#     human bar and so stranded staging PRs the fast lane would auto-merge.
PREVIOUSLY_ESCALATED=$(gh issue view {MERGE_ISSUE} {MERGE_GH_FLAG} --json labels \
  --jq '[.labels[].name] | any(. == "needs-human")' 2>/dev/null || echo "false")
GUARD_BASE=$(gh pr view {PR_NUMBER} {MERGE_GH_FLAG} --json baseRefName --jq '.baseRefName' 2>/dev/null || echo "")

if [ "$PREVIOUSLY_ESCALATED" = "true" ]; then
    # forge#2625: `jq -r '.baseRefName'` stringifies a JSON null to the literal text "null" (not
    # an empty string), so the `-n` check alone does not catch it — add an explicit `!= "null"`
    # check so a literal-string "null" is treated the same as an empty/unresolved base (strict).
    if [ -n "$GUARD_BASE" ] && [ "$GUARD_BASE" != "null" ] && [ "$GUARD_BASE" != "main" ]; then
      # forge#2570: non-`main` base — defer to remediate.md M7's auto-land, not a human.
      gh issue comment {MERGE_ISSUE} {MERGE_GH_FLAG} --body "🟠 PR #{PR_NUMBER} was previously escalated (\`needs-human\`) and has now been re-reviewed to \`${VERDICT:-APPROVED}\` with a clean mergeability check on non-\`main\` base \`${GUARD_BASE}\`. It is parked at \`workflow:awaiting-merge\` for the remediation auto-land bar (\`remediate.md\` Phase M7, forge#2570) — which auto-merges it on the same fast-lane condition the normal \`/work-on\` path uses for this target branch — NOT for a human merge decision."
    else
      # forge#2570: `main` / deploy gate (or unresolved base — fail closed to the human gate).
      gh issue comment {MERGE_ISSUE} {MERGE_GH_FLAG} --body "🟠 PR #{PR_NUMBER} was previously escalated (\`needs-human\`) and has now been re-reviewed to \`${VERDICT:-APPROVED}\` with a clean mergeability check. This PR targets the deploy gate (\`${GUARD_BASE:-unresolved base}\`), so it is held at \`workflow:awaiting-merge\` for a human merge decision — \`staging → main\` is the genuine human gate. Merge manually once reviewed: \`gh pr merge {PR_NUMBER} {MERGE_GH_FLAG} --merge\`."
    fi
    RESOLUTION=$(resolve_script 'transition-label')
    TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
    case "$TIER" in
      adaptive|universal) bash "$SCRIPT_PATH" {MERGE_ISSUE} {MERGE_GH_FLAG} awaiting-merge ;;
      prose)
        gh issue edit {MERGE_ISSUE} {MERGE_GH_FLAG} --add-label "workflow:awaiting-merge" \
          --remove-label "needs-human,workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:merged,workflow:invalid,workflow:decomposed" 2>/dev/null || true
        ;;
    esac
    # STOP — do not attempt gh pr merge here. The merge decision belongs to a human for a
    # `main`/deploy-gate base, or to remediate.md Phase M7's base-scoped auto-land bar for a
    # non-`main` base (forge#2570). Either way this guard only parks at workflow:awaiting-merge.
else
    # Checkpoint comment on issue
    gh issue comment {MERGE_ISSUE} {MERGE_GH_FLAG} --body "Review complete for PR #{PR_NUMBER}. Verdict: ${VERDICT:-APPROVED}. Proceeding to merge."

    # Merge
    gh pr merge {PR_NUMBER} {MERGE_GH_FLAG} --merge

    # Verify
    MERGE_STATE=$(gh pr view {PR_NUMBER} {MERGE_GH_FLAG} --json state --jq '.state')
    [ "$MERGE_STATE" != "MERGED" ] && gh issue comment {MERGE_ISSUE} {MERGE_GH_FLAG} --body "PR #{PR_NUMBER} merge failed. State: $MERGE_STATE."
fi
fi
fi
```

**Important**: Phase 8 ONLY merges the PR. It does NOT close the issue, update labels, or clean up worktrees. When invoked via `/work-on`, those responsibilities belong to `work-on/close.md` (work-on.md Phase 6 — triggered when PR is merged and issue is still open). Doing them here would cause the issue to be closed with `workflow:merged` before Phase 6 runs, skipping the close phase entirely.

### 8B: Post-Merge Review Finding Demilestoning (Milestone PRs Only)

**Skip if**: `IS_MILESTONE_TO_STAGING` is false or `MERGE_STATE != "MERGED"`. Runs only when a milestone→staging PR was just successfully merged.

**Purpose**: Review-finding issues created during a milestone PR review (Phase 6C) inherit the milestone. Once the milestone PR merges, those findings should flow through the fast lane independently — not remain stranded on a closed milestone. This step clears their milestone assignment automatically.

```bash
if [ "${IS_MILESTONE_TO_STAGING:-false}" = "true" ] && [ "${MERGE_STATE:-}" = "MERGED" ]; then
    echo "Phase 8B: Clearing milestone from open review-finding issues referencing PR #${PR_NUMBER}..."

    # Find open review-finding issues whose body references this PR number
    # The title template in Phase 6C always includes: "review finding — PR #${PR_NUMBER}"
    FINDINGS_TO_DEMILESTONE=$(gh issue list -R "${REPO}" \
        --state open \
        --label "review-finding" \
        --limit 200 \
        --json number,title,milestone \
        --jq ".[] | select(.milestone != null) | select(.title | test(\"PR #${PR_NUMBER}\")) | .number" \
        2>/dev/null || echo "")

    if [ -z "$FINDINGS_TO_DEMILESTONE" ]; then
        echo "Phase 8B: No open review-finding issues with milestones found referencing PR #${PR_NUMBER}."
    else
        MOVED_COUNT=0
        echo "$FINDINGS_TO_DEMILESTONE" | while IFS= read -r FINDING_NUM; do
            [ -z "$FINDING_NUM" ] && continue
            FINDING_TITLE=$(gh issue view "$FINDING_NUM" -R "${REPO}" --json title --jq '.title' 2>/dev/null || echo "#${FINDING_NUM}")
            gh issue edit "$FINDING_NUM" -R "${REPO}" --milestone "" 2>/dev/null && \
                echo "  Moved to fast lane: #${FINDING_NUM} — ${FINDING_TITLE}" || \
                echo "  WARNING: Failed to clear milestone for #${FINDING_NUM}"
            MOVED_COUNT=$((MOVED_COUNT + 1))
        done
        echo "Phase 8B: Review finding demilestoning complete."
    fi
fi
```

<!-- Added: forge#815 -->

---

## Phase 9: Integrity Check & Summary (LAST)

**Run AFTER Phase 6 (issues created), Phase 7 (verdict posted), Phase 8 (merge if applicable).**

### 9A: Post-Merge Review Finding Demilestoning Fallback (Milestone PRs Only)

**Skip if**: `IS_MILESTONE_TO_STAGING` is false. Runs when `AUTO_MERGE=false` but the PR was merged manually — Phase 8B did not run in this case, so Phase 9 handles cleanup.

**Detection**: Check if the PR is now MERGED. If so and `IS_MILESTONE_TO_STAGING=true`, run the same demilestoning logic as Phase 8B.

```bash
if [ "${IS_MILESTONE_TO_STAGING:-false}" = "true" ]; then
    PR_MERGE_STATE=$(gh pr view $ARGUMENTS --json state --jq '.state' 2>/dev/null || echo "")
    if [ "$PR_MERGE_STATE" = "MERGED" ]; then
        echo "Phase 9A: Checking for open review-finding issues to demilestone (fallback — manual merge path)..."

        FINDINGS_TO_DEMILESTONE=$(gh issue list -R "${REPO}" \
            --state open \
            --label "review-finding" \
            --limit 200 \
            --json number,title,milestone \
            --jq ".[] | select(.milestone != null) | select(.title | test(\"PR #${PR_NUMBER}\")) | .number" \
            2>/dev/null || echo "")

        if [ -z "$FINDINGS_TO_DEMILESTONE" ]; then
            echo "Phase 9A: No open review-finding issues with milestones found referencing PR #${PR_NUMBER} (already cleared or none created)."
        else
            echo "$FINDINGS_TO_DEMILESTONE" | while IFS= read -r FINDING_NUM; do
                [ -z "$FINDING_NUM" ] && continue
                FINDING_TITLE=$(gh issue view "$FINDING_NUM" -R "${REPO}" --json title --jq '.title' 2>/dev/null || echo "#${FINDING_NUM}")
                gh issue edit "$FINDING_NUM" -R "${REPO}" --milestone "" 2>/dev/null && \
                    echo "  Moved to fast lane: #${FINDING_NUM} — ${FINDING_TITLE}" || \
                    echo "  WARNING: Failed to clear milestone for #${FINDING_NUM}"
            done
            echo "Phase 9A: Fallback demilestoning complete."
        fi
    fi
fi
```

<!-- Added: forge#815 -->

```bash
CURRENT_SHA=$(gh pr view $ARGUMENTS --json headRefOid --jq '.headRefOid')
REVIEW_IS_STALE="false"
if [ "$CURRENT_SHA" != "$REVIEW_SHA" ]; then REVIEW_IS_STALE="true"; fi
```

### Phase 9 — New Contributor Welcome (Conditional) <!-- Added: forge#960 -->

Post a welcome comment when all three conditions are true:
1. `IS_FIRST_TIME_CONTRIBUTOR="true"` (set in Phase 1A — no prior merged PRs from this author in this repo)
2. `community.welcome_new_contributors` is not `false` in `forge.yaml` (default: enabled)
3. This is a single-PR review (MODE 3) — not a staging→main or multi-PR review

```bash
# Read config — default enabled when key is absent
WELCOME_ENABLED=$(yq '.community.welcome_new_contributors // true' forge.yaml 2>/dev/null || echo 'true')

if [ "$IS_FIRST_TIME_CONTRIBUTOR" = "true" ] && [ "$WELCOME_ENABLED" != "false" ] && [ "$REVIEW_MODE" = "single-pr" ]; then
    # Read optional custom values from forge.yaml community section
    CONTRIBUTING_URL=$(yq '.community.contributing_url // "CONTRIBUTING.md"' forge.yaml 2>/dev/null || echo 'CONTRIBUTING.md')
    CUSTOM_CONVENTIONS=$(yq '.community.conventions // ""' forge.yaml 2>/dev/null || echo '')
    PROJECT_NAME_WELCOME=$(yq '.project.name // "this project"' forge.yaml 2>/dev/null || echo 'this project')

    # Resolve the conventions text into a plain shell variable BEFORE interpolating it into
    # the --body string below. A nested $(...) command substitution containing an escaped
    # \$VAR here is never expanded — see forge#2214.
    if [ -n "$CUSTOM_CONVENTIONS" ]; then
        CONVENTIONS_TEXT="$CUSTOM_CONVENTIONS"
    else
        CONVENTIONS_TEXT="- **Conventional commits**: prefix your commit messages with \`fix(scope):\`, \`feat(scope):\`, \`refactor(scope):\`, etc.
- **DCO sign-off**: all commits must be signed off with \`git commit -s\` (Developer Certificate of Origin — required for the dual-license model).
  Fix unsigned commits: \`git commit --amend -s --no-edit && git push --force-with-lease\` <!-- allowlist:check-command-side-effects -->
- **Issues, not inline fixes**: when you spot a bug or improvement opportunity, open a GitHub issue rather than fixing it inline — so it flows through the pipeline with full traceability."
    fi

    # Unquoted heredoc (not the corpus's quoted <<'EOF' form) — this body needs live
    # ${VAR} interpolation, which a quoted heredoc would disable. Literal backticks in
    # the static text are still escaped (\`) since they remain live inside an unquoted
    # heredoc, same as inside a double-quoted string. See forge#2223.
    gh pr comment "$ARGUMENTS" --body "$(cat <<EOF
## Welcome to ${PROJECT_NAME_WELCOME}! 🎉

Hi @${PR_AUTHOR} — this looks like your first merged contribution here. Thanks for opening a PR!

### What just happened

The automated review pipeline (/review-pr) ran against your PR. It spawned domain-specific agents to review security, integration assumptions, and code quality. Any findings were created as separate GitHub issues — not merge blockers unless they are CONFIRMED at HIGH/CRITICAL severity.

### Key conventions

${CONVENTIONS_TEXT}

### Getting started

- Contributing guide: [\`${CONTRIBUTING_URL}\`](${CONTRIBUTING_URL})
- Run \`npx forgedock\` to install the pipeline commands locally if you want to run /review-pr or /work-on yourself.

Welcome aboard!
EOF
)"
fi
```

**Verifiable agent count (MANDATORY — do not report a self-asserted `Agents: [N]` figure)** <!-- Added: forge#1849 -->

A degraded run that skipped Task-based agent dispatch must be visible from this summary alone, without interrogating the agent afterward. Compute the actual launched-agent count from the `<!-- FORGE:REVIEW-AGENT:{domain} -->` comments each agent is required to post (Phase 3C), rather than trusting a free-text tally:

```bash
ACTUAL_AGENT_DOMAINS=$(gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" \
    --jq '[.[].body | scan("<!-- FORGE:REVIEW-AGENT:([a-z-]+) -->") | .[0]] | unique | join(", ")' 2>/dev/null || echo "")
# NOTE: no `|| echo 0` fallback here — grep -c always prints a count (including 0 on
# no match) even though it exits 1 in that case. Appending `|| echo 0` after a `grep -c`
# pipeline double-counts: the pipeline already printed "0", then the fallback prints a
# second "0" line, corrupting the value to "0\n0" in exactly the zero-agent case this
# check exists to detect. <!-- Added: forge#1849 -->
ACTUAL_AGENT_COUNT=$(echo "$ACTUAL_AGENT_DOMAINS" | tr ',' '\n' | grep -c '.' 2>/dev/null)
```

Substitute `ACTUAL_AGENT_COUNT`/`ACTUAL_AGENT_DOMAINS` into the summary's `**Agents**: [N] ([names])` field below — do NOT substitute a manually-counted or remembered figure. If the agent's own recollection of what it launched disagrees with `ACTUAL_AGENT_COUNT` (e.g. it believes it ran agents but zero `FORGE:REVIEW-AGENT` comments exist), that mismatch itself is the signal this check exists to surface: report `ACTUAL_AGENT_COUNT` as-is (it is the ground truth) and add a note in the Recommendation section flagging the discrepancy — never suppress it to make the summary look complete. If `ACTUAL_AGENT_COUNT` is `0`, the review degraded to solo/inline mode (the exact failure mode this guard exists to catch) and the verdict MUST reflect that (`NEEDS RE-REVIEW`), regardless of what analysis was performed inline.

```bash
gh pr comment $ARGUMENTS --body "$(cat <<'EOF'
# PR Review Summary: #[NUMBER] - [TITLE]

## Review Integrity
**Reviewed commit**: `[SHA]` | **Current HEAD**: `[SHA]` | **Status**: [CURRENT/STALE]

## Verdict: [APPROVE / CHANGES REQUESTED / NEEDS RE-REVIEW]

## Context-Aware Review
**Domains**: [list] | **Agents**: [N] ([names]) | **Dispatch mode**: [risk-scaled (default) / thorough (--thorough flag) / full-union (milestone PR)]

## Integration Checks (Phase 2.5)
**Code registration**: [pass / N broken activation paths found]
**SOPS deploy chain**: [pass / not applicable / N warnings found]
**Purpose Regression Gate (7A)**: [N/A — non-milestone PR / PASSED — no purpose regressions / BLOCKED — N finding(s) contradict milestone goal]

## Risk Matrix
| Category | Risk | Blocking? | Confidence |
|----------|------|-----------|------------|

## Findings
| Finding | Severity | Confidence | Issue |
|---------|----------|------------|-------|

## Automated Checks
| Check | Result |
|-------|--------|

## Recommendation
[Final recommendation]

---
*Context-aware review complete. [N] agents + integration checks. [M] findings triaged.*
EOF
)"
```

Notify user:
```
Review complete for PR #X. Verdict: [VERDICT].
- Domains: [list]
- Agents: [N] ([names]) — [dispatch mode: risk-scaled / thorough / full-union]
- Integration checks: [pass/N broken paths found]
- Issues created: [M]
{IF AUTO_MERGE: "PR merged and issue closed." / "Merge FAILED — see issue."}
{IF IS_MILESTONE_TO_STAGING: "Review findings demilestoned: [N] issues moved to fast lane." / ""}
{Tip if risk-scaled: "Run with --thorough to enable full union dispatch for release-critical reviews."}
```
