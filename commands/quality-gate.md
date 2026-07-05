---
description: Pre-commit quality check — catches defects the review would flag, so the builder can fix them before committing
argument-hint: (invoked by /work-on, not directly)
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /quality-gate — Pre-Commit Quality Check

**Input**: $ARGUMENTS (worktree path and changed files list from the builder)

You are a quality gate that runs AFTER implementation but BEFORE commit. Your job is to scan the builder's code for the same defects the review agents would catch — so the builder can fix them before the PR even exists.

You do NOT post to GitHub. You do NOT create issues. You return findings directly to the builder agent that spawned you.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — quality-gate.md loaded and active. Agent is bound by this spec. -->

---

## Adaptive Design

This quality gate uses **domain detection** to adapt to your project's actual tech stack. Checks are not one-size-fits-all — they are selectively triggered based on the file types and patterns present in each change.

**How it works**:
1. Changed files are classified into domains (AUTH, DEPLOY, DATABASE, FRONTEND, etc.) by pattern-matching against file paths, extensions, and diff content
2. Only checks for detected domains are executed — irrelevant checks are skipped entirely
3. A project that only changes markdown files runs zero domain checks; a project that changes only TypeScript components runs only SECURITY, FRONTEND, and PROXY checks

**Universal check** (always runs for any code file):
- **SECURITY** — SQL injection, SSRF, path traversal, hardcoded secrets, XSS, command injection

**Conditional checks** (triggered only when relevant patterns are detected):

| Domain | Triggered when |
|--------|----------------|
| AUTH | Files matching `*router*` or `route.ts` handlers |
| DEPLOY | Files referencing `os.getenv` or `process.env` |
| DATABASE | `.sql` files or files under `migrations/` |
| FRONTEND | `.tsx`/`.ts` files in client component paths |
| PROXY | Client components using `fetch`/`useSWR`/`apiFetch` |
| SHELL | `.sh` files or scripts using `curl`/`wget` |
| STRING_SETS | *(scraping pack — opt-in)* Python files in anti-detection or browser automation paths. Enable via `forge.yaml → quality_gate.optional_domains: [STRING_SETS]` |
| CONCURRENCY | Python files using `asyncio.shield`, `asyncio.wait_for`, or `Task.cancel` |
| STATE | Python files with new module-level mutable variable assignments |
| CAPACITY | *(scraping pack — opt-in)* Worker/infra Python files with new size/limit/threshold constants. Enable via `forge.yaml → quality_gate.optional_domains: [CAPACITY]` |
| WORKFLOW | `.yml` files in `.github/workflows/` |
| IMPORT_RESOLUTION | Python files with new `from app.*` imports added outside `try:` blocks |
| INFRA | Dockerfiles or entrypoints with runtime UID changes |
| ROUTER_BUG | Router Python files where gate conditions are narrowed |
| FORGE_GRAPH | `commands/*.md` specs or `scripts/*` files change (ForgeDock self-consistency) |
| CONFIG_SCHEMA | Config files for external tools (`traefik/`, `infra/nginx/`, `k8s/`, `terraform/`, `*.conf`, `*.toml` in infra paths, or `docker-compose*.yml` with service definition changes) |
| BILLING | Files under `billing/`, `credits/`, `subscription`, `ledger`, or `payment` paths |

**Stack-agnostic coverage**: The example domains above reflect common patterns caught in production; they are not requirements. A Go or Ruby project benefits from SECURITY checks. A Node.js project benefits from FRONTEND, PROXY, and DEPLOY checks. Any project benefits from DATABASE and WORKFLOW checks when those file types are present. The stack-specific examples (Python routers, SOPS secrets chain, FastAPI layouts, appleboy SSH deploys) are illustrative — the domain detection system applies the applicable subset to any codebase.

---

## Input Format

The builder passes:
```
WORKTREE_PATH: /path/to/worktree
CHANGED_FILES: file1.py file2.tsx file3.sql
PR_BASE: staging|milestone/slug
TASK_TYPE: bug-fix|feature|refactor|investigation
ISSUE_NUMBER: #123
```

## Step 1: Read the diff

```bash
cd {WORKTREE_PATH}
git diff --cached --name-only 2>/dev/null || git diff HEAD --name-only
git diff --cached 2>/dev/null || git diff HEAD
```

Read EVERY changed file in full — not just the diff. Context matters.

---

## Step 1.5: Determine applicable domains

Before running checks, classify the changed files into domains. This avoids running irrelevant checks (e.g., database checks on a frontend-only change).

**Domain classification rules:**

| File pattern | Domain(s) triggered |
|---|---|
| `*.py` in `routers/` or `route.ts` handlers | AUTH |
| `*.py`, `*.ts`, `*.tsx`, `*.sh` (any code file) | SECURITY (always) |
| Files containing `os.getenv` or `process.env` | DEPLOY |
| `*.sql`, files in `migrations/`, or `*migrations/*.py` (Alembic) | DATABASE |
| Files under `billing/`, `credits/`, `subscription`, `ledger`, or `payment` paths | BILLING |
| `*.tsx`, `*.ts` in `web/src/` (excluding `route.ts`) | FRONTEND |
| `*.tsx`, `*.ts` client components with fetch/useSWR | PROXY |
| `*.sh` files or scripts with `curl`/`wget` | SHELL |
| `*.py` in `anti_detection/`, `consumers/`, `browser/`, or `shared/detection/` | STRING_SETS *(scraping pack — opt-in, see 2J)* |
| `*.py` containing `asyncio.shield`, `asyncio.wait_for`, or `Task.cancel` | CONCURRENCY |
| `*.py` files with new module-level `dict`, `set`, `Counter`, `Lock`, or `defaultdict` assignments | STATE |
| `*.py` in `services/worker/`, `infra/`, or `browser/` with new assignments to variables containing `MB`, `SIZE`, `MAX`, `LIMIT`, `THRESHOLD`, or `TIMEOUT` | CAPACITY *(scraping pack — opt-in, see 2K)* |
| `*.yml` in `.github/workflows/` | WORKFLOW |
| `*.py` with new `from app.` import statements added outside `try:` blocks | IMPORT_RESOLUTION |
| `Dockerfile*` or `entrypoint*.sh` with added/changed `USER`, `su-exec`, `gosu`, or `setuid` | INFRA |
| `*.py` in `routers/` where the diff removes a line containing an or-gate condition (lines starting with `-` containing `if.*or`) | ROUTER_BUG |
| `commands/*.md` or `scripts/*` files (ForgeDock repo only — dogfoods its own spec graph) | FORGE_GRAPH |
| Files under `traefik/`, `infra/nginx/`, `k8s/`, `terraform/`, or files matching `*.conf`, `*.toml` in infra paths, or `docker-compose*.yml` with service definition changes | CONFIG_SCHEMA |

**Apply the classification:**

```bash
# Initialize domain flags
DOMAINS=""

# {CHANGED_FILES} is a space-separated argument (same contract as {AFFECTED_FILES}
# in architect.md) — split explicitly on IFS=' ' into an array instead of relying
# on a bare `for f in {CHANGED_FILES}`, which word-splits on the shell's default
# IFS (space, tab, AND newline) and would corrupt any path containing a space.
IFS=' ' read -ra CHANGED_FILES_ARR <<< "{CHANGED_FILES}"
for f in "${CHANGED_FILES_ARR[@]}"; do
    case "$f" in
        *.sql|*migrations/*|*migrations/*.py) DOMAINS="$DOMAINS DATABASE" ;;
    esac
    case "$f" in
        *billing/*|*credits/*|*subscription*|*ledger*|*payment*) DOMAINS="$DOMAINS BILLING" ;;
    esac
    case "$f" in
        *router*|*route.ts) DOMAINS="$DOMAINS AUTH" ;;
    esac
    case "$f" in
        *.tsx|*.ts|*.jsx)
            echo "$f" | grep -qv 'route\.ts$' && DOMAINS="$DOMAINS FRONTEND PROXY"
            ;;
    esac
    case "$f" in
        *.sh) DOMAINS="$DOMAINS SHELL" ;;
    esac
    case "$f" in
        *anti_detection/*|*consumers/*|*browser/*|*shared/detection/*)
            # STRING_SETS is a scraping-pack domain — opt-in via forge.yaml → quality_gate.optional_domains
            # <!-- Updated: forge#1349 — not enabled by default; scraping-product-specific -->
            if echo "$f" | grep -qE '\.py$'; then
                _OPT_DOMAINS=$(grep -A5 'optional_domains:' "{WORKTREE_PATH}/forge.yaml" 2>/dev/null | grep -oE 'STRING_SETS' | head -1 || true)
                [ -n "$_OPT_DOMAINS" ] && DOMAINS="$DOMAINS STRING_SETS"
            fi
            ;;
    esac
    case "$f" in
        commands/*.md|scripts/*) DOMAINS="$DOMAINS FORGE_GRAPH" ;;
    esac
    case "$f" in
        .github/workflows/*.yml) DOMAINS="$DOMAINS WORKFLOW" ;;
    esac
done

# Check for asyncio concurrency patterns in Python files
grep -lE "asyncio\.shield|asyncio\.wait_for|Task\.cancel" {CHANGED_FILES} 2>/dev/null | grep -qE '\.py$' && DOMAINS="$DOMAINS CONCURRENCY"

# Check for new module-level state variable assignments in Python files
grep -lE "^\w+ = (\{\}|\[\]|set\(\)|Lock\(\)|defaultdict|Counter)" {CHANGED_FILES} 2>/dev/null | grep -qE '\.py$' && DOMAINS="$DOMAINS STATE"

# Check for capacity constants in worker/infra/browser Python files
# CAPACITY is a scraping-pack domain — opt-in via forge.yaml → quality_gate.optional_domains
# <!-- Updated: forge#1349 — not enabled by default; scraping-product-specific -->
_OPT_CAPACITY=$(grep -A5 'optional_domains:' "{WORKTREE_PATH}/forge.yaml" 2>/dev/null | grep -oE 'CAPACITY' | head -1 || true)
if [ -n "$_OPT_CAPACITY" ]; then
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        git diff HEAD -- "$f" 2>/dev/null | grep -qE '^\+[A-Za-z_]\w*(MB|SIZE|MAX|LIMIT|THRESHOLD|TIMEOUT)\w*\s*=' && DOMAINS="$DOMAINS CAPACITY" && break
    done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'services/worker/|infra/|browser/')
fi

# Check for env var usage in changed files
grep -lE "os\.getenv|process\.env" {CHANGED_FILES} 2>/dev/null && DOMAINS="$DOMAINS DEPLOY"

# Check for new app.* imports added outside try: blocks in Python files
while IFS= read -r f; do
    [ -z "$f" ] && continue
    NEW_IMPORTS=$(git diff HEAD -- "$f" 2>/dev/null | grep -E '^\+\s*(from app\.|import app\.)' | grep -v '^+++')
    if [ -n "$NEW_IMPORTS" ]; then
        DOMAINS="$DOMAINS IMPORT_RESOLUTION"
        break
    fi
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$')

# Check for runtime UID changes in Dockerfiles or entrypoint scripts
while IFS= read -r f; do
    [ -z "$f" ] && continue
    git diff HEAD -- "$f" 2>/dev/null | grep -E '^\+.*(USER\s+[^0]|su-exec|gosu|setuid)' | grep -v '^+++' | grep -q . && DOMAINS="$DOMAINS INFRA" && break
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -iE 'Dockerfile|entrypoint.*\.sh')

# Check for gate condition narrowing in router Python files (condition removal = fix may be incomplete across siblings)
while IFS= read -r f; do
    [ -z "$f" ] && continue
    git diff HEAD -- "$f" 2>/dev/null | grep -E '^-.*\bif\b.*\bor\b' | grep -v '^---' | grep -q . && DOMAINS="$DOMAINS ROUTER_BUG" && break
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'router')

# Check for external tool config files (structural schema validation advisory)
# {CHANGED_FILES} is space-separated (see array-split note above) — reuse the
# same CHANGED_FILES_ARR built above instead of re-splitting.
for f in "${CHANGED_FILES_ARR[@]}"; do
    case "$f" in
        traefik/*|infra/nginx/*|k8s/*|terraform/*)
            DOMAINS="$DOMAINS CONFIG_SCHEMA" && break ;;
        *.conf|*.toml)
            echo "$f" | grep -qE 'infra/|traefik/|nginx/|k8s/|terraform/' && DOMAINS="$DOMAINS CONFIG_SCHEMA" && break ;;
        docker-compose*.yml)
            # Trigger only if service definitions changed (not just env vars or labels)
            git diff HEAD -- "$f" 2>/dev/null | grep -E '^\+\s+(image:|command:|entrypoint:)' | grep -q . && DOMAINS="$DOMAINS CONFIG_SCHEMA" && break ;;
    esac
done

# SECURITY is always included for any code file
DOMAINS="SECURITY $DOMAINS"

# Deduplicate
DOMAINS=$(echo "$DOMAINS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
echo "Applicable domains: $DOMAINS"
```

