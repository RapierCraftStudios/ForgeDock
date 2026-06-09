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

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.

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
| `*.sql` or files in `migrations/` | DATABASE |
| `*.tsx`, `*.ts` in `web/src/` (excluding `route.ts`) | FRONTEND |
| `*.tsx`, `*.ts` client components with fetch/useSWR | PROXY |
| `*.sh` files or scripts with `curl`/`wget` | SHELL |
| `*.py` in `anti_detection/`, `consumers/`, `browser/`, or `shared/detection/` | STRING_SETS |
| `*.py` containing `asyncio.shield`, `asyncio.wait_for`, or `Task.cancel` | CONCURRENCY |
| `*.py` files with new module-level `dict`, `set`, `Counter`, `Lock`, or `defaultdict` assignments | STATE |
| `*.py` in `services/worker/`, `infra/`, or `browser/` with new assignments to variables containing `MB`, `SIZE`, `MAX`, `LIMIT`, `THRESHOLD`, or `TIMEOUT` | CAPACITY |
| `*.yml` in `.github/workflows/` | WORKFLOW |
| `*.py` with new `from app.` import statements added outside `try:` blocks | IMPORT_RESOLUTION |
| `Dockerfile*` or `entrypoint*.sh` with added/changed `USER`, `su-exec`, `gosu`, or `setuid` | INFRA |
| `*.py` in `routers/` where the diff removes a line containing an or-gate condition (lines starting with `-` containing `if.*or`) | ROUTER_BUG |

**Apply the classification:**

