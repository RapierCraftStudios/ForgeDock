---
description: Periodic security posture audit — runs a scripted 4-phase checklist against repo files (not diffs), creates GitHub issues for confirmed findings
argument-hint: [--repo <prefix>] [--phase 1|2|3|4|all] [--dry-run]
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /security-audit — Periodic Security Posture Audit

**Input**: $ARGUMENTS

You are the security posture auditor. Run a scripted 4-phase checklist against the **current state** of the target repository (not a PR diff). Each check uses bash/grep against repo files. Confirmed findings are posted as GitHub issues in the target repo, labeled `security,audit-finding,priority:P1/priority:P2/priority:P3`.

This command is designed to be run:
- **Manually** after a pen test engagement
- **Quarterly** as a scheduled posture review
- **After major infrastructure changes** (new services, docker-compose rewrites, auth changes)

This is NOT a PR review — it does not approve or block. It creates issues for each gap found.

**Agent model policy**: `model: "sonnet"`, `effort: xhigh` (deep tier — comprehensive security analysis). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

---

## Config Preamble

Before executing any phase, read `forge.yaml` to resolve project references:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ -f "$CONFIG_FILE" ]; then
  GH_OWNER=$(yq '.project.owner' "$CONFIG_FILE")
  GH_REPO_NAME=$(yq '.project.repo' "$CONFIG_FILE")
  GH_REPO="${GH_OWNER}/${GH_REPO_NAME}"
  GH_FLAG="-R $GH_REPO"
  REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
  # FORGE_REPO: the self-pipeline repo where security audit summary comments are posted.
  # Set project.forge_repo in forge.yaml if your pipeline repo differs from GH_REPO.
  FORGE_REPO=$(yq '.project.forge_repo // ""' "$CONFIG_FILE")
  [ -z "$FORGE_REPO" ] && FORGE_REPO="$GH_REPO"
  # BILLING_ENABLED: controls whether Phase 4 (Financial Integrity) runs.
  # Set billing.enabled: true in forge.yaml if your project uses Stripe billing.
  BILLING_ENABLED=$(yq '.billing.enabled // "false"' "$CONFIG_FILE")
else
  echo "WARNING: forge.yaml not found — commands will use placeholder values"
  echo "Run: cp forge.yaml.example forge.yaml  and fill in your project details"
  GH_REPO="your-org/your-repo"
  GH_FLAG="-R $GH_REPO"
  REPO_PATH="./"
  FORGE_REPO="$GH_REPO"
  BILLING_ENABLED="false"
fi
```

---

## Multi-Repo Support

If your project spans multiple repositories, define them in the `repos.satellites` section of `forge.yaml`. The `--repo <prefix>` argument selects a satellite by its `prefix` field.

Parse `$ARGUMENTS` for:
- **`--repo <prefix>`**: target repo prefix (default: primary repo from `project.owner/project.repo`)
- **`--phase <N|all>`**: run only a specific phase, or all (default: `all`)
- **`--dry-run`**: print findings but do NOT create GitHub issues

Set context variables from config:

```bash
REPO_PREFIX=$(echo "$ARGUMENTS" | grep -oP '(?<=--repo )\S+' || true)

if [ -n "$REPO_PREFIX" ]; then
  # Look up satellite repo by prefix in forge.yaml
  SATELLITE_REPO=$(yq ".repos.satellites[] | select(.prefix == \"$REPO_PREFIX\") | .repo" "$CONFIG_FILE" 2>/dev/null)
  if [ -n "$SATELLITE_REPO" ] && [ "$SATELLITE_REPO" != "null" ]; then
    GH_REPO="$SATELLITE_REPO"
    GH_FLAG="-R $GH_REPO"
    REPO_PATH=$(yq ".repos.satellites[] | select(.prefix == \"$REPO_PREFIX\") | .local_path" "$CONFIG_FILE" 2>/dev/null || echo "$REPO_PATH")
    # Also read billing flag for satellite if set
    BILLING_ENABLED=$(yq ".repos.satellites[] | select(.prefix == \"$REPO_PREFIX\") | .billing_enabled // \"false\"" "$CONFIG_FILE" 2>/dev/null || echo "false")
  else
    echo "WARNING: --repo prefix '$REPO_PREFIX' not found in forge.yaml repos.satellites — using default repo"
  fi