**Only run checks in Step 2 that match the identified domains.** Skip all others entirely.

---

## Step 2: Run domain checks

Run ONLY the checks whose domain was identified in Step 1.5. Skip checks for domains not present in the `DOMAINS` list.

- **2A (Security)**: Run if `SECURITY` in DOMAINS *(always — included for all code files)*
- **2B (Auth)**: Run if `AUTH` in DOMAINS
- **2C (Deploy chain)**: Run if `DEPLOY` in DOMAINS
- **2D (Database)**: Run if `DATABASE` in DOMAINS
- **2E (Frontend lifecycle)**: Run if `FRONTEND` in DOMAINS
- **2F (Frontend proxy)**: Run if `PROXY` in DOMAINS
- **2G (Cross-service integration)**: Run if `SHELL` or `FORGE_GRAPH` in DOMAINS
- **2H (Asyncio cancellation)**: Run if `CONCURRENCY` in DOMAINS
- **2I (State completeness)**: Run if `STATE` in DOMAINS
- **2J (String literal consistency)**: Run if `STRING_SETS` in DOMAINS
- **2K (Capacity constant validation)**: Run if `CAPACITY` in DOMAINS
- **2L (GitHub Actions template safety)**: Run if `WORKFLOW` in DOMAINS
- **2M (Import resolution)**: Run if `IMPORT_RESOLUTION` in DOMAINS
- **2N (Runtime UID × filesystem write)**: Run if `INFRA` in DOMAINS
- **2O (Residual pattern check)**: Run if `ROUTER_BUG` in DOMAINS
- **2P (External tool config schema)**: Run if `CONFIG_SCHEMA` in DOMAINS
- **2Q (Billing)**: Run if `BILLING` in DOMAINS
- **2R (Registry checks)**: ALWAYS run — executes all promoted checks from `scripts/check-registry/manifest.json` <!-- Added: forge#1331 -->
- **2T (Test suite execution)**: ALWAYS run — runs each configured `verification.commands.<lang>.test` command; stack-agnostic <!-- Added: forge#1605 -->
- **2S (Test failure classification)**: Run if Step 2T (or any future Step 2 check) invoked a test suite and it failed — classifies the failure as PRE_BROKEN, FLAKY, or REAL using `scripts/flaky-quarantine.sh` <!-- Added: forge#1336 -->

### 2A: Security (ALL files)

For every changed file, check:
1. **SQL injection**: Any string formatting/f-strings in SQL queries? Must use parameterized queries (`$1`, `:param`).
2. **SSRF**: User-controlled URLs passed to `httpx`, `requests`, `fetch` without allowlist validation?
3. **Path traversal**: User input used in file paths without sanitization?
4. **Hardcoded secrets**: API keys, passwords, tokens in code (not env vars)?
5. **XSS**: User input rendered with `dangerouslySetInnerHTML`?
6. **Command injection**: User input in `subprocess`, `exec`, `eval`?

```bash
# Quick automated checks
# {CHANGED_FILES} is a space-separated argument — split explicitly on IFS=' '
# into an array instead of a bare `for f in {CHANGED_FILES}` (see Step 1.5 for
# the full rationale; this is a separate bash block so the array is rebuilt here).
IFS=' ' read -ra CHANGED_FILES_ARR <<< "{CHANGED_FILES}"
for f in "${CHANGED_FILES_ARR[@]}"; do
    # f-string SQL
    grep -nE "f['\"].*SELECT|f['\"].*INSERT|f['\"].*UPDATE|f['\"].*DELETE|f['\"].*WHERE" "$f" 2>/dev/null && echo "SEC: f-string SQL in $f"
    # Hardcoded secrets
    grep -nE "(api_key|secret|password|token)\s*=\s*(f?['\"]|\`)[^{'\"\`]" "$f" 2>/dev/null | grep -vE "(example|placeholder|test|mock)" && echo "SEC: possible hardcoded secret in $f"
    # In-memory rate limiter (TypeScript only) — resets on restart, no cross-replica enforcement
    # Pattern: in-memory Maps/objects used for rate limiting reset on container restart and are not shared across replicas
    case "$f" in
        *.ts|*.tsx)
            grep -nE "new Map\(\)|=\s*\{\}|= new Map" "$f" 2>/dev/null | grep -iE "rate|limit|attempt|count|throttle|window" && \
                echo "SEC: in-memory rate limiter in $f — resets on container restart, not shared across blue/green replicas. Use Redis for distributed rate limiting."
            # Cookie security flags — explicit false/none values are CONFIRMED findings
            # Pattern: explicitly weakened cookie security flags expose sessions to XSS, plaintext interception, or CSRF
            grep -nE "httpOnly:\s*false|secure:\s*false|sameSite.*['\"]none['\"]" "$f" 2>/dev/null && \
                echo "SEC: cookie security flag weakened in $f — httpOnly: false exposes cookie to JS (XSS); secure: false allows HTTP transmission; sameSite: none without Secure enables CSRF."
            ;;
    esac
done
```

### 2B: Auth conventions (Python routers, TypeScript route handlers)

For new/modified endpoints:
1. Which auth dependency is used? Read `forge.yaml → review.domains.auth` for the configured dependency name(s). If absent, skip the naming check and fall back to generic resource-ownership verification only.
2. Does the endpoint check resource ownership (`user_id` or equivalent) before returning data?

Route-path-to-dependency convention (e.g. "dashboard routes must use X, public routes must use Y") is project-specific. Configure it in `forge.yaml → review.domains.auth` if your project uses one. Do not enforce a hard-coded convention universally. <!-- Updated: forge#1349 — removed hardcoded SessionUser/CurrentUser rule -->

```bash
# Read configured auth dependency names from forge.yaml (if present)
AUTH_DEPS=""
if [ -f "{WORKTREE_PATH}/forge.yaml" ]; then
    AUTH_DEPS=$(grep -A5 'domains:' "{WORKTREE_PATH}/forge.yaml" 2>/dev/null \
        | grep -A3 'auth:' | grep -oE '[A-Za-z_]+User|[A-Za-z_]+Auth|get_[a-z_]+' | sort -u | tr '\n' '|' | sed 's/|$//')
fi

while IFS= read -r f; do
    [ -z "$f" ] && continue
    if [ -n "$AUTH_DEPS" ]; then
        grep -nE "($AUTH_DEPS)|Depends\(get_" "$f" 2>/dev/null
    else
        grep -nE "Depends\(get_" "$f" 2>/dev/null
    fi
    grep -nE "@router\.(get|post|put|delete)" "$f" 2>/dev/null
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E 'router|route')
```

### 2C: Deploy chain (when new env vars are introduced)

```bash
NEW_ENVS=$(grep -rnE "os\.getenv\(|process\.env\." {CHANGED_FILES} 2>/dev/null | grep -oP "(os\.getenv\(['\"]|process\.env\.)(\w+)" | sed 's/os.getenv(["'"'"']//;s/process.env.//' | sort -u)
if [ -n "$NEW_ENVS" ]; then
    for var in $NEW_ENVS; do
        # Check if it exists in .env.example
        grep -q "$var" .env.example 2>/dev/null || echo "DEPLOY: $var not in .env.example"
        # Check decrypt-secrets.sh ENV_MAPPING only when the SOPS mapping script exists.
        # Emitting a finding for a file that doesn't exist in the repo produces false BLOCKINGs
        # on non-SOPS repos. Use verify-sops-chain.sh for the full SOPS chain check instead.
        # <!-- Updated: forge#1349 — gate on file presence -->
        if [ -f "{WORKTREE_PATH}/scripts/decrypt-secrets.sh" ]; then
            grep -q "$var" "{WORKTREE_PATH}/scripts/decrypt-secrets.sh" 2>/dev/null || echo "DEPLOY: $var not in decrypt-secrets.sh ENV_MAPPING"
        fi
    done
fi
```

### 2D: Database quality (SQL migration files and Alembic Python migrations)

For each `.sql` file or Alembic migration `.py` file:
1. **NOT NULL without DEFAULT**: `ALTER TABLE ... ADD COLUMN ... NOT NULL` without `DEFAULT` locks table and fails on existing rows
2. **DROP without IF EXISTS**: Fails on fresh databases
3. **Missing indexes**: New columns used in WHERE/JOIN without indexes
4. **Unbounded queries**: SELECT without LIMIT or time-bound WHERE clause
5. **Migration number collision**: Check against origin branch
6. **IF NOT EXISTS guard**: `CREATE TABLE`/`CREATE INDEX` without `IF NOT EXISTS` guard fails on re-run

