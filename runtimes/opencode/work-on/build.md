# Phase: Build

Implement the approved plan in the controller-supplied worktree and create a
real commit. Do not push or open a PR; the review phase owns those effects.

1. Verify a complete investigator and architect annotation exist. Read the
   context annotation when present. Treat architecture constraints and danger
   cards as binding.
2. Add `workflow:building`; remove `workflow:ready-to-build`.
3. If absent, post a `FORGE:CONTRACT` comment with task type, exact deliverables,
   acceptance checks, files, and preserved interfaces.
4. Confirm the worktree is on the branch and base supplied in the invocation
   context. Never switch branches, modify another worktree, or guess a new base.
5. Inspect current status before editing. Preserve unrelated changes. Implement
   the smallest complete change, including tests and configuration/docs only
   when required by behavior.
6. Run focused tests, formatting, static checks, and any repository-required
   quality command. Fix failures caused by the change. Record skipped checks
   and why.
7. Review the final diff for secrets, generated artifacts, debug code, unrelated
   edits, and acceptance-criteria coverage.
8. Stage only intended files and create a concise non-empty commit. Do not amend,
   bypass hooks, or add attribution trailers.
9. Only after the commit exists and the branch is ahead of the supplied base,
   post:

```markdown
<!-- FORGE:BUILDER -->
**Branch**: `<branch>`
**Commits**: <count or SHA>
**Files changed**: <count>

## Implementation
...

## Verification
- `<command>`: PASS | FAIL | SKIPPED (reason)

## Acceptance Criteria
- criterion: PASS | FAIL
<!-- FORGE:BUILDER:COMPLETE -->
```

If no change is needed, do not fabricate a commit or completion marker. Post a
blocker and add `needs-human` so the issue can be re-scoped.