fi

# If REPO_PATH is not found locally, clone from GitHub
if [ ! -d "$REPO_PATH" ]; then
  gh repo clone {GH_REPO} {REPO_PATH} -- --depth=1 2>/dev/null || true
fi
```

---

## Severity Classification

| Severity | Condition |
|----------|-----------|
| **P1** | Direct exploitation path with no mitigation; publicly reachable; auth bypass |
| **P2** | Exploitable under specific conditions; security control absent but other mitigations present |
| **P3** | Defense-in-depth gap; best-practice deviation; no active exploitability shown |

---

## Phase 1: Infrastructure Posture

### 1A: Docker Compose Port Bindings

**What**: Non-web services bound to `0.0.0.0` expose internal ports to all network interfaces, including public ones when deployed without an external firewall.

**Check**:
```bash
DOCKER_COMPOSE_FILES=$(find "$REPO_PATH" -name "docker-compose*.yml" -not -path "*/.git/*" 2>/dev/null)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  HITS=$(grep -n '0\.0\.0\.0:[0-9]' "$f" 2>/dev/null | grep -v '^\s*#' || true)
  if [ -n "$HITS" ]; then
    echo "FINDING [1A] $f:"
    echo "$HITS"
  fi
done <<< "$DOCKER_COMPOSE_FILES"
```

**Confirm**: For each hit, verify the port is NOT a web-facing port (80, 443, 8080, 3000). Ports like 6432 (PgBouncer), 6379 (Redis), 5432 (Postgres), 27017 (MongoDB) bound to `0.0.0.0` are confirmed findings.

**Severity**: `priority:P1` if no external firewall documented; `priority:P2` otherwise.

**Issue title**: `security: {SERVICE} port {PORT} bound to 0.0.0.0 — exposed beyond localhost`

---

### 1B: Dockerfile USER Directive

**What**: Containers running as root violate least-privilege. A compromised container running as root has full host access if namespace isolation is broken.

**Check**:
```bash
DOCKERFILES=$(find "$REPO_PATH" -name "Dockerfile*" -not -path "*/.git/*" 2>/dev/null)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # Skip if USER directive is present (anywhere in the file, case-insensitive)
  if ! grep -iq '^\s*USER\s' "$f" 2>/dev/null; then
    echo "FINDING [1B] $f: no USER directive — container runs as root"
  fi
done <<< "$DOCKERFILES"
```

**Confirm**: Check if the Dockerfile is for a long-running service (not a one-shot build image). If service container with no USER → confirmed finding.

**Severity**: `priority:P2` (standard finding; exploitability depends on runtime isolation).

**Issue title**: `security: {SERVICE} Dockerfile has no USER directive — runs as root`

---

### 1C: Dev Service Authentication

**What**: Dev databases or caches with no password are fine locally but become a critical gap if port bindings change or the compose file is used in non-dev environments.

**Check**:
```bash
DOCKER_COMPOSE_FILES=$(find "$REPO_PATH" -name "docker-compose*.yml" -not -path "*/.git/*" 2>/dev/null)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # Redis without requirepass
  REDIS_NO_AUTH=$(grep -A5 'image:.*redis' "$f" 2>/dev/null | grep -v 'requirepass\|password' | grep -c 'redis' || true)
  # Postgres without POSTGRES_PASSWORD
  PG_NO_AUTH=$(awk '/image:.*postgres/{found=1} found && /POSTGRES_PASSWORD/{found=0} found && /^[[:space:]]*-[[:space:]]*[A-Z]/{print}' "$f" 2>/dev/null | grep -v 'POSTGRES_PASSWORD' | head -3 || true)

  [ -n "$PG_NO_AUTH" ] && echo "FINDING [1C] $f: Postgres service may lack POSTGRES_PASSWORD"