```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    grep -nE "ADD COLUMN.*NOT NULL" "$f" | grep -v "DEFAULT" && echo "DB: NOT NULL without DEFAULT in $f"
    grep -nE "DROP (TABLE|COLUMN|INDEX)" "$f" | grep -v "IF EXISTS" && echo "DB: DROP without IF EXISTS in $f"
    grep -nE "SELECT.*FROM" "$f" | grep -v "LIMIT" | grep -v "WHERE.*created_at" && echo "DB: possibly unbounded query in $f"
    # IF NOT EXISTS guard check — CREATE TABLE/INDEX without guard fails on replay or repeated apply
    grep -nE "^\s*(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX)\b" "$f" | grep -iv "IF NOT EXISTS" && \
        echo "DB-GUARD | MEDIUM | $f | CREATE TABLE/INDEX without IF NOT EXISTS guard — statement will fail on re-run or fresh database replay. Add IF NOT EXISTS."
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.sql$')

# Also run structural checks on Alembic Python migration files
while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Check for op.create_table / op.create_index without if_not_exists or checkfirst guard
    grep -nE "\bop\.create_table\b|\bop\.create_index\b" "$f" | grep -iv "if_not_exists\|checkfirst" && \
        echo "DB-GUARD | MEDIUM | $f | op.create_table/op.create_index without if_not_exists/checkfirst guard — will fail on replay. Add if_not_exists=True or checkfirst=True."
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E 'migrations/.*\.py$')

# Migration prefix collision scan (Deploy Gate — HIGH)
# Runs whenever any SQL or Alembic Python migration file changed. Scans the configured
# migrations directory for duplicate numeric prefixes (both .sql and .py files).
# Duplicate prefixes can cause ordering conflicts during deploy.
# <!-- Updated: forge#1349 — removed stale validate-migration-order.sh reference (script does not exist) -->
# <!-- Updated: forge#1329 — extended collision scan to cover .py Alembic migration files -->
MIGRATIONS_DIR="{WORKTREE_PATH}/infra/migrations"
# Support configured migration directory from forge.yaml (if set)
if [ -f "{WORKTREE_PATH}/forge.yaml" ]; then
    _CONFIGURED_MIGRATIONS=$(grep -E '^\s*migrations_dir:' "{WORKTREE_PATH}/forge.yaml" 2>/dev/null \
        | head -1 | sed 's/.*migrations_dir:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs)
    [ -n "$_CONFIGURED_MIGRATIONS" ] && MIGRATIONS_DIR="{WORKTREE_PATH}/${_CONFIGURED_MIGRATIONS}"
fi
if [ -d "$MIGRATIONS_DIR" ]; then
    # Find duplicate numeric prefixes across all migration files (.sql and .py)
    DUPLICATE_PREFIXES=$( { ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null; ls "$MIGRATIONS_DIR"/*.py 2>/dev/null; } \
        | sed 's|.*/\([0-9]*\)_.*|\1|' \
        | sort | uniq -d)
    for prefix in $DUPLICATE_PREFIXES; do
        echo "DB-COLLISION | HIGH | $MIGRATIONS_DIR | Duplicate migration prefix $prefix — ordering conflict will occur during deploy. Classify as CRITICAL BLOCKER."
    done
fi
```

### 2E: Frontend lifecycle (React/TSX files)

For each `.tsx`/`.ts` client component:
1. **useEffect cleanup**: Does every useEffect that creates subscriptions/timers return a cleanup function?
2. **useCallback deps**: Are dependencies stable values (ids, primitives) not full objects (SWR responses)?
3. **Missing error/loading states**: Does data fetching handle loading and error?
4. **Component unmount**: Are async operations cancelled on unmount?
5. **Button type attribute**: Do all `<button>` elements have an explicit `type` attribute?
6. **Polling loop guard**: Do all polling/retry loops have a max-iteration or timeout guard?
7. **Rules of Hooks**: Do function components avoid early returns before hook calls?

```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Check for useEffect without cleanup (basic heuristic)
    grep -c "useEffect" "$f" 2>/dev/null
    grep -c "return.*cleanup\|return.*\(\) =>" "$f" 2>/dev/null

    # FE-5: button missing explicit type attribute
    # Handles both single-line (<button onClick=...>) and multi-line JSX (type= on next line).
    # Greps a 2-line window: flag only if neither the button line nor the following line contains type=
    grep -nE "<button\b" "$f" 2>/dev/null | while IFS=: read -r lineno rest; do
        window=$(sed -n "${lineno},$((lineno+1))p" "$f" 2>/dev/null)
        echo "$window" | grep -qE 'type\s*=' || \
            echo "FE-5 | MEDIUM | $f:$lineno | <button> missing explicit type= attribute — add type=\"button\" or type=\"submit\" to prevent accidental form submission"
    done

    # FE-6: polling/retry loop without max-iteration guard
    # Triggered by setTimeout/setInterval/requestAnimationFrame used in a recursive or loop context.
    # Checks for absence of a guard variable (maxRetries, maxAttempts, attempt, count, retries, MAX_)
    # within 10 lines of the polling call.
    grep -nE "\b(setTimeout|setInterval|requestAnimationFrame)\b" "$f" 2>/dev/null | while IFS=: read -r lineno rest; do
        start=$((lineno > 5 ? lineno - 5 : 1))
        window=$(sed -n "${start},$((lineno+10))p" "$f" 2>/dev/null)
        # Skip if a guard variable or clearTimeout/clearInterval is nearby
        echo "$window" | grep -qiE '\b(maxRetries|maxAttempts|attempts|retries|retryCount|count|MAX_RETRIES|MAX_ATTEMPTS|clearTimeout|clearInterval)\b' || \
            echo "FE-6 | MEDIUM | $f:$lineno | polling/retry call without visible max-iteration guard — add a retry counter or timeout limit to prevent infinite loops"
    done

    # FE-7: Rules of Hooks — early return before hook call (conservative, false positives possible)
    # Flags only unconditional top-level return statements that appear before any use* call in the
    # same function component. Does NOT flag returns inside if/else/switch blocks.
    # Note: this is a heuristic — complex components with valid conditional logic may false-positive.
    # Severity: MEDIUM. The review agent verifies with full AST context.
    awk '
        /^(export\s+)?(default\s+)?function\s+[A-Z]/ { in_component=1; found_hook=0; depth=0 }
        in_component && /\{/ { depth++ }
        in_component && /\}/ { depth--; if (depth <= 0) { in_component=0 } }
        in_component && depth==1 && /^\s*return\b/ && !found_hook {
            print FILENAME ":" NR ": FE-7 | MEDIUM | early return before first hook call — verify this does not split hook execution (Rules of Hooks)"
        }
        in_component && /\buse[A-Z]/ { found_hook=1 }
    ' FILENAME="$f" "$f" 2>/dev/null
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.tsx?$' | grep -v 'route\.ts')
```

### 2F: Frontend proxy wiring (client-side fetch calls)

The direct-backend path prefix to flag is read from `forge.yaml → review.layout.direct_api_prefix`.
If absent, defaults to `/api/v1/` (backward compatible). This prevents false findings on projects
that use a different API path scheme. <!-- Updated: forge#1349 — gate on forge.yaml, not hardcoded prefix -->

```bash
# Read configured direct API prefix from forge.yaml, fall back to /api/v1/
DIRECT_API_PREFIX="/api/v1/"
if [ -f "{WORKTREE_PATH}/forge.yaml" ]; then
    _CONFIGURED_PREFIX=$(grep -E '^\s*direct_api_prefix:' "{WORKTREE_PATH}/forge.yaml" 2>/dev/null \
        | head -1 | sed 's/.*direct_api_prefix:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs)
    # Also check under review.layout section
    if [ -z "$_CONFIGURED_PREFIX" ]; then
        _CONFIGURED_PREFIX=$(grep -A 10 'layout:' "{WORKTREE_PATH}/forge.yaml" 2>/dev/null \
            | grep -E '^\s*direct_api_prefix:' \
            | head -1 | sed 's/.*direct_api_prefix:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs)
    fi
    [ -n "$_CONFIGURED_PREFIX" ] && DIRECT_API_PREFIX="$_CONFIGURED_PREFIX"
fi
ESCAPED_PREFIX=$(printf '%s' "$DIRECT_API_PREFIX" | sed 's|/|\\/|g')

while IFS= read -r f; do
    [ -z "$f" ] && continue
    grep -nE "(fetch|useSWR|apiFetch)\\s*[(<]\\s*[\`\"']${ESCAPED_PREFIX}" "$f" 2>/dev/null && echo "PROXY: direct ${DIRECT_API_PREFIX} call in $f — must use /api/ proxy (configure review.layout.direct_api_prefix in forge.yaml to change the flagged prefix)"
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.(tsx?|jsx?)$' | grep -v 'route\.ts$')
```

### 2G: Cross-service integration (shell scripts with curl/wget)

For shell scripts that make HTTP requests to internal services:
1. Read the target service's middleware to verify the Host header will be accepted
2. Check that auth tokens are included if the endpoint requires them
3. Verify the URL path actually exists

Before running host-header checks on shell scripts, read project-specific internal service patterns from `forge.yaml` and export them so `verify-host-headers.sh` can append them to its generic defaults:

```bash
# Read project-specific internal service patterns from forge.yaml (if present)
FORGE_INTERNAL_PATTERNS=""
if [ -f "{WORKTREE_PATH}/forge.yaml" ]; then
    # Extract internal_service_patterns list (one pattern per line) and join with |
    FORGE_INTERNAL_PATTERNS=$(grep -A 999 'internal_service_patterns:' "{WORKTREE_PATH}/forge.yaml" \
        | grep -E '^\s*-\s+' \
        | sed 's/^\s*-\s*//' \
        | tr -d '"'"'" \
        | paste -sd '|' -)
fi
export FORGE_INTERNAL_PATTERNS
```

The script `verify-host-headers.sh` checks for the `FORGE_INTERNAL_PATTERNS` env var and appends any project-specific patterns to its generic defaults (localhost, 127.0.0.1, api-, worker-, 172.x.x.x, IP env vars) when the var is set.

### 2G.5: Hardcoded localhost in DB connection functions (shell scripts)

**Triggered when**: changed `*.sh` files contain DB connection patterns (`PGPASSWORD`, `createdb`, `psql`, `pg_dump`, `pg_restore`).

