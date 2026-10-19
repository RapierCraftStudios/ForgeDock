---
issue: 4172
pr: null
commit: null
status: fresh
anchor: scripts/affected-files-check.sh
created: 2026-10-20
---

# ADR — `/issue` greenfield mode validates planned Affected Files against the spike's declared repo layout, in a script

## Decision

`/issue` Phase 3E rule 2 ("Affected files are real") is now checked by `scripts/affected-files-check.sh`, not by LLM prose.

- **Brownfield (default):** every backticked path in `## Affected Files` must exist at `origin/staging` or `origin/main`. This is the same rule as before.
- **Greenfield mode:** triggered by `--greenfield`, by `--spike <path>`, or by the spike doc (default `docs/engineering/technical-spike.md`) having a `Repo layout` heading. A path that does not exist yet passes as `PLANNED` when either:
  - it equals a path declared in that section, or
  - it sits under a declared directory (an entry ending in `/`).

## Context

Greenfield issues (#4155, `/bootstrap`) list files that are still to be created, so the existence-only gate rejected them. Following NORTHSTAR non-negotiables 1 and 7, the path facts move into a deterministic script, and the spec keeps only the routing.

The layout format is deliberately minimal, because no spike template exists yet (#4155 item 9):
- entries are backticked paths, plus the lines of fenced tree blocks;
- tree glyphs and `#` comments are stripped;
- every entry is a full repo-relative path, and indentation is not reconstructed.

## Consequences

- Phase 3F (programmatic validation) and Phase 4C.5 (post-create section repair) are unchanged, because they check section presence only.
- If the helper does not resolve, Phase 3E falls back to the manual `git show` check.
- Exit codes: 1 means `MISSING`, which fails validation. 2 means the spike doc is missing or declares no layout.

## Status

`fresh`: the anchor is active.
