---
issue: 2447
pr: 2472
commit: 30158d7b8fdf
status: fresh
anchor: scripts/severity-to-priority.sh
created: 2026-07-17
---

# ADR — Applied the corrected severity-based mapping when creating this PR's own review-finding issues rather than the pre-fix confidence-based mapping still live on origin/staging at review time, since the fix had already merged

## Decision

Applied the corrected severity-based mapping when creating this PR's own review-finding issues (#2479 `priority:P2` for MEDIUM severity, #2480/#2481 `priority:P3` for LOW severity) rather than the pre-fix confidence-based mapping still live on `origin/staging` at review time, since PR #2472 (the fix itself) had already merged before finding triage ran.

## Context

Auto-extracted from FORGE:TRAJECTORY Decisions section on issue #2447.

**Citations**:
- Issue: https://github.com/RapierCraftStudios/ForgeDock/issues/2447
- PR: https://github.com/RapierCraftStudios/ForgeDock/pull/2472
- Commit: 30158d7b8fdf
- Anchor: `scripts/severity-to-priority.sh`

## Status

`fresh` — anchor is active. Architect plans on future runs will inject this ADR as a constraint
when the anchor path overlaps the contract files.

Set `status: needs-review` manually (or the staleness pass in `build-knowledge-index.mjs` will
flip it automatically) when the anchored code region no longer exists.
