---
issue: 2459
pr: 2497
commit: d04c984f4397
status: fresh
anchor: bin/journey.mjs
created: 2026-07-17
---

# ADR — Overwrite-and-adopt (not warn-and-skip) chosen for the non-manifest regular-file branch, because every path in forge()'s loop is enumerated from ForgeDock's own commandsDir and therefore never an arbitrary user file — mirroring the manifest-tracked branch's existing behavior.

## Decision

Overwrite-and-adopt (not warn-and-skip) chosen for the non-manifest regular-file branch, because every path in forge()'s loop is enumerated from ForgeDock's own commandsDir and therefore never an arbitrary user file — mirroring the manifest-tracked branch's existing behavior.

## Context

Auto-extracted from FORGE:TRAJECTORY Decisions section on issue #2459.

**Citations**:
- Issue: https://github.com/RapierCraftStudios/ForgeDock/issues/2459
- PR: https://github.com/RapierCraftStudios/ForgeDock/pull/2497
- Commit: d04c984f4397
- Anchor: `bin/journey.mjs`

## Status

`fresh` — anchor is active. Architect plans on future runs will inject this ADR as a constraint
when the anchor path overlaps the contract files.

Set `status: needs-review` manually (or the staleness pass in `build-knowledge-index.mjs` will
flip it automatically) when the anchored code region no longer exists.
