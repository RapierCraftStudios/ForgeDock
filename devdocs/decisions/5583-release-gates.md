---
status: fresh
anchor: bin/lean/release-gates.mjs
created: 2026-11-13
---

# ADR: deploy gate catalogue and false-block demotion

## Context

No per-gate false-block statistics existed (#5583, epic #5549 N4). Flakes (#5568) and controls (#5556) cover checks, not deploy gates.

## Decision

- The catalogue is `.forge/gates.yaml`, read with `git show <ref>:` (never the worktree for policy, as `.forge/release.yaml`), validated closed in `release-gates.mjs`.
- Telemetry records live in the release state (`state.gates`); a TP/FB class needs evidence, else `unknown`, so unreviewed data never drives demotion.
- Demotion uses new `demote`/`promote` verbs of `runControl` (not `exempt`: it is skip/quarantine only, capped at 24h and refuses unskippable classes). The state is `gateModes` in `_active`, with an expiry and the standard audit line. Safety gates are refused in the verb itself, so a manual demote cannot bypass the allowlist. Promotion requires `--fixture`.
- The FB rate is FB runs / runs over the last full window, and the report's FB share is the same number.

## Consequences

Nothing reads `gateModes` to change a deploy yet: the repo's deploy job uses `effectiveMode`. Without a catalogue nothing runs or writes.