**Why this matters**: Every DB connection function in a deploy script must use `${POSTGRES_HOST:-localhost}` (or equivalent env var interpolation), not a bare `"localhost"` string literal. A hardcoded `"localhost"` works in local development but fails in any environment where PostgreSQL runs on a separate host. The pattern is reliably grep-detectable. <!-- Added: forge#303 -->

```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
  # Only check files that contain DB connection tools
  if grep -qE "PGPASSWORD|createdb|psql|pg_dump|pg_restore" "$f" 2>/dev/null; then
    # Look for new/modified lines with hardcoded localhost in variable assignments
    # Match: db_host="localhost", db_host='localhost', db_host=localhost (unquoted),
    #        local db_host=localhost (bash local keyword + unquoted) in DB context
    # Do NOT match: ${POSTGRES_HOST:-localhost} or ${DB_HOST:-localhost} (env var with fallback)
    HARDCODED=$(git diff HEAD -- "$f" 2>/dev/null | grep '^+' | grep -v '^+++' \
      | grep -E '\b(local\s+)?(db_host|host|DB_HOST)\s*=\s*["\047]?localhost["\047]?' \
      | grep -vE '\$\{[A-Z_]+:-localhost\}|\$[A-Z_]+')
    if [ -n "$HARDCODED" ]; then
      echo "SHELL-1 | HIGH | $f | Hardcoded 'localhost' in DB connection function — use \${POSTGRES_HOST:-localhost} pattern instead. Hardcoded localhost fails in production where PostgreSQL runs on a separate host."
      echo "$HARDCODED"
    fi
  fi
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.sh$')
```

Report any hit as **HIGH** — the DB connection will fail in any environment where PostgreSQL is not on `127.0.0.1:5432`.

### 2G.6: Spec graph self-consistency (FORGE_GRAPH domain)

**Triggered when**: changed files include `commands/*.md` specs or `scripts/*` files (ForgeDock repo only — it dogfoods its own Spec Knowledge Graph). Skips silently in any project without `scripts/validate-spec-graph.sh`.

**Why this matters**: ForgeDock's pipeline behavior is encoded in a ~1.2 MB prose spec corpus where drift is invisible — a `FORGE:*` annotation written but never read, a `Skill(skill="X")` referencing a sub-phase that no longer exists, or a `workflow:*` label set by no command. The Spec Knowledge Graph (`build-spec-graph.mjs`) makes this queryable; `validate-spec-graph.sh` consumes it and partitions findings into HARD (dangling cross-refs, broken label transitions) and SOFT (orphan annotations).

```bash
# Run only when commands/*.md or scripts/* changed and the validator ships in this repo.
VALIDATOR="$FORGEDOCK_SCRIPTS/validate-spec-graph.sh"
[ -f "$VALIDATOR" ] || VALIDATOR="{WORKTREE_PATH}/scripts/validate-spec-graph.sh"
if [ -f "$VALIDATOR" ]; then
    # The graph is auto-built from the worktree (gitignored JSON not required).
    # --soft keeps the gate non-blocking on the documented baseline orphans;
    # HARD findings are still reported below and surfaced as gate findings.
    GRAPH_REPORT=$(bash "$VALIDATOR" --root "{WORKTREE_PATH}" --soft 2>&1 || true)
    echo "$GRAPH_REPORT"
    # Map any HARD finding to a quality-gate finding (dangling ref / broken transition).
    echo "$GRAPH_REPORT" | grep -E '^\s*\[HARD\]' | while IFS= read -r hit; do
        echo "FORGE_GRAPH | HIGH | spec-graph | ${hit#*] }"
    done
fi
```

Report each `[HARD]` line as **HIGH** — a dangling `Skill()` target or a label set by no command is a real pipeline break (an agent will invoke a phase that does not exist, or a state will never be entered/exited). Orphan-annotation `[SOFT]` lines are advisory: surface them in the report for periodic triage but do NOT block the commit. Scaffolding `[INFO]` lines are expected and need no action. To gate on HARD findings (fail the build), drop `--soft`; the default keeps existing baseline orphans from blocking until they are triaged. <!-- Added: forge#869 -->

### 2G.7: Native command conflict check (FORGE_GRAPH domain)

**Triggered when**: changed files include `commands/*.md` files (top-level, not sub-phase subdirectories). Skips silently in any project without `scripts/check-native-conflicts.sh`.

**Why this matters**: ForgeDock commands are installed into `~/.claude/commands/`, the same namespace as native Claude Code built-in slash commands. A top-level command file whose basename matches a native command name (e.g. `resume.md` → `/resume`, `status.md` → `/status`) completely shadows the native command — users lose access to core Claude Code functionality with no error message. This check prevents the bug class from ever reaching `staging` or `npm publish`. <!-- Added: forge#1074 -->

```bash
# Run only when top-level commands/*.md files changed and the script ships in this repo.
# Sub-phase files in subdirectories (commands/work-on/*.md) are installed with their
# relative path preserved and resolve to namespaced commands — they cannot shadow
# root-level native commands and are not scanned.
CONFLICT_CHECKER="$FORGEDOCK_SCRIPTS/check-native-conflicts.sh"
[ -f "$CONFLICT_CHECKER" ] || CONFLICT_CHECKER="{WORKTREE_PATH}/scripts/check-native-conflicts.sh"
if [ -f "$CONFLICT_CHECKER" ]; then
    CONFLICT_REPORT=$(bash "$CONFLICT_CHECKER" "{WORKTREE_PATH}/commands" 2>&1) || CONFLICT_EXIT=$?
    echo "$CONFLICT_REPORT"
    if [ "${CONFLICT_EXIT:-0}" -ne 0 ]; then
        # Extract each conflicting file from the report and emit a gate finding.
        echo "$CONFLICT_REPORT" | grep -E '^\s+commands/' | while IFS= read -r hit; do
            echo "FORGE_GRAPH | HIGH | native-conflict | ${hit#*  }"
        done
    fi
fi
```

Report each conflict as **HIGH** — a shadowed native command is a silent user-facing regression (the native command becomes unreachable without warning). The builder must rename the conflicting file before the commit. Blocklist updates are in `scripts/check-native-conflicts.sh` (NATIVE_COMMANDS array).

### 2H: Asyncio cancellation safety (Python async code)

**Triggered when**: changed Python files contain `asyncio.shield`, `asyncio.wait_for`, or `Task.cancel`.

**Why this matters**: `asyncio.shield()` is one of the most misused async primitives — it fails silently when `CancelledError` is already pending on the outer task. `asyncio.wait_for` with `finally` blocks can deadlock if the finally body awaits a cancellable operation. These bugs are hard to reproduce and often only surface under load or connection teardown.

**Severity**: MEDIUM (flags for review, not auto-blocking). The review agent's concurrency auditor verifies with full context.

```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    # asyncio.shield usage — outer await may be reached with pending CancelledError
    grep -nE "asyncio\.shield" "$f" 2>/dev/null && \
        echo "ASYNC: asyncio.shield in $f — verify outer await isn't reachable with pending CancelledError. Prefer loop.create_task() for fire-and-forget."

    # asyncio.wait_for — verify all finally blocks don't await cancellable operations
    grep -nE "asyncio\.wait_for" "$f" 2>/dev/null && \
        echo "ASYNC: asyncio.wait_for in $f — verify all finally blocks handle CancelledError without awaiting cancellable operations"

    # await inside except/finally BaseException blocks — where shield failures manifest
    grep -nE "^[[:space:]]+(except BaseException|finally):" "$f" 2>/dev/null | while IFS= read -r line; do
        LINENO=$(echo "$line" | cut -d: -f1)
        sed -n "$((LINENO+1)),$((LINENO+5))p" "$f" | grep -q "await" && \
            echo "ASYNC: await in except/finally block at $f:$LINENO — may fail if CancelledError is pending"
    done
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$')
```


### 2I: State completeness (module-level counters/dicts/sets/locks)

**Triggered when**: changed Python files introduce new module-level `dict`, `set`, `Counter`, `Lock`, or `defaultdict` assignments (detected via the STATE domain flag above).

**Why this matters**: When a new state variable is added alongside an existing one (e.g., `_user_active_browsers` alongside `_browser_active_count`), every function that mutates the existing variable is a potential mutation site for the new variable. Missing even one site causes silent data divergence — the kind of bug that only surfaces under concurrent load or connection teardown.

For each new module-level state variable in the diff:
1. Identify its sibling — the existing state variable it mirrors or is paired with (same file, similar type and naming pattern)
2. Find all mutation sites of the sibling in the same module:
   ```bash
   grep -n "sibling_name\[" <module_file>
   grep -n "sibling_name\.pop\|sibling_name\.get\|sibling_name\s*=" <module_file>
   ```
3. For each sibling mutation site NOT already in the current diff, flag it:
   ```
   STATE: {sibling} mutated at {file}:{line} but {new_var} not handled — verify intentional
   ```

```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Find new module-level state variables introduced in the diff
    NEW_VARS=$(git diff HEAD -- "$f" 2>/dev/null | grep -E '^\+[A-Za-z_]\w* = (\{\}|\[\]|set\(\)|Lock\(\)|defaultdict|Counter)' | grep -oE '^[+][A-Za-z_]\w*' | tr -d '+' | sort -u)
    for new_var in $NEW_VARS; do
        # Find existing sibling variables (same file, similar type) — look at non-diff lines
        SIBLINGS=$(grep -nE "^[A-Za-z_]\w+ = (\{\}|\[\]|set\(\)|Lock\(\)|defaultdict|Counter)" "$f" 2>/dev/null | grep -v "$new_var" | grep -oE "^[0-9]+:[A-Za-z_]\w+" | head -5)
        for sibling_entry in $SIBLINGS; do
            sibling=$(echo "$sibling_entry" | cut -d: -f2)
            # Find all mutation sites of this sibling
            grep -nE "${sibling}\[|${sibling}\.pop|${sibling}\.get|${sibling}\s*=" "$f" 2>/dev/null | while read -r match; do
                line_num=$(echo "$match" | cut -d: -f1)
                # Check if this line is in the diff (already handled)
                git diff HEAD -- "$f" 2>/dev/null | grep -qE "^\+.*$(echo "$match" | cut -d: -f2-)" || \
                    echo "STATE: $sibling mutated at $f:$line_num but $new_var not handled — verify intentional"
            done
        done
    done
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$')
```

**Severity**: MEDIUM — missing a mutation site is usually a latent bug, not an immediate crash, but it causes incorrect behavior under concurrent load.

---

### 2J: String literal consistency (anti-detection/scraping code) *(Scraping Pack — opt-in)*

