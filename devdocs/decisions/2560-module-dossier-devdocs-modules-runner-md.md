---
issue: 2560
pr: 2574
commit: fa4769dcf325
status: fresh
anchor: devdocs/modules/runner.md
created: 2026-07-18
---

# ADR — Module dossier (`devdocs/modules/runner.md`) not updated with a new entry because origin/staging already carries an entry documenting this exact finding (written when the originating feature #2524/PR #2555 was reviewed, which anticipated and cited #2560).

## Decision

Module dossier (`devdocs/modules/runner.md`) not updated with a new entry because origin/staging already carries an entry documenting this exact finding (written when the originating feature #2524/PR #2555 was reviewed, which anticipated and cited #2560).

## Context

Auto-extracted from FORGE:TRAJECTORY Decisions section on issue #2560.

**Citations**:
- Issue: https://github.com/RapierCraftStudios/ForgeDock/issues/2560
- PR: https://github.com/RapierCraftStudios/ForgeDock/pull/2574
- Commit: fa4769dcf325
- Anchor: `devdocs/modules/runner.md`

## Status

`fresh` — anchor is active. Architect plans on future runs will inject this ADR as a constraint
when the anchor path overlaps the contract files.

Set `status: needs-review` manually (or the staleness pass in `build-knowledge-index.mjs` will
flip it automatically) when the anchored code region no longer exists.