done <<< "$DOCKER_COMPOSE_FILES"
```

**Manual review**: Check for `POSTGRES_PASSWORD` and `requirepass` in compose environment sections. Flag any service using a blank/trivial password as a documented value.

**Severity**: `priority:P3` for dev compose; `priority:P1` if the compose file is used in production.

**Issue title**: `security: {SERVICE} in {FILE} has no authentication configured`

---

## Phase 2: CI/CD Security Gating

### 2A: Security Scanner continue-on-error

**What**: Security scanners (Trivy, Snyk, OWASP dependency check) with `continue-on-error: true` silently pass even when vulnerabilities are detected. The job green-lights the pipeline while the scanner's findings are ignored.

**Check**:
```bash
WORKFLOW_FILES=$(find "$REPO_PATH/.github/workflows" -name "*.yml" 2>/dev/null)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # Find security scanner steps then check if continue-on-error follows within 5 lines
  awk '
    /trivy|snyk|owasp|dependency.check|gitleaks|semgrep|gosec|bandit/ {
      scanner_line = NR
      scanner_name = $0
    }
    /continue-on-error:\s*true/ && NR - scanner_line <= 5 && scanner_line > 0 {
      print FILENAME ":" NR ": continue-on-error: true near security scanner at line " scanner_line
    }
  ' FILENAME="$f" "$f" 2>/dev/null || true
done <<< "$WORKFLOW_FILES"
```

**Confirm**: Verify the flagged step is indeed a security scanner step (not a notification or deploy step). Confirmed if scanner produces failure exit codes that are being swallowed.

**Severity**: `priority:P2` (scanner present but findings are silently ignored).

**Issue title**: `security: {SCANNER} step in {WORKFLOW} has continue-on-error: true — findings silently ignored`

---

### 2B: Commented-Out Access Controls

**What**: Access control rules (nginx `deny`, `allow`, IP ACLs, auth guards) that are commented out may have been disabled for debugging and never re-enabled.

**Check**:
```bash
CONFIG_FILES=$(find "$REPO_PATH/infra" "$REPO_PATH/services" -name "*.conf" -o -name "*.yml" -o -name "nginx.conf" 2>/dev/null | grep -v '.git')
while IFS= read -r f; do
  [ -z "$f" ] && continue
  HITS=$(grep -n '^\s*#.*\(deny\|allow\s\|auth_basic\|auth_request\|satisfy all\|limit_req\|access_by_lua\)' "$f" 2>/dev/null || true)
  [ -n "$HITS" ] && echo "FINDING [2B] $f:" && echo "$HITS"
done <<< "$CONFIG_FILES"
```

**Confirm**: Distinguish intentional comments (documentation) from disabled access control rules. Confirmed if the commented line is a functional directive that would restrict access.

**Severity**: `priority:P1` if the endpoint is publicly accessible; `priority:P2` otherwise.

**Issue title**: `security: commented-out access control in {FILE} — {DIRECTIVE} disabled`

---

## Phase 3: Application Security Posture

### 3A: CSP unsafe-inline in script-src

**What**: `unsafe-inline` in Content-Security-Policy `script-src` allows arbitrary inline scripts, negating XSS protection entirely.

**Check**:
```bash
CSP_FILES=$(grep -rl "Content-Security-Policy\|script-src" "$REPO_PATH" --include="*.js" --include="*.ts" --include="*.json" --include="*.conf" --include="*.yml" 2>/dev/null | grep -v '.git' | grep -v node_modules)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  HITS=$(grep -n "script-src.*unsafe-inline\|unsafe-inline.*script-src" "$f" 2>/dev/null || true)
  [ -n "$HITS" ] && echo "FINDING [3A] $f:" && echo "$HITS"
