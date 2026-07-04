<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Agent: Auth Conventions Auditor

> Read `review-pr-agents/protocols.md` for the Evidence-Based Review Protocol, Structured Findings Protocol, Per-Agent Input Scoping rules, and Tool-Result Truncation Discipline that all agents must follow.



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

   # Check if the backend trusts X-Forwarded-For for rate limit keying
   grep -rn "X-Forwarded-For\|x_forwarded_for\|forwarded_for\|client_ip\|real_ip" \
     $(git ls-files | grep -E "\.(py|ts|js)$" | head -20) | head -10
   # If found without trusted-proxy-range validation: CONFIRMED HIGH
   # The backend must only trust X-Forwarded-For when the immediate caller is in a known trusted proxy range
   ```

   **Flag as CONFIRMED HIGH** if: X-Forwarded-For is forwarded from client to backend without stripping or rightmost-only extraction AND the backend keys rate limits on that header value.

7. JWT secret/algorithm separation: when the diff touches JWT signing, verification, or token generation, verify that different token classes (user session, admin-proxy, API key) use distinct signing secrets or asymmetric algorithms — not a shared secret differentiated only by claims

   ```bash
   # Check signing configuration across token classes — adapt paths to the project's auth files
   AUTH_FILES=$(git ls-files | grep -iE "auth|security|jwt|token" | grep -E "\.(py|ts|js)$" | head -10)
   grep -nE "SECRET|algorithm|HS256|RS256|verify|decode" $AUTH_FILES | head -20
   # Flag if: multiple token classes reference the same secret variable AND the only differentiator is a claim (e.g., aud, role)
   # Safe pattern: privileged tokens use a separate secret or RS256 (asymmetric)
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
4. Search for auth dependency patterns: `grep -rn "get_current\|require_auth\|authenticated_user\|current_user" $(git ls-files | grep -E "router|route|endpoint" | head -20)`
5. Compare against existing route patterns for consistency
6. If diff touches middleware, route handlers, or rate-limit code: run header forwarding check (item 6 grep commands above)
7. If diff touches auth/JWT/token files: run JWT secret separation check (item 7 grep commands above)

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Auth Conventions Audit

### Endpoints Reviewed
| Endpoint | Method | Auth Dep Used | Expected Auth Dep | Correct? | Ownership Check |
|----------|--------|--------------|-------------------|----------|-----------------|
| /path | POST | [auth_dep] | [expected_dep] | Yes/No | Yes/No/N/A |

### Convention Violations
[List any violations of the project's auth convention (from [DOMAIN_CONTEXT]) with file:line]

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
| Wrong auth dependency (convention from [DOMAIN_CONTEXT]) | Item 2 | COVERED | |
| Multi-tenancy / IDOR | Item 3 | COVERED | |
| Missing rate limiting on public endpoints | Item 4 | COVERED | |
| IDOR via error code differentiation | Item 5 | COVERED | |
| X-Forwarded-For trust model bypass | Item 6 | COVERED | #299 |
| JWT shared-secret privilege escalation | Item 7 | COVERED | #299 |
| OAuth state parameter CSRF | — | GAP | |
| Session fixation / session invalidation on privilege change | — | GAP | |

---

