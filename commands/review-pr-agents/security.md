---
install: internal
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Agent: General Security & Quality Scan (ALWAYS RUNS)

> Read `review-pr-agents/protocols.md` for the Evidence-Based Review Protocol, Structured Findings Protocol, Per-Agent Input Scoping rules, and Tool-Result Truncation Discipline that all agents must follow.



**Type**: `security-exploit-auditor` | **Model**: `{SUBAGENT_MODEL}`

**Prompt template:**
```
You are performing a security and code quality scan on PR #[PR_NUMBER] for [PROJECT_NAME].

## Context
- PR title: [TITLE]
- Services touched: [SERVICES]
- Files changed: [FILE_LIST]
[PROJECT_CONTEXT]

## Your Mission
Scan ALL changed code for security vulnerabilities and code quality issues. This is the baseline review that runs on every PR.

## Step 1: Read the Diff

The security agent receives the full PR diff (security vulnerabilities are cross-cutting — no file-path scoping is applied). The diff is pre-supplied as `[DOMAIN_DIFF_SLICE]` and is capped at ~100K chars. Do NOT re-fetch the full diff — use what was provided.

```bash
gh pr diff [PR_NUMBER] --name-only
# Use the pre-supplied diff: [DOMAIN_DIFF_SLICE]
```

## Step 2: Security Scan
For each changed file, check:
1. **Injection**: SQL, command, template injection via user input. **Specifically**: f-string interpolation in SQL queries is CONFIRMED HIGH — this is the #1 security finding across all reviews. Check every SQL string for `f"..."` or `.format()`.
2. **SSRF**: User-controlled URLs hitting internal services. Check webhook handlers, URL preview features, any endpoint that fetches a user-provided URL.
3. **Path traversal**: User input in file paths. Check proxy allowlists — overly broad patterns (e.g., allowing `/v1/` prefix instead of exact paths) enable traversal.
4. **Unsafe deserialization**: pickle, yaml.load without safe_load
5. **Hardcoded secrets**: API keys, passwords, tokens in code
6. **XSS**: User input rendered without sanitization (frontend)
7. **Token privilege confusion**: Is the correct token used for the operation? Recording/read tokens should NOT be used for write/admin operations. Check every `verify_token` call — should it be `verify_admin_token`?
8. **Unbounded resource consumption**: Endpoints that accept user input controlling query scope (date ranges, pagination) without limits. An attacker can trigger expensive queries or LLM calls without cost controls.
9. **Information disclosure via API responses** (conditional — when FastAPI router, model, or main.py files are in the diff): Does the API reveal more than necessary in error responses, health endpoints, and response headers?

   First, identify which trigger conditions apply:
   ```bash
   MODEL_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "\.py$" | xargs grep -lE "class [A-Za-z]+\(BaseModel\)|from pydantic import|@router\.(get|post|put|patch|delete)\(" 2>/dev/null)
   HEALTH_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "(health|router).*\.py$")
   MIDDLEWARE_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "(main|middleware|app)\.py$")
   ```

   **Sub-check 9a: Pydantic validation error handler** (trigger: `$MODEL_FILES` non-empty)

   FastAPI's default validation error response exposes internal field names, types, and constraints. Attackers can enumerate the complete request schema by sending malformed payloads.
   ```bash
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       grep -rn "RequestValidationError\|validation_exception_handler\|@app.exception_handler" $(git ls-files | grep -E "(main|app)\.(py|ts|js)$" | head -5) 2>/dev/null | head -5
   done <<< "$MODEL_FILES"
   # If no custom handler found AND the PR adds new Pydantic models or FastAPI endpoints:
   #   LIKELY MEDIUM — FastAPI default exposes internal field names/types/constraints to any caller
   #   Safe pattern: catch RequestValidationError and return only {"detail": "Invalid request"} or a sanitized message
   ```
   **Confidence**: `LIKELY` — a custom handler may exist in a file not in the diff.
   **Severity**: MEDIUM — schema enumeration accelerates fuzzing and targeted injection attempts; not a direct exploit.
   **Evidence**: FastAPI's default validation error response includes the full Pydantic schema field tree, exposing internal field names and model structure to clients. A new endpoint added without a custom exception handler inherits this default, leaking schema details to error-triggering callers.

   **Sub-check 9b: Public health endpoint data exposure** (trigger: `$HEALTH_FILES` non-empty)

   Unauthenticated health endpoints are expected to be public — the Auth agent's auth-dependency check does not apply. The relevant question is whether they reveal more than `{"status": "ok"}`.
   ```bash
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       # Find unauthenticated endpoints (no Depends() in signature) and check return content
       grep -A25 "@router\.\(get\|head\)\|async def health\|async def ping\|async def live\|async def ready\|async def status" "$f" | \
           grep -iE "version|host|port|redis|postgres|db_url|tesseract|pillow|PIL\.__version__|software|engine|server" && \
           echo "SEC: health endpoint in $f returns operational details. Reveals software versions (enables CVE targeting) or connectivity state (enables DoS confirmation). Safe pattern: return only {\"status\": \"ok\"} or {\"status\": \"degraded\"} — no version strings, no host/port, no connectivity details."
   done <<< "$HEALTH_FILES"
   ```
   **Confidence**: `LIKELY` — version strings may be intentionally scoped to internal-only endpoints; verify auth status of the endpoint.
   **Severity**: MEDIUM for software version strings (direct CVE targeting input); LOW for DB/Redis connectivity state (useful for DoS confirmation, not exploit).
   **Evidence**: Health endpoints are often added alongside new services or integrations and return detailed status data by default. Without an explicit check, reviewers tend to verify that the endpoint works — not that it reveals too much. Software version strings in health responses enable CVE targeting; connectivity state enables DoS confirmation.

   **Sub-check 9c: Response header disclosure** (trigger: `$MIDDLEWARE_FILES` non-empty)

   Git SHAs and deployment topology exposed via response headers enable targeted CVE research and attack planning.
   ```bash
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       grep -nE "X-App-Version|X-Deployment-Color|X-.*-SHA|X-.*-Build|X-.*-Commit|Server:|X-Powered-By" "$f" 2>/dev/null && \
           echo "SEC: response header in $f leaks infrastructure details. Git SHA enables targeted CVE diffing against public commits. Deployment color reveals blue/green topology. Safe pattern: omit these headers or gate them behind an internal-only middleware."
   done <<< "$MIDDLEWARE_FILES"
   ```
   **Confidence**: `LIKELY` — header may be intentional for internal observability tooling behind an auth gate; verify it applies to all responses.
   **Severity**: LOW — information disclosure accelerates other attacks but is not directly exploitable without an additional vulnerability.
   **Evidence**: Response headers are often added in middleware for observability tooling (blue/green routing, version tracking) and inadvertently included in all public responses. This check targets middleware/main.py changes specifically, where headers are most commonly added globally.

   *Note: Step 2.5 Check C also covers response headers in an infra-posture context (trigger: Python files with existing `response.headers[` or `add_header(` patterns). Sub-check 9c complements it with a broader trigger scoped to middleware/main.py diffs.*

## Step 2.5: Infrastructure Security Posture (conditional — when infra files are in the diff)

These checks ONLY run when the corresponding file type appears in the PR diff. They cover structural security properties that don't change per-PR but must be verified whenever the surrounding config is modified.

**Run each block only if the file type is present:**

```bash
INFRA_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "docker-compose.*\.yml$")
DOCKERFILE_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -iE "Dockerfile")
WORKFLOW_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "^\.github/workflows/.*\.yml$")
HEADER_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "\.py$" | xargs grep -lE "response\.headers\[|add_header\(" 2>/dev/null)
TS_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "\.(ts|tsx)$")
CONFIG_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "(traefik/|infra/nginx/|infra/|\.github/workflows/).*(\.ya?ml|\.toml|\.json|\.conf|\.ini)$")
```

**A. Port bind address audit** (when `docker-compose*.yml` is in diff — trigger: `$INFRA_FILES` non-empty)
```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Flag non-web ports bound to 0.0.0.0 (no explicit host binding = binds to 0.0.0.0 by default)
    grep -nE "^\s+- \"[0-9]+:[0-9]+\"" "$f" | grep -v "127\.0\.0\.1\|::1" | grep -vE "\"(80|443):" && \
        echo "SEC: port published on 0.0.0.0 in $f — verify UFW/firewall is the ONLY protection. Docker daemon restart can reset iptables and expose the port directly."
