---
authority: recommended
scope: templates
applies_to: [issue, work-on]
domain: pipeline
last_validated: "YYYY-MM-DD"
version: "0.0.0"
---

# Issue Template

Use this template when creating GitHub issues. All four mandatory sections (`Problem`, `Affected Files`, `Expected Behavior`, `Acceptance Criteria`) are required for pipeline compatibility — the `/work-on` investigation agent reads these sections to understand scope and locate the right files.

---

## Template

```markdown
## Problem

{1-3 sentences describing what is wrong or what is missing. Be specific.}

{For bugs: include the error message, observable symptom, or stack trace snippet.}
{For regressions: "Regression of #{N} — {brief description of original fix}."}

## Root Cause (if known)

{Point to the specific code path. Use `file:line` references.}
{If unknown: "Root cause unknown — investigation needed."}

## Affected Files

Files that need changes (ordered by dependency — change these in this order):

1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}
3. `{filepath}` — {what needs to change}

## Expected Behavior

{What should happen after the fix/feature is implemented.}

## Acceptance Criteria

- [ ] {Specific, testable criterion}
- [ ] {Specific, testable criterion}
- [ ] No regressions in {related_feature}

## Dependencies

{If this depends on other issues: "Depends on #{N} — {reason}"}
{If no dependencies: omit this section entirely.}

## Additional Context

{Optional: screenshots, logs, links to error tracking, user reports}
{Optional: "**Code branch**: `{branch}`" if the code only exists on a specific branch}
```

---

## Investigation Issue Template

For research, audit, or exploration tasks:

```markdown
## Scope

{What needs to be investigated and why.}

## Questions to Answer

- [ ] {Specific question 1}
- [ ] {Specific question 2}
- [ ] {Specific question 3}

## Starting Points

Files/areas to examine:
1. `{filepath}` — {why start here}
2. `{filepath}` — {why start here}

## Deliverable

{What the investigation should produce:}
- Execution plan with specific sub-issues, OR
- Root cause analysis with fix recommendation, OR
- Decision document with trade-offs

## Context

{Background information the investigator needs.}
```

---

## Title Format

```
{prefix}: {concise description}
{prefix}({scope}): {concise description}
```

| Prefix | Use for |
|--------|---------|
| `fix:` | Bug fixes |
| `feat:` | New features or capabilities |
| `refactor:` | Code restructuring (no behavior change) |
| `docs:` | Documentation only |
| `chore:` | Maintenance (version bumps, CI config) |
| `investigate:` | Research/audit tasks |

**Examples**:
- `fix(billing): division by zero when user credits reach 0`
- `feat: add dark mode toggle to dashboard settings`
- `investigate: why API p95 latency doubled since last deploy`

---

## Priority Labels

| Label | When to use |
|-------|------------|
| `priority:P0` | Production down, data loss, security vulnerability |
| `priority:P1` | Significant user-facing bug, deploy blocked |
| `priority:P2` | Minor bug, non-critical enhancement (default) |
| `priority:P3` | Cosmetic, nice-to-have |

Default to **P2** if unclear.

---

## Mandatory Section Checklist

Before creating the issue, verify:

- [ ] Title follows `{prefix}: {description}` convention
- [ ] `## Problem` — concrete and specific (not "something is wrong")
- [ ] `## Affected Files` — every file path has been verified to exist in the repo
- [ ] `## Expected Behavior` — describes the desired state after the fix
- [ ] `## Acceptance Criteria` — at least one testable `- [ ]` criterion
- [ ] Priority label set
- [ ] Category label set
- [ ] No duplicate issues exist (check open AND recently closed)
