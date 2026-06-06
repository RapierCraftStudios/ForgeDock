---
authority: recommended
scope: templates
applies_to: [work-on, quality-gate]
---

# Commit Convention Reference

This project follows the **Conventional Commits** specification. All commits must follow this format to enable automated changelog generation and pipeline compatibility.

---

## Format

```
{type}({scope}): {description} (#{issue_number})

{optional body — explains the "why" in more detail}

{optional footer — breaking changes, co-authors, etc.}
```

### Required Fields

| Field | Rules |
|-------|-------|
| `type` | Required. Lowercase. One of the types below. |
| `description` | Required. Imperative mood. Lowercase. No period. Under 72 characters. |
| `#{issue_number}` | Required. Always reference the linked issue. |

### Optional Fields

| Field | Rules |
|-------|-------|
| `scope` | Component or module name in parentheses. Optional but recommended. |
| `body` | Blank line after subject. Explain the "why". Wrap at 72 characters. |
| `footer` | `BREAKING CHANGE:` or `Co-authored-by:`. |

---

## Commit Types

| Type | Use for | Example |
|------|---------|---------|
| `fix` | Bug fixes that correct existing behavior | `fix(billing): prevent division by zero` |
| `feat` | New features or capabilities | `feat(dashboard): add dark mode toggle` |
| `refactor` | Code restructuring with no behavior change | `refactor(api): extract pagination to utility` |
| `docs` | Documentation changes only | `docs(config): add devdocs schema reference` |
| `chore` | Maintenance tasks (version bumps, CI config) | `chore: bump version to 1.2.0 [skip ci]` |
| `test` | Adding or updating tests | `test(billing): add coverage for zero-credit edge case` |
| `perf` | Performance improvements | `perf(scraper): reduce queue memory footprint` |
| `style` | Code style/formatting (no logic change) | `style: apply black formatting` |
| `build` | Build system or dependency changes | `build: upgrade to Node 20` |
| `ci` | CI/CD configuration changes | `ci: add deploy job to workflow` |

---

## Scope Examples

Scope is the component or module affected. Keep it short:

| Scope | Use for |
|-------|---------|
| `billing` | Payment, credits, subscription logic |
| `api` | Backend API routes and handlers |
| `auth` | Authentication and authorization |
| `dashboard` | Frontend dashboard pages |
| `scraper` | Data collection services |
| `infra` | Docker, CI/CD, deployment configs |
| `installer` | `bin/forgedock.mjs` onboarding flow |
| `onboarding` | Setup and initialization logic |
| `security` | Security hardening changes |

---

## Examples

### Simple fix

```
fix(billing): prevent division by zero when user credits reach 0 (#42)
```

### Feature with body

```
feat(dashboard): add dark mode toggle to settings page (#58)

Users reported eye strain when using the dashboard in low-light environments.
This adds a persistent dark mode preference stored in localStorage and
applied via CSS custom properties.
```

### Breaking change

```
feat(api)!: change /health endpoint response format (#99)

BREAKING CHANGE: The health endpoint now returns {"status":"ok"} instead
of {"status":"healthy"}. Update all consumers before deploying.
```

### Chore (skip CI)

```
chore: bump version to 1.2.0 [skip ci]
```

### Multiple authors

```
fix(scraper): handle empty response from external API (#71)

Co-authored-by: Jane Smith <jane@example.com>
```

---

## Rules

1. **Imperative mood**: "add" not "added", "fix" not "fixed", "remove" not "removed"
2. **Lowercase description**: `fix(auth): handle null token` not `fix(auth): Handle Null Token`
3. **No period** at the end of the description line
4. **Under 72 characters** on the subject line
5. **Always reference the issue**: Every commit must include `(#{issue_number})`
6. **`[skip ci]`**: Only for pure documentation or version bump commits with no code changes
7. **`BREAKING CHANGE:`**: Always document breaking API/behavior changes in the footer

---

## Anti-Patterns

| Bad | Why | Good |
|-----|-----|------|
| `fix: stuff` | Not specific | `fix(auth): handle null refresh token in session middleware (#55)` |
| `Added dark mode` | Wrong tense, no type, no issue | `feat(dashboard): add dark mode toggle (#58)` |
| `wip` | Not meaningful | Stage as draft PR; use meaningful commit messages |
| `fix: fixed the thing that was broken` | Redundant, vague | `fix(api): prevent 500 when payment provider returns null intent (#42)` |
| `update config` | No type, vague | `chore(infra): add REDIS_URL to docker-compose.prod.yml (#67)` |

---

## CI Integration

The pipeline checks commit messages using conventional commit linting. Non-conforming messages on PRs targeting `staging` or `milestone/*` branches will trigger a quality gate finding.

The `[skip ci]` directive suppresses CI runs — use only when the change has zero code impact (docs, version string update).
