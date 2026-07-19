---
issue: 2447
pr: 2472
commit: 30158d7b8fdf
status: fresh
anchor: scripts/severity-to-priority.sh
created: 2026-07-17
---

# ADR — Extracted the severity→priority mapping into a shared script rather than editing the two command specs independently, because both files had already drifted once from a shared logical intent

## Decision

Extracted the severity→priority mapping into a new shared script (`scripts/severity-to-priority.sh`) rather than editing the two command specs (`commands/review-pr.md`, `commands/review-pr-staging.md`) independently, because both files had already drifted once from a shared logical intent (confidence-based derivation, introduced in two separate commits on 2026-06-06: `c0d04bb` and `957b513`) — a shared script is enforceable drift-prevention where prose alone previously failed.

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