done <<< "$INFRA_FILES"
```
**Confidence**: `LIKELY` — a firewall rule may exist that provides protection; flag for verification rather than hard-block.
**Severity**: HIGH for database/internal service ports (5432, 6432, 6379); MEDIUM for other non-web ports.
**Evidence**: Internal service ports (DB, cache, proxy) published without an explicit host binding default to `0.0.0.0`, making them reachable from any interface. Docker daemon restarts can reset iptables and bypass firewall rules that were the only protection.

**B. Missing USER directive** (when any `Dockerfile` is in diff — trigger: `$DOCKERFILE_FILES` non-empty)
```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    grep -q "^USER " "$f" || \
        echo "SEC: CONFIRMED — no USER directive in $f. Container runs as UID 0. For services that process user-supplied URLs or untrusted input (worker, Playwright), running as root significantly lowers the bar for container escape."
done <<< "$DOCKERFILE_FILES"
```
**Confidence**: `CONFIRMED` — absence of USER directive is an objective, verifiable fact.
**Severity**: HIGH for services processing untrusted input; MEDIUM for internal-only services.
**Evidence**: A Dockerfile without a USER directive runs all processes as UID 0. For services that process user-supplied content (browser automation, file parsing, untrusted URLs), root execution significantly lowers the bar for container escape.

**C. Response header information disclosure** (when Python middleware/main.py adds response headers — trigger: `$HEADER_FILES` non-empty)
```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    grep -nE "X-App-Version|X-Deployment-Color|Server:|X-Powered-By|X-.*-SHA|X-.*-Build" "$f" 2>/dev/null && \
        echo "SEC: response header in $f leaks infrastructure details. Git SHA enables targeted CVE diffing against public commits. Deployment color reveals blue/green topology to attackers."
