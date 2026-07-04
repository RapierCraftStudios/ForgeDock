<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Agent Catalog for `/review-pr`

This file is the Agent Catalog referenced by the `/review-pr` orchestrator. It is read via the `Read` tool during Phase 3C (agent dispatch). It contains:

1. The **Evidence-Based Review Protocol** — all spawned agents must follow this
2. The **Structured Findings Protocol** — all spawned agents must include a machine-readable block in their PR comment
3. All **9 agent templates** — copy the relevant template verbatim when constructing agent prompts

Do not modify this file without also updating `review-pr.md`.

---

## Evidence-Based Review Protocol (ALL Agents Follow)

Every agent MUST follow this protocol:

### 1. Start From the PR Diff
```bash
# Verify review is still current before reading diff
CURRENT_SHA=$(gh pr view [PR_NUMBER] --json headRefOid --jq '.headRefOid')
if [ "$CURRENT_SHA" != "[REVIEW_SHA]" ]; then
    echo "WARNING: PR HEAD changed during review. Review may be stale."
    echo "Review pinned to: [REVIEW_SHA_SHORT]"
    echo "Current HEAD: $(echo $CURRENT_SHA | cut -c1-7)"
fi

gh pr diff [PR_NUMBER] --name-only
gh pr diff [PR_NUMBER]
```

**Hot-spot prior**:
[CHURN_CONTEXT]

If a file you are reviewing is listed above as a hot-spot, apply deeper scrutiny to it — high historical churn correlates with defect density. Prefer tracing that file's full code paths (Evidence-Based Review Protocol §2) over a quick pattern scan, and weight ambiguous findings in hot-spot files toward LIKELY rather than POSSIBLE.

### 2. Dynamic Exploration
- From each changed file, follow imports and function calls
- Trace data flows across service boundaries (API → Redis → Worker)
- Search for related code: `grep -rn "function_name" services/`

### 3. Validation Before Reporting

| Confidence | Criteria | Action |
|------------|----------|--------|
| **CONFIRMED** | Traced the full code path, found specific lines proving the bug | Report as blocking — P1 issue |
| **LIKELY** | Code pattern suggests issue but mitigations might exist elsewhere | Report with caveat — P2 issue |
| **POSSIBLE** | Suspicious pattern but couldn't trace the full flow | Report as informational — P3 advisory (non-blocking) |
| **UNFOUNDED** | Looked for the issue but found mitigations/correct handling | Do NOT report |

### 3.5 REPRODUCTION GATE — Required Before CONFIRMED Classification

**MANDATORY**: Before classifying any finding as CONFIRMED, you MUST document one of the following forms of reproduction evidence in your report. A pattern match alone is not sufficient.

**Acceptable reproduction evidence (one of)**:
- **(a) Full code path trace**: List the execution chain from PR-changed code to the failure point. Minimum: 3 steps with specific file + line for each. Example: `services/api/app/routers/billing.py:142 → credits.py:check_balance():87 → returns None → caller at billing.py:148 raises AttributeError`. The chain must terminate at the actual failure — not at "and then it could fail."
- **(b) Specific input demonstration**: Provide concrete input values that trigger the failure. Example: `POST /api/v1/scrape with {"url": "http://internal:6432/"}` → `requests.get()` hits internal DB port → SSRF confirmed. The values must be specific (not "if an attacker provides a malicious URL") and must map to actual code in the PR diff.

**Downgrade rule**: If you cannot produce either (a) or (b) after a reasonable trace attempt, you MUST classify the finding as **POSSIBLE** — not CONFIRMED or LIKELY. Do NOT use CONFIRMED when the finding is based on:
- A suspicious pattern without tracing whether the condition is reachable via changed code
- A theoretical exploit path not grounded in specific lines from the diff
- A heuristic ("this type of code often has X bug") without verification

**POSSIBLE findings are informational advisories** — they are logged and tracked but do NOT block merge and do NOT trigger mandatory fix PRs. When in doubt, POSSIBLE is the correct classification. <!-- Added: forge#371 -->

### 4. SEVERITY CLASSIFICATION — TRACE THE IMPACT

**CRITICAL RULE: Never dismiss a finding as "minor", "cosmetic", or "harmless" without tracing its downstream impact.** If you spot something unusual (redundant code, odd patterns, duplicated values), ask: "Does this cause a runtime error, data corruption, or wrong behavior in any code path that touches it?" Trace forward through every consumer of the construct.

**Severity decision tree:**
1. Will this error at runtime? → **HIGH or CRITICAL** (not "minor redundancy")
2. Will this produce wrong data silently? → **HIGH**
3. Will this cause degraded performance? → **MEDIUM**
4. Is it genuinely cosmetic with no runtime impact after tracing all consumers? → **LOW**

If you're unsure whether something is cosmetic or a runtime error, **assume it's a runtime error** and flag it for investigation. A false positive costs a minute of review time. A missed runtime error costs production downtime.

### 5. INTERACTION ANALYSIS — "Pre-existing" Is Not "Safe"

**CRITICAL RULE: Never dismiss a finding as "pre-existing, not introduced by this PR" without checking whether NEW code in the PR interacts with the pre-existing construct to create a bug.**

A redundant import, an unused variable, or a duplicated constant may be harmless in isolation. But new code added in the same scope can turn it into a crash. Example: a local `import os` inside a function is harmless until new code above it calls `os.getenv()` — Python treats `os` as local for the entire function scope, causing `UnboundLocalError` before the import line is reached.

**Before dismissing anything as "pre-existing":**
1. List every NEW line in the PR that references the pre-existing construct
2. For each reference, ask: "Does the pre-existing construct cause this new line to fail at runtime?"
3. If yes → CONFIRMED finding, not a dismissal

### 6. FALSE POSITIVE PREVENTION

**Before claiming variable scope issues:** Read the FULL function, count indentation levels, check if/else structure.

**Before claiming type/unit mismatches:** Trace the variable to its source. Check if naming is misleading (e.g., `balanceCents` might hold microcents).

**Before claiming missing functions/imports:** `grep -rn "functionName" .` — check re-exports, aliases.

**Before claiming unreachable code:** Check all callers, dynamic dispatch, test code.

**Before dismissing redundant imports as harmless:** In Python, a local `import X` inside a function makes `X` a local variable for the ENTIRE function scope. Any use of `X` before that import line will raise `UnboundLocalError`. Check whether any code (existing or new) references `X` before the local import. This is a CONFIRMED CRITICAL if found — it crashes at runtime.

### 6. Report Format

Every finding must include:
- **File:Line** — Exact location
- **Code snippet** — The problematic code
- **Evidence** — Why this is a bug (show the code path)
- **Confidence** — CONFIRMED/LIKELY/POSSIBLE
- **What you checked** — List files you read to verify

---

## Structured Findings Protocol

**All review agents MUST include a machine-readable findings block at the end of their PR comment.** This is NON-OPTIONAL. Without structured findings, the review system cannot create GitHub issues, and findings die as unread PR comments. Every finding that doesn't become a GitHub issue is a finding that will never be addressed.

### Format

Append this block at the very end of your comment (after the `---` footer line, still inside the EOF heredoc). It uses HTML comments so it's invisible in rendered markdown:

`<!-- REVIEW-FINDINGS-START -->`
`<!-- FINDING:PREFIX-N|CONFIDENCE|SEVERITY|file.py:line|One-line summary -->`
`<!-- REVIEW-FINDINGS-END -->`

### Rules

1. **Include ALL findings at CONFIRMED, LIKELY, and POSSIBLE confidence** — every finding becomes a GitHub issue. Nothing stays as just a PR comment. **POSSIBLE findings are informational advisories (P3/non-blocking)** — they are tracked but do not require a fix PR and do not block merge. CONFIRMED and LIKELY findings are blocking at P1/P2 respectively.
2. **One line per finding** — sequential numbering (PREFIX-1, PREFIX-2, ...)
3. **Confidence**: `CONFIRMED`, `LIKELY`, or `POSSIBLE`
4. **Severity**: `CRITICAL`, `HIGH`, `MEDIUM`, or `LOW`
5. **Location**: Exact `file:line` reference
6. **Summary**: Concise one-line description (no pipe `|` characters in summary)
7. **Empty block**: If no findings at all, include just the START/END markers
8. **HTML comments**: The block is invisible in rendered markdown but parseable by the review system

### Domain Prefixes

| Agent | Prefix |
|-------|--------|
| General Security | `SEC` |
| Auth Conventions | `AUTH` |
| Billing Integrity | `BILL` |
| Concurrency | `CONC` |
| Scraper Logic | `SCRP` |
| Frontend Quality | `FE` |
| API Design | `API` |
| Database & Migration | `DB` |
| Infrastructure | `INFRA` |
| Config Schema | `CFG` |

### Example

`<!-- REVIEW-FINDINGS-START -->`
`<!-- FINDING:SEC-1|CONFIRMED|HIGH|services/api/app/routers/scrape.py:45|SQL injection via unsanitized user input in query parameter -->`
`<!-- FINDING:SEC-2|LIKELY|MEDIUM|services/worker/worker/queues.py:312|Potential SSRF through user-controlled proxy URL -->`
`<!-- REVIEW-FINDINGS-END -->`

---

## Agent Catalog

### Agent: General Security & Quality Scan (ALWAYS RUNS)

**Type**: `security-exploit-auditor` | **Model**: `sonnet`

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
```bash
gh pr diff [PR_NUMBER] --name-only
gh pr diff [PR_NUMBER]
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
       grep -rn "RequestValidationError\|validation_exception_handler\|@app.exception_handler" services/api/app/main.py services/api/app/ 2>/dev/null | head -5
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

### Agent: Auth Conventions Auditor

**Trigger**: AUTH domain detected
**Type**: `security-exploit-auditor` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for authentication and authorization correctness in [PROJECT_NAME].

## CRITICAL PROJECT CONVENTIONS — You MUST enforce these:

[DOMAIN_CONTEXT]

### How to Check
```bash
# Find auth patterns in changed files
grep -rn "auth\|Depends\|get_current\|verify_token\|require_auth" [CHANGED_FILES]

