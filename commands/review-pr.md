---
description: Context-aware PR review — analyzes what the PR touches, spawns domain-specific agents with project conventions. Supports staging reviews.
argument-hint: [PR number, URL, "open", or "staging" for feature→main review]
allowed-tools: Task, Bash, Read, Grep, Glob, WebFetch, Skill
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# PR Review — Orchestrator

**Input**: $ARGUMENTS

**NEVER use plan mode (EnterPlanMode)** during review — it breaks execution context.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`. User can override with `--model <name>`. Pass the resolved model in every `Task` tool call.

## Architecture — How This Command Works

This is the **orchestrator**. It routes to the right review mode, runs automated checks, spawns domain-specific agents, triages findings, and posts the verdict.

**Sub-files** (loaded on demand — NOT auto-loaded):

| File | What | How to invoke |
|------|------|---------------|
| `$FORGE_HOME/commands/review-pr-agents.md` | Agent prompt templates (9 agents + protocols) | `Read` tool during Phase 3C |
| `$FORGE_HOME/commands/review-pr-staging.md` | Full staging→main review pipeline | `Skill("review-pr-staging", ...)` during Phase 0 |

`$FORGE_HOME` defaults to `~/.claude` (the directory where `npx forgedock` symlinks commands). Override by setting `FORGE_HOME` in your environment.

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
```

### 1B: Classify
```bash
FILES=$(gh pr diff $ARGUMENTS --name-only)
DIFF=$(gh pr diff $ARGUMENTS)

echo "=== SERVICES ==="
echo "$FILES" | grep -c "^services/api/" && echo "API" || true
echo "$FILES" | grep -c "^services/worker/" && echo "WORKER" || true
echo "$FILES" | grep -c "^web/" && echo "WEB" || true
echo "$FILES" | grep -c "^shared/" && echo "SHARED" || true
echo "$FILES" | grep -cE "^(docker|infra/|\.github|Makefile|traefik)" && echo "INFRA" || true

echo "=== DOMAINS ==="
echo "$DIFF" | grep -cE "SessionUser|CurrentUser|get_current_user|jwt|oauth|login|logout|Depends\(get_|x.forwarded.for|x_forwarded_for|forwarded_for|rate.limit.*ip|ip.*rate.limit|algorithm.*HS256|algorithm.*RS256|NEXTAUTH_SECRET|JWT_SECRET|admin.proxy" && echo "AUTH" || true
echo "$DIFF" | grep -cE "credit|balance|debit|reconcil|tier_cost|pricing|charge|refund|stripe|subscription" && echo "BILLING" || true
echo "$DIFF" | grep -cE "scrape|tier.*escalat|proxy|anti_bot|stealth|playwright|playbook" && echo "SCRAPING" || true
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

Read `forge.yaml → verification.commands.{lang}.test` for the project's test command:

```bash
# Check each configured language for a test command
for lang in python typescript go rust; do
    TEST_CMD=$(yq ".verification.commands.${lang}.test // \"\"" forge.yaml 2>/dev/null || echo '')
    if [ -n "$TEST_CMD" ]; then
        echo "=== Running tests (${lang}): ${TEST_CMD} ==="
        eval "$TEST_CMD" 2>&1 | tail -30
        TEST_EXIT=$?
        [ "$TEST_EXIT" -ne 0 ] && echo "BLOCKING: ${lang} tests failed (exit $TEST_EXIT)"
    fi
done

# If no test commands were configured, log explicitly
PYTHON_TEST=$(yq '.verification.commands.python.test // ""' forge.yaml 2>/dev/null || echo '')
TS_TEST=$(yq '.verification.commands.typescript.test // ""' forge.yaml 2>/dev/null || echo '')
if [ -z "$PYTHON_TEST" ] && [ -z "$TS_TEST" ]; then
    echo "SKIPPED — no test commands configured in verification.commands"