```bash
# Initialize domain flags
DOMAINS=""

for f in {CHANGED_FILES}; do
    case "$f" in
        *.sql|*migrations/*) DOMAINS="$DOMAINS DATABASE" ;;
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
            echo "$f" | grep -qE '\.py$' && DOMAINS="$DOMAINS STRING_SETS"
            ;;
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
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'services/worker/|infra/|browser/'); do
    git diff HEAD -- "$f" 2>/dev/null | grep -qE '^\+[A-Za-z_]\w*(MB|SIZE|MAX|LIMIT|THRESHOLD|TIMEOUT)\w*\s*=' && DOMAINS="$DOMAINS CAPACITY" && break
done

# Check for env var usage in changed files
grep -lE "os\.getenv|process\.env" {CHANGED_FILES} 2>/dev/null && DOMAINS="$DOMAINS DEPLOY"

# Check for new app.* imports added outside try: blocks in Python files
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$'); do
    NEW_IMPORTS=$(git diff HEAD -- "$f" 2>/dev/null | grep -E '^\+\s*(from app\.|import app\.)' | grep -v '^+++')
    if [ -n "$NEW_IMPORTS" ]; then
        DOMAINS="$DOMAINS IMPORT_RESOLUTION"
        break
    fi
done

# Check for runtime UID changes in Dockerfiles or entrypoint scripts
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -iE 'Dockerfile|entrypoint.*\.sh'); do
    git diff HEAD -- "$f" 2>/dev/null | grep -E '^\+.*(USER\s+[^0]|su-exec|gosu|setuid)' | grep -v '^+++' | grep -q . && DOMAINS="$DOMAINS INFRA" && break
done

# Check for gate condition narrowing in router Python files (condition removal = fix may be incomplete across siblings)
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'router'); do
    git diff HEAD -- "$f" 2>/dev/null | grep -E '^-.*\bif\b.*\bor\b' | grep -v '^---' | grep -q . && DOMAINS="$DOMAINS ROUTER_BUG" && break
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
- **2G (Cross-service integration)**: Run if `SHELL` in DOMAINS
- **2H (Asyncio cancellation)**: Run if `CONCURRENCY` in DOMAINS
- **2I (State completeness)**: Run if `STATE` in DOMAINS
- **2J (String literal consistency)**: Run if `STRING_SETS` in DOMAINS
- **2K (Capacity constant validation)**: Run if `CAPACITY` in DOMAINS
- **2L (GitHub Actions template safety)**: Run if `WORKFLOW` in DOMAINS
- **2M (Import resolution)**: Run if `IMPORT_RESOLUTION` in DOMAINS
- **2N (Runtime UID × filesystem write)**: Run if `INFRA` in DOMAINS
- **2O (Residual pattern check)**: Run if `ROUTER_BUG` in DOMAINS

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
for f in {CHANGED_FILES}; do
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
1. Which auth dependency is used — `SessionUser` or `CurrentUser`?
2. Does the route path match? Dashboard routes (`/api/dashboard/*`) must use `SessionUser`. Public API routes (`/api/v1/*`) must use `CurrentUser`.
3. Does the endpoint check resource ownership (`user_id`) before returning data?

```bash
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E 'router|route'); do
    grep -nE "CurrentUser|SessionUser|Depends\(get_" "$f" 2>/dev/null
    grep -nE "@router\.(get|post|put|delete)" "$f" 2>/dev/null
done
```

### 2C: Deploy chain (when new env vars are introduced)

```bash
NEW_ENVS=$(grep -rnE "os\.getenv\(|process\.env\." {CHANGED_FILES} 2>/dev/null | grep -oP "(os\.getenv\(['\"]|process\.env\.)(\w+)" | sed 's/os.getenv(["'"'"']//;s/process.env.//' | sort -u)
if [ -n "$NEW_ENVS" ]; then
    for var in $NEW_ENVS; do
        # Check if it exists in .env.example
        grep -q "$var" .env.example 2>/dev/null || echo "DEPLOY: $var not in .env.example"
        # Check if it's in decrypt-secrets.sh ENV_MAPPING
        grep -q "$var" scripts/decrypt-secrets.sh 2>/dev/null || echo "DEPLOY: $var not in decrypt-secrets.sh ENV_MAPPING"
    done
fi
```

### 2D: Database quality (SQL migration files)

For each `.sql` file:
1. **NOT NULL without DEFAULT**: `ALTER TABLE ... ADD COLUMN ... NOT NULL` without `DEFAULT` locks table and fails on existing rows
2. **DROP without IF EXISTS**: Fails on fresh databases
3. **Missing indexes**: New columns used in WHERE/JOIN without indexes
4. **Unbounded queries**: SELECT without LIMIT or time-bound WHERE clause
5. **Migration number collision**: Check against origin branch

```bash
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep '\.sql$'); do
    grep -nE "ADD COLUMN.*NOT NULL" "$f" | grep -v "DEFAULT" && echo "DB: NOT NULL without DEFAULT in $f"
    grep -nE "DROP (TABLE|COLUMN|INDEX)" "$f" | grep -v "IF EXISTS" && echo "DB: DROP without IF EXISTS in $f"
    grep -nE "SELECT.*FROM" "$f" | grep -v "LIMIT" | grep -v "WHERE.*created_at" && echo "DB: possibly unbounded query in $f"
done

# Migration prefix collision scan (Deploy Gate — HIGH)
# Runs whenever any SQL file changed. Scans the full infra/migrations/ tree for duplicate
# numeric prefixes not in GRANDFATHERED_DUPLICATES. Duplicates not in the allowlist WILL
# hard-fail deploy-production.yml's validate-migration-order.sh gate.
MIGRATIONS_DIR="{WORKTREE_PATH}/infra/migrations"
if [ -d "$MIGRATIONS_DIR" ]; then
    # Extract grandfathered prefixes from validate-migration-order.sh if it exists
    GRANDFATHER_SCRIPT="{WORKTREE_PATH}/scripts/validate-migration-order.sh"
    GRANDFATHERED=""
    if [ -f "$GRANDFATHER_SCRIPT" ]; then
        GRANDFATHERED=$(grep -oE '[0-9]{4}' "$GRANDFATHER_SCRIPT" | sort -u | tr '\n' ' ')
    fi
    # Find duplicate numeric prefixes across all migration files
    DUPLICATE_PREFIXES=$(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null \
        | sed 's|.*/\([0-9]*\)_.*|\1|' \
        | sort | uniq -d)
    for prefix in $DUPLICATE_PREFIXES; do
        if echo "$GRANDFATHERED" | grep -qw "$prefix"; then
            echo "DB: migration prefix $prefix is duplicated but grandfathered (INFO)"
        else
            echo "DB-COLLISION | HIGH | infra/migrations/ | Duplicate migration prefix $prefix is NOT grandfathered — will hard-fail deploy-production.yml validate-migration-order.sh gate. Classify as CRITICAL BLOCKER."
        fi
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
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.tsx?$' | grep -v 'route\.ts'); do
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
done
```

### 2F: Frontend proxy wiring (client-side fetch calls)

```bash
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.(tsx?|jsx?)$' | grep -v 'route\.ts$'); do
    grep -nE '(fetch|useSWR|apiFetch)\s*[(<]\s*[`"'"'"']/api/v1/' "$f" 2>/dev/null && echo "PROXY: direct /api/v1/ call in $f — must use /api/ proxy"
