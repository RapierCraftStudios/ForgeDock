---
issue: 4695
status: fresh
anchor: bin/lean/decisions.mjs
created: 2026-10-27
---

# ADR: decisions are anchored to paths and superseded by status records

## Context

Settled choices lived in prose `FORGE:DECISION` comments tied to no code, so later lanes re-litigated them (#1737 did this for the legacy path as advisory documents).

## Decision

- A decision record carries anchors (files, `dir/` prefixes or globs), optional symbols and `supersedes`, as JSON on the `<!-- FORGE:DECISION {json} -->` marker line. GitHub is the register; `~/.forge/decisions/<repo>.json` is a rebuildable index (`decisions list --refresh`).
- Supersession appends a new record of the old decision (`status: superseded`, `superseded_by`) on the old issue instead of editing its comment: the latest record per id wins, history stays, no extra permissions.
- Rows reuse the `H<n>` preserve shape of #4694 (`source: "decision"`) under one cap of 5, so the reviewer's existing preserve check enforces them with no new LLM call, phase or prompt text. Standalone: #4695 does not wait for guards (#4692/#4694).
- Anchor validation is a match against one `git ls-tree` of the base, run only when a lane posts a decision amendment. Stale means an active decision with an anchor matching no base file; it is reported, never applied.