done <<< "$CSP_FILES"
```

**Confirm**: Verify the CSP header applies to the production site (not just dev/storybook). Check if a nonce-based approach is already in use (nonce + unsafe-inline is still a finding but lower severity).

**Severity**: `priority:P2` (XSS protection materially weakened).

**Issue title**: `security: CSP script-src includes unsafe-inline in {FILE} — XSS protection bypassed`

---

### 3B: Response Header Disclosure

**What**: Headers leaking git SHA, deploy color, internal service versions, or infrastructure details help attackers target known CVEs.

**Check**:
```bash
HEADER_FILES=$(grep -rl "X-App-Version\|X-Deployment-Color\|X-Git-Sha\|X-Build-Id\|Server:" "$REPO_PATH" --include="*.py" --include="*.ts" --include="*.js" --include="*.conf" 2>/dev/null | grep -v '.git' | grep -v node_modules)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  HITS=$(grep -n '"X-App-Version"\|"X-Deployment-Color"\|"X-Git-Sha"\|"X-Build-Id"\|"Server:' "$f" 2>/dev/null || true)
  [ -n "$HITS" ] && echo "FINDING [3B] $f:" && echo "$HITS"
done <<< "$HEADER_FILES"
```

**Confirm**: Check if the header is set in a response (not just read). If set in outbound responses → confirmed finding. Internal-only APIs (not publicly routed) are `priority:P3`; public APIs are `priority:P2`.

**Severity**: `priority:P2` for public APIs; `priority:P3` for internal.

**Issue title**: `security: {HEADER} response header leaks deployment/version information`

---

### 3C: Unauthenticated Endpoints Returning System State

**What**: Endpoints that return system health, metrics, version, or configuration data without authentication help attackers enumerate infrastructure.

**Check**:
```bash
# Look for unprotected health/metrics/info routes (Python FastAPI/Flask pattern)
grep -rn '@router.get\("/health"\|@app.route("/health"\|@router.get\("/metrics"\|@router.get\("/info"\|@router.get\("/version"' \
  "$REPO_PATH" --include="*.py" 2>/dev/null | grep -v '.git' | \
  while IFS= read -r line; do
    # Check if there's a dependency/auth check within 10 lines
    FILE=$(echo "$line" | cut -d: -f1)
    LINENO=$(echo "$line" | cut -d: -f2)
    CONTEXT=$(sed -n "$((LINENO)),$((LINENO+10))p" "$FILE" 2>/dev/null)
    if ! echo "$CONTEXT" | grep -q "Depends\|require_auth\|get_current_user\|verify_token\|HTTPBearer"; then
      echo "FINDING [3C] $FILE:$LINENO: health/metrics route may lack auth"
    fi
  done
```

**Confirm**: Manually verify the route has no authentication dependency. Check if it's behind a network-level gate (traefik middleware, nginx ACL). Confirmed if publicly routable and returns system state.

**Severity**: `priority:P2` (information disclosure enables targeted attacks).

**Issue title**: `security: unauthenticated {ROUTE} endpoint exposes system state`

---

### 3D: In-Memory Rate Limiters

**What**: Rate limiters backed by in-process memory (`dict`, `new Map()`, `{}`) are per-replica and reset on restart. In multi-replica deployments they provide no protection — each replica has its own independent counter.

**Check**:
```bash
# Python: dict/defaultdict used as rate limit store (not Redis/database-backed)
grep -rn "rate_limit\|ratelimit\|rate.limit" "$REPO_PATH" --include="*.py" 2>/dev/null | \
  grep -v '.git' | grep -v '#' | \
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    LINENO=$(echo "$line" | cut -d: -f2)
    # Check surrounding context for in-memory stores
    CONTEXT=$(sed -n "$((LINENO-5)),$((LINENO+5))p" "$FILE" 2>/dev/null)
    if echo "$CONTEXT" | grep -qE '=\s*\{\}|=\s*dict\(\)|=\s*defaultdict|new Map\(\)'; then
      echo "FINDING [3D] $FILE:$LINENO: in-memory rate limiter (not Redis-backed)"
    fi
  done