> **This domain is opt-in and disabled by default.** It is specific to scraping/anti-detection products and produces false findings on general repos. Enable it by adding `STRING_SETS` to `forge.yaml → quality_gate.optional_domains`. <!-- Added: forge#1349 -->

**Triggered when**: changed files include Python files in `anti_detection/`, `consumers/`, `browser/`, or `shared/detection/` directories AND `STRING_SETS` is in `forge.yaml → quality_gate.optional_domains`.

**Why this matters**: Detection keyword sets (e.g., `CHALLENGE_KEYWORDS`, `COMMON_COOKIES`) across related modules share a domain truth — if Akamai adds a new cookie marker, it must appear in ALL related sets. A typo or omission in one set silently breaks detection for that service path. This check catches both inter-file inconsistencies and intra-file comment/code drift.

For each changed file in the anti-detection/scraping domains:

**1. Identify modified string identifier sets** (frozensets, tuples, or lists of string literals used for detection):

```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    echo "=== String sets in $f ==="
    # Find named constants that are frozenset/tuple/list of strings
    grep -nE "^[A-Z_]+ = (frozenset|tuple|set)\(\[?['\"]|^[A-Z_]+ = \(['\"]|^[A-Z_]+ = \[['\"]" "$f" 2>/dev/null
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'anti_detection/|consumers/|browser/|shared/detection/')
```

**2. For each string in a modified set, check if it appears in sibling detection files:**

```bash
SERVICE_DIR=$(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E 'anti_detection/|consumers/|browser/' | head -1 | grep -oE '^services/[^/]+/[^/]+' || echo "services/worker/worker")

while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Extract string values from detection sets in this file
    STRINGS=$(grep -oE "'[a-z_][a-z0-9_-]*'" "$f" 2>/dev/null | tr -d "'" | sort -u)
    for s in $STRINGS; do
        # Check if this string appears in at least one other file in the service
        FOUND=$(grep -rl "\"$s\"\|'$s'" $SERVICE_DIR/ 2>/dev/null | grep -v "^$f$" | grep '\.py$' | head -1)
        [ -z "$FOUND" ] && echo "STR: '$s' in $f appears NOWHERE else in $SERVICE_DIR — possible typo or dead entry"
    done
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'anti_detection/|consumers/|browser/|shared/detection/')
```

**3. Check for identifiers mentioned in comments/docstrings of the SAME file that are NOT in the actual set** (catches the `abck` vs `_abck` class of bug):

```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    echo "=== Comment/code drift in $f ==="
    # Extract string literals from actual sets (remove quotes)
    SET_STRINGS=$(grep -oE "frozenset\(\[([^]]+)\]\)" "$f" 2>/dev/null | grep -oE "'[^']+'" | tr -d "'" | sort -u)
    SET_STRINGS="$SET_STRINGS $(grep -oE "\(([^)]*'[^']*'[^)]*)\)" "$f" 2>/dev/null | grep -oE "'[a-z_][a-z0-9_-]*'" | tr -d "'" | sort -u)"

    # Find identifiers mentioned in comments (after # or in docstrings)
    COMMENT_REFS=$(grep -oE "#.*\`[a-z_][a-z0-9_-]+\`|\"\"\".*[a-z_][a-z0-9_-]+.*\"\"\"" "$f" 2>/dev/null | grep -oE "\`[a-z_][a-z0-9_-]+\`|_[a-z][a-z0-9_]+" | tr -d '`' | sort -u)

    for ref in $COMMENT_REFS; do
        echo "$SET_STRINGS" | grep -q "^${ref}$" || echo "STR: '$ref' mentioned in comment in $f but NOT found in any string set — possible omission or typo"
    done
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'anti_detection/|consumers/|browser/|shared/detection/')
```

**4. Cross-reference sibling sets in related modules** (the primary inter-file check):

```bash
# Find all detection-related Python files in the same service
while IFS= read -r f; do
    [ -z "$f" ] && continue
    SIBLINGS=$(find $(dirname "$f")/../ -name "*.py" -path "*/anti_detection/*" -o -name "*.py" -path "*/consumers/*" -o -name "*.py" -path "*/browser/*" 2>/dev/null | grep -v "^$f$" | head -10)

    # Extract detection set names from the changed file
    SET_NAMES=$(grep -oE "^[A-Z_]+ = (frozenset|tuple|set)" "$f" 2>/dev/null | grep -oE "^[A-Z_]+")

    # $SIBLINGS is one file path per line (`find`) — herestring (not a piped
    # `| while read`, which would run the loop body in a subshell and discard
    # any accumulator set inside it) preserves newline-safety for paths with spaces.
    while IFS= read -r sib; do
        [ -z "$sib" ] && continue
        # Extract strings from sibling detection sets
        SIB_STRINGS=$(grep -oE "'[a-z_][a-z0-9_-]*'" "$sib" 2>/dev/null | tr -d "'" | sort -u)

        # Find strings in the changed file's sets that don't appear in the sibling
        for s in $(grep -oE "'[a-z_][a-z0-9_-]*'" "$f" 2>/dev/null | tr -d "'" | sort -u); do
            # Skip very short strings (likely not identifiers)
            [ ${#s} -lt 4 ] && continue
            echo "$SIB_STRINGS" | grep -q "^${s}$" || \
                echo "STR: '$s' in $f not found in sibling file $sib — verify if cross-module consistency is required"
        done
    done <<< "$SIBLINGS"
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'anti_detection/|consumers/|browser/')
```

**Flag as findings**:
- Strings appearing nowhere else in the service: possible typo or dead entry (MEDIUM)
- Strings in comments not present in actual set: possible omission or typo (HIGH — same-file drift is almost always a bug)
- Strings in one detection set missing from a known sibling set (same service, related domain): possible inter-module inconsistency (MEDIUM)

---

### 2K: Capacity constant validation (worker/infra code) *(Scraping Pack — opt-in)*

> **This domain is opt-in and disabled by default.** It is specific to scraping/browser-pool products and produces false findings on general repos. Enable it by adding `CAPACITY` to `forge.yaml → quality_gate.optional_domains`. <!-- Added: forge#1349 -->

**Triggered when**: changed Python files in `services/worker/`, `infra/`, or `browser/` introduce new assignments to variables whose names contain `MB`, `SIZE`, `MAX`, `LIMIT`, `THRESHOLD`, or `TIMEOUT` AND `CAPACITY` is in `forge.yaml → quality_gate.optional_domains`.

**Why this matters**: Hardcoded capacity constants (e.g., `_BROWSER_ESTIMATED_MB = 200`) are design-time guesses that drift from production reality. When used in guard conditions (e.g., "5 × 200 MB = 1000 MB peak"), a wrong constant directly limits system throughput and may never be caught until a slot fails to spawn. A constant is correctly-typed and correctly-used but factually wrong — logic checks pass, the bug ships.

For each new or modified capacity constant in the diff:

```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Find new capacity constant assignments introduced by this diff
    NEW_CAPS=$(git diff HEAD -- "$f" 2>/dev/null | grep -E '^\+[A-Za-z_]\w*(MB|SIZE|MAX|LIMIT|THRESHOLD|TIMEOUT)\w*\s*=' | grep -oE '^[+][A-Za-z_]\w+' | tr -d '+' | sort -u)
    for cap_var in $NEW_CAPS; do
        cap_val=$(grep -oE "^${cap_var}\s*=\s*[0-9]+" "$f" 2>/dev/null | grep -oE '[0-9]+$')

        # Check if a measurement annotation exists in the same file (inline comment on same line or preceding line)
        annotated=$(grep -E "^${cap_var}\s*=" "$f" 2>/dev/null | grep -iE "measured|validated|observed|benchmark|production|empirical|PR #[0-9]+|issue #[0-9]+")
        if [ -z "$annotated" ]; then
            echo "CAP: ${cap_var}=${cap_val} in $f — no measurement annotation found (add 'VALIDATED: <source>' comment or link issue/PR)"
        fi

        # Search git log for prior art that may contradict this value
        # Use the variable name keywords to search — strip common prefixes/suffixes
        keywords=$(echo "$cap_var" | tr '_' ' ' | tr '[:upper:]' '[:lower:]' | sed 's/\b\(max\|min\|limit\|size\|mb\|threshold\|timeout\|estimated\|browser\|pool\|worker\)\b/ /g' | tr -s ' ')
        git log --all -15 --oneline --grep="memory" 2>/dev/null | head -5
        git log --all -15 --oneline --grep="$(echo $keywords | cut -d' ' -f1)" 2>/dev/null | head -5
    done
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'services/worker/|infra/|browser/')
```

**Flag as findings**:
- Capacity constant with no measurement annotation: MEDIUM — "Hardcoded constant without measurement source — add `VALIDATED: <source>` comment or link issue/PR"
- Capacity constant where git history contains contradicting measured values: HIGH — "Hardcoded constant contradicts measured data in git history — verify before deploy"

**Note**: This check does NOT fail constants that cite a source. A comment like `# VALIDATED: observed 200-250MB per browser under load (2026-03-01)` or a linked PR is sufficient to pass.

---

### 2L: GitHub Actions template safety (workflow files with appleboy/ssh-action)

**Triggered when**: changed files include `.github/workflows/*.yml` files.

**Why this matters**: `appleboy/ssh-action` processes every `script:` field through Go's `text/template` engine **client-side, before SSH transmission**. Any `{{` in the script — including in comments, `docker ps --format` strings, and `docker inspect --format` strings — is interpreted as a Go template directive. If the expression does not resolve against the action's data context (which is an empty map for `appleboy/ssh-action`), the step exits with status 1 **before the script reaches the remote shell**. Shell error handlers (`|| fallback`, `2>/dev/null`, `set -e`) are completely bypassed. `continue-on-error: true` masks the failure silently, producing apparent deploy success with no remote shell output.

```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    if grep -q "appleboy/ssh-action" "$f"; then
        TEMPLATE_HITS=$(grep -n "{{" "$f")
        if [ -n "$TEMPLATE_HITS" ]; then
            echo "WORKFLOW-1 | HIGH | $f | Go template syntax found in file using appleboy/ssh-action"
            echo "$TEMPLATE_HITS"
            echo "ACTION REQUIRED: Replace docker inspect --format '{{...}}' and docker ps --format '{{...}}'"
            echo "with jq equivalents. ANY {{ in an appleboy/ssh-action script crashes the action before"
            echo "the script reaches the remote shell. Both function calls ({{index .X Y}}) AND field"
            echo "accessors ({{.Names}}, {{.Status}}) are CONFIRMED BLOCKING — both fail on empty context."
            echo ""
            echo "Safe replacements:"
            echo "  docker inspect IMAGE | jq -r '.[0].RepoTags[0]'"
            echo "  docker ps --format json | jq -r '.Names'"
            echo "  docker ps --format json | jq -r '.Status'"
        fi
    fi
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.github/workflows/.*\.yml$')
```

