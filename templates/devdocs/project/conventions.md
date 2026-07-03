---
authority: required
scope: project
applies_to: [work-on, review-pr, quality-gate]
domain: conventions
last_validated: "YYYY-MM-DD"
version: "0.0.0"
---

# Coding Conventions and Standards

This file defines the coding standards, patterns, and anti-patterns for this project. Pipeline agents (build and review) read this file to ensure changes conform to project conventions.

---

## Instructions

Replace the placeholder content below with your project's actual conventions. Be specific — "use async patterns" is less useful than "all database calls must use `async with AsyncSession()` from `app/db.py`".

---

## Language-Specific Standards

### Python

> Fill in your Python conventions.

- **Version**: {e.g., Python 3.12}
- **Formatter**: {e.g., black (line length 88), isort}
- **Type hints**: {e.g., "Required on all public functions; use `Optional[X]` not `X | None` for compatibility"}
- **Import order**: {e.g., stdlib → third-party → local; enforced by isort}
- **Async**: {e.g., "All database and HTTP I/O must be async — never mix sync/async patterns in the same call chain"}
- **Error handling**: {e.g., "Raise specific exceptions, not bare `Exception`; always log before re-raising"}
- **Logging**: {e.g., "Use `structlog` with context fields — never `print()`"}

**Anti-patterns**:
- {e.g., "`os.system()` — use `subprocess.run(check=True)` instead"}
- {e.g., "Mutable default arguments — use `None` sentinel and assign in function body"}
- {e.g., "String concatenation for SQL — always use parameterized queries"}

### TypeScript / JavaScript

> Fill in your TypeScript conventions.

- **Version**: {e.g., TypeScript 5.x}
- **Formatter**: {e.g., Prettier (single quotes, 100 char line length)}
- **Strict mode**: {e.g., "Strict TypeScript — `noImplicitAny: true`, `strictNullChecks: true`"}
- **API calls**: {e.g., "Always use `/api/...` proxy routes — never call `localhost:8000` or hardcoded host:port"}
- **State**: {e.g., "Server state via SWR/React Query; UI state via Zustand; no global mutable variables"}
- **Components**: {e.g., "Use named exports for components, default export for pages"}

**Anti-patterns**:
- {e.g., "`any` type — use `unknown` with type narrowing instead"}
- {e.g., "Direct DOM manipulation — use React state"}
- {e.g., "Hardcoded API URLs — always use the `/api` proxy"}

---

## Testing Conventions

> Describe your testing requirements and patterns.

- **Unit tests**: {e.g., "Required for all service-layer functions; use pytest with async fixtures"}
- **Integration tests**: {e.g., "Required for all API endpoints; use `httpx.AsyncClient` with test DB"}
- **Coverage**: {e.g., "Minimum 80% line coverage on new code; enforced by CI"}
- **Test file location**: {e.g., "Co-located with source — `services/api/app/billing/test_credits.py` next to `credits.py`"}
- **Mocking**: {e.g., "Mock external APIs (Stripe, email) in tests — never hit external services in CI"}

**Test naming convention**:
```
test_{function_name}_{scenario}_{expected_outcome}

# Examples:
test_check_balance_zero_credits_returns_none
test_check_balance_negative_credits_raises_value_error
test_check_balance_valid_credits_returns_balance
```

---

## Git Conventions

See `templates/commit-convention.md` for the full commit message reference.

**Branch naming**:
- `fix/{slug}-{issue}` for bug fixes
- `feat/{slug}-{issue}` for features
- `refactor/{slug}-{issue}` for refactors

**PR rules**:
- Never target `main` directly
- Fast-lane PRs target `staging`
- Feature-lane PRs target `milestone/{slug}`
- Every PR must close at least one issue

---

## File Organization

> Describe your file organization conventions.

```
{e.g.:
services/
  api/
    app/
      {domain}/      ← one directory per domain
        __init__.py
        router.py    ← FastAPI router
        service.py   ← business logic
        models.py    ← SQLAlchemy models
        schemas.py   ← Pydantic schemas
        test_{domain}.py  ← tests
}
```

**Rules**:
- {e.g., "One module per domain — no cross-domain imports at the same level"}
- {e.g., "Routers only handle HTTP concerns (parsing, response shaping) — business logic in service layer"}
- {e.g., "Database models in `models.py`, Pydantic request/response schemas in `schemas.py`"}

---

## Security Conventions

> Document security requirements agents must follow.

- {e.g., "All user-supplied strings that touch shell commands must be sanitized — use `shlex.quote()` or `subprocess` with list args"}
- {e.g., "Never log passwords, tokens, or PII — scrub before logging"}
- {e.g., "Use parameterized queries for all SQL — no string formatting"}
- {e.g., "CORS: restrict `allow_origins` to known domains in production — never `*` in prod"}
- {e.g., "File uploads: validate MIME type and size; never pass user-supplied filenames to `open()`"}

---

## Code Review Standards

> What agents look for when reviewing PRs.

**Blocking findings** (must fix before merge):
- Runtime errors (uncaught exceptions, type mismatches, null dereferences)
- Security vulnerabilities (SSRF, injection, exposed secrets)
- Breaking API contracts (changed response format without consumer update)
- Missing error handling on external calls

**Non-blocking findings** (tracked as separate issues):
- Performance improvements
- Test coverage gaps
- Documentation gaps
- Code style violations (unless enforced by CI)

---

## Documentation Standards

> When and how to document code.

- {e.g., "All public functions require docstrings with Args and Returns sections"}
- {e.g., "Type hints replace docstring parameter descriptions — don't duplicate"}
- {e.g., "Document the 'why', not the 'what' — code explains what; comments explain intent"}
- {e.g., "Mark non-obvious workarounds with `# WORKAROUND: {reason} — remove when {condition}`"}