# TypeScript/JavaScript: new Map() used as rate limit store
grep -rn "new Map\(\)" "$REPO_PATH/web" --include="*.ts" --include="*.tsx" --include="*.js" 2>/dev/null | \
  grep -i "rate\|limit\|throttle" | grep -v '.git' | grep -v node_modules | \
  while IFS= read -r line; do
    echo "FINDING [3D] $line: potential in-memory rate limiter"
  done
```

**Confirm**: Verify the rate limiter is not backed by Redis, a database, or a distributed cache. Confirmed if per-process store with no TTL-based external backend.

**Severity**: `priority:P2` (rate limit bypass possible in scaled deployments).

**Issue title**: `security: in-memory rate limiter in {FILE} has no cross-replica enforcement`

---

### 3E: Cookie Security Flags

**What**: Cookies storing user-controlled data or session tokens without `httpOnly`, `Secure`, or `SameSite` flags are vulnerable to XSS theft, MITM interception, and CSRF.

**Check**:
```bash
# Python: check set-cookie calls / cookie creation without security flags
grep -rn "set_cookie\|response.set_cookie\|cookies\[" "$REPO_PATH" --include="*.py" 2>/dev/null | \
  grep -v '.git' | grep -v '#' | \
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    LINENO=$(echo "$line" | cut -d: -f2)
    CONTEXT=$(sed -n "${LINENO}p" "$FILE" 2>/dev/null)
    if ! echo "$CONTEXT" | grep -q "httponly=True\|http_only=True\|secure=True\|samesite"; then
      echo "FINDING [3E] $FILE:$LINENO: cookie set without httpOnly/secure/samesite flags"
    fi
  done

# TypeScript: check document.cookie or res.cookie calls
grep -rn "document\.cookie\s*=\|res\.cookie(" "$REPO_PATH/web" --include="*.ts" --include="*.tsx" 2>/dev/null | \
  grep -v '.git' | grep -v node_modules | \
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    LINENO=$(echo "$line" | cut -d: -f2)
    CONTEXT=$(sed -n "${LINENO}p" "$FILE" 2>/dev/null)
    if ! echo "$CONTEXT" | grep -q "httpOnly\|secure\|sameSite\|SameSite"; then
      echo "FINDING [3E] $FILE:$LINENO: cookie set without security flags"
    fi
  done
```

**Confirm**: Verify the cookie stores user-controlled data or authentication state. Internal-only cookies (debug flags, feature flags with no sensitive data) are `priority:P3`. Auth/session cookies without flags are `priority:P1`.

**Severity**: `priority:P1` for auth/session tokens; `priority:P2` for user-controlled data; `priority:P3` for non-sensitive cookies.

**Issue title**: `security: {COOKIE_NAME} cookie missing {FLAGS} — vulnerable to XSS/CSRF/MITM`

---

### 3F: Credential Placeholder Fallbacks in Config

**What**: Config files with credential fallbacks like `|| "changeme"` or `|| "password"` or `os.getenv("KEY", "secret")` provide working defaults that may silently activate in environments where the secret is absent — including production if the env var injection fails.

**Check**:
```bash
# Python: os.getenv with non-empty default for credential-like vars
grep -rn 'os\.getenv\s*(\s*"[^"]*\(KEY\|SECRET\|PASSWORD\|TOKEN\|PASS\|CRED\|AUTH\)[^"]*"\s*,\s*"[^"]\+"\s*)' \
  "$REPO_PATH" --include="*.py" 2>/dev/null | grep -v '.git' | grep -v '#' | \
  while IFS= read -r line; do
    echo "FINDING [3F] $line: credential env var has non-empty fallback default"
  done