fi
```
**BLOCKING if tests fail.**

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

For each changed file, execute the relevant checks using the standalone verification scripts in `$FORGE_HOME/scripts/`. These scripts can also be run independently outside the review context (e.g., from `/quality-gate` or `/work-on` builder steps).

**Platform note**: The verify-*.sh scripts require bash and standard POSIX tools. On Windows without bash (Git Bash / WSL / MSYS2), these checks are skipped with an explicit message — the review continues without them.

```bash
CHANGED_FILES=$(gh pr diff $ARGUMENTS --name-only)
REPO_ROOT="."  # Assumes cwd is the repo root

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
    bash "$FORGE_HOME/scripts/verify-route-registration.sh" "$CHANGED_FILES_TMP" "$REPO_ROOT" || true

    # 2. Environment variable wiring (checks .env.example, docker-compose, env_validation, SOPS mapping)
    echo "=== Running: verify-env-vars.sh ==="
    bash "$FORGE_HOME/scripts/verify-env-vars.sh" "$DIFF_TMP" "$REPO_ROOT" || true

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
    bash "$FORGE_HOME/scripts/verify-host-headers.sh" "$CHANGED_FILES_TMP" "$REPO_ROOT" || true

    # 4. SOPS deploy chain (ENV_MAPPING consistency, deploy path drift, hotfix sync)
    echo "=== Running: verify-sops-chain.sh ==="
    bash "$FORGE_HOME/scripts/verify-sops-chain.sh" "$DIFF_TMP" "$CHANGED_FILES_TMP" "$REPO_ROOT" || true

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
echo "$DIFF" | grep -cE "SessionUser|CurrentUser|jwt|oauth|password|token|secret|x.forwarded.for|x_forwarded_for|forwarded_for|rate.limit.*ip|ip.*rate.limit|algorithm.*HS256|algorithm.*RS256|NEXTAUTH_SECRET|JWT_SECRET|admin.proxy" && echo "  AUTH_SENSITIVE" || true
echo "$DIFF" | grep -cE "\.sql$|migration|DROP|ALTER|DELETE FROM" && echo "  DATABASE_MUTATION" || true
echo "$DIFF" | grep -cE "docker|deploy|traefik|nginx|\.yml.*service" && echo "  INFRASTRUCTURE" || true
echo "$DIFF" | grep -cE "docker-compose.*postgres|docker-compose.*redis|postgres.*command:|redis.*command:|image:.*postgres|image:.*redis" && echo "  DATABASE_CONTAINER" || true
echo "$DIFF" | grep -cE "create_async_engine|AsyncSession|connect_args|pool_size|prepared_statement|engine_from_config|sessionmaker" && echo "  DB_CONFIG" || true
echo "$DIFF" | grep -cE "subprocess|os\.system|eval\(|exec\(|pickle|yaml\.load[^_]" && echo "  CODE_EXECUTION" || true
echo "$FILES" | grep -cE "^sdk/|openapi.*\.json$|openapi-versions/" && echo "  SDK_OPENAPI" || true
```

**Churn (hot-spot) signal**: The signals above are all derived from the current diff content — none of them measure historical change frequency, which is one of the strongest empirical predictors of defect density. Compute a bounded per-file churn tier for the PR's changed files only (never repo-wide) and carry it forward as `CHURN_CONTEXT` for Phase 3C:

```bash
CHURN_WINDOW="90 days ago"   # named constant — must match the same window used in architect.md Phase A5
CHURN_CONTEXT=""
# Herestring (not a piped `| while read`) — a pipe would run the loop body in a
# subshell in bash, silently discarding CHURN_CONTEXT once the loop exits. $FILES
# is one path per line (gh pr diff --name-only), so `read -r` per line is safe
# even when a path contains embedded spaces.
while IFS= read -r FILE; do
  [ -z "$FILE" ] && continue
  COMMITS=$(git log --oneline --since="$CHURN_WINDOW" -- "$FILE" 2>/dev/null | wc -l)
  if [ "$COMMITS" -ge 15 ]; then
    # Real newline appended via $'\n' (ANSI-C quoting), not a literal backslash-n.
    # A literal "\n" would only be interpreted by `echo -e` — it survives
    # unprocessed into Phase 3C's raw template substitution ([CHURN_CONTEXT] ->
    # $CHURN_CONTEXT), which does not reprocess escapes, so with 2+ HOT files
    # multi-hotspot PRs would render squished in the agent prompt. A real
    # newline here makes the variable correct for every consumer.
    CHURN_CONTEXT="${CHURN_CONTEXT}${FILE} (${COMMITS} commits in last 90 days — HOT)"$'\n'
  fi
