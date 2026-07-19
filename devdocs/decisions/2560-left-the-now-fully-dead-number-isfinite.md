---
issue: 2560
pr: 2574
commit: fa4769dcf325
status: fresh
anchor: unknown
created: 2026-07-18
---

# ADR — Left the now-fully-dead `Number.isFinite(hour)` check in place because the issue explicitly marked its removal as optional/non-blocking, to keep the diff minimal.

## Decision

Left the now-fully-dead `Number.isFinite(hour)` check in place because the issue explicitly marked its removal as optional/non-blocking, to keep the diff minimal.

## Context

Auto-extracted from FORGE:TRAJECTORY Decisions section on issue #2560.

**Citations**:
- Issue: https://github.com/RapierCraftStudios/ForgeDock/issues/2560
- PR: https://github.com/RapierCraftStudios/ForgeDock/pull/2574
- Commit: fa4769dcf325
- Anchor: `no file anchor found`

## Status

`fresh` — anchor is active. Architect plans on future runs will inject this ADR as a constraint
when the anchor path overlaps the contract files.

Set `status: needs-review` manually (or the staleness pass in `build-knowledge-index.mjs` will
flip it automatically) when the anchored code region no longer exists.