done
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
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.sh$'); do
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
done
```

Report any hit as **HIGH** — the DB connection will fail in any environment where PostgreSQL is not on `127.0.0.1:5432`.

### 2H: Asyncio cancellation safety (Python async code)

**Triggered when**: changed Python files contain `asyncio.shield`, `asyncio.wait_for`, or `Task.cancel`.

**Why this matters**: `asyncio.shield()` is one of the most misused async primitives — it fails silently when `CancelledError` is already pending on the outer task. `asyncio.wait_for` with `finally` blocks can deadlock if the finally body awaits a cancellable operation. These bugs are hard to reproduce and often only surface under load or connection teardown.

**Severity**: MEDIUM (flags for review, not auto-blocking). The review agent's concurrency auditor verifies with full context.

```bash
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$'); do
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
done
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
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$'); do
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
done
```

**Severity**: MEDIUM — missing a mutation site is usually a latent bug, not an immediate crash, but it causes incorrect behavior under concurrent load.

---

### 2J: String literal consistency (anti-detection/scraping code)

**Triggered when**: changed files include Python files in `anti_detection/`, `consumers/`, `browser/`, or `shared/detection/` directories.

**Why this matters**: Detection keyword sets (e.g., `CHALLENGE_KEYWORDS`, `COMMON_COOKIES`) across related modules share a domain truth — if Akamai adds a new cookie marker, it must appear in ALL related sets. A typo or omission in one set silently breaks detection for that service path. This check catches both inter-file inconsistencies and intra-file comment/code drift.

For each changed file in the anti-detection/scraping domains:

**1. Identify modified string identifier sets** (frozensets, tuples, or lists of string literals used for detection):

```bash
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'anti_detection/|consumers/|browser/|shared/detection/'); do
    echo "=== String sets in $f ==="
    # Find named constants that are frozenset/tuple/list of strings
    grep -nE "^[A-Z_]+ = (frozenset|tuple|set)\(\[?['\"]|^[A-Z_]+ = \(['\"]|^[A-Z_]+ = \[['\"]" "$f" 2>/dev/null
done
```

**2. For each string in a modified set, check if it appears in sibling detection files:**

```bash
SERVICE_DIR=$(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E 'anti_detection/|consumers/|browser/' | head -1 | grep -oE '^services/[^/]+/[^/]+' || echo "services/worker/worker")

for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'anti_detection/|consumers/|browser/|shared/detection/'); do
    # Extract string values from detection sets in this file
    STRINGS=$(grep -oE "'[a-z_][a-z0-9_-]*'" "$f" 2>/dev/null | tr -d "'" | sort -u)
    for s in $STRINGS; do
        # Check if this string appears in at least one other file in the service
        FOUND=$(grep -rl "\"$s\"\|'$s'" $SERVICE_DIR/ 2>/dev/null | grep -v "^$f$" | grep '\.py$' | head -1)
        [ -z "$FOUND" ] && echo "STR: '$s' in $f appears NOWHERE else in $SERVICE_DIR — possible typo or dead entry"
    done
done
```

**3. Check for identifiers mentioned in comments/docstrings of the SAME file that are NOT in the actual set** (catches the `abck` vs `_abck` class of bug):

```bash
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'anti_detection/|consumers/|browser/|shared/detection/'); do
    echo "=== Comment/code drift in $f ==="
    # Extract string literals from actual sets (remove quotes)
    SET_STRINGS=$(grep -oE "frozenset\(\[([^]]+)\]\)" "$f" 2>/dev/null | grep -oE "'[^']+'" | tr -d "'" | sort -u)
    SET_STRINGS="$SET_STRINGS $(grep -oE "\(([^)]*'[^']*'[^)]*)\)" "$f" 2>/dev/null | grep -oE "'[a-z_][a-z0-9_-]*'" | tr -d "'" | sort -u)"

    # Find identifiers mentioned in comments (after # or in docstrings)
    COMMENT_REFS=$(grep -oE "#.*\`[a-z_][a-z0-9_-]+\`|\"\"\".*[a-z_][a-z0-9_-]+.*\"\"\"" "$f" 2>/dev/null | grep -oE "\`[a-z_][a-z0-9_-]+\`|_[a-z][a-z0-9_]+" | tr -d '`' | sort -u)

    for ref in $COMMENT_REFS; do
        echo "$SET_STRINGS" | grep -q "^${ref}$" || echo "STR: '$ref' mentioned in comment in $f but NOT found in any string set — possible omission or typo"
    done