Report any hit as **CONFIRMED HIGH** — the step will exit 1 before reaching the remote shell.

Go template directives in `appleboy/ssh-action` `script:` blocks are preprocessed client-side before the script reaches SSH — they fail on an empty data context, crashing the action before any shell error handler can catch it. Both function call forms (`{{index .X Y}}`) and field accessors (`{{.Names}}`) fail. A partial fix that only replaces one form while leaving the other is insufficient. <!-- Added: forge#226 -->

### 2M: Import resolution (Python files with new app.* imports)

**Triggered when**: changed Python files introduce new `from app.` or `import app.` statements outside `try:` blocks.

**Why this matters**: A builder agent with access to milestone branch context can import `app.billing.subscriptions` in a fast-lane PR that targets `staging` — where that module does not exist. Every request crashes with `ModuleNotFoundError`. The module exists on disk in the builder's worktree (checked out from the milestone branch) but NOT in `git ls-files` for the base branch. `python -m py_compile` passes because the builder's environment has the module; the runtime environment does not.

```bash
PR_BASE="${PR_BASE:-staging}"

while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Extract new app.* import statements added in the diff
    # Only consider lines added (starting with +), skip diff headers (+++)
    NEW_IMPORTS=$(git diff HEAD -- "$f" 2>/dev/null | grep -E '^\+\s*(from app\.|import app\.)' | grep -v '^+++' | sed 's/^+//')

    # Use while IFS= read -r to preserve full import lines (word-splitting breaks multi-word imports)
    echo "$NEW_IMPORTS" | while IFS= read -r import_line; do
        # Skip empty lines (produced when NEW_IMPORTS is empty)
        [ -z "$import_line" ] && continue

        # Skip imports inside try: blocks — these are intentional conditional imports
        # Check the preceding 5 lines of the file for an unindented try: statement
        LINE_NUM=$(grep -nF "$import_line" "$f" 2>/dev/null | tail -1 | cut -d: -f1)
        if [ -n "$LINE_NUM" ]; then
            START=$((LINE_NUM > 5 ? LINE_NUM - 5 : 1))
            CONTEXT=$(sed -n "${START},$((LINE_NUM-1))p" "$f" 2>/dev/null)
            echo "$CONTEXT" | grep -qE '^\s*try\s*:' && continue
        fi

        # Derive the module path from the import statement
        # "from app.billing.subscriptions import X" → "app/billing/subscriptions.py"
        MODULE=$(echo "$import_line" | grep -oP '(?<=from |import )app[\w.]+' | head -1 | tr '.' '/')

        if [ -n "$MODULE" ]; then
            # Check if the module exists in the base branch file tree
            # Try both module.py and module/__init__.py
            EXISTS_AS_FILE=$(git ls-files --with-tree="origin/${PR_BASE}" "${MODULE}.py" 2>/dev/null | head -1)
            EXISTS_AS_PKG=$(git ls-files --with-tree="origin/${PR_BASE}" "${MODULE}/__init__.py" 2>/dev/null | head -1)

            if [ -z "$EXISTS_AS_FILE" ] && [ -z "$EXISTS_AS_PKG" ]; then
                echo "IMPORT-1 | HIGH | $f | Cross-lane import: '${import_line}' — module '${MODULE}' does not exist on origin/${PR_BASE}. This will crash at runtime with ModuleNotFoundError. Verify the module is available on the base branch, use a try/except ImportError fallback, or remove the import."
            fi
        fi
    done
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$')
```

**Flag as findings**:
- Import of `app.*` module not present in base branch tree: **HIGH** — guaranteed `ModuleNotFoundError` at runtime

**Regression guard**:
- Does NOT flag `try: from app.X import Y` patterns — these are intentional conditional imports
- Does NOT flag non-`app.*` imports (third-party libraries, `shared/`, stdlib)
- Does NOT block imports from modules that genuinely exist on the base branch

A builder agent working in a milestone-branch worktree has access to milestone-only modules. A fast-lane PR importing `app.*` modules that only exist on the milestone branch will pass `py_compile` (the module is present in the worktree) but crash at runtime on the base branch with `ModuleNotFoundError` on every request. <!-- Added: forge#277 -->

### 2N: Runtime UID × filesystem write check (Dockerfile or entrypoint with USER/su-exec/gosu changes)

**Triggered when**: INFRA domain is set (Dockerfile or entrypoint script introduces `USER`, `su-exec`, `gosu`, or `setuid` change).

**Why this matters**: When a container's runtime user changes from root to a non-root UID, Docker named volumes retain their existing root ownership. Any service code path that calls `mkdir`, `write_bytes`, `open(... 'w')`, or `os.makedirs` under a volume mount point will fail with `[Errno 13] Permission denied`. This failure is silent at startup — it only surfaces when the write code path executes, potentially hours or days after deploy.

```bash
# Step 1: Identify the service directory from the changed Dockerfile/entrypoint path
# e.g. services/worker/Dockerfile → service root = services/worker/
SERVICE_DIR=""
while IFS= read -r f; do
    [ -z "$f" ] && continue
    SERVICE_DIR=$(dirname "$f")
    break
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -iE 'Dockerfile|entrypoint.*\.sh')

if [ -n "$SERVICE_DIR" ]; then
    # Step 2: Find volume mount points for this service in any docker-compose*.yml
    COMPOSE_FILES=$(find . -maxdepth 3 -name "docker-compose*.yml" 2>/dev/null | sort)
    VOLUME_MOUNTS=""
    # $COMPOSE_FILES is one path per line (`find`) — herestring, not a piped
    # `| while read`, so VOLUME_MOUNTS remains visible after the loop exits.
    while IFS= read -r cf; do
        [ -z "$cf" ] && continue
        # Extract named volume mount points (lines like: - volume_name:/container/path)
        MOUNTS=$(grep -oE '[a-z_-]+:/[^: ]+' "$cf" 2>/dev/null | grep -v '^#' | cut -d: -f2)
        VOLUME_MOUNTS="$VOLUME_MOUNTS $MOUNTS"
    done <<< "$COMPOSE_FILES"

    # Step 3: Grep the service directory for filesystem write operations
    WRITE_OPS=$(grep -rn "mkdir\|write_bytes\|open(.*['\"]w\|makedirs\|shutil\.copy\|shutil\.move" \
        "$SERVICE_DIR" --include="*.py" 2>/dev/null | grep -v __pycache__ | head -20)

    if [ -n "$WRITE_OPS" ]; then
        echo "INFRA: filesystem write operations found in $SERVICE_DIR:"
        echo "$WRITE_OPS"
        echo ""
        if [ -n "$VOLUME_MOUNTS" ]; then
            echo "Named volume mount points in docker-compose*.yml: $VOLUME_MOUNTS"
            echo "INFRA-1: Verify entrypoint runs 'chown -R <user>:<group> <mount>' BEFORE privilege drop."
        fi
    fi
fi
```

**Flag as findings**:
- Filesystem write operations found in service directory AND named volume mounts exist AND no `chown` before privilege drop in entrypoint: **HIGH** — `PermissionError` on first write after UID drop. Named volumes are root-owned by default; a privilege drop without `chown` silently breaks all write paths under the mount point. <!-- Added: forge#323 -->

### 2O: Residual Pattern Check (router Python files with gate condition narrowing)

**Triggered when**: ROUTER_BUG domain is set (a router `*.py` file has a diff that removes or narrows a gate condition).

**Why this matters**: A bug fix that narrows a gate condition in one router file may leave identical unfixed conditions in sibling router files in the same directory. The fix is incomplete if the original (unfixed) pattern still exists elsewhere — even though the changed file is now correct. Grep-detectable at gate time.

```bash
PR_BASE="${PR_BASE:-staging}"

while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Extract removed condition lines from the diff (lines starting with -)
    REMOVED_CONDITIONS=$(git diff HEAD -- "$f" 2>/dev/null | grep -E '^-.*\bif\b' | grep -v '^---' | sed 's/^-//' | sed 's/^\s*//' | head -5)

    if [ -n "$REMOVED_CONDITIONS" ]; then
        ROUTER_DIR=$(dirname "$f")
        echo "Checking for residual unfixed patterns in $ROUTER_DIR siblings of $f..."

        # For each removed condition line, search sibling files for the same pattern
        echo "$REMOVED_CONDITIONS" | while IFS= read -r condition; do
            # Extract the key pattern from the condition (e.g., field name or function call)
            PATTERN=$(echo "$condition" | grep -oP '(?<=if\s)[\w.]+|[\w.]+\(|[\w.]+\s+or' | head -1 | tr -d ' ')
            if [ -n "$PATTERN" ]; then
                MATCHES=$(grep -rn "$PATTERN" "$ROUTER_DIR" --include="*.py" | grep -v "^${f}:" | grep -v "^\s*#" | head -10)
                if [ -n "$MATCHES" ]; then
                    echo "ROUTER-1 | HIGH | $f | Residual unfixed pattern '$PATTERN' found in sibling file(s) — fix may be incomplete:"
                    echo "$MATCHES" | while IFS= read -r match; do
                        echo "  $match"
                    done
                fi
            fi
        done
    fi
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'router')
```

**Flag as findings**:
- Original condition pattern found in sibling router files after the fix was applied: **HIGH** — the fix is incomplete; the same bug class exists in unlisted sibling files and will continue to produce the original error for users of those endpoints. <!-- Added: forge#383 -->

**False-positive prevention**:
- Only runs on files in a `routers/` path
- Only triggers when a condition line was actually removed in the diff (not just modified)
- Reports file:line matches from sibling files only (excludes the fixed file itself)

### 2P: External Tool Config Schema Advisory (external tool config files)

**Triggered when**: CONFIG_SCHEMA domain is set (config files for external tools are in the diff).

**Why this matters**: External tools with strict config schemas (Traefik, nginx, Kubernetes, Terraform, Docker Compose) silently ignore or reject structurally incorrect config — no startup crash, no error log, the feature simply does not activate. The quality gate cannot run `traefik validate` / `nginx -t` / `terraform validate` (those belong in CI), but it can verify that CI validation steps exist for the tool and remind the builder that structural validation is CI's responsibility. <!-- Added: forge#1104 -->