# YAML/config: fallback patterns
grep -rn '||\s*["'"'"'][a-zA-Z0-9]\{4,\}["'"'"']\|default.*password\|default.*secret\|default.*changeme' \
  "$REPO_PATH/infra" "$REPO_PATH/services" --include="*.yml" --include="*.yaml" --include="*.conf" 2>/dev/null | \
  grep -v '.git' | grep -iv '# ' | \
  while IFS= read -r line; do
    echo "FINDING [3F] $line: possible credential fallback in config"
  done
```

**Confirm**: Verify the fallback value is a real credential (not a placeholder like `""` or `"REPLACE_ME"` which would fail explicitly). Confirmed if a non-trivial value would silently succeed authentication.

**Severity**: `priority:P1` if the credential protects a production service; `priority:P2` otherwise.

**Issue title**: `security: credential placeholder fallback in {FILE} — {VAR} defaults to hardcoded value`

---

## Phase 4: Financial Integrity

*Skip this phase if `billing.enabled` is not set to `true` in `forge.yaml`. These checks require Stripe webhook integration and a billing architecture in your project.*

```bash
if [ "$BILLING_ENABLED" != "true" ]; then
  echo "Phase 4 skipped — billing.enabled is not true in forge.yaml"
  echo "To enable: add 'billing:\n  enabled: true' to forge.yaml"
  # Skip to Phase 5
fi
```

### 4A: Stripe Webhook Handler Coverage

**What**: Stripe events that are financially relevant (subscription cancel, payment failure, dispute opened, charge refunded) must be explicitly handled. Unhandled events silently succeed (Stripe expects 200), leaving user account state inconsistent with billing state.

**Minimum required events**:
```
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.payment_succeeded
invoice.payment_failed
customer.subscription.trial_will_end
charge.refunded
charge.dispute.created
payment_intent.payment_failed
```

**Check**:
```bash
WEBHOOK_FILES=$(grep -rl "stripe\|webhook" "$REPO_PATH/services" --include="*.py" 2>/dev/null | grep -v '.git' | head -10)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  REQUIRED_EVENTS="customer.subscription.deleted invoice.payment_failed charge.refunded charge.dispute.created"
  for event in $REQUIRED_EVENTS; do
    if ! grep -q "\"$event\"\|'$event'" "$f" 2>/dev/null; then
      echo "FINDING [4A] $f: Stripe event '$event' not handled"
    fi
  done
done <<< "$WEBHOOK_FILES"
```

**Confirm**: Verify the event type appears in a handler dispatch (not just a comment). Confirmed if the event would change user entitlements or financial state but has no handler.

**Severity**: `priority:P1` for events that affect billing state (subscription.deleted, payment_failed, dispute); `priority:P2` for informational events.

**Issue title**: `security: Stripe event {EVENT_TYPE} not handled in {FILE} — financial state may diverge`

---

### 4B: Spend Limit Accuracy

**What**: Pre-reservation credit checks that use a hardcoded cost cap lower than the maximum possible operation cost allow users to overdraw credit.

**Check**:
```bash
grep -rn "pre_reserve\|prereserve\|reserve_credits\|MAX_COST\|max_cost\|PRE_RESERVE" \
  "$REPO_PATH/services" --include="*.py" 2>/dev/null | grep -v '.git' | \
  while IFS= read -r line; do
    echo "REVIEW [4B] $line: verify pre-reservation amount matches maximum tier cost"
  done
```

**Manual review required**: Compare the pre-reserve amount against the maximum operation cost for the highest-tier model. If pre-reserve < max possible cost, users can overdraw.

**Severity**: `priority:P2` (financial loss; users can consume credits they don't have).

**Issue title**: `security: pre-reservation credit cap {AMOUNT} is below maximum operation cost {MAX_COST}`

---

## Phase 5: Reporting & Issue Creation

### 5A: Collate findings

After all phases complete, produce a summary table:

```
## Security Audit Findings

