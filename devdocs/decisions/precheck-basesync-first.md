---
status: fresh
anchor: bin/lean/lean.mjs
created: 2026-11-27
---

# ADR: a precheck failure on a lane behind its base is rerun on the merged tree before it is classified

## Context

The pre-PR precheck runs the repo's guard commands (a lane-checks script, or a host guard calling it) from the lane branch's own copy. When the base fixed that script, resumed, recovered or requeued lanes still ran the old copy and parked again as env.tool_missing or ci.red, repeatedly (#6153). #6107 synced the base before a ci.red recovery only.

## Decision

- `syncBaseForChecks` (lean.mjs) merges the base when the branch is behind it (conflicts: deterministic resolvers as in the #6107 path, else base.conflict). It runs at most once per lane run.
- It runs before the first precheck of a `ci.red` or `env.tool_missing` recovery, and on the first failing precheck round of any lane: after a merge the checks rerun (no builder round spent) before the failure is classified as env.tool_missing, flake, ci.red or a fix round.
- Rule kept simple: lane behind base means sync then rerun once; no per-file "did the base touch the referenced script" analysis.

## Consequences

A lane never fails on a script the base already fixed. A genuinely failing check costs one extra merge and rerun. A lane that is not behind is unchanged.
