---
issue: 2502
pr: 2526
commit: eb426071f55cccebdaea668bb60d67e0ecf97e90
status: fresh
anchor: commands/orchestrate/phase-3-dependency.md
created: 2026-07-17
---

# ADR — Scope kept to single line, not a repo-wide requoting pass

## Decision

Scope kept to single line: sibling-pattern sweep confirmed unquoted `-R {GH_REPO}` is the
prevailing convention elsewhere in `commands/`, so a repo-wide requoting pass was not
undertaken.

## Context

Auto-extracted from FORGE:TRAJECTORY Decisions section on issue #2502.

Investigation for #2502 (a review finding from PR #2500) confirmed that
`commands/orchestrate/phase-3-dependency.md:81` had an internally inconsistent quoting
style: `"$NUM"` was quoted while the adjacent `-R {GH_REPO}` was not. Before fixing,
a sibling-pattern sweep across all of `commands/*.md` found 100+ other occurrences of
unquoted `-R {GH_REPO}`, confirming that unquoted is the dominant convention project-wide.
Widening the fix to requote all occurrences would have contradicted that convention and
introduced unrequested scope. The fix was therefore kept to the single line the issue
named — the internal inconsistency within that one call site — not a broader style pass.

**Citations**:
- Issue: https://github.com/RapierCraftStudios/ForgeDock/issues/2502
- PR: https://github.com/RapierCraftStudios/ForgeDock/pull/2526
- Commit: eb426071f55cccebdaea668bb60d67e0ecf97e90
- Anchor: `commands/orchestrate/phase-3-dependency.md`

## Status

`fresh` — anchor is active. Architect plans on future runs will inject this ADR as a
constraint when the anchor path overlaps the contract files.

Set `status: needs-review` manually (or the staleness pass in `build-knowledge-index.mjs`
will flip it automatically) when the anchored code region no longer exists.