# Cross-reference with route path to determine if correct
grep -rn "@router\.(get\|post\|put\|delete)\|app\.(get\|post\|put\|delete)" [CHANGED_FILES]
```

### What to Verify
1. Every new endpoint has an auth dependency (no unauthenticated endpoints without justification)
2. The CORRECT auth dependency is used based on route type (refer to project conventions in [DOMAIN_CONTEXT] above — if absent, derive from surrounding code patterns)
3. Multi-tenancy: resource access checks `user_id` ownership BEFORE returning data
4. Rate limiting is applied to public-facing endpoints
5. No IDOR vulnerabilities (different error codes for 404 vs 403 leak existence)
6. Header forwarding trust model: when the diff touches Next.js middleware, route handlers, or FastAPI rate-limiting middleware, verify that attacker-controlled `X-Forwarded-For` headers cannot spoof the IP used for rate limit keying

   ```bash
   # Check if Next.js proxy layer strips or validates X-Forwarded-For before forwarding
   grep -nE "x-forwarded-for|X-Forwarded-For|headers.*forwarded|forwarded.*headers" \
     web/src/middleware.ts web/src/app/api/ 2>/dev/null
   # If found without a strip/validate step: CONFIRMED HIGH — complete rate limit bypass
   # Safe pattern: headers.delete("x-forwarded-for") or rightmost-IP-only extraction

   # Check if FastAPI backend trusts X-Forwarded-For for rate limit keying
   grep -rn "X-Forwarded-For\|x_forwarded_for\|forwarded_for\|client_ip\|real_ip" \
     services/api/app/ | head -10
   # If found without trusted-proxy-range validation: CONFIRMED HIGH
   # The backend must only trust X-Forwarded-For when the immediate caller is in a known trusted proxy range
   ```

   **Flag as CONFIRMED HIGH** if: X-Forwarded-For is forwarded from client to backend without stripping or rightmost-only extraction AND the backend keys rate limits on that header value.

7. JWT secret/algorithm separation: when the diff touches JWT signing, verification, or token generation, verify that different token classes (user session, admin-proxy, API key) use distinct signing secrets or asymmetric algorithms — not a shared secret differentiated only by claims

   ```bash
   # Check signing configuration across token classes
   grep -nE "SECRET|algorithm|HS256|RS256|verify|decode" \
     services/api/app/security/auth.py web/src/lib/auth.ts | head -20
   # Flag if: multiple token classes reference the same secret variable AND the only differentiator is a claim (e.g., aud, role)
   # Safe pattern: admin tokens use a separate ADMIN_JWT_SECRET or RS256 (asymmetric)
   # so that a user-level token CANNOT be escalated to admin by claim manipulation
   ```

   **Flag as CONFIRMED HIGH** if: two or more token classes with different privilege levels share the same signing secret and algorithm, with only claim values (e.g., `aud="admin-proxy"`) preventing privilege escalation.

## Context
- Files changed: [AUTH_RELEVANT_FILES]
- PR description: [PR_BODY]

## Steps
1. Read the diff: `gh pr diff [PR_NUMBER]`
2. For each endpoint, verify auth dependency matches route type
3. Check ownership queries for multi-tenancy
4. Search for patterns: `grep -rn "Depends(get_current" services/api/app/routers/`
5. Compare against existing router patterns for consistency
6. If diff touches `web/src/middleware.ts`, Next.js route handlers, or FastAPI rate-limit middleware: run header forwarding check (item 6 grep commands above)
7. If diff touches `services/api/app/security/auth.py`, `web/src/lib/auth.ts`, or any JWT signing/verification code: run JWT secret separation check (item 7 grep commands above)

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Auth Conventions Audit

### Endpoints Reviewed
| Endpoint | Method | Auth Dep Used | Expected Auth Dep | Correct? | Ownership Check |
|----------|--------|--------------|-------------------|----------|-----------------|
| /path | POST | CurrentUser | SessionUser | NO — VIOLATION | Yes/No/N/A |

### Convention Violations
[List any violations of the SessionUser/CurrentUser convention with file:line]

### Multi-Tenancy Check
[For each resource access, show the ownership check or flag missing]

### Header Forwarding Trust Model (Item 6)
[If proxy/middleware files touched: state whether X-Forwarded-For is stripped/validated before rate-limit IP keying, or SKIPPED if no middleware changes in this PR]

### JWT Secret Separation (Item 7)
[If auth.py or JWT signing files touched: state whether each token class uses a distinct secret/algorithm, or SKIPPED if no JWT configuration changes in this PR]

### Files Reviewed
[List all auth-related files checked]

---
*Auth conventions audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:AUTH-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `AUTH`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — AUTH Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Missing auth dependency on endpoint | Item 1 | COVERED | |
| Wrong auth dependency (SessionUser vs CurrentUser) | Item 2 | COVERED | |
| Multi-tenancy / IDOR | Item 3 | COVERED | |
| Missing rate limiting on public endpoints | Item 4 | COVERED | |
| IDOR via error code differentiation | Item 5 | COVERED | |
| X-Forwarded-For trust model bypass | Item 6 | COVERED | #299 |
| JWT shared-secret privilege escalation | Item 7 | COVERED | #299 |
| OAuth state parameter CSRF | — | GAP | |
| Session fixation / session invalidation on privilege change | — | GAP | |

---

### Agent: Billing Integrity Auditor

**Trigger**: BILLING domain detected
**Type**: `codebase-explorer` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for billing integrity in [PROJECT_NAME].

CRITICAL: Any billing bug = revenue loss or user overcharging.

## Project Billing Architecture

[DOMAIN_CONTEXT]

If no billing context is configured above, derive the billing flow from the changed files: trace credit check → debit → execution → reconciliation paths.

## What to Verify
1. **Trace the full flow**: credit check → pre-debit → execution → reconciliation
2. **tier_used accuracy**: Where is `tier_used` set? Is it the final tier or intermediate?
3. **No double-charging**: Verify pre-debit and reconciliation don't overlap
4. **Failure handling**: What happens to credits when a scrape fails?
5. **Idempotency**: Can a retry cause double-debit?
6. **Free scrape paths**: Is there any code path that bypasses billing entirely?
7. **Gate regression check**: If the PR contains or preserves a feature gate that restricts endpoint access (e.g., `if "feature_name" not in features`, tier checks, balance thresholds blocking a route), verify the gate existed in the base branch BEFORE the commits being reviewed. Run `git show origin/{base}:{file} | grep -n "gate_pattern"` to check. If the gate was introduced by the same commit chain being fixed — not an independent historical addition — flag it as a potential rogue gate with HIGH severity: the correct fix is to fully revert the gate block, not to patch around it. A rogue gate silently restricts access for all users below a tier or balance threshold without any intentional review of that restriction. This finding is **informational — not a merge blocker**, but must appear in the Findings table so it can be tracked as a follow-up. <!-- Added: forge#278 -->

## MANDATORY Before Reporting
- Search `grep -rn "reconcil" services/worker/` before claiming "no reconciliation"
- Trace `tier_used` variable before claiming "wrong tier charged"
- Read the job completion handler in queues.py before claiming "credits not refunded"

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Billing Integrity Audit

### Billing Impact: [NONE/LOW/MEDIUM/HIGH]

### Flow Traced
1. Credit check: [file:line]
2. Pre-debit: [file:line]
3. Execution: [file:line]
4. Tier determination: [file:line] — tier_used = [how set]
5. Reconciliation: [file:line]

### Findings
| Issue | Confidence | Evidence | Revenue Impact |
|-------|------------|----------|----------------|
| ... | CONFIRMED/LIKELY | [code path] | [estimated impact] |

### What I Verified
- [ ] Traced credit deduction from API to worker
- [ ] Found reconciliation logic at [file:line]
- [ ] Verified tier_used source
- [ ] Checked idempotency
- [ ] Checked feature gates for rogue-gate regression (item 7)

### Files Reviewed
[List all billing-related files checked]

---
*Billing integrity audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:BILL-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `BILL`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — BILL Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Credit check → debit → reconciliation flow integrity | Item 1 | COVERED | |
| tier_used accuracy (wrong tier charged) | Item 2 | COVERED | |
| Double-charging (pre-debit + reconciliation overlap) | Item 3 | COVERED | |
| Credit loss on scrape failure | Item 4 | COVERED | |
| Retry idempotency (double-debit) | Item 5 | COVERED | |
| Free scrape bypass paths | Item 6 | COVERED | |
| Rogue feature gate regression | Item 7 | COVERED | #278 |
| Webhook handler completeness | — | PARTIAL | #297 |
| Spend limit / budget cap accuracy | — | PARTIAL | #297 |
| Promo/voucher redemption integrity | — | GAP | |

---

### Agent: Concurrency & Race Condition Auditor

**Trigger**: CONCURRENCY domain detected OR BILLING domain detected
**Type**: `general-purpose` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for concurrency bugs and race conditions in [PROJECT_NAME].

CRITICAL: This is a billing system. Double-spend = revenue loss.

## What to Look For
1. **Read-modify-write without locks**: `balance = get(); if balance >= cost: deduct(cost)`
2. **Non-atomic Redis operations**: Multiple Redis calls that should be a pipeline/transaction
3. **Missing FOR UPDATE**: DB queries that read-then-write without row locks
4. **Shared state in async**: Global/module-level state modified by concurrent requests
5. **Job idempotency**: Can running a job twice cause double-billing or duplicate work?
6. **Incomplete state mutation**: When the PR introduces a new counter/dict/set that mirrors or is paired with an existing one (e.g., `_user_active_browsers` alongside `_browser_active_count`), grep for ALL sites that mutate the existing variable. Each site must also handle the new variable, or document why not. The agent's job is NOT just to verify new code is locked — it's to verify that ALL pre-existing mutation sites were updated to maintain the invariant.
7. **Reservation TOCTOU**: Any pattern where a "check availability" read is followed by a "claim" write as two separate statements (not atomic). Required safe patterns:
   - `SELECT ... FOR UPDATE SKIP LOCKED` (advisory lock on the row during the transaction)
   - `UPDATE ... WHERE reserved_by IS NULL RETURNING id` (single atomic claim — no separate read)
   - Database UNIQUE constraint on the reservation column (prevents duplicate claims at DB level)

   Search for check-then-claim patterns in promo, voucher, or coupon redemption code:
   ```bash
   grep -n "reserved_by\|voucher.*claim\|promo.*redeem\|coupon.*use" <billing_files> | head -20
   # If found without FOR UPDATE or RETURNING in same transaction: CONFIRMED HIGH
   ```
   If `WHERE reserved_by IS NULL` appears in a SELECT that is followed by a separate UPDATE (not in the same atomic statement), this is a CONFIRMED HIGH finding — two concurrent sessions can both pass the read check before either writes.

8. **Cross-service flag staleness**: When a discount or pricing flag (e.g. `has_active_subscription`, a `discount_type` field) is set by the API layer at job submission and read by the Worker layer at billing time, verify the flag is re-validated at debit time — not trusted from the queued job payload.

   Search for discount flags passed through Redis/job payloads:
   ```bash
   grep -rn "discount.*flag\|flag.*discount\|subscription.*flag\|plan_type\|discount_type" {API_PATH}/ {WORKER_PATH}/ | head -20
   # If the flag flows through a job payload and is not re-validated at billing: CONFIRMED HIGH
   ```
   A race window exists when a flag is checked at submission but consumed at billing: the underlying condition (e.g., subscription status, entitlement) may have changed between the two operations. The fix must re-validate the flag atomically at the point of debit, not rely on a stale value from the job payload.

## Safe Patterns in This Codebase
```bash
# Search for existing protections
grep -rn "with_for_update\|FOR UPDATE" services/
grep -rn "MULTI\|pipeline\|transaction" services/
grep -rn "distributed_lock\|acquire_lock" services/
```

## Verify State Completeness
For every new state variable (counter, dict, set) introduced by the PR:
1. Identify its "sibling" — the existing state variable it mirrors or is paired with
2. `grep -n "sibling_variable_name"` in the same module/file
3. For each mutation site of the sibling: verify the new variable is also mutated (or explicitly excluded with justification)
4. Flag any site that mutates the sibling but NOT the new variable — this is a CONFIRMED finding (invariant violation, not a style issue)

Example: PR adds `_user_active_browsers`. Sibling is `_browser_active_count`. Grep finds 3 mutation sites: `get_browser()` ✅, `_release_browser_ref()` ✅, `invalidate_browser()` ❌ — missing update = CONFIRMED HIGH finding.

## Cancellation Safety — Prove, Don't Reason
When reviewing `asyncio.shield`, `asyncio.wait_for`, or `Task.cancel()` patterns:

1. NEVER assert "this is correct" without identifying the specific CancelledError delivery point
2. For `asyncio.shield`: the outer `await asyncio.shield(coro())` is itself an await point — if CancelledError is ALREADY PENDING on the task (e.g., injected by `asyncio.wait_for` timeout), it fires HERE before the inner coroutine starts. The shield does not protect against a pending cancellation.
3. For `asyncio.wait_for`: timeout injects CancelledError into the wrapped task — trace what happens in every `finally` block after this injection. Does any `finally` block contain an `await`? That await is also a cancellation point.
4. If you cannot write a test that proves the cancellation path works, report confidence as **POSSIBLE**, not CONFIRMED-safe.
5. Flag any `asyncio.shield` usage with: "Requires test: simulate CancelledError pending before shield await"

## Verify Before Claiming
- Check if the code you're analyzing is already protected by locks/transactions elsewhere
- Read the FULL function scope, not just the diff
- For state completeness: read ALL mutation sites of the sibling variable, not just the ones modified in the PR diff
- For asyncio patterns: identify the exact await point where CancelledError fires — do not reason about "what the code intends"

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Concurrency & Race Condition Audit

### Risk Level: [LOW/MEDIUM/HIGH/CRITICAL]

### Race Conditions Found
| Pattern | Location | Protected? | Confidence | Evidence |
|---------|----------|------------|------------|----------|
| read-modify-write | file:line | No | CONFIRMED | [code path] |

### Protections Searched For
- FOR UPDATE: [found/not found]
- Redis transactions: [found/not found]
- Distributed locks: [found/not found]
- Idempotency keys: [found/not found]

### Asyncio Cancellation Safety
| Pattern | Location | Outer await cancellation-safe? | Confidence | Evidence |
|---------|----------|-------------------------------|------------|----------|
| asyncio.shield | file:line | Yes/No/POSSIBLE — [explain CancelledError delivery point] | CONFIRMED/POSSIBLE | [code path] |

### State Completeness Check
| New Variable | Sibling Variable | Mutation Sites Found | All Sites Updated? |
|-------------|-----------------|---------------------|-------------------|
| [new_var] | [sibling_var] | [count] | Yes/No — [missing sites if No] |

### Files Reviewed
[List files checked]

---
*Concurrency audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:CONC-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `CONC`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — CONC Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Read-modify-write without locks | Item 1 | COVERED | |
| Non-atomic Redis operations | Item 2 | COVERED | |
| Missing FOR UPDATE on read-then-write | Item 3 | COVERED | |
| Shared state in async handlers | Item 4 | COVERED | |
| Job idempotency (double-billing) | Item 5 | COVERED | |
| Incomplete state mutation (new counter/dict) | Item 6 | COVERED | |
| Reservation TOCTOU (check-then-claim) | Item 7 | COVERED | #298 |
| Cross-service flag staleness | Item 8 | COVERED | #298 |
| asyncio.shield cancellation safety | Cancellation Safety | COVERED | |
| Distributed lock timeout / deadlock | — | GAP | |
| Connection pool exhaustion under concurrency | — | GAP | |

---

### Agent: Scraper Logic Auditor

**Trigger**: SCRAPING domain detected
**Type**: `codebase-explorer` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for domain-specific logic correctness in [PROJECT_NAME].

## Project Domain Architecture

[DOMAIN_CONTEXT]

If no domain context is configured above, derive the architecture from the changed files: read the primary consumer/worker/handler files to understand the execution model.

## What to Verify
1. **Tier selection**: Is the starting tier correct? Does escalation logic work?
2. **Tier-billing alignment**: Does `tier_used` match what's charged?
3. **Timeout handling**: Are timeouts configured correctly per tier?
4. **Error propagation**: Do scrape failures propagate correctly?
5. **Playbook authority**: Does `playbook_min_tier_is_authoritative` work as expected?
6. **Content validation**: Does escalation trigger on empty/blocked content?
7. **Detection keyword consistency**: If the PR modifies `CHALLENGE_KEYWORDS`, `COMMON_COOKIES`, or ANY frozenset/tuple/list of string identifiers used for bot detection, WAF markers, or anti-detection cookies in `anti_detection/`, `consumers/`, or `browser/`:
   - **Cross-reference sibling sets**: List all other detection-related constants in the worker service (`grep -rn "^[A-Z_]* = frozenset\|^[A-Z_]* = tuple\|^[A-Z_]* = \[" services/worker/worker/`). For each entry in the modified set, verify it appears in all relevant sibling sets. Flag any entry present in one set but absent from a functionally related sibling (e.g., `ak_bmsc` in `CHALLENGE_KEYWORDS` but not in `COMMON_COOKIES`).
   - **Intra-file comment/code drift**: Read the full file. For any identifier mentioned in comments, docstrings, or commit messages (e.g., `_abck`, `ak_bmsc`) that is NOT present in the actual set literal, flag it as a likely typo or omission. This is CONFIRMED HIGH — comments describe the intended state; the code contradicts it.
   - **Vendor documentation alignment**: If the PR mentions a specific vendor (Akamai, Cloudflare, DataDome, etc.), grep for the vendor's known markers across the entire worker service and verify the modified set is complete.
8. **Capacity constants**: Any hardcoded numeric constant defining memory limits, pool sizes, timeouts, or thresholds (e.g., `_BROWSER_ESTIMATED_MB = 200`, `MAX_BROWSERS = 5`, `POOL_SIZE = 10`):
   - Does the PR or commit message cite a measurement source (e.g., "observed peak 744-890MB", "benchmarked at N req/s", linked issue/PR)?
   - Search git history for prior art that may contradict the constant:
     ```bash
     # Search git log for related measurements — adapt keywords to the constant's domain
     git log --all -20 --oneline --grep="memory" --grep="browser" 2>/dev/null | head -10
     git log --all -20 --oneline --grep="$(echo {CONSTANT_NAME} | tr '_' ' ' | tr '[:upper:]' '[:lower:]')" 2>/dev/null | head -5
     # Check recent PRs that touched the same file for prior measurement context
     git log --oneline --all -20 -- {CHANGED_FILE} 2>/dev/null | head -10
     ```
   - If no measurement source is cited and git history contains contradicting data (e.g., a prior PR documenting real observed values): flag as **CONFIRMED** with note "Hardcoded constant contradicts measured data in git history — verify against production metrics before deploy"
   - If no measurement source is cited and no contradicting git history found: flag as **POSSIBLE** with note "Hardcoded constant without measurement annotation — verify against production metrics"
   - If a measurement source IS cited (comment, commit message, or linked issue): no flag needed
9. **API gate semantic correctness** (conditional — trigger: PR modifies any router file that gates existing request parameters behind a new condition):
   When a PR adds or changes a condition that gates a set of request fields behind a resource requirement (API key, feature flag, tier check), **verify independently for EACH parameter in the condition** whether it actually requires the gated resource:
   - For each field in the gate condition (`if request.X or request.Y:`, `if X and Y`): ask "Was this field previously handled without this gate? What is the behavioral change for existing users who send this field without satisfying the gate?"
   - Distinguish resource-dependent fields (e.g., those that invoke an external LLM or BYOK key at execution time) from resource-independent fields (those processed deterministically without the gated resource). A gate that covers both classes is incorrect — the resource-independent field must be routed separately.
   - Inspect the pre-existing code path for each field: search the router file and worker for the field's pre-change handling (`grep -rn "request\\.{field_name}" services/api/ services/worker/`). If the pre-existing path did NOT require the gated resource, the inclusion of that field in the gate is a **CONFIRMED HIGH** behavioral regression for existing callers.
   - If different fields in the condition reach different execution paths (one LLM-dependent, one not), the condition must be split — gate only the fields that require the resource.

   ```bash
   # Identify gate conditions in changed router files
   gh pr diff [PR_NUMBER] -- "services/api/app/routers/*.py" | grep "^\+" | grep -E "if request\.|if.*or.*request\." | head -20

   # For each gated field, check its pre-existing handling path
   # (adapt FIELD_NAME to each field appearing in the changed condition)
   git log --all --oneline -10 -- services/api/app/routers/ | head -10
   grep -rn "FIELD_NAME" services/api/app/ services/worker/worker/ | grep -v "^\s*#" | head -20
   ```
   <!-- Added: forge#382 -->
10. **Cross-component gate tracing** (conditional — trigger: PR touches both a router file that injects a field into a job payload AND a worker file that reads that field at execution time):
    When a worker-layer review identifies that a resource field (API key, LLM key, BYOK credential) is resolved at use-time from a job payload, the review MUST also trace to the API-layer gate condition that controls injection of that field. A gate can fail at the API layer for logic that executes at the worker layer — both components must be reviewed together.
    - Find the API router that creates the job payload and injects the field. Read the condition that controls whether the field is populated.
    - Verify the gate condition is semantically correct for ALL request fields that flow through it — not just the primary feature field.
    - If the API gate fires before job enqueue and the worker gate fires after dequeue, a misconfigured API gate will silently reject valid requests before the worker ever sees them.

    ```bash
    # Find all sites where the key/credential field is injected into the job payload
    grep -rn "byok_api_key\|llm_key\|extraction_key\|api_key" services/api/app/routers/ | grep -v "^\s*#" | head -20

    # For each injection site, read the surrounding conditional context (±15 lines)
    # Then cross-reference: what request fields trigger the injection condition?
    # Are ALL those fields genuinely dependent on the injected resource?

    # Check the worker consumption site for the same field
    grep -rn "byok_api_key\|llm_key\|extraction_key\|api_key" services/worker/worker/ | grep -v "^\s*#" | head -20
    ```
    <!-- Added: forge#382 -->

```bash
# Find all detection-related string constants in the worker service
grep -rn "^[A-Z_]* = frozenset\(\|^[A-Z_]* = tuple(\|^[A-Z_]* = \[" services/worker/worker/ 2>/dev/null

