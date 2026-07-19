---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Agent: Frontend Quality Auditor

> Read `review-pr-agents/protocols.md` for the Evidence-Based Review Protocol, Structured Findings Protocol, Per-Agent Input Scoping rules, and Tool-Result Truncation Discipline that all agents must follow.

**Trigger**: WEB service touched
**Type**: `codebase-explorer` | **Model**: `{SUBAGENT_MODEL}`

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
10. **Hook provider scope**: For any new `useX()` hook call added to a component, verify the hook is safe to call outside its provider. If `useX` internally calls `useContext(XContext)` and throws when context is undefined (i.e., the hook contains `if (!ctx) throw new Error(...)`), check ALL mount sites of the component across the codebase. If the component is used in both authenticated routes (e.g., `app/dashboard/`) AND public routes (e.g., `app/(public)/`, `app/playground/`) that do not wrap children in the provider, the hook call will crash the public route with a React error boundary cascade. Flag as CONFIRMED HIGH if a public mount site exists without the provider.

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