done
```

**4. Cross-reference sibling sets in related modules** (the primary inter-file check):

```bash
# Find all detection-related Python files in the same service
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'anti_detection/|consumers/|browser/'); do
    SIBLINGS=$(find $(dirname "$f")/../ -name "*.py" -path "*/anti_detection/*" -o -name "*.py" -path "*/consumers/*" -o -name "*.py" -path "*/browser/*" 2>/dev/null | grep -v "^$f$" | head -10)

    # Extract detection set names from the changed file
    SET_NAMES=$(grep -oE "^[A-Z_]+ = (frozenset|tuple|set)" "$f" 2>/dev/null | grep -oE "^[A-Z_]+")

    for sib in $SIBLINGS; do
        # Extract strings from sibling detection sets
        SIB_STRINGS=$(grep -oE "'[a-z_][a-z0-9_-]*'" "$sib" 2>/dev/null | tr -d "'" | sort -u)

        # Find strings in the changed file's sets that don't appear in the sibling
        for s in $(grep -oE "'[a-z_][a-z0-9_-]*'" "$f" 2>/dev/null | tr -d "'" | sort -u); do
            # Skip very short strings (likely not identifiers)
            [ ${#s} -lt 4 ] && continue
            echo "$SIB_STRINGS" | grep -q "^${s}$" || \
                echo "STR: '$s' in $f not found in sibling file $sib — verify if cross-module consistency is required"
        done
    done
done
```

**Flag as findings**:
- Strings appearing nowhere else in the service: possible typo or dead entry (MEDIUM)
- Strings in comments not present in actual set: possible omission or typo (HIGH — same-file drift is almost always a bug)
- Strings in one detection set missing from a known sibling set (same service, related domain): possible inter-module inconsistency (MEDIUM)

---

### 2K: Capacity constant validation (worker/infra code)

**Triggered when**: changed Python files in `services/worker/`, `infra/`, or `browser/` introduce new assignments to variables whose names contain `MB`, `SIZE`, `MAX`, `LIMIT`, `THRESHOLD`, or `TIMEOUT`.

**Why this matters**: Hardcoded capacity constants (e.g., `_BROWSER_ESTIMATED_MB = 200`) are design-time guesses that drift from production reality. When used in guard conditions (e.g., "5 × 200 MB = 1000 MB peak"), a wrong constant directly limits system throughput and may never be caught until a slot fails to spawn. A constant is correctly-typed and correctly-used but factually wrong — logic checks pass, the bug ships.

For each new or modified capacity constant in the diff:

```bash
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'services/worker/|infra/|browser/'); do
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
done
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
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.github/workflows/.*\.yml$'); do
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
done
```

Report any hit as **CONFIRMED HIGH** — the step will exit 1 before reaching the remote shell.

Go template directives in `appleboy/ssh-action` `script:` blocks are preprocessed client-side before the script reaches SSH — they fail on an empty data context, crashing the action before any shell error handler can catch it. Both function call forms (`{{index .X Y}}`) and field accessors (`{{.Names}}`) fail. A partial fix that only replaces one form while leaving the other is insufficient. <!-- Added: forge#226 -->

### 2M: Import resolution (Python files with new app.* imports)

**Triggered when**: changed Python files introduce new `from app.` or `import app.` statements outside `try:` blocks.

**Why this matters**: A builder agent with access to milestone branch context can import `app.billing.subscriptions` in a fast-lane PR that targets `staging` — where that module does not exist. Every request crashes with `ModuleNotFoundError`. The module exists on disk in the builder's worktree (checked out from the milestone branch) but NOT in `git ls-files` for the base branch. `python -m py_compile` passes because the builder's environment has the module; the runtime environment does not.

```bash
PR_BASE="${PR_BASE:-staging}"

for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$'); do
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
done
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
for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -iE 'Dockerfile|entrypoint.*\.sh'); do
    SERVICE_DIR=$(dirname "$f")
    break
done

if [ -n "$SERVICE_DIR" ]; then
    # Step 2: Find volume mount points for this service in any docker-compose*.yml
    COMPOSE_FILES=$(find . -maxdepth 3 -name "docker-compose*.yml" 2>/dev/null | sort)
    VOLUME_MOUNTS=""
    for cf in $COMPOSE_FILES; do
        # Extract named volume mount points (lines like: - volume_name:/container/path)
        MOUNTS=$(grep -oE '[a-z_-]+:/[^: ]+' "$cf" 2>/dev/null | grep -v '^#' | cut -d: -f2)
        VOLUME_MOUNTS="$VOLUME_MOUNTS $MOUNTS"
    done

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

for f in $(echo {CHANGED_FILES} | tr ' ' '\n' | grep -E '\.py$' | grep -E 'router'); do
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
done
```

**Flag as findings**:
- Original condition pattern found in sibling router files after the fix was applied: **HIGH** — the fix is incomplete; the same bug class exists in unlisted sibling files and will continue to produce the original error for users of those endpoints. <!-- Added: forge#383 -->

**False-positive prevention**:
- Only runs on files in a `routers/` path
- Only triggers when a condition line was actually removed in the diff (not just modified)
- Reports file:line matches from sibling files only (excludes the fixed file itself)

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

<!-- FORGE:PHASE_COMPLETE — Quality gate is an intermediate check. See work-on.md Universal Phase Dispatcher for next phase. Not terminal — calling agent must continue. -->
```

If findings exist:
```
QUALITY GATE FINDINGS: N issues detected.
{findings list}

<!-- FORGE:PHASE_COMPLETE — Quality gate is an intermediate check. See work-on.md Universal Phase Dispatcher for next phase. Not terminal — calling agent must continue. -->
```