# For each modified set, check if its entries appear in sibling detection files
for f in [CHANGED_ANTI_DETECTION_FILES]; do
    grep -oE "'[a-z_][a-z0-9_-]{3,}'" "$f" | tr -d "'" | sort -u | while read entry; do
        grep -rl "'$entry'\|\"$entry\"" services/worker/worker/ | grep -v "^$f$" | grep '\.py$' || \
            echo "SCRP: '$entry' in $f not found in any sibling worker file — verify if cross-module sync needed"
    done
    # Check comment vs set drift
    grep -oE "#.*\`_?[a-z][a-z0-9_-]+\`" "$f" | grep -oE "\`[^']+\`" | tr -d '`' | while read ref; do
        grep -q "'$ref'\|\"$ref\"" "$f" || \
            echo "SCRP: '$ref' mentioned in comment in $f but absent from string sets — possible typo or omission (HIGH)"
    done
done
```

## Cross-Service Consistency
- API-side: Job creation, initial tier selection
- Worker-side: Actual execution, tier escalation, result handling
- Verify consistency between services

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Scraper Logic Audit

### Components Affected: [list the specific service/worker/api components touched — e.g. job-queue/rate-limiter/validation/gate-semantics/cross-component-gate]

### Tier Flow Analysis
[Trace the tier selection and escalation with file:line references]

### Detection Keyword Consistency
[If any detection set was modified: table of sibling sets checked, entries present/absent in each, comment/code drift found]
| Set Name | File | Entries | Missing from Sibling? | Comment Drift? |
|----------|------|---------|----------------------|----------------|
| CHALLENGE_KEYWORDS | file:line | N entries | [list missing] | [yes/no] |

### Capacity Constants
[If any capacity constants were added or modified: list each constant, its value, whether a measurement source was cited, and any contradicting git history]
| Constant | Value | Measurement Source Cited? | Git History Finding |
|----------|-------|--------------------------|---------------------|
| _BROWSER_ESTIMATED_MB | 200 | No | PR #4958 documented 744-890MB observed peak |

### API Gate Semantic Correctness
[If any router file gates request fields behind a new condition: for each field in the condition, state whether it requires the gated resource and whether the pre-existing behavior is preserved. "N/A — no gate condition changes in diff" is acceptable if no gate conditions changed.]

### Cross-Component Gate Tracing
[If worker layer injects or reads a resource field from the job payload: state the API-layer gate condition that controls injection, the fields it gates, and whether each field genuinely requires the gated resource. "N/A — no cross-component key/gate flow in diff" is acceptable if not triggered.]

### Findings
| Category | Issue | Location | Confidence |
|----------|-------|----------|------------|
| Tier logic | [issue] | file:line | CONFIRMED |
| Detection keywords | [issue] | file:line | CONFIRMED |
| Capacity constant | [issue] | file:line | POSSIBLE |
| API gate semantics | [issue] | file:line | CONFIRMED |
| Cross-component gate | [issue] | file:line | CONFIRMED |

### Cross-Service Consistency
[If changes span services, verify they're consistent]

### Files Reviewed
[List files checked]

---
*Scraper logic audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:SCRP-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `SCRP`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — SCRP Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Tier selection correctness | Item 1 | COVERED | |
| Tier-billing alignment | Item 2 | COVERED | |
| Timeout configuration per tier | Item 3 | COVERED | |
| Error propagation on scrape failure | Item 4 | COVERED | |
| Playbook authority logic | Item 5 | COVERED | |
| Content validation / escalation trigger | Item 6 | COVERED | |
| Detection keyword cross-set consistency | Item 7 | COVERED | |
| Capacity constant measurement verification | Item 8 | COVERED | |
| Cross-service consistency — tier logic (API vs Worker) | Cross-Service section | COVERED | |
| API gate semantic correctness per parameter | Item 9 | COVERED | forge#382 |
| Cross-component gate tracing (API gate ↔ worker injection) | Item 10 | COVERED | forge#382 |
| Playwright resource cleanup on failure | — | GAP | |
| Domain playbook override conflicts | — | GAP | |

---

### Agent: Frontend Quality Auditor

**Trigger**: WEB service touched
**Type**: `codebase-explorer` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for frontend quality in [PROJECT_NAME].

## Project Frontend Conventions

[DOMAIN_CONTEXT]

If no frontend context is configured above, derive conventions from the changed files: check package.json for framework versions and look at existing patterns in surrounding components.

## What to Check
1. **Server vs Client components**: Is 'use client' used appropriately? Could this be a Server Component instead?
2. **React lifecycle**: Missing useEffect cleanup (subscriptions, timers, AbortControllers not cancelled on unmount). This is the #1 frontend defect — causes memory leaks and stale state.
3. **useCallback/useMemo deps**: Dependencies must be stable values (ids, primitives), NOT full objects (SWR responses, arrays). An unstable dep causes infinite re-render loops.
4. **Data fetching**: Loading/error states handled, stale data invalidated, race conditions in parallel fetches
5. **Type safety**: Zod schemas match API response types, no `any` types. Check that component props match what the parent passes — wrong prop types (e.g., passing a component reference instead of a rendered element) cause build failures.
6. **Component imports**: Verify imported components actually exist. Check `@/components/ui/*` imports against what's installed via shadcn. Missing components pass `tsc` if types exist but fail `next build`.
7. **XSS**: User input rendered with `dangerouslySetInnerHTML` without sanitization
8. **Accessibility**: Interactive elements have proper labels, keyboard navigation works
9. **Performance**: Large bundles, unnecessary client-side rendering, missing dynamic imports
10. **Hook provider scope**: For any new `useX()` hook call added to a component, verify the hook is safe to call outside its provider. If `useX` internally calls `useContext(XContext)` and throws when context is undefined (i.e., the hook contains `if (!ctx) throw new Error(...)`), check ALL mount sites of the component across the codebase. If the component is used in both authenticated routes (e.g., `app/dashboard/`) AND public routes (e.g., `app/(public)/`, `app/playground/`) that do not wrap children in the provider, the hook call will crash the public route with a React error boundary cascade. Flag as CONFIRMED HIGH if a public mount site exists without the provider. <!-- Added: forge#381 -->

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Frontend Quality Audit

### Quality Level: [GOOD/ACCEPTABLE/NEEDS WORK]

### Findings
| Category | Issue | File:Line | Severity |
|----------|-------|-----------|----------|
| React | missing useEffect dep | file:line | MEDIUM |
| A11y | button without label | file:line | LOW |

### Component Architecture
[Server vs Client component usage assessment]

### Files Reviewed
[List files checked]

---
*Frontend quality audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:FE-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `FE`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — FE Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Unnecessary 'use client' directive | Item 1 | COVERED | |
| Missing useEffect cleanup (memory leaks) | Item 2 | COVERED | |
| Unstable useCallback/useMemo dependencies | Item 3 | COVERED | |
| Missing loading/error states | Item 4 | COVERED | |
| Type safety (Zod schema / prop mismatch) | Item 5 | COVERED | |
| Missing component imports (shadcn) | Item 6 | COVERED | |
| XSS via dangerouslySetInnerHTML | Item 7 | COVERED | |
| Accessibility (labels, keyboard nav) | Item 8 | COVERED | |
| Performance (bundle size, dynamic imports) | Item 9 | COVERED | |
| Hook outside provider scope (crash on public routes) | Item 10 | COVERED | forge#381 |
| Server Component data leakage to client | — | GAP | |
| Next.js App Router caching pitfalls | — | GAP | |

---

### Agent: API Design & Consistency Auditor

**Trigger**: New or modified routers/routes, OR SDK/OpenAPI files changed (`sdk/`, `openapi*.json`, `openapi-versions/`)
**Type**: `general-purpose` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for API design consistency in [PROJECT_NAME].

## Project API Conventions

[DOMAIN_CONTEXT]

If no API context is configured above, derive conventions from the changed files: read the main router/application entrypoint to understand registration patterns, and check neighboring endpoints for error format and naming conventions.

## What to Check
1. **Registration**: Is the new router registered in main.py?
2. **Schema completeness**: Request/response models defined? Types correct?
3. **Error handling**: Consistent error responses? HTTPException with proper status codes?
4. **Endpoint naming**: RESTful conventions? Consistent with existing endpoints?
5. **Query parameters**: Validated? Reasonable defaults?
6. **Response format**: Consistent with other endpoints in the same domain?
7. **External response type-safety**: Any code that consumes an external API response (HTTP client calls, SDK calls, third-party service responses) must guard against unexpected shapes. Flag direct dict/attribute access on an external response without a prior `isinstance` check or `None` guard — the response may be a dict, list, `None`, or an error string depending on the upstream service's behavior. Look for patterns like `data["key"]` or `data.field` immediately after `requests.get(...)`, `httpx.get(...)`, `await client.get(...)`, or similar calls without a guard. Exception: internal Pydantic-validated models are safe; only flag unvalidated external payloads.
8. **Code generator field coverage**: Any function that builds a code snippet, SDK usage example, or serialized representation of a model must include ALL fields defined in the relevant Pydantic model or schema. Flag generators where the field list is hardcoded rather than derived from the model, or where the model has gained new fields that the generator does not emit. Search for functions named `generate_*`, `build_snippet_*`, `get_code_*`, `example_*`, or similar that reference a model class — compare their emitted fields against the model's field list.
9. **New-field propagation**: When a PR adds a new field to a Pydantic model or database schema, verify that all downstream consumers are updated: serializers, snippet generators, SDK example builders, and any function that enumerates the model's fields. Search for all locations that reference the model class by name and check whether they handle the new field.

10. **Cross-PR SDK/schema consistency** (MANDATORY when PR touches `sdk/`, `openapi*.json`, or `openapi-versions/`): Documentation PRs that update SDK or OpenAPI files must be checked against recently-merged PRs to the same base branch. A concurrent schema PR may have already changed the API behavior being documented — producing contradictory docs that tell users to use methods the API now rejects.

    ```bash
    # Get the PR's base branch
    BASE=$(gh pr view [PR_NUMBER] --json baseRefName --jq '.baseRefName')

    # Find PRs merged to this base in the last 48 hours
    CUTOFF="$(date -u -d '48 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-48H +%Y-%m-%dT%H:%M:%SZ)"
    RECENT_MERGED=$(gh pr list --base "$BASE" --state merged --limit 20 \
      --json number,title,mergedAt,files \
      2>/dev/null | jq --arg cutoff "$CUTOFF" \
      '.[] | select(.mergedAt > $cutoff) | {number, title, schema_files: [.files[].path | select(test("schemas?/|scrape\\.py|models\\.py"))]}' \
      2>/dev/null | head -40)

    echo "Recent merged PRs to $BASE (last 48h): $RECENT_MERGED"

    # For each recent PR that touched schema files, check if Literal types changed
    for PR_NUM in $(echo "$RECENT_MERGED" | grep -oP '"number":\s*\K\d+'); do
      SCHEMA_DIFF=$(gh pr diff "$PR_NUM" 2>/dev/null | grep -E '^\+.*Literal\[|^\-.*Literal\[' | grep -v '^\+\+\+\|^---')
      if [ -n "$SCHEMA_DIFF" ]; then
        echo "SCHEMA CHANGE in PR #$PR_NUM (already merged to $BASE):"
        echo "$SCHEMA_DIFF"
        echo "--- Verify this PR's SDK/OpenAPI docs are consistent with the above Literal change ---"
      fi
    done
    ```

    For each schema Literal change found in recently-merged PRs:
    - Read the diff of THIS PR (PR [PR_NUMBER]) to see what values the SDK/OpenAPI files now document
    - If this PR's SDK documentation still lists values that the schema change removed (e.g., SDK JSDoc says `DELETE` is supported but schema now only accepts `GET`/`POST`) → this is a **CONFIRMED HIGH** finding
    - If this PR's SDK documentation says DELETE is "use with caution" but the schema already returns 422 for DELETE → this is a **CONFIRMED HIGH** finding (false reassurance)
    - Pattern: `sdk/*/client.py` `_valid_methods` list, TypeScript JSDoc `@param` literals, `openapi*.json` enum arrays — all must be consistent with the API schema's current `Literal[...]` type

## Cross-Reference
```bash
# See how existing routers are structured
grep -rn "APIRouter\|include_router" services/api/app/
# Check existing patterns
ls services/api/app/routers/
# Find external response consumers (unguarded dict/attribute access after HTTP calls)
grep -rn "\.get\|\.post\|\.put\|\.delete\|httpx\|requests\." services/api/app/ | grep -v "test_\|#"
# Find code/snippet generators
grep -rn "def generate_\|def build_snippet\|def get_code_\|def.*example\b" services/api/app/ services/worker/
# Find all locations that reference a modified model class
grep -rn "{ModelClassName}" services/api/app/ services/worker/ web/src/
# SDK method lists (for cross-PR check #10)
grep -rn "_valid_methods\|Literal\[" sdk/ 2>/dev/null | head -20
grep -rn "Literal\[" services/api/app/schemas/ 2>/dev/null | head -20
```

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## API Design & Consistency Audit

### New/Modified Endpoints
| Endpoint | Method | Registered? | Schema? | Auth? | Consistent? |
|----------|--------|-------------|---------|-------|-------------|
| /path | POST | Yes/No | Yes/No | Yes/No | Yes/No |

### Consistency Issues
[Any deviations from established patterns]

### Files Reviewed
[List files checked]

---
*API design audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:API-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `API`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — API Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Unregistered router | Item 1 | COVERED | |
| Missing request/response schema | Item 2 | COVERED | |
| Inconsistent error handling | Item 3 | COVERED | |
| Non-RESTful endpoint naming | Item 4 | COVERED | |
| Unvalidated query parameters | Item 5 | COVERED | |
| Inconsistent response format | Item 6 | COVERED | |
| External response type-safety | Item 7 | COVERED | |
| Code generator field coverage drift | Item 8 | COVERED | |
| New-field propagation to consumers | Item 9 | COVERED | |
| Cross-PR SDK/schema consistency | Item 10 | COVERED | #190 |
| API versioning contract breaks (v1 vs v2) | — | GAP | |
| Pagination contract consistency | — | GAP | |

---

### Agent: Database & Migration Auditor

**Trigger**: DATABASE domain detected
**Type**: `general-purpose` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for database changes in [PROJECT_NAME].

[DOMAIN_CONTEXT]

## What to Check
1. **SQL correctness** (CHECK FIRST — a query that errors at runtime breaks the whole page):
   - **Ambiguous references**: `SELECT t.col, t.*` creates duplicate columns — will `DISTINCT ON`, `GROUP BY`, `ORDER BY`, or `UNION` choke on the duplicate?
   - **Column visibility**: CTEs and subqueries that produce duplicate column names, then are referenced by `SELECT *`
   - **Type mismatches**: Comparing UUID to text, integer to string without cast
   - **Invalid aggregations**: Non-aggregated columns in SELECT with GROUP BY
   - **Mental-execute the query**: Read the full SQL top-to-bottom. What columns does each CTE produce? What does the final SELECT see? Would PostgreSQL accept this or throw an error?
2. **Migration safety**: Can this run on a live database without downtime?
   - `ALTER TABLE ... ADD COLUMN ... NOT NULL` without `DEFAULT` → table lock + failure on existing rows
   - `DROP TABLE/COLUMN` without `IF EXISTS` → fails on fresh DBs
   - Large table operations → may lock for minutes
3. **Reversibility**: Is there a rollback path?
4. **Index usage**: New queries without indexes on filtered/joined columns? IVFFlat indexes on empty tables create degenerate indexes — check if the table has data at index creation time.
5. **Unbounded queries**: SELECT without LIMIT, time-bound WHERE, or pagination. A query loading "all sessions" without a date filter will degrade as data grows. Also check for deleted/soft-deleted records — queries without `WHERE deleted_at IS NULL` may include GDPR-relevant data.
6. **N+1 queries**: Loop fetching rows one at a time instead of batch?
7. **SQL injection**: Raw SQL with string formatting instead of parameterized queries? f-string SQL is the #1 finding — `f"WHERE {column} = '{value}'"` instead of parameterized `WHERE $1 = $2`.
8. **Migration number collisions (CRITICAL — full-tree scan required)**:
   This check is structurally different from the others — it must scan the **entire `infra/migrations/` directory**, not just files in the PR diff. Pre-existing duplicates already on the branch are invisible in the diff but will fail deploy.
   Steps:
   a. List ALL `*.sql` files in `infra/migrations/` on the PR's target branch (use `git ls-tree` or `ls`)
   b. Extract the 4-digit numeric prefix from each filename (the leading digits before the first `_`)
   c. Identify any prefix that appears more than once
   d. Identify if the project maintains a grandfathered-duplicates allowlist (e.g., a config file or comment block listing known-safe legacy duplicate prefixes). If one exists, cross-reference against it. <!-- Updated: forge#1349 — removed stale validate-migration-order.sh reference (script does not exist in ForgeDock) -->
   e. **DEPLOY GATE — CRITICAL**: If ANY non-allowlisted duplicate prefix exists → flag as **CRITICAL BLOCKER** and reject the PR. **Do NOT apply migration runner reasoning here.** Deploy gates that enforce migration ordering hard-fail on any non-allowed duplicate regardless of whether the migration runner executes files correctly. The runner may handle duplicate filenames fine; the deploy script does not. A PR that passes this reasoning trap ("unique filenames, so the runner is safe") will still halt production deploy. The only safe classification is CRITICAL BLOCKER.
   f. Additionally: if the PR adds new migration files, verify their prefixes don't collide with existing files in the directory
9. **FK and CHECK constraints**: New tables should have appropriate foreign keys and CHECK constraints. Missing FK allows orphaned rows; missing CHECK allows invalid enum values.
10. **asyncpg gotchas**:
   - Must use `CAST(:param AS type)` for nullable params (asyncpg can't infer NULL types)
   - `::jsonb` after `:param` conflicts with SQLAlchemy binding — use `CAST(:param AS jsonb)`

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Database & Migration Audit

### Migration Safety: [SAFE/CAUTION/DANGEROUS]

### Findings
| Issue | Location | Severity | Evidence |
|-------|----------|----------|----------|
| ... | file:line | HIGH | [explanation] |

### Migration Review
[For each SQL file: what it does, is it safe, is it reversible?]

### Files Reviewed
[List files checked]

---
*Database audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:DB-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `DB`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — DB Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Ambiguous column references / duplicate cols | Item 1 | COVERED | |
| Type mismatches in SQL (UUID vs text) | Item 1 | COVERED | |
| Migration safety (NOT NULL without DEFAULT) | Item 2 | COVERED | |
| Migration reversibility | Item 3 | COVERED | |
| Missing indexes on filtered/joined columns | Item 4 | COVERED | |
| Unbounded queries (no LIMIT, no date filter) | Item 5 | COVERED | |
| N+1 query patterns | Item 6 | COVERED | |
| SQL injection (f-string SQL) | Item 7 | COVERED | |
| Migration number collisions | Item 8 | COVERED | #222 |
| Missing FK / CHECK constraints | Item 9 | COVERED | |
| asyncpg parameter casting | Item 10 | COVERED | |
| ORM field rename without migration | — | GAP | #240 |
| Ghost migration (rename-to-fill-gap) | — | GAP | #227 |

---

### Agent: Infrastructure & Deploy Safety Auditor

**Trigger**: INFRA service touched
**Type**: `general-purpose` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for infrastructure and deployment safety in [PROJECT_NAME].

## Deployment Architecture

[DOMAIN_CONTEXT]

If no infra context is configured above, derive the deployment model from the changed files: read docker-compose files, GitHub Actions workflows, and entrypoint scripts to understand the deployment pipeline.

## What to Check
1. **Downtime risk**: Will this change cause container restarts during deploy?
1b. **Database container restart risk** (when `docker-compose*.yml` changes touch the `postgres` or `redis` service — `command:`, `image:`, `volumes:`, `environment:`):
   Changing any of these fields forces container recreation on `docker-compose up`. For stateful services this is **HIGH risk by default** — regardless of how simple the config change appears.
   **Auto-escalate Deploy Risk to HIGH** when this trigger fires. Then verify ALL of the following:
   - Is `full_page_writes = on` in the PG config? (Protects against partial page writes if shutdown is not clean)
   - Is `fsync = on`? (Ensures writes are durable to disk)
   - Is `stop_grace_period` set in docker-compose and sufficient (≥30s for Postgres)? If absent, Docker sends SIGKILL after 10s default — too short for PG to flush WAL and checkpoint.
   - Are there likely active long-running transactions (migrations, bulk imports, analytics queries) that will be interrupted?
   - Is the deploy blue-green for THIS container, or will PG/Redis be hard-restarted? (Typically stateful containers are NOT blue-green — they are singletons that get recreated in-place.)
   **Recommendation**: Postgres/Redis restarts should NOT happen as a side effect of a routine deploy. Recommend:
   - Schedule the restart during a **maintenance window** (low-traffic hours)
   - OR split the change: deploy the stateful config change as a **separate manual operation** with monitoring
   - Verify backups are current before any PG restart
   A Postgres container restart under active write load can corrupt btree indexes and bypass UNIQUE constraints — the database may return to a consistent state but with structural damage that only surfaces on subsequent writes or queries. <!-- Added: forge#146 -->
1c. **Functional equivalence on config mechanism change** (when a stateful service's `command:` or `entrypoint:` changes structurally — e.g., inline args → script, or vice versa):
   The old and new configurations MUST produce the same runtime behavior. Verify:
   - Extract the effective config from the OLD approach (parse `command:` args or previous entrypoint)
   - Extract the effective config from the NEW approach (parse new entrypoint/script + env vars)
   - Diff them — flag any settings that changed, disappeared, or gained new defaults
   - **Env var delivery mechanism**: When `command:` uses `${VAR}` (Compose interpolation, host-side parse time) and the new approach uses an entrypoint script that reads `${VAR}` (shell, container runtime), the var MUST be explicitly passed via `environment:` or `env_file:`. Compose interpolation does NOT inject the var into the container — it resolves it before the container starts. If the entrypoint reads `$VAR` but no `environment:` block passes it, the var will be empty inside the container. **This is a CONFIRMED BLOCKING finding.**
   Compose interpolation (`${VAR}` in `command:`) resolves the variable at parse time on the host before the container starts — it does NOT inject the variable into the container's environment. If the new entrypoint script reads `$VAR` but no `environment:` block passes it, the variable will be empty inside the container. This is a silent misconfiguration that only surfaces at deploy time. <!-- Added: forge#185 -->
2. **Blue-green compatibility**: Do old and new versions work simultaneously?
   - API responses compatible?
   - Database schema works with both versions?
   - Redis keys compatible?
   - Queue message formats compatible?
3. **Rollback path**: Can we revert if something goes wrong?
4. **Prerequisites**: New env vars, secrets, DNS changes needed before deploy?
5. **In-flight requests**: Will active scrape jobs, webhooks, or billing transactions be affected?
6. **Health endpoint response contract breakage** (when the PR diff includes changes to route handlers for health, status, ping, liveness, or readiness endpoints — search for changed Python functions decorating paths matching `/health`, `/status`, `/ping`, `/ready`, `/live`, `/readiness`, `/liveness`):
   A PR that changes the response body shape of a health/status endpoint can silently break any downstream consumer that pattern-matches on the old response format — deploy scripts, CI healthchecks, docker-compose healthcheck definitions, monitoring configs, and Traefik probes. These consumers are rarely in the same file as the endpoint handler and are often missed during code review.

   **Scan all consumer locations for references to the old response format:**
   ```bash
   # Identify old response field values from the diff
   OLD_VALUES=$(gh pr diff [PR_NUMBER] | grep "^\-" | grep -oP '"status"\s*:\s*"\K[^"]+' | sort -u)

   # Search all non-application consumer locations for those old values
   while IFS= read -r val; do
       [ -z "$val" ] && continue
       echo "=== Searching for old response value: $val ==="
       grep -rn "$val" scripts/ infra/ .github/ traefik/ 2>/dev/null | grep -v "^Binary"
       grep -rn "$val" docker-compose*.yml 2>/dev/null
   done <<< "$OLD_VALUES"

   # Also search for endpoint path references in consumer locations
   HEALTH_PATHS=$(gh pr diff [PR_NUMBER] | grep "^\+" | grep -oP '@\w+\.(?:get|post)\("\K[^"]+(?:health|status|ping|ready|live|readiness|liveness)[^"]*')
   while IFS= read -r path; do
       [ -z "$path" ] && continue
       grep -rn "$path" scripts/ infra/ .github/ traefik/ docker-compose*.yml 2>/dev/null | grep -v "^Binary"
   done <<< "$HEALTH_PATHS"
   ```

   **For each hit, classify:**
   - `grep -q "old_value"`, `if echo "$resp" | grep "old_value"`, jq filter on a now-missing field, or string comparison against an old response key value: **CONFIRMED BLOCKING** — the consumer will fail silently or return a false negative after deploy
   - Variable set from response field, then used in a conditional: **CONFIRMED BLOCKING** — behavior change is guaranteed
   - Log or comment referencing old value: **OK** — cosmetic only, no behavioral impact

   **Severity**: CONFIRMED BLOCKING for any behavioral consumer. A deploy that rolls out the new response format while a deploy script still checks for the old format will cause the deploy's own health gate to reject healthy containers, forcing an automatic rollback.

   **Recommended fix**: Update ALL behavioral consumers in the same PR as the endpoint change. If a consumer is in a deploy script or CI workflow, updating it after the endpoint change has already shipped creates a window where every deploy will roll back.

   A response contract change that updates only the endpoint while leaving downstream consumers on the old format is equivalent to a breaking API change deployed without a migration path — the breakage surfaces at the worst possible time: during a production deploy. <!-- Added: forge#321 -->

7. **Secret delivery chain** (when `decrypt-secrets.sh`, `.secrets/prod.enc.yaml`, or deploy workflows change):
   Trace the FULL path a secret takes from SOPS to a running container. Read these files and verify consistency:
   - `.secrets/prod.enc.yaml` — the SOPS key name under its section (e.g., `oauth.discord_client_id`)
   - `scripts/decrypt-secrets.sh` — the ENV_MAPPING tuple must match the SOPS path (e.g., `("oauth", "discord_client_id")`)
   - `.github/workflows/deploy-production.yml` — the SCP `target:` path and the merge step's `PROJECT=` variable
   - `.github/workflows/hotfix-deploy.yml` — same paths, must be consistent with main deploy
   - `docker-compose.prod.yml` — `env_file:` must point to the same `.env.production` the merge step writes to
   **Critical check**: If the workflow appends `/app` to `PRODUCTION_PROJECT_PATH`, and that secret already includes `/app`, secrets will silently go to a wrong directory. Verify the SCP target resolves to the SAME file that `docker-compose.prod.yml` env_file reads.
   **Do NOT just verify naming consistency** — verify the filesystem paths are correct end-to-end.
7b. **Shell metacharacter safety in .env writers** (when `decrypt-secrets.sh` or any script that writes values to `.env` or shell-sourceable config files is touched):
   Secret values can contain any character — passwords, API keys, and OAuth tokens frequently contain `;`, `!`, `|`, `&`, `(`, `)`, `{`, `}`, backticks, and other bash metacharacters. If a script that generates `.env` files uses an **allowlist-based quoting approach** (checking for a specific subset of special characters before deciding whether to quote), it will silently write unquoted values for any character not in the list. When the deploy pipeline sources that file, bash interprets the metacharacter as a command separator, causing exit 127 or command-not-found errors.

   **What to look for**: In the diff for any script that writes `KEY=VALUE` lines to `.env` or shell-sourceable files:
   - Search for quoting logic: `if any(c in value for c in ...)`, character-set checks, or regex allowlists
   - If the script decides whether to quote based on whether the value contains characters from a hardcoded list: this is an allowlist-based approach
   - Check whether the allowlist includes ALL bash metacharacters: `;`, `!`, `|`, `&`, `(`, `)`, `{`, `}`, `` ` ``, `<`, `>`, `\n`, `\t`, `$`, `"`, `'`, `#`, `\`, and space. If ANY of these are missing from the allowlist: **CONFIRMED HIGH**

   **Safe pattern**: The only safe approach is **unconditional double-quoting** of all values. The output line must always be `KEY="VALUE"` — never `KEY=VALUE` without quotes. If the script conditionally skips quoting for any value, flag it.

   **Severity classification**:
   - Allowlist-based quoting with incomplete metacharacter set: **CONFIRMED HIGH** — any secret containing a missing metachar breaks `source .env.production` at deploy time
   - `source`/`.` command on an env file without `set -e` or error handling: **LIKELY MEDIUM** — a bad value causes a silent no-op instead of a visible deploy failure

   **Recommended fix**: Replace the conditional quoting block with unconditional double-quoting:
   ```python
   # FRAGILE — allowlist will miss metacharacters
   if any(c in value for c in (' ', '$', '"', "'", '\n', '\t', '#', '\\')):
       f.write(f'{key}="{value}"\n')
   else:
       f.write(f'{key}={value}\n')

   # SAFE — always double-quote
   f.write(f'{key}="{value}"\n')
   ```

   An allowlist-based quoting approach in a secret-decryption script will silently fail for any metacharacter not in the list. Secret values (passwords, API keys, OAuth tokens) can contain any character — allowlists are guaranteed to be incomplete. The only safe approach is always-quote. <!-- Added: forge#286 -->
8. **Cross-domain service interactions** (when shell scripts curl/wget internal services):
   For every `curl` or `wget` command in changed shell scripts that targets an internal service (API, worker, Redis, Postgres), trace the HTTP request through the target application's middleware stack:
   - Read `services/api/app/main.py` — check `TrustedHostMiddleware` allowed_hosts list. Does the curl's `Host` header value match an allowed entry? (Default `Host` is the URL hostname — a bare container IP like `172.18.0.x` is NOT `localhost`.)
   - Check auth requirements — does the target endpoint require API keys or session tokens?
   - Check the URL path — does the endpoint actually exist at that path?
   - **If the curl would be rejected** (wrong Host header, missing auth, wrong path): flag as CONFIRMED finding. A health check or monitoring script that gets 400/401/404 instead of 200 produces false alerts.
   **Do NOT assume a curl will succeed just because the URL is syntactically valid** — read the target service's code to verify.
9. **Sibling workflow drift** (ALWAYS check for staging→main PRs; also check when ANY `.github/workflows/*.yml` file changes):
   Multiple workflows contain jobs with the same logical purpose (e.g., `test-api` exists in both `ci.yml` and `deploy-production.yml`).
   **For staging→main PRs, ALWAYS read both `ci.yml` and `deploy-production.yml` and compare shared jobs — even if neither file changed.** Pre-existing drift is the most dangerous kind: a PR can be approved with green CI while `deploy-production.yml` is missing env vars or install steps that `ci.yml` has, causing failures only at deploy time — not during testing.
   - Read both files. For each shared job (test-api, test-web): compare PYTHONPATH values on every step, dependency install steps (count + content), step names present in one but not the other
   - **Any env var, path, install step, or command present in one but missing from the sibling is CONFIRMED BLOCKING drift** — CI passes but deploy fails
   - Common siblings: `ci.yml` ↔ `deploy-production.yml` (share `test-api`, `test-web` jobs), `deploy-production.yml` ↔ `hotfix-deploy.yml` (share build/deploy logic)
   **This is the #1 cause of "CI passed but deploy failed" incidents.** Do not skip this check.
10. **Deploy scope awareness** (ALWAYS run — checks whether ALL changed services will actually be deployed):
   This project may have multiple deploy pipelines. Check which pipelines cover which services:

   ```bash
   # List all GitHub Actions workflows
   ls .github/workflows/
   # List all paths changed in this PR
   gh pr diff [PR_NUMBER] --name-only
   ```

   For each changed path: read the `.github/workflows/` directory to determine which workflow deploys it and whether it's auto-triggered or requires manual action. If any changed service path is NOT covered by an auto-triggered workflow on merge:
   - Flag as CONFIRMED BLOCKING finding
   - Verdict: `BLOCK — Deploy prerequisite: manually trigger [workflow] for [service names] before or after this deploy`
   - Rationale: Services not covered by the auto-deploy pipeline will not be updated on merge, leaving a broken contract between deployed and un-deployed layers.

   If `[DOMAIN_CONTEXT]` above contains a deploy pipeline table, use it as the authoritative source for path → pipeline mapping.
11. **Config field type/doc-comment consistency** (when the diff introduces new pydantic-settings fields):
   When a new env var is introduced as a pydantic-settings field with a collection type (`list[str]`, `List[str]`, `set[str]`, `Set[str]`), cross-reference the field's type annotation against the format hint documented in `.env.example`. **pydantic-settings v2 parses collection-type fields via `json.loads()` — they require JSON array format like `["a","b"]`, NOT comma-separated format like `a,b`**. A doc comment saying "comma-separated" on a `list[str]` field is a CONFIRMED HIGH finding — it guarantees a startup crash for anyone following the documented format.
   ```bash
   # Find new pydantic-settings fields with collection types in the diff
   gh pr diff [PR_NUMBER] | grep "^\+" | grep -E ":\s*(list|List|set|Set)\[str\]" | grep -oP "[A-Z_]{3,}(?=\s*:)" | sort -u
   # For each field, find its .env.example entry and read the format documentation
   for field in $COLLECTION_FIELDS; do
       echo "=== $field ==="
       grep -A5 "$field" .env.example 2>/dev/null
   done
   ```
   If the `.env.example` comment says "comma-separated", "CSV", or shows a bare `a,b,c` example value for a `list[str]` field: **CONFIRMED HIGH** — the documented format crashes pydantic-settings v2 on startup. The fix is to update `.env.example` to show JSON format (`["a","b","c"]`) as primary, OR add a custom settings source that handles CSV as a fallback.
   pydantic-settings v2 parses `list[str]` fields via `json.loads()` — it requires JSON array format. A `.env.example` comment saying "comma-separated" on a `list[str]` field is a guaranteed startup crash for any operator who follows the documented format. The type annotation and the documented format must agree. <!-- Added: forge#190 -->
12. **appleboy/ssh-action Go template safety** (when `.github/workflows/*.yml` changes include `appleboy/ssh-action` steps):
   The `appleboy/ssh-action` action processes every `script:` field through Go's `text/template` engine **client-side, before SSH transmission**. Any `{{` in the script — including in comments, `docker ps --format` strings, and `docker inspect --format` strings — is interpreted as a Go template directive. If the expression does not resolve against the action's data context (which is an empty map for `appleboy/ssh-action`), the step exits with status 1 **before the script reaches the remote shell**. Shell error handlers (`|| fallback`, `2>/dev/null`, `set -e`) are completely bypassed. If `continue-on-error: true` is set, GitHub Actions will report overall success — masking the failure silently.

   **Scan ALL `{{` occurrences in every `script:` block of every `appleboy/ssh-action` step in changed files:**
   ```bash
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       if grep -q "appleboy/ssh-action" "$f"; then
           echo "=== appleboy/ssh-action found in $f ==="
           # Show all {{ occurrences with line numbers
           grep -n "{{" "$f"
       fi
   done < <(gh pr diff [PR_NUMBER] --name-only | grep -E '\.github/workflows/.*\.yml$')
   ```

   **For every `{{` found, classify and flag:**
   - `{{index .X Y}}` or any function call form: **CONFIRMED BLOCKING** — Go template function calls fail on empty context
   - `{{.FieldName}}` (field accessor, e.g., `{{.Names}}`, `{{.Status}}`): **CONFIRMED BLOCKING** — field accessors fail when the field does not exist on the data context. Do NOT assume field accessors are safe just because they look simpler than function calls. Both forms crash the template engine on an empty context.
   - `{{ range ... }}`, `{{ if ... }}`, `{{ with ... }}`: **CONFIRMED BLOCKING** — control flow directives

   **Safe replacements:**
   - `docker inspect --format '{{index .RepoTags 0}}'` → `docker inspect IMAGE | jq -r '.[0].RepoTags[0]'`
   - `docker ps --format '{{.Names}}'` → `docker ps --format json | jq -r '.Names'`
   - `docker ps --format '{{.Status}}'` → `docker ps --format json | jq -r '.Status'`

   Both function call forms (`{{index .X Y}}`) and field accessor forms (`{{.FieldName}}`) fail on `appleboy/ssh-action`'s empty data context. A partial fix that replaces only one form while leaving the other is insufficient — search for ALL `{{` occurrences, not just the specific form that triggered the initial investigation. <!-- Added: forge#226 -->

13. **Insecure config file defaults** (when any `traefik/`, `infra/nginx/`, `infra/`, or CI config file is in the diff):
   Config files that use shell-style variable substitution with fallback values (`${VAR:-default}`) are safe only when the fallback itself is safe. The INFRA agent checks whether the env var is delivered to the container (items 7 and 7b) — but does NOT check whether the fallback value is a credential placeholder that becomes active if the env var is absent in production.

   **Scan changed config files for credential fallbacks:**
   ```bash
   CONFIG_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "(traefik/|infra/nginx/|infra/|\.github/workflows/).*(\.ya?ml|\.toml|\.json|\.conf|\.ini)$" | head -20)
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       # Shell-style fallback: ${VAR:-default} — filter out safe non-credential defaults
       grep -nE "\$\{[A-Z_]+:-[^}]{4,}\}" "$f" | grep -ivE "(localhost|127\.0\.0\.1|0\.0\.0\.0|true|false|^[0-9]+$|/tmp|/var|/etc)" | head -20
   done <<< "$CONFIG_FILES"
   ```

   **For each hit, classify the fallback value:**
   - Fallback matches `\$apr1\$`, `\$2b\$`, `\$bcrypt\$`, `\$argon2`, or any hash-like string (long alphanumeric with `$` separators): **CONFIRMED HIGH**
     - Rationale: htpasswd/bcrypt/apr1 entries are placeholder credentials. If the env var is absent in any environment, the placeholder is active and may be guessable if derived from a weak password.
     - Required: Replace with `${VAR}` (no fallback) AND verify the var is required in `env_validation.py`.
   - Fallback is an empty string (`${VAR:-}` or `${VAR:-""}`): **CONFIRMED HIGH** if the field controls authentication
     - Rationale: empty auth = no auth for the service protected by the config.
   - Fallback is a weak/example credential string (`admin`, `password`, `changeme`, `secret`, `test`, `demo`): **CONFIRMED HIGH**
     - Rationale: default credentials are the first thing an attacker tries; a placeholder that ships as default is permanently vulnerable unless the env var is proven present in all environments.
   - Fallback is a non-credential value (port number, hostname, path): **OK** — no action needed.

   **Cross-check when a credential fallback is found:**
   1. Is the corresponding env var required (not optional) in `app/env_validation.py` (or equivalent startup validation)?
   2. Is the env var in `scripts/decrypt-secrets.sh` ENV_MAPPING (if configured in your SOPS deploy chain — skip if absent; delivered from SOPS to `.env.production`)?
   3. Is the env var documented with a "REQUIRED" note in `.env.example`?

   If ANY of these three are missing: the env var may legitimately be absent in some environments, making the insecure fallback active. Flag as **CONFIRMED HIGH** with all three cross-check results.

   **Recommended fix**: Remove the fallback entirely (`${VAR}` not `${VAR:-placeholder}`) and make the env var required in `env_validation.py`. If the service cannot start without the credential, a startup crash is safer than running with a default credential.

   The INFRA agent's secret delivery chain verification (env var present in ENV_MAPPING) does NOT verify whether the fallback value is safe. A config file can pass all delivery chain checks while still containing an active placeholder credential for any environment where the env var is absent. This check targets that gap. <!-- Added: forge#301 -->

14. **Host-side database tool invocations in deploy scripts** (when `.github/workflows/*.yml`, `scripts/deploy*.sh`, or any deploy entrypoint script in the diff invokes `psql`, `createdb`, or `pg_dump` directly on the host):
   Host-side `psql`, `createdb`, and `pg_dump` connect to PostgreSQL via the host's port binding (`localhost:5432` or `127.0.0.1:5432`). In SSH-based deploy contexts, the host-side port mapping to PostgreSQL's Docker container is unreliable — the listening address may differ from what the SSH session can reach, and the mapping is not guaranteed to be present at all in hardened host configurations. The safe pattern is to use `docker exec <postgres-container>` for all database operations in deploy scripts.

   To find the correct container name, grep the project's docker-compose files:
   ```bash
   grep -n "container_name" docker-compose*.yml | grep -i "postgres\|pg\|db"
   ```
   Use the container name found (referred to as `[DB_CONTAINER]` in examples below).

   **Scan for host-side database tool invocations:**
   ```bash
   DEPLOY_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "(\.github/workflows/.*\.yml$|scripts/deploy.*\.sh$|docker-entrypoint.*\.sh$)")
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       grep -n "\bpsql\b\|\bcreatedb\b\|\bpg_dump\b\|\bpg_restore\b" "$f" | grep -v "docker exec" | head -20
   done <<< "$DEPLOY_FILES"
   ```

   **For each match, classify:**
   - `psql`, `createdb`, `pg_dump`, or `pg_restore` called directly (not via `docker exec`): **CONFIRMED HIGH**
     - Rationale: Host-side port mappings to PostgreSQL's Docker container are unreliable in SSH deploy contexts. A deploy step that fails to connect leaves post-deploy database setup incomplete — silently if `continue-on-error: true` is set, or rolls back a successful deploy if not.
     - The safe pattern: `docker exec [DB_CONTAINER] psql -U $POSTGRES_USER -d $POSTGRES_DB -c "..."` or `docker exec [DB_CONTAINER] createdb -U $POSTGRES_USER $DB_NAME`
   - `psql`/`createdb`/`pg_dump` called inside `docker exec [DB_CONTAINER] ...`: **OK** — this is the safe pattern.

   **Recommended fix**: Replace host-side invocations with `docker exec [DB_CONTAINER]` equivalents:
   - `psql -h localhost -U $USER -d $DB -c "..."` → `docker exec [DB_CONTAINER] psql -U $USER -d $DB -c "..."`
   - `createdb -h localhost -U $USER $DB_NAME` → `docker exec [DB_CONTAINER] createdb -U $USER $DB_NAME`
   - `pg_dump -h localhost -U $USER $DB` → `docker exec [DB_CONTAINER] pg_dump -U $USER $DB`

   Host-side port bindings to Docker containers are unreliable in SSH deploy contexts. Deploy scripts that invoke database tools directly cannot depend on `localhost:5432` being reachable; the same operation via `docker exec` bypasses the host network entirely and always succeeds when the container is running. <!-- Added: forge#322 -->

15. **External tool config schema validation** (when any config file consumed by an external tool is in the diff — trigger: files under `traefik/`, `infra/nginx/`, `k8s/`, `terraform/`, `*.conf`, `*.toml`, or any `docker-compose*.yml` with non-trivial changes to service definitions):

   **Principle: Logical correctness ≠ structural correctness.** A config can have the right values in the wrong nesting and be silently rejected by the external tool — producing zero error logs in some tools (e.g. Traefik v3 ignores unrecognized nesting silently). The INFRA agent must verify both dimensions:
   - **Logical correctness** (covered by existing checks): Are the values coherent? Do names match across files? Is the wiring consistent with the deploy pipeline?
   - **Structural correctness** (this check): Does the YAML/TOML/HCL structure match what the tool's actual schema expects? Are directives nested at the correct depth? Do required parent keys exist?

   **For each external tool config file in the diff**:

   1. **Identify the tool and version**: Read the `image:` tag in `docker-compose*.yml` for the tool (e.g., `traefik:v3.1`, `nginx:1.25`). If the tool version cannot be determined from the diff, note it as unknown.

   2. **Reason about the schema**: Ask — "Does this change's structure match what `{tool} {version}` actually expects?" Key questions:
      - Is this directive/key nested under the correct parent section?
      - Does this version of the tool use a different config syntax than a prior version? (Version migrations often change required nesting — e.g., Traefik v2 → v3 moved many config keys to different parent sections)
      - Are any required sibling keys missing from the changed section?
      - Does the tool expect this value at file scope, or under a named block?

   3. **Cross-reference against sibling config files**: If the project uses dynamic config loading (e.g., `traefik/dynamic/`), verify that a key defined in the static config is not also required in the dynamic config (or vice versa) for the feature to activate.

   4. **Flag structural mismatches**: If any key or nesting does not match the tool's expected schema for the declared version, flag as **CONFIRMED HIGH**. Structural config mismatches are silently rejected at runtime — no startup crash, no error log, the feature simply does not activate.

   ```bash
   # Identify tool config files in the diff
   CONFIG_TOOL_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E \
     "(traefik/|infra/nginx/|k8s/|terraform/|.*\.conf$|.*\.toml$)" | head -20)
   COMPOSE_INFRA_FILES=$(gh pr diff [PR_NUMBER] --name-only | grep -E "docker-compose.*\.yml$")

   # For each config file: read the full file (not just the diff) to understand the structure
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       echo "=== Reading full config structure: $f ==="
       cat "$f"
   done <<< "$CONFIG_TOOL_FILES"

   # Identify tool version from docker-compose (for version-aware schema reasoning)
   while IFS= read -r f; do
       [ -z "$f" ] && continue
       grep -E "image:\s*(traefik|nginx|haproxy|envoy|caddy|terraform):" "$f" 2>/dev/null && echo "  ^ in $f"
   done <<< "$COMPOSE_INFRA_FILES"
   ```

   **Severity classification**:
   - Config key present but under wrong parent section: **CONFIRMED HIGH** — key is silently ignored; feature does not activate
   - Required sibling key missing from changed section: **CONFIRMED HIGH** — partial config is silently incomplete
   - Version mismatch (config uses v2 syntax on v3 tool): **CONFIRMED HIGH** — v3 silently ignores v2 keys in most tools
   - Structural ambiguity (key could plausibly be correct but version cannot be determined): **LIKELY MEDIUM** — flag for human verification with schema reference

   **Do NOT rely solely on logical correctness checks when structural correctness has not been verified.** A config that names services correctly, uses coherent values, and matches the deploy script's expectations can still be silently rejected if the nesting does not match the tool's schema. Both dimensions must be verified independently. <!-- Added: forge#1104 -->

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Infrastructure & Deploy Safety Audit

### Deploy Risk: [LOW/MEDIUM/HIGH/CRITICAL]

### Downtime Risk
| Change | Restart Required? | Impact | Mitigation |
|--------|-------------------|--------|------------|
| ... | Yes/No | [duration] | [strategy] |

### Blue-Green Compatibility
| Component | Old↔New Compatible? | Issue |
|-----------|---------------------|-------|
| API responses | Yes/No | ... |
| Database | Yes/No | ... |
| Redis | Yes/No | ... |

### Prerequisites
- [ ] [Any env vars, secrets, DNS changes needed before deploy]

### Secret Delivery Chain
[If decrypt-secrets.sh, SOPS, or deploy workflows changed — otherwise write "N/A"]
| Step | File | Value | Consistent? |
|------|------|-------|-------------|
| SOPS key | `.secrets/prod.enc.yaml` | [section.key_name] | — |
| ENV_MAPPING | `scripts/decrypt-secrets.sh` | [("section", "key_name")] | Yes/No |
| SCP target | `deploy-production.yml` | [resolved path] | Yes/No |
| Merge PROJECT | `deploy-production.yml` | [resolved path] | Yes/No |
| env_file | `docker-compose.prod.yml` | [.env.production] | Yes/No |
| Hotfix SCP | `hotfix-deploy.yml` | [resolved path] | Yes/No |

### Rollout Recommendation
**Strategy**: [Full deploy / Canary / Low-traffic window]

### Files Reviewed
[List files checked]

---
*Infrastructure safety audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:INFRA-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `INFRA`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — INFRA Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Container restart downtime risk | Item 1 | COVERED | |
| Database container restart safety | Item 1b | COVERED | #146 |
| Config mechanism change equivalence | Item 1c | COVERED | #185 |
| Blue-green deployment compatibility | Item 2 | COVERED | |
| Rollback path verification | Item 3 | COVERED | |
| Missing deploy prerequisites (env/secrets/DNS) | Item 4 | COVERED | |
| In-flight request impact | Item 5 | COVERED | |
| Health endpoint response contract breakage | Item 6 | COVERED | #321 |
| Secret delivery chain (SOPS → container) | Item 7 | COVERED | |
| Shell metacharacter safety in .env writers | Item 7b | COVERED | #286 |
| Cross-domain service interactions (curl/wget) | Item 8 | COVERED | |
| Sibling workflow drift (CI vs deploy) | Item 9 | COVERED | #222 |
| Deploy scope awareness (auto vs manual trigger) | Item 10 | COVERED | #239 |
| Config field type/doc-comment consistency | Item 11 | COVERED | #190 |
| appleboy/ssh-action Go template safety | Item 12 | COVERED | #226 |
| Insecure config file defaults | Item 13 | COVERED | #301 |
| Host-side database tool invocations | Item 14 | COVERED | #322 |
| External tool config schema validation (structural correctness) | Item 15 | COVERED | #1104 |
| Docker image tag pinning (mutable tags) | — | GAP | |
| Network policy / inter-container isolation | — | GAP | |