| # | Phase | Finding | File | Severity | Status |
|---|-------|---------|------|----------|--------|
| 1 | 1A | Port binding | docker-compose.prod.yml:12 | priority:P1 | CONFIRMED |
| 2 | 1B | No USER directive | services/worker/Dockerfile | priority:P2 | CONFIRMED |
...
```

If `--dry-run` was passed, print the table and STOP. Do not create issues.

### 5B: Ensure labels exist in target repo

Before creating any issues, ensure all required labels exist. Colors match the canonical ForgeDock label manifest (`bin/labels.json`). Run `npx forgedock labels setup` to bootstrap all managed labels at once.

```bash
gh label create "security" --color "B60205" --description "Security vulnerability or hardening. Managed by ForgeDock." --force -R "{GH_REPO}" 2>/dev/null || true
gh label create "audit-finding" --color "D93F0B" --description "Security or compliance defect found during audit. Managed by ForgeDock." --force -R "{GH_REPO}" 2>/dev/null || true
gh label create "priority:P1" --color "D93F0B" --description "High priority — major feature broken, no workaround. Managed by ForgeDock." --force -R "{GH_REPO}" 2>/dev/null || true
gh label create "priority:P2" --color "FBCA04" --description "Medium priority — impaired functionality, workaround exists. Managed by ForgeDock." --force -R "{GH_REPO}" 2>/dev/null || true
gh label create "priority:P3" --color "C2E0C6" --description "Low priority — minor issue or polish. Managed by ForgeDock." --force -R "{GH_REPO}" 2>/dev/null || true
```

### 5C: Create GitHub issues for CONFIRMED findings

For each CONFIRMED finding (not REVIEW-only), create an issue:

```bash
gh issue create -R "{GH_REPO}" \
  --title "{ISSUE_TITLE}" \
  --label "security,audit-finding,{SEVERITY}" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

{2-3 sentences describing the finding, its location, and exploitation path.}

## Evidence

**File**: \`{FILE}\`
**Line**: {LINE}
**Finding**: {GREP_OUTPUT}

## Risk

{1-2 sentences: who can exploit this, under what conditions, what can they do.}

## Affected Files

1. \`{FILE}\` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific remediation step}
- [ ] Verified by re-running \`/security-audit\` after fix

## Context

**Audited at**: {TIMESTAMP}
**Audit phase**: {PHASE}
**Severity**: {SEVERITY}
**Source**: \`/security-audit\` run on \`{GH_REPO}\`
ISSUE_EOF
)"
```

### 5D: Post audit summary comment (if invoked from a GitHub issue context)

If this command was invoked from within a `/work-on` context or with an issue reference:

```bash
gh issue comment "{CALLER_ISSUE}" -R {FORGE_REPO} --body "$(cat <<'COMMENT_EOF'
<!-- FORGE:SECURITY_AUDIT -->
## Security Audit Complete

**Target**: {GH_REPO}
**Run at**: {TIMESTAMP}
**Phases**: {PHASES_RUN}

### Findings Summary

| Severity | Count |
|----------|-------|
| priority:P1 | {P1_COUNT} |
| priority:P2 | {P2_COUNT} |
| priority:P3 | {P3_COUNT} |

### Issues Created

{LIST_OF_CREATED_ISSUE_URLS}

Re-run with: \`/security-audit --repo {REPO_PREFIX}\`
COMMENT_EOF
)"
```

---

## Suggested Cadence

| Trigger | Scope |
|---------|-------|
| After pen test engagement | All phases |
| Quarterly (scheduled) | All phases |
| After major infrastructure change (new service, docker-compose rewrite) | Phase 1 + Phase 2 |
| After auth system change | Phase 3 (3C, 3E) |
| After billing integration change | Phase 4 |
