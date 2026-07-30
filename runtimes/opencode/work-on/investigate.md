# Phase: Investigate

Validate that the issue describes a real, current repository problem before any
implementation is attempted.

1. Read the issue, labels, milestone, comments, `forge.yaml`, repository
   instructions, and any explicitly cited PRs/issues.
2. Reproduce or prove the behavior where practical. Trace the complete code
   path, callers, configuration, tests, and relevant git history. Do not accept
   a proposed fix as the root cause without verification.
3. Classify the verdict as `CONFIRMED`, `PARTIAL`, or `INVALID`; confidence as
   `HIGH`, `MEDIUM`, or `LOW`; severity as `CRITICAL`, `HIGH`, `MEDIUM`, or
   `LOW`; and task type as `Bug Fix`, `Feature`, `Refactor`, `Maintenance`, or
   `Investigation`.
4. Decide whether the work must be decomposed. Use `YES` only when independent
   ordered sub-issues are required; include their titles, scopes, dependencies,
   acceptance criteria, and affected files.
5. Post exactly one complete investigator annotation containing at least:

```markdown
<!-- FORGE:INVESTIGATOR -->
**Verdict**: CONFIRMED | PARTIAL | INVALID
**Confidence**: HIGH | MEDIUM | LOW
**Severity**: CRITICAL | HIGH | MEDIUM | LOW
**Task Type**: Bug Fix | Feature | Refactor | Maintenance | Investigation
**Decomposition Assessment**: YES | NO

## Evidence
...

## Root Cause
...

## Affected Files
- `path`

## Acceptance Criteria
- ACCEPTANCE_CHECK: verifiable condition

## Decomposition Plan
...
<!-- INVESTIGATION:COMPLETE -->
```

For `INVALID`, replace the final line with
`<!-- INVESTIGATION:INVALID -->`; never emit both sentinels. For decomposition,
also include a standalone `DECOMPOSE:YES` line before the completion sentinel.

6. Reconcile labels:
   - `CONFIRMED`/`PARTIAL` without decomposition: add
     `workflow:ready-to-build`; remove `workflow:investigating`.
   - decomposition: keep the parent out of build; the decompose phase owns the
     terminal `workflow:decomposed` transition.
   - `INVALID`: add `workflow:invalid`, remove active workflow labels, and close
     the issue with a concise reason.

Do not edit code in this phase.
