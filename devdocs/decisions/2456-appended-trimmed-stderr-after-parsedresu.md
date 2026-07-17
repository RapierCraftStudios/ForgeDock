---
issue: 2456
pr: 2476
commit: e4508319bfc8
status: fresh
anchor: bin/runner.mjs
created: 2026-07-17
---

# ADR — Appended trimmed stderr after parsedResult on the runCliBackend success path instead of always discarding it, mirroring the existing "combine streams" fix for run_bash (#1229), because the prior JSON-envelope-parsing behavior silently dropped stderr warnings/banners on a clean exit — a real behavior regression from the pre-#2398 baseline.

## Decision

Appended trimmed stderr after parsedResult on the runCliBackend success path instead of always discarding it, mirroring the existing "combine streams" fix for run_bash (#1229), because the prior JSON-envelope-parsing behavior silently dropped stderr warnings/banners on a clean exit — a real behavior regression from the pre-#2398 baseline.

## Context

Auto-extracted from FORGE:TRAJECTORY Decisions section on issue #2456.

**Citations**:
- Issue: https://github.com/RapierCraftStudios/ForgeDock/issues/2456
- PR: https://github.com/RapierCraftStudios/ForgeDock/pull/2476
- Commit: e4508319bfc8
- Anchor: `bin/runner.mjs`

## Status

`fresh` — anchor is active. Architect plans on future runs will inject this ADR as a constraint
when the anchor path overlaps the contract files.

Set `status: needs-review` manually (or the staleness pass in `build-knowledge-index.mjs` will
flip it automatically) when the anchored code region no longer exists.