done <<< "$HEADER_FILES"
```
**Confidence**: `CONFIRMED` — header name reveals infra details by definition.
**Severity**: MEDIUM — information disclosure accelerates other attacks but is not directly exploitable.
**Evidence**: Git SHAs in response headers enable targeted CVE diffing against public commits. Deployment color headers reveal blue/green topology. Software version strings in health endpoints enable CVE targeting. These headers are often added for internal observability and inadvertently included in all responses.

**D. CI security scan gating** (when `.github/workflows/*.yml` is in diff — trigger: `$WORKFLOW_FILES` non-empty)
```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Find security scanner steps with continue-on-error: true
    grep -B5 "continue-on-error: true" "$f" | grep -iE "trivy|snyk|security|cve|scan|grype|dockle" && \
        echo "SEC: security scanner in $f has continue-on-error: true — CVEs will be logged but will NEVER block a deploy. Remove continue-on-error or add a severity threshold."
done <<< "$WORKFLOW_FILES"
```
**Confidence**: `CONFIRMED` — `continue-on-error: true` on a security scanner step is objectively a non-blocking scan.
**Severity**: HIGH — security scanner provides zero protection when it cannot block.
**Evidence**: A security scanner with `continue-on-error: true` reports green CI regardless of findings — CVEs are logged but never surface as failures. This makes the scan purely decorative: PRs introducing known vulnerabilities pass all checks.

**E. In-memory rate limiter** (when TypeScript files are in diff — trigger: `$TS_FILES` non-empty)
```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    grep -nE "new Map\(\)|=\s*\{\}|= new Map" "$f" 2>/dev/null | grep -iE "rate|limit|attempt|count|throttle|window" && \
        echo "SEC: in-memory rate limiter detected in $f — resets on every container restart, not shared across blue/green replicas. Use Redis (via Upstash, ioredis, or the existing Redis client) for distributed rate limiting."
done <<< "$TS_FILES"
```
**Confidence**: `LIKELY` — in-memory store may be intentional for non-critical paths; flag for verification.
**Severity**: MEDIUM — bypass requires restarting the container or hitting a different replica; not trivially exploitable but provides no protection in blue/green deploys.
**Evidence**: In-memory Maps/objects used for rate limiting reset on every container restart and are not shared across replicas in blue/green deployments. An attacker can bypass limits by targeting the other replica or waiting for a deploy cycle.

**F. Cookie security flags** (when TypeScript files are in diff — trigger: `$TS_FILES` non-empty)
```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    grep -nE "httpOnly:\s*false|secure:\s*false|sameSite.*['\"]none['\"]" "$f" 2>/dev/null && \
        echo "SEC: cookie in $f has weakened security flag. httpOnly: false exposes cookie to JS (XSS risk). secure: false allows transmission over HTTP. sameSite: none without Secure enables CSRF."
done <<< "$TS_FILES"
```
**Confidence**: `CONFIRMED` — explicit `false`/`none` values are objective findings.
**Severity**: HIGH for `httpOnly: false` (direct XSS vector for session cookies); MEDIUM for `secure: false` or `sameSite: none`.
**Evidence**: Explicitly weakened cookie security flags are directly exploitable: `httpOnly: false` exposes the cookie value to any JavaScript running in the page (XSS-to-session-theft); `secure: false` allows the cookie to be sent over plaintext HTTP; `sameSite: none` without `Secure` enables cross-site request forgery.

**G. Fallback credential scan in config files** (when config files are in diff — trigger: `$CONFIG_FILES` non-empty)
```bash
while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Shell-style fallback: ${VAR:-default} — flag non-trivial fallback values that may be credentials
    grep -nE "\$\{[A-Z_]+:-[^}]{4,}\}" "$f" | grep -ivE "(localhost|127\.0\.0\.1|0\.0\.0\.0|true|false|^[0-9]+$|/tmp|/var|/etc)" && \
        echo "SEC: potential credential fallback in $f — verify fallback value is safe if env var is absent"
done <<< "$CONFIG_FILES"
```
For each hit: read the fallback value.
- Contains `$apr1$`, `$2b$`, `$bcrypt$`, `$argon2`, or hash-like long alphanumeric with `$` separators: **CONFIRMED HIGH** — htpasswd/bcrypt placeholder; active if env var is absent.
- Is `admin`, `password`, `changeme`, `secret`, `test`, or similar weak string: **CONFIRMED HIGH** — default credential.
- Is empty string (`${VAR:-}` or `${VAR:-""}`): **CONFIRMED HIGH** if field controls authentication.

**Required cross-checks when a credential fallback is found**: (1) Is the env var required in `app/env_validation.py`? (2) Is it in `scripts/decrypt-secrets.sh` ENV_MAPPING (if configured in your SOPS deploy chain — skip if absent)? (3) Is it marked required in `.env.example`? If ANY missing: the insecure fallback may be active in some environments.
**Confidence**: `CONFIRMED` — fallback value is objectively verifiable.
**Severity**: HIGH — insecure fallback credential is equivalent to a hardcoded credential for any environment missing the env var.
**Evidence**: Config files commonly use `${VAR:-placeholder}` patterns during development, where the placeholder is a sample credential or hash. If the env var is absent in any environment (staging, non-production, first deploy before secrets are injected), the placeholder becomes the active credential. Also covered by INFRA agent item 13 (deployment context + ENV_MAPPING cross-check); this item extends coverage to PRs not classified as INFRA domain.

**H. Runtime UID × volume ownership** (when any Dockerfile is in diff AND diff contains `USER`, `su-exec`, `gosu`, or `setuid` — trigger: `$DOCKERFILE_FILES` non-empty AND UID change detected)
```bash
UID_CHANGE=$(while IFS= read -r f; do
    [ -z "$f" ] && continue
    gh pr diff [PR_NUMBER] -- "$f" 2>/dev/null | grep -E '^\+.*(USER\s+[^0]|su-exec|gosu|setuid)' | grep -v '^+++' && break
done <<< "$DOCKERFILE_FILES")
if [ -n "$UID_CHANGE" ]; then
    echo "UID change detected — cross-referencing named volume mounts..."
    COMPOSE_FILES=$(find . -maxdepth 2 -name "docker-compose*.yml" 2>/dev/null | sort)
    while IFS= read -r cf; do
        [ -z "$cf" ] && continue
        grep -A2 "volumes:" "$cf" | grep -E "^\s+\w.*:" | grep -v "^--$" && echo "  ^ in $cf"
    done <<< "$COMPOSE_FILES"
fi
```
For each named volume found: determine its container mount point. Named volumes are created as **root-owned** by Docker at first use — a privilege drop (root → UID N) without a `chown` before the drop will silently break any service path that calls `mkdir`, `write_bytes`, `open(... 'w')`, or `os.makedirs` under that mount point.

**Check**: Does the entrypoint script (or equivalent) run `chown -R <user>:<group> <mount_point>` BEFORE the `exec su-exec` / `exec gosu` call? If not:
- Search the service codebase for filesystem write operations under the volume mount point:
  ```bash
  grep -rn "mkdir\|write_bytes\|open(.*['\"]w\|makedirs\|shutil\.copy\|shutil\.move" services/{SERVICE}/ --include="*.py" | grep -v __pycache__
  ```
- If any write path is found under the volume mount: **CONFIRMED BLOCKING** — the service will fail with `[Errno 13] Permission denied` on first write attempt after the privilege drop.

**Confidence**: `CONFIRMED` — Docker named volume ownership is an objective, verifiable fact (volumes are root-owned at creation).
**Severity**: HIGH — filesystem writes fail silently at runtime with `PermissionError`; no startup crash, so the failure only surfaces when the code path executes.
**Evidence**: When a container's runtime user changes from root to a non-root UID, Docker named volumes retain their existing ownership (root:root). Any code path that writes to a path under a named volume mount point will fail with `[Errno 13] Permission denied`. The fix is to add `chown -R <user>:<group> <mount_point>` to the entrypoint script before the privilege-drop `exec` call. <!-- Added: forge#323 -->

## Step 3: Code Quality Scan
1. **Error handling**: Exceptions swallowed silently, generic except clauses
2. **Resource leaks**: Unclosed connections, files, async tasks not awaited
3. **Logic errors**: Off-by-one, wrong operators, missing returns
4. **Type safety**: Optional types accessed without None check
5. **Runtime correctness**: Will this code actually execute without errors? Trace every construct to its runtime behavior — duplicate column names in SQL, mismatched function signatures, invalid regex, malformed templates. If something looks "redundant", ask whether the redundancy causes an error downstream (e.g., duplicate columns + DISTINCT ON = ambiguous reference).
6. **Python scoping hazards**: Local `import X` inside a function makes `X` a local variable for the ENTIRE function. If any code above that import references `X`, it will crash with `UnboundLocalError`. Check every function-scoped import against all references to that name in the same scope. This is a CONFIRMED CRITICAL — it's a guaranteed runtime crash.
7. **Callback/callable signature mismatch**: When the diff passes a `lambda`, function reference, or callable as a keyword argument to a library/framework function (e.g., `prepared_statement_name_func=lambda _: ""`, `key=lambda x, y: ...`, `default=lambda: ...`), verify the callback's parameter count matches what the library expects. Check the library's default value for that parameter or its documentation. A lambda with wrong arity is a guaranteed `TypeError` at runtime — this is CONFIRMED CRITICAL. Wrong arity cannot be caught by static analysis or `py_compile` — it only fails at the call site. The review agent must verify signature, not just quote the lambda and approve.
8. **Fix PR input-format coverage** (when PR title contains "fix" and the diff patches a specific input format failure): When a fix PR addresses one documented failure mode (e.g., blank string → `[]`), search `.env.example` for ALL documented input format examples for the affected env var or config field. For each documented format that the fix does NOT handle, flag as CONFIRMED HIGH.
   ```bash
   # Find the env var(s) touched by the fix
   FIXED_VARS=$(gh pr diff [PR_NUMBER] | grep -oE "ENABLED_[A-Z_]+|[A-Z_]{3,}(?=.*decode_complex_value|.*list\[str\]|.*List\[str\])" | sort -u)
   # For each var, read its .env.example comment for documented format examples
   for var in $FIXED_VARS; do
       grep -A5 "$var" .env.example 2>/dev/null | grep -iE "comma.separated|csv|json|space.separated|pipe.separated|semicolon.separated"
   done
   # Then read the fix itself — what format(s) does it handle?
   gh pr diff [PR_NUMBER] | grep -E "^\+" | grep -iE "json\.loads|split\(','\)|split\(' '\)|csv|,\.join"
   ```
   Compare documented formats against handled formats. Any documented format not handled by the fix is a gap. A fix that addresses one documented failure mode (e.g., blank string) while leaving another documented format (e.g., CSV) unhandled is an incomplete fix. <!-- Added: forge#190 -->
9. **Scope creep detection**: Compare the PR title/description scope against the actual diff size. When a fix PR's diff contains significantly more logic than its stated scope implies, there is a high risk that the extra code introduces bugs the reviewer is not primed to look for — and that the builder agent added context from a different branch or a different issue.
   ```bash
   # Count lines added in the diff (excluding whitespace-only lines and file headers)
   DIFF_LINES_ADDED=$(gh pr diff [PR_NUMBER] | grep -c '^+[^+]' 2>/dev/null || echo 0)
   PR_TITLE=$(gh pr view [PR_NUMBER] --json title --jq '.title')
   PR_BODY=$(gh pr view [PR_NUMBER] --json body --jq '.body')
   ```
   **Flag as POSSIBLE (MEDIUM) if ALL of the following are true**:
   - PR title contains "fix" (indicating a targeted bug fix, not a feature or refactor)
   - The diff adds more than 40 non-whitespace lines
   - The added lines include logic blocks (functions, classes, conditionals) not directly related to the stated fix
   - The added logic is NOT mentioned in the PR description

   **What to check**: Read the diff in full. For each block of added code that is NOT directly implementing the stated fix, ask: "Is this block explained by the PR title or description?" If not, flag it. Specifically look for:
   - New import statements for modules not referenced in the fix
   - New function definitions beyond what the fix requires
   - Feature gate blocks added to a bug-fix PR
   - Conditional blocks that check for feature flags, subscriptions, or plan tiers in a PR that claims to fix an unrelated error

   **Confidence**: `POSSIBLE` (reviewer cannot always know the full intent — flag for human review, do not hard-block). If the extra code is importing a module from a non-existent path, upgrade to `CONFIRMED HIGH`.

   When a builder agent working in a milestone-branch worktree adds code to a fast-lane fix PR, it can introduce imports of milestone-only modules or feature gate logic unrelated to the stated fix. These additions pass local compilation (the module exists in the worktree) but crash at runtime (the module doesn't exist on the base branch). <!-- Added: forge#277 -->

10. **Architectural fit check**: For any PR that introduces new files in service directories (`services/`, `worker/`, `scripts/`, `tools/`, or project-specific tooling directories like `reddit-bot/`, `bots/`, `cli/`), check whether a scheduled or automated system already handles the same functional capability.
    ```bash
    # Get list of new files introduced by the PR
    gh pr diff [PR_NUMBER] --name-only | grep -E "^(services|worker|scripts|tools|reddit-bot|bots|cli)/"
    # For each new file, identify the primary capability (posting, syncing, notifying, etc.)
    # Then search for existing implementations:
    grep -rn "{capability_keyword}" services/ --include="*.py" -l 2>/dev/null | head -10
    grep -rn "scheduler\|celery\|cron\|nightly\|periodic\|schedule" services/ --include="*.py" -l 2>/dev/null | head -10
    ```
    **Flag as POSSIBLE (HIGH) if**: A new file implements a capability (e.g., posting to Reddit, sending emails, syncing data) AND a search of existing services finds a scheduler, runner, or automated pipeline that already performs the same action. The risk: parallel systems create split ownership, dual authentication surface, and non-deterministic execution order.

    **What to look for**:
    - New file posts to a platform (Reddit, Twitter, Slack) → check if an existing service has a scheduler or crosspost runner for that platform
    - New file sends emails or notifications → check if a notification service or Herald already handles this
    - New file syncs or exports data → check if a worker or periodic job already owns this data flow
    - New file queries an external API on a schedule → check if an existing scheduler already polls that API

    **Confidence**: `POSSIBLE` — reviewer may not have full knowledge of all service capabilities. Flag for human verification. Escalate to `CONFIRMED HIGH` only if the existing code path is unambiguously doing the same thing (e.g., both files call the same third-party API endpoint to perform the same action).

    A new standalone script that duplicates a capability owned by an existing service creates split ownership: two code paths performing the same action, each with separate authentication surfaces and no coordination. The review passing on syntax and call signatures does not catch this — the question is whether the new file should exist at all. <!-- Added: forge#279 -->

11. **Pattern-completion check** *(conditional — when PR title contains "fix" AND the diff removes or narrows a condition or field gate in a router file)*: When a fix PR changes a condition that guards a function call or restricts a set of fields, grep for the same original (unfixed) condition in sibling files within the same router directory. A fix that corrects one router but leaves identical gates in sibling routers is incomplete — users of those endpoints still receive the original error.
    ```bash
    # Identify the router directory of the changed file
    ROUTER_DIR=$(gh pr diff [PR_NUMBER] --name-only | grep -E "routers/.*\.py$" | head -1 | xargs dirname 2>/dev/null)

    # Extract removed condition lines from the diff
    REMOVED_CONDITIONS=$(gh pr diff [PR_NUMBER] | grep -E '^-.*\bif\b.*\bor\b|^-.*\bif\b.*(and|:)\s*$' | grep -v '^---' | sed 's/^-//' | head -5)

    if [ -n "$ROUTER_DIR" ] && [ -n "$REMOVED_CONDITIONS" ]; then
        echo "$REMOVED_CONDITIONS" | while IFS= read -r condition; do
            # Extract a key term from the condition to search for
            PATTERN=$(echo "$condition" | grep -oP '\b[a-z_]{5,}\b' | grep -v "^if$\|^or$\|^and$\|^not$\|^request$\|^self$" | head -1)
            if [ -n "$PATTERN" ]; then
                # Find changed files to exclude
                CHANGED=$(gh pr diff [PR_NUMBER] --name-only | tr '\n' ' ')
                # Search sibling files for the same pattern in a conditional context
                grep -rn "\b${PATTERN}\b" "$ROUTER_DIR" --include="*.py" | grep -E "\bif\b" | while read -r match; do
                    FILE=$(echo "$match" | cut -d: -f1)
                    # Skip files already changed in this PR
                    echo "$CHANGED" | grep -q "$FILE" && continue
                    echo "SEC: Residual unfixed gate pattern '$PATTERN' found in $match — sibling router may have the same bug as this fix addressed. Verify the condition is correct for all fields in scope."
                done
            fi
        done
    fi
    ```
    **Flag as CONFIRMED (HIGH) if**: The same condition pattern exists in a sibling router file AND that file is NOT in the PR diff. The sibling file has the same structural bug — users of that endpoint are still affected.

    **Flag as POSSIBLE (MEDIUM) if**: The pattern match is found but the surrounding context is ambiguous (e.g., the field appears in a different kind of condition or with different semantics).

    A condition fix that is limited to the most visible endpoint (the one generating observed errors) leaves users of sibling endpoints experiencing the original bug. The fix is structurally complete only when all callers of the gated operation have been verified. <!-- Added: forge#383 -->

## Step 4: Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Security & Code Quality Scan

### Risk Level: [LOW/MEDIUM/HIGH/CRITICAL]

### Security Findings
| Severity | Confidence | Finding | File:Line | Evidence |
|----------|------------|---------|-----------|----------|
| ... | ... | ... | ... | ... |

### Code Quality Issues
| Category | Issue | File:Line | Impact |
|----------|-------|-----------|--------|
| ... | ... | ... | ... |

### Files Reviewed
[List all files checked]

---
*Automated security & quality scan*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:SEC-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `SEC`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — SEC Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| SQL/command/template injection | Step 2.1 | COVERED | #210–#323 |
| SSRF via user-controlled URLs | Step 2.2 | COVERED | |
| Path traversal | Step 2.3 | COVERED | |
| Unsafe deserialization | Step 2.4 | COVERED | |
| Hardcoded secrets | Step 2.5 | COVERED | |
| XSS | Step 2.6 | COVERED | |
| Token privilege confusion | Step 2.7 | COVERED | |
| Unbounded resource consumption | Step 2.8 | COVERED | |
| API information disclosure | Step 2.9 (a/b/c) | COVERED | #302 |
| Port bind address exposure | Step 2.5A | COVERED | #296 |
| Missing container USER directive | Step 2.5B | COVERED | #296 |
| Response header info leakage | Step 2.5C | COVERED | #302 |
| CI security scan gating | Step 2.5D | COVERED | #296 |
| In-memory rate limiter bypass | Step 2.5E | COVERED | |
| Cookie security flags | Step 2.5F | COVERED | |
| Credential fallbacks in config | Step 2.5G | COVERED | #301 |
| UID x volume ownership | Step 2.5H | COVERED | #323 |
| Error handling gaps | Step 3.1 | COVERED | |
| Resource leaks | Step 3.2 | COVERED | |
| Logic errors / off-by-one | Step 3.3 | COVERED | |
| Type safety (Optional without None check) | Step 3.4 | COVERED | |
| Runtime correctness (duplicate cols, bad regex) | Step 3.5 | COVERED | |
| Python scoping hazards (local import) | Step 3.6 | COVERED | |
| Callback signature mismatch | Step 3.7 | COVERED | #277 |
| Fix PR input-format coverage | Step 3.8 | COVERED | #190 |
| Scope creep detection | Step 3.9 | COVERED | #277 |
| Architectural fit (parallel systems) | Step 3.10 | COVERED | #279 |
| Pattern-completion for condition-fix PRs (sibling router check) | Step 3.11 | COVERED | #383 |
| Supply chain / dependency confusion | — | GAP | |
| Timing side-channels in auth | — | GAP | |

---

