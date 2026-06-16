---
authority: recommended
scope: templates
applies_to: [review-pr, work-on]
domain: pipeline
last_validated: "YYYY-MM-DD"
version: "0.0.0"
---

# Review-Finding Issue Template

Use this template when `/review-pr` domain agents create GitHub issues for findings. Each finding must be a standalone, actionable issue that the `/work-on` pipeline can pick up independently.

---

## Template

```markdown
## Problem

{1-3 sentences describing the specific finding. Be concrete — name the file, function, and exact behavior.}

## Root Cause

{Specific code path that causes the issue. Include file:line references.}

Example:
1. `services/api/app/routers/billing.py:142` — calls `credits.check_balance()`
2. `services/api/app/credits.py:87` — returns `None` when user has no credit record
3. `billing.py:148` — caller does not guard against `None` return → `AttributeError` at runtime

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Expected Behavior

{What the code should do instead.}

## Acceptance Criteria

- [ ] {Specific, testable fix criterion}
- [ ] No regression in {related feature}

## Pattern Metadata

**Pattern**: {short name for this class of bug, e.g., "Unguarded None return in credit check"}
**Root cause**: {one-line technical root cause}
**Prevention**: {one-line prevention rule for future code in this area}

## Evidence

**Confidence**: {CONFIRMED | LIKELY | POSSIBLE}
**Severity**: {CRITICAL | HIGH | MEDIUM | LOW}

{For CONFIRMED: include the full code path trace or specific input that reproduces the failure.}
{For LIKELY: note what mitigations might exist and why you couldn't fully confirm.}
{For POSSIBLE: describe the suspicious pattern and why you couldn't trace the full flow.}

## Context

**Source PR**: #{pr_number}
**Reviewer**: {domain agent name, e.g., "API Review Agent"}
**Code branch**: `{branch_name}`
```

---

## Confidence Levels

| Confidence | When to use | Blocking? |
|------------|-------------|-----------|
| `CONFIRMED` | Full code path traced to failure; concrete reproduction evidence | Yes — creates P1 issue |
| `LIKELY` | Pattern strongly suggests bug; mitigations may exist but not traced | Yes — creates P2 issue |
| `POSSIBLE` | Suspicious pattern but full flow not traceable | No — informational advisory; P3 |

**POSSIBLE findings are not merge blockers.** They are tracked for awareness.

---

## Severity Levels

| Severity | Criteria |
|----------|---------|
| `CRITICAL` | Data loss, security vulnerability, production crash |
| `HIGH` | Runtime error, wrong data produced silently, significant user impact |
| `MEDIUM` | Degraded performance, edge case failure, non-critical data inconsistency |
| `LOW` | Cosmetic, minor inefficiency, no runtime impact confirmed |

---

## Title Format

```
fix({scope}): {specific description of what needs to be fixed}
```

Examples:
- `fix(billing): guard against None return from credits.check_balance() (#42-finding)`
- `fix(api): validate Content-Type header before deserializing request body (#58-finding)`
- `fix(auth): refresh token rotation does not invalidate previous token family (#71-finding)`

---

## Labels

Required labels for all review-finding issues:

| Label | Required? |
|-------|----------|
| `review-finding` | Always |
| `priority:P{0-3}` | Based on severity (P0=CRITICAL, P1=HIGH, P2=MEDIUM/LIKELY, P3=LOW/POSSIBLE) |
| Category label (`bug`, `security`, etc.) | Recommended |

---

## Source Branch

When a review-finding is filed from a PR targeting a non-default branch, include the code branch so the fix PR starts from the right base:

```markdown
**Code branch**: `{branch_name}`
```

The `/work-on` pipeline reads this field to determine the source branch for the fix PR.

---

## Batch Filing Guidelines

When a single PR review produces multiple findings:

1. Create one issue per finding (not one combined issue)
2. Each issue must be independently actionable
3. Link related findings with "Related to #{N}" in the body
4. Order creation by severity (CRITICAL first)
5. Do NOT combine CONFIRMED and POSSIBLE findings into one issue

---

## Anti-Patterns

| Bad | Why | Good |
|-----|-----|------|
| "The code has security issues" | Too vague | File separate issues per finding with specific file:line |
| CONFIRMED without code path trace | Not reproducible | Downgrade to POSSIBLE if trace is incomplete |
| "This might be a bug" with no evidence | Not actionable | Include specific file:line and describe the observable failure |
| One issue with 5 findings | Not independently actionable | One issue per finding |