done <<< "$FILES"
if [ -z "$CHURN_CONTEXT" ]; then
  CHURN_CONTEXT="No hot-spot files detected (all changed files under 15 commits in the last 90 days)."
fi
echo "$CHURN_CONTEXT"
```

Tiers (fixed thresholds, identical to `architect.md` Phase A5): **HOT** = 15+ commits / 90 days, **MEDIUM** = 5–14, **LOW** = 0–4. Only HOT-tier files are listed in `CHURN_CONTEXT` — this keeps the agent prompt signal short and high-value rather than dumping a churn count for every file. This does not change agent selection (3B) — it is a scrutiny prior surfaced to whichever agents are already selected, substituted as `[CHURN_CONTEXT]` in Phase 3C.

### 3B: Select Agents

| Risk Signal | Required Agents |
|-------------|----------------|
| UNTRUSTED_INPUT_PROCESSING | Security (deep) + relevant domain |
| SHELL_SCRIPT | Security (deep) + Infrastructure |
| FINANCIAL | Security + Billing + Concurrency |
| AUTH_SENSITIVE | Security + Auth Conventions |
| DATABASE_MUTATION | Security + Database |
| DB_CONFIG | Security + Database + Infrastructure |
| INFRASTRUCTURE | Security + Infrastructure |
| DATABASE_CONTAINER | Security + Infrastructure (escalate to HIGH risk — stateful container restart) |
| CODE_EXECUTION | Security (deep) |
| SDK_OPENAPI | Security + API Design & Consistency (runs cross-PR schema check #10) |
| None | Security + all matching domain agents |

**General Security agent ALWAYS runs.** Domain agents selected by classification, not PR size. If BILLING detected, always also spawn Concurrency agent. If SHARED touched, spawn agents for all importing services.

**Domain-overlap dispatch (MANDATORY for multi-signal PRs):**

1. **Union semantics**: If multiple risk signals are detected, spawn the UNION of all agents from ALL matched rows. A PR triggering both `AUTH_SENSITIVE` and `FINANCIAL` spawns Security + Auth + Billing + Concurrency — not just one row's agents.

2. **Critical domain override**: If 2+ of these critical domains are detected in the same PR, spawn agents for ALL affected domains regardless of file count or line changes:
   - AUTH + BILLING → Security (deep) + Auth + Billing + Concurrency
   - AUTH + DATABASE_MUTATION → Security (deep) + Auth + Database
   - FINANCIAL + CONCURRENCY → Security (deep) + Billing + Concurrency + Database
   - AUTH + CODE_EXECUTION → Security (deep) + Auth

3. **Why this exists**: A 2-file PR touching both `services/api/app/core/auth.py` and `services/api/app/routers/billing.py` is MORE dangerous than a 20-file refactor in one domain. Small cross-domain PRs create interaction bugs that single-domain reviewers cannot catch. Never reduce agent count based on file count when multiple critical domains are involved.

### 3C: Load Agent Templates & Launch

**>>> INVOCATION: Read the agent catalog file:**
```
Read the file: $FORGE_HOME/commands/review-pr-agents.md
```

(`$FORGE_HOME` defaults to `~/.claude`)

**>>> LOAD CONFIG: Read forge.yaml for project context:**
```bash
# Read review config from forge.yaml (if present in project root)
FORGE_YAML="${FORGE_CONFIG:-$(git rev-parse --show-toplevel 2>/dev/null)/forge.yaml}"
PROJECT_NAME=$(yq '.project.name' "$FORGE_YAML" 2>/dev/null || echo "this project")
PROJECT_CONTEXT=$(yq '.review.context' "$FORGE_YAML" 2>/dev/null || echo "")
TECH_STACK=$(yq '.review.tech_stack' "$FORGE_YAML" 2>/dev/null || echo "")
# Domain-specific context (keyed by agent name)
DOMAIN_CONTEXT_AUTH=$(yq '.review.domains.auth' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_BILLING=$(yq '.review.domains.billing' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_INFRA=$(yq '.review.domains.infra' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_DATABASE=$(yq '.review.domains.database' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_FRONTEND=$(yq '.review.domains.frontend' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_SECURITY=$(yq '.review.domains.security' "$FORGE_YAML" 2>/dev/null || echo "")
DOMAIN_CONTEXT_API=$(yq '.review.domains.api' "$FORGE_YAML" 2>/dev/null || echo "")
```

If `forge.yaml` is absent or a field is empty/null, agents fall back to generic checks (no project-specific context injected — agents still function correctly, just without project conventions).

This file contains the Evidence-Based Review Protocol, Structured Findings Protocol, and all 9 agent prompt templates. For each selected agent:
1. Extract its template from the catalog
2. Substitute: `[PR_NUMBER]`, `[REVIEW_SHA]`, `[REVIEW_SHA_SHORT]`, `[TITLE]`, relevant files list
3. Substitute: `[PROJECT_NAME]` → `$PROJECT_NAME`, `[PROJECT_CONTEXT]` → `$PROJECT_CONTEXT`, `[TECH_STACK]` → `$TECH_STACK`
4. Substitute per-agent domain context: `[DOMAIN_CONTEXT]` → the agent's matching key from `forge.yaml → review.domains` (e.g., `$DOMAIN_CONTEXT_AUTH` for the auth agent, `$DOMAIN_CONTEXT_BILLING` for the billing agent)
5. Substitute the shared hot-spot prior: `[CHURN_CONTEXT]` → `$CHURN_CONTEXT` (computed once in Phase 3A, same value for every agent — this is a PR-level fact, not a per-domain config value, so it is NOT read from `forge.yaml`)
6. If Phase 2.5 found broken assumptions, append them to the agent's prompt as "Pre-found integration issues to verify"
7. Launch via `Task` tool with the resolved model (default `"sonnet"`, fallback `"opus"` if rate-limited)

**CRITICAL**: Launch ALL selected agents in a SINGLE message using multiple Task tool calls. Each agent posts findings directly to the PR via `gh pr comment`.

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

If synthesis needed, launch a `general-purpose` Task (model: resolved per policy — default sonnet, fallback opus):
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
# Check BOTH head and base branches — feature PRs targeting milestone/* branches
# should inherit the milestone for their review findings
BASE_BRANCH=$(gh pr view ${PR_NUMBER} --json baseRefName --jq '.baseRefName')
HEAD_BRANCH=$(gh pr view ${PR_NUMBER} --json headRefName --jq '.headRefName')
MILESTONE_FLAG=""

# First check: PR's base branch is a milestone branch (most common for feature-lane PRs)
MILESTONE_BRANCH=""
if echo "$BASE_BRANCH" | grep -qE "^milestone/"; then
    MILESTONE_BRANCH="$BASE_BRANCH"
elif echo "$HEAD_BRANCH" | grep -qE "^milestone/"; then
    MILESTONE_BRANCH="$HEAD_BRANCH"
fi

if [ -n "$MILESTONE_BRANCH" ]; then
    BRANCH_SLUG=$(echo "$MILESTONE_BRANCH" | sed 's|^milestone/||')
    MILESTONE_NUMBER=$(gh api repos/${REPO}/milestones 2>/dev/null | jq --arg slug "$BRANCH_SLUG" '.[] | select((.title | ascii_downcase | gsub("[^a-z0-9]+"; "-")) == $slug) | .number' 2>/dev/null | head -1)
    [ -z "$MILESTONE_NUMBER" ] && MILESTONE_NUMBER=$(gh api repos/${REPO}/milestones 2>/dev/null | jq --arg slug "$BRANCH_SLUG" '.[] | select((.title | ascii_downcase | gsub("[^a-z0-9]+"; "-")) | test($slug)) | .number' 2>/dev/null | head -1)
    [ -n "$MILESTONE_NUMBER" ] && MILESTONE_FLAG="--milestone $(gh api repos/${REPO}/milestones/${MILESTONE_NUMBER} --jq '.title')"
fi
```

**Dedup against existing issues (MANDATORY before creating):**

```bash
# For each finding, check if an open issue already exists at the same file within ±5 lines
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

**For each finding** (that passes dedup), create issue:
```bash
ISSUE_NUM=$(gh issue create \
  --title "fix: [summary] (review finding — PR #${PR_NUMBER})" \
  --label "review-finding,needs-validation,{priority}" \
  ${MILESTONE_FLAG} \
  --body "$(cat <<'ISSUE_EOF'
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

## Affected Files

Files that need changes:
1. `[file:line]` — [what needs to change to fix this finding]

## Source Branch Context

**Code branch**: `[HEAD_BRANCH]`
**Worktree base**: `origin/[HEAD_BRANCH]`

> When fixing: `git worktree add ../fix-{slug} -b fix/{slug} origin/[HEAD_BRANCH]`

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
ISSUE_EOF
)" --json number --jq '.number')
```

Labels: `review-finding` + `needs-validation` + priority (`priority:P1` CONFIRMED, `priority:P2` LIKELY, `priority:P3` POSSIBLE).

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

# Stale review:
gh pr review $ARGUMENTS --comment --body "Review of commit $REVIEW_SHA_SHORT is stale — PR HEAD changed. Re-run /review-pr."

# Clean (no blocking issues):
gh pr review $ARGUMENTS --comment --body "APPROVED: commit $REVIEW_SHA_SHORT after context-aware review ([N] agents: [names]). [M] findings created as issues. Safe to merge.
$([ "$MERGE_HEALTH" = "UNKNOWN" ] && echo "
⚠ Mergeability: GitHub is still computing merge state (UNKNOWN after retries). Verify manually before merging.")"

# Blocking issues (including merge conflicts and purpose regressions):
gh pr review $ARGUMENTS --comment --body "CHANGES REQUESTED: commit $REVIEW_SHA_SHORT — [N] blocking issues found. See GitHub issues.
$([ "$HAS_MERGE_CONFLICT" = "true" ] && echo "
🔴 Merge Conflict: ${MERGE_CONFLICT_MSG}")
$([ "$HAS_PURPOSE_REGRESSION" = "true" ] && echo "
⚠ Purpose Regression: [N] finding(s) contradict the milestone's stated goal and are automatically blocking regardless of runtime impact. See: ${PURPOSE_REGRESSION_FINDINGS[@]}")"
```

---

## Phase 8: Auto-Merge (Conditional)

**Skip if** `AUTO_MERGE=false`.

```bash
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
    # Checkpoint comment on issue
    gh issue comment {MERGE_ISSUE} {MERGE_GH_FLAG} --body "Review complete for PR #{PR_NUMBER}. Verdict: {VERDICT}. Proceeding to merge."

    # Merge
    gh pr merge {PR_NUMBER} {MERGE_GH_FLAG} --merge

    # Verify
    MERGE_STATE=$(gh pr view {PR_NUMBER} {MERGE_GH_FLAG} --json state --jq '.state')
    [ "$MERGE_STATE" != "MERGED" ] && gh issue comment {MERGE_ISSUE} {MERGE_GH_FLAG} --body "PR #{PR_NUMBER} merge failed. State: $MERGE_STATE."
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

```bash
gh pr comment $ARGUMENTS --body "$(cat <<'EOF'
# PR Review Summary: #[NUMBER] - [TITLE]

## Review Integrity
**Reviewed commit**: `[SHA]` | **Current HEAD**: `[SHA]` | **Status**: [CURRENT/STALE]

## Verdict: [APPROVE / CHANGES REQUESTED / NEEDS RE-REVIEW]

## Context-Aware Review
**Domains**: [list] | **Agents**: [N] ([names])

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
- Agents: [N] ([names])
- Integration checks: [pass/N broken paths found]
- Issues created: [M]
{IF AUTO_MERGE: "PR merged and issue closed." / "Merge FAILED — see issue."}
{IF IS_MILESTONE_TO_STAGING: "Review findings demilestoned: [N] issues moved to fast lane." / ""}
```