```bash
# Identify which external tools have config files in the diff
TOOL_FILES=$(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E \
    "(traefik/|infra/nginx/|k8s/|terraform/|docker-compose.*\.yml$|.*\.(conf|toml)$)" | head -20)

if [ -n "$TOOL_FILES" ]; then
    echo "CONFIG_SCHEMA: External tool config files detected in diff:"
    echo "$TOOL_FILES"
    echo ""

    # Check whether CI has a validation step for each detected tool
    WORKFLOW_DIR="{WORKTREE_PATH}/.github/workflows"
    CI_MISSING=""

    # $TOOL_FILES is one path per line (already newline-split above via `tr`) —
    # herestring, not a piped `| while read`, so CI_MISSING remains visible
    # after the loop exits.
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        case "$f" in
            traefik/*)
                grep -rlE "traefik.*validate|traefik.*check" "$WORKFLOW_DIR" 2>/dev/null | grep -q . || \
                    CI_MISSING="$CI_MISSING traefik"
                ;;
            infra/nginx/*|*nginx*.conf)
                grep -rlE "nginx.*-t|nginx.*test|nginx.*configtest" "$WORKFLOW_DIR" 2>/dev/null | grep -q . || \
                    CI_MISSING="$CI_MISSING nginx"
                ;;
            k8s/*|*.yaml)
                if ! grep -rlE "kubectl.*--dry-run|kubeval|kustomize.*build|helm.*lint" "$WORKFLOW_DIR" 2>/dev/null | grep -q .; then
                    echo "$f" | grep -qE '^k8s/' && CI_MISSING="$CI_MISSING kubernetes"
                fi
                ;;
            terraform/*)
                grep -rlE "terraform.*validate|terraform.*plan|tflint" "$WORKFLOW_DIR" 2>/dev/null | grep -q . || \
                    CI_MISSING="$CI_MISSING terraform"
                ;;
        esac
    done <<< "$TOOL_FILES"

    # Deduplicate
    CI_MISSING=$(echo "$CI_MISSING" | tr ' ' '\n' | sort -u | grep -v '^$' | tr '\n' ' ')

    if [ -n "$CI_MISSING" ]; then
        for tool in $CI_MISSING; do
            echo "CFG-1 | MEDIUM | .github/workflows/ | No CI validation step found for $tool config changes — add structural validation (e.g., 'traefik validate', 'nginx -t', 'terraform validate') to CI so structural errors are caught before merge. The INFRA review agent verifies logical correctness; CI must verify structural correctness."
        done
    else
        echo "CFG: CI validation steps detected for modified tool configs — structural validation covered by CI."
    fi
fi
```

**Flag as findings**:
- No CI validation step for a tool whose config files changed: **MEDIUM** — structural config errors will not be caught before deploy. The fix is a CI-layer addition (see `/ci-audit` for a comprehensive CI gap audit), not a quality gate fix.

**This check is advisory (MEDIUM), not blocking (HIGH)**. The quality gate cannot substitute for CI-level validators (`traefik validate`, `nginx -t`, `terraform validate`). Its role is to detect when those validators are absent from CI and surface that gap to the builder. Actual structural validation belongs in GitHub Actions.

**Separation of concerns**: ForgeDock reasons about architecture, logic, and security; CI runs deterministic tool validators with zero token cost. The quality gate enforces that the CI layer is complete — it does not replace it.

### 2Q: Billing domain checks (billing/credits/subscription/ledger/payment code)

**Triggered when**: BILLING domain is set (changed files are under `billing/`, `credits/`, `subscription`, `ledger`, or `payment` paths).

**Why this matters**: Billing code has three reliably grep-detectable defect classes that account for ~27% of review findings in the AlterLab health window: (1) `org_id` not propagated to debit/refund ledger write paths (silent data ownership loss — charges appear with wrong tenant); (2) `asyncio.sleep` / blocking sleep called inside an advisory-lock or open-transaction scope (holds DB connection/lock for the full sleep duration, causing connection exhaustion and deadlocks under load); (3) stdlib `logging.*()` calls passed structlog-style keyword arguments (`event=`, named context keys) that are not valid stdlib kwargs — crashes at runtime with `TypeError: unexpected keyword argument`. <!-- Added: forge#1329 --> <!-- allowlist: AlterLab -->

**2Q-1: org_id propagation in ledger write functions**

```bash
# Grep billing Python files for ledger write function definitions missing an org_id parameter.
# Heuristic: functions named debit/refund/charge/credit/apply_credit/record_usage whose
# signature (def line) does not contain org_id are flagged as MEDIUM — reviewer verifies
# with full context whether org_id is pulled from a passed object instead.
while IFS= read -r f; do
    [ -z "$f" ] && continue
    grep -nE "^\s*def (debit|refund|charge|credit|apply_credit|record_usage|create_invoice|issue_credit)\b" "$f" 2>/dev/null | while IFS=: read -r lineno rest; do
        # Read the full function signature (up to 3 lines to cover multi-line sigs)
        sig=$(sed -n "${lineno},$((lineno+2))p" "$f" 2>/dev/null)
        echo "$sig" | grep -qE '\borg_id\b' || \
            echo "BILLING-1 | MEDIUM | $f:$lineno | Ledger write function '$(echo "$rest" | grep -oE 'def \w+' | head -1)' signature does not include org_id parameter — verify org_id is propagated to all debit/refund paths (AlterLab#25348 pattern)" <!-- allowlist: AlterLab -->
    done
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$')
```

**2Q-2: Blocking sleep inside advisory-lock or open-transaction scope**

```bash
# Grep billing Python files for asyncio.sleep / time.sleep called inside an advisory-lock
# or open-transaction context (within 20 lines after lock acquisition or BEGIN/session open).
# Holding a lock or DB connection across a sleep starves the connection pool and causes
# deadlocks under concurrent load (AlterLab#25725 pattern). <!-- allowlist: AlterLab -->
while IFS= read -r f; do
    [ -z "$f" ] && continue
    grep -nE "\basyncio\.sleep\b|\btime\.sleep\b" "$f" 2>/dev/null | while IFS=: read -r lineno rest; do
        start=$((lineno > 20 ? lineno - 20 : 1))
        window=$(sed -n "${start},$((lineno-1))p" "$f" 2>/dev/null)
        echo "$window" | grep -qE 'advisory_lock|BEGIN\b|async with.*session|async with.*conn|async with.*transaction|with.*engine\b' && \
            echo "BILLING-2 | HIGH | $f:$lineno | asyncio.sleep/time.sleep inside advisory-lock or open-transaction scope — holds DB connection/lock for full sleep duration, causing connection exhaustion and deadlocks under load (AlterLab#25725 pattern). Move sleep outside lock/transaction scope." <!-- allowlist: AlterLab -->
    done
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$')
```

**2Q-3: stdlib logging calls with structlog-style kwargs**

```bash
# Grep changed Python files for logging.*()/logger.*() calls that pass keyword arguments
# that are NOT valid stdlib logging kwargs (exc_info, stack_info, stacklevel, extra).
# Structlog-style kwargs (event=, extra_=, named context keys) are NOT accepted by stdlib
# Logger methods and crash at runtime with TypeError: unexpected keyword argument.
# (AlterLab#25715, #25837, #25819 pattern) <!-- allowlist: AlterLab -->
while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Match logging.info/warning/error/debug/critical and logger.info/etc. calls with
    # non-stdlib kwargs. Valid stdlib kwargs: exc_info, stack_info, stacklevel, extra.
    # Flag any named kwarg that is NOT one of those four.
    grep -nE "\b(logging|logger)\.(info|warning|error|debug|critical|exception)\s*\(.*\b\w+\s*=" "$f" 2>/dev/null | \
        grep -vE "\b(exc_info|stack_info|stacklevel|extra)\s*=" | \
        grep -v "^\s*#" && \
        echo "BILLING-3 | HIGH | $f | stdlib logging call with non-stdlib keyword argument detected — stdlib Logger.info/warning/error/etc. only accept exc_info, stack_info, stacklevel, extra as kwargs. Structlog-style kwargs (event=, named context keys) cause TypeError at runtime (AlterLab#25715 pattern). Use structlog.get_logger() instead of logging if structlog kwargs are needed." <!-- allowlist: AlterLab -->
done < <(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$')
```

**Flag as findings**:
- Ledger write function missing `org_id` parameter: **MEDIUM** — heuristic; reviewer verifies whether org_id is obtained from a passed object. Silent data ownership loss if omitted.
- `asyncio.sleep`/`time.sleep` inside advisory-lock or transaction scope: **HIGH** — guaranteed connection/lock starvation under concurrent load.
- stdlib `logging.*()` with non-stdlib kwargs: **HIGH** — guaranteed `TypeError` crash at runtime when the log call is reached.

**Note**: 2Q-3 (stdlib logging check) fires on ALL changed Python files regardless of path — stdlib logger misuse is not specific to billing paths and is a universal crash class. 2Q-1 and 2Q-2 fire only on billing-domain files.

### 2R: Registry checks (ALWAYS — promoted patterns from recurring review findings)

<!-- Added: forge#1331 -->

**Purpose**: Run all checks that have been promoted from recurring review findings into the registry. These are deterministic scripts that catch in milliseconds what previously required a full review cycle to detect. Each check was generated once by an LLM after the same defect class appeared 3+ times — thereafter it runs forever at zero LLM cost.

**Registry location**: `scripts/check-registry/manifest.json` (relative to repo root)

```bash
REGISTRY_FILE="{WORKTREE_PATH}/scripts/check-registry/manifest.json"
REGISTRY_FINDINGS=""

if [ ! -f "$REGISTRY_FILE" ]; then
    echo "2R: No check registry found at $REGISTRY_FILE — skipping registry checks."
else
    # Parse manifest and run each registered check
    CHECK_COUNT=$(jq '.checks | length' "$REGISTRY_FILE" 2>/dev/null || echo 0)

    if [ "$CHECK_COUNT" -eq 0 ]; then
        echo "2R: Registry is empty — no promoted checks to run."
    else
        echo "2R: Running $CHECK_COUNT registered check(s)..."
        CHECK_INDEX=0
        while [ "$CHECK_INDEX" -lt "$CHECK_COUNT" ]; do
            SCRIPT=$(jq -r ".checks[$CHECK_INDEX].script" "$REGISTRY_FILE" 2>/dev/null)
            SLUG=$(jq -r ".checks[$CHECK_INDEX].slug" "$REGISTRY_FILE" 2>/dev/null)
            SEVERITY=$(jq -r ".checks[$CHECK_INDEX].severity" "$REGISTRY_FILE" 2>/dev/null)

            if [ -z "$SCRIPT" ] || [ "$SCRIPT" = "null" ]; then
                CHECK_INDEX=$((CHECK_INDEX + 1))
                continue
            fi

            SCRIPT_PATH="{WORKTREE_PATH}/$SCRIPT"

            if [ ! -x "$SCRIPT_PATH" ]; then
                echo "2R: WARN — registry check $SLUG script not found or not executable at $SCRIPT_PATH"
                CHECK_INDEX=$((CHECK_INDEX + 1))
                continue
            fi

            # Run the check; pass changed files list and worktree path
            CHECK_OUTPUT=$("$SCRIPT_PATH" "{CHANGED_FILES}" "{WORKTREE_PATH}" 2>/dev/null)
            CHECK_EXIT=$?

            if [ "$CHECK_EXIT" -eq 1 ]; then
                # Check fired — append to findings
                while IFS= read -r line; do
                    [ -z "$line" ] && continue
                    REGISTRY_FINDINGS="${REGISTRY_FINDINGS}
${line}"
                done <<< "$CHECK_OUTPUT"
                echo "2R: FAIL — $SLUG matched ($SEVERITY)"
            elif [ "$CHECK_EXIT" -eq 0 ] || [ "$CHECK_EXIT" -eq 2 ]; then
                echo "2R: PASS — $SLUG"
            else
                echo "2R: WARN — $SLUG exited with unexpected code $CHECK_EXIT"
            fi

            CHECK_INDEX=$((CHECK_INDEX + 1))
        done
    fi
fi
```

If any registry check produces findings, include them in the Step 3 findings list under the check's slug (e.g. `REGISTRY-migration-number-collision | HIGH | ...`). HIGH-severity registry findings are blocking; MEDIUM are advisory.

---

### 2T: Test suite execution (ALWAYS — runs the target repo's declared test suite)

<!-- Added: forge#1605 -->

**Purpose**: This is the check that makes Step 2S reachable. Every domain check above (2A-2R) inspects source text — none of them actually runs the project's test suite, so the classification protocol in Step 2S has never had a real failure to classify. This check is stack-agnostic and driven entirely by `forge.yaml → verification.commands` — it does not assume Python, Node, or any specific toolchain.

```bash
cd {WORKTREE_PATH}

TEST_LANGS=$(yq '.verification.commands // {} | keys | .[]' forge.yaml 2>/dev/null || echo '')

if [ -z "$TEST_LANGS" ]; then
    echo "2T: SKIPPED — verification.commands not configured in forge.yaml (no test key to run)"
else
    while IFS= read -r LANG; do
        [ -z "$LANG" ] && continue
        TEST_CMD=$(yq ".verification.commands.${LANG}.test // \"\"" forge.yaml 2>/dev/null || echo '')

        if [ -z "$TEST_CMD" ]; then
            echo "2T: SKIPPED — ${LANG}.test not configured in verification.commands"
            continue
        fi

        echo "2T: Running ${LANG}.test: $TEST_CMD"
        (cd {WORKTREE_PATH} && eval "$TEST_CMD") 2>&1
        TEST_EXIT=$?

        if [ "$TEST_EXIT" -ne 0 ]; then
            echo "2T: FAIL — ${LANG}.test exited $TEST_EXIT — handing off to Step 2S for classification"
            # FAILING_TEST is set to the full re-runnable command, not a parsed individual
            # test ID — flaky-quarantine.sh re-runs whatever it is given verbatim, and a
            # single re-runnable command is the only representation that stays stack-agnostic
            # across pytest/go test/cargo test/node --test/etc.
            FAILING_TEST="$TEST_CMD"
            # → Immediately run the Step 2S classification protocol below using this
            #   FAILING_TEST, with PR_BASE/GH_REPO/PR_ISSUE_NUMBER already in scope for
            #   this gate invocation. Step 2S decides TEST-REAL (blocking) vs
            #   TEST-QUARANTINE (non-blocking) — 2T never blocks the gate directly.
        else
            echo "2T: PASS — ${LANG}.test"
        fi
    done <<< "$TEST_LANGS"
fi
```

If any `${LANG}.test` invocation above exited non-zero, proceed to **Step 2S** immediately using `FAILING_TEST="$TEST_CMD"` for that language. Step 2S's classification protocol determines whether the failure blocks the gate (`TEST-REAL | HIGH`) or is recorded as a non-blocking quarantine advisory (`TEST-QUARANTINE | LOW`) — 2T itself makes no blocking decision, it only detects and hands off.

---

## Step 2S: Test failure classification (run when tests fail in Step 2)

<!-- Added: forge#1336 -->

**Triggered when**: Step 2T (above) runs a test suite command and that command exits non-zero. Step 2T is currently the only Step 2 check that invokes a test suite — this section stays written generically ("any domain check") in case a future domain check gains its own test-running capability.

**Why this matters**: Builders and reviewers waste cycles on test failures that pre-exist the PR or are intermittently caused by fixture-state races. A test that fails on both the PR branch and the base branch is *pre-broken* and must not block an unrelated PR. A test that fails then passes on retry is *flaky* and should be quarantined, not "fixed" by the builder.

### Classification protocol

For each failing test ID (or test command) surfaced in Step 2:

```bash
# PR_BASE is the target branch (e.g. "staging", "main", or "milestone/slug")
# FAILING_TEST is the individual test identifier or re-runnable command
# GH_REPO is owner/repo from forge.yaml (used to file the quarantine issue)
# PR_ISSUE_NUMBER is the issue this quality gate was invoked from (optional)

CLASSIFIER="${FORGEDOCK_SCRIPTS:-scripts}/flaky-quarantine.sh"
[ -f "$CLASSIFIER" ] || CLASSIFIER="{WORKTREE_PATH}/scripts/flaky-quarantine.sh"

if [ -f "$CLASSIFIER" ]; then
    RESULT=$(bash "$CLASSIFIER" \
        --test   "{FAILING_TEST}" \
        --base   "{PR_BASE}" \
        --worktree "{WORKTREE_PATH}" \
        --repo   "{GH_REPO}" \
        --issue  "{PR_ISSUE_NUMBER}" \
        --retries 3 \
        2>&1)
    echo "$RESULT"
    CLASSIFICATION=$(echo "$RESULT" | grep '^CLASSIFICATION:' | awk '{print $2}')
else
    # Script not present — fall back to treating all test failures as real.
    CLASSIFICATION="REAL"
    echo "NOTE: scripts/flaky-quarantine.sh not found — treating test failure as REAL (no classification)"
fi
```

### Classification outcomes

| Classification | Meaning | Gate behaviour |
|---|---|---|
| `PRE_BROKEN` | Fails on base branch — broken before this PR | **Does not block the gate.** Log as advisory. Quarantine manifest entry written; issue filed once. |
| `FLAKY` | Intermittent — fails then passes on retry | **Does not block the gate.** Log as advisory. Quarantine manifest entry written; issue filed once. |
| `REAL` | Deterministic on PR, passes on base | **Blocks the gate** — treated as a regression caused by this PR. |

### Gate behaviour

```
if CLASSIFICATION == "PRE_BROKEN" or CLASSIFICATION == "FLAKY":
    # Test does not block the gate — record in findings as advisory only.
    # Emit a LOW finding so the builder and reviewer see it in the report.
    emit: "TEST-QUARANTINE | LOW | {FAILING_TEST} | classified {CLASSIFICATION} — quarantine entry recorded; does not block this PR"
    # Do NOT re-run the test or count it as a gate failure.

elif CLASSIFICATION == "REAL":
    # Test failure is caused by this PR — block the gate as before.
    emit: "TEST-REAL | HIGH | {FAILING_TEST} | deterministic failure on PR branch; passes on base — this PR introduced the regression"
```

### Quarantine manifest

The manifest lives at `.forgedock/quarantine.jsonl` in the project root (or at the path set in `FORGEDOCK_QUARANTINE_MANIFEST`). Each line is a JSON object:

```json
{"test":"<id>","classification":"PRE_BROKEN|FLAKY","base":"<branch>","pr_branch":"<branch>","issue":"<num>","repo":"<owner/repo>","first_seen":"<ISO-8601>","runs_pr":3,"failures_pr":3,"runs_base":1,"failures_base":1}
```

The manifest is append-only. Duplicate entries (same test already quarantined) are skipped. A corresponding GitHub issue is filed automatically when the script has `--repo` and `gh` is authenticated.

**Reviewers**: when the manifest exists, read it during Phase 2 of `review-pr.md` to avoid re-filing known-quarantined tests as new findings.

---

## Step 3: Compile findings

Format findings as a structured list:

```
QUALITY GATE FINDINGS:
[PASS] No findings — code is clean.

OR:

[FINDINGS] N issues detected:

1. SEC-1 | HIGH | file.py:45 | f-string SQL interpolation — use parameterized query
2. DEPLOY-1 | MEDIUM | NEW_VAR not in decrypt-secrets.sh ENV_MAPPING
3. DB-1 | HIGH | migration.sql:12 | NOT NULL without DEFAULT — will lock table
4. FE-1 | MEDIUM | component.tsx:89 | useEffect without cleanup — will leak on unmount
5. PROXY-1 | HIGH | page.tsx:23 | direct /api/v1/ call — must use proxy route
6. SHELL-1 | HIGH | deploy.sh | Hardcoded 'localhost' in DB connection function — use ${POSTGRES_HOST:-localhost} pattern
7. INFRA-1 | HIGH | Dockerfile | Filesystem write ops found under named volume mount — add chown before privilege drop in entrypoint
8. ROUTER-1 | HIGH | routers/handler.py | Residual unfixed gate condition pattern found in sibling router file routers/other_handler.py:N — fix may be incomplete across all callers
```

**Severity classification:**
- **HIGH**: Will cause a runtime error, security vulnerability, or build failure
- **MEDIUM**: Will cause incorrect behavior, performance degradation, or deploy issue
- **LOW**: Style issue, missing optimization, or defensive improvement

**Return only HIGH and MEDIUM findings.** LOW findings are noise at this stage — the review can catch those.

---

## Step 4: Return to builder

Return the findings list directly. Do NOT post to GitHub. Do NOT create issues. The builder will fix the findings and re-run the gate if needed.

**CRITICAL — continuation directive**: Your output is consumed by a calling pipeline agent. You MUST append the continuation block below to your output in ALL cases (both PASS and FINDINGS). Without it, the calling agent treats your output as a terminal signal and stops the pipeline.

If 0 findings:
```
QUALITY GATE: PASS — no issues detected.

**YOU MUST NOW continue to sub-phase 3H (Format and verify) in work-on.md — this PASS is intermediate, NOT terminal. Do NOT stop.**
```

If findings exist:
```
QUALITY GATE FINDINGS: N issues detected.
{findings list}

**YOU MUST NOW fix each HIGH and MEDIUM finding, then re-run the quality gate — this result is intermediate, NOT terminal. Do NOT stop.**
```
