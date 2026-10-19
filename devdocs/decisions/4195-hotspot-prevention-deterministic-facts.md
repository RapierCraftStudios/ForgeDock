---
issue: 4195
status: fresh
anchor: devdocs/modules/lean.md
created: 2026-10-20
---

# ADR — Hotspot prevention: deterministic facts at plan time, unexempted growth blocks in precheck

## Context

On target repos every lane appended its change to the existing file, so a few files grew to tens of thousands of
lines with hundreds of commits per quarter. Nothing in core work-on looked at file size or churn.

## Decision

- `scripts/hotspots.sh` (git + wc + jq; yq only to read `maintenance.hotspot`) produces the facts. It runs one
  `git rev-list --count --since=90.days HEAD -- <path>` per file, 8 at a time. It reads no blob unless `--base` is
  given, and then only the merge-base side, to compute growth.
- The planner gets one sentence plus one line per over-threshold file, nothing when none. The builder gets one rule.
  Neither adds a runner call.
- `hotspotGrowth` in precheck fails with `maintenance.hotspot_growth`. The failure is in `SHADOW_PRE_BLOCKS` because it is
  a deterministic fact about the builder's own diff (like a failed validate). The existing loop gives one resume.
- The exemption is a `hotspot-exempt: <reason>` string in the covering deliverable's `change` (or an add-deliverable
  amendment's `why`), so it is frozen with the contract and visible to the reviewer.

## Rejected

- One `git log --name-only` walk for all files: one walk instead of N, but its merge and path-simplification
  semantics differ from `rev-list --count` per path, so the counts would not be exact.
- Reading `maintenance.hotspot` with `parseForgeYaml`: it flattens nested blocks and arrays (`exclude_globs`).
- Report-only in shadow: a warning nobody reads (NORTHSTAR anti-goal); the growth is cheap to move at resume time.

## Merge with the maintenance budget (#4197)

#4197 added a flat `maintenance:` block (`enabled`, `file_lines`, ...) read by `parseForgeYaml` and by `yaml_maint` in
`scripts/maintenance-scan.sh`. `parseForgeYaml` flattens one nested level on purpose (`engine.admission.*`,
`lane_limits.*` rely on it), so `maintenance.hotspot.enabled: true` would have turned the budget on and overwritten
its `file_lines`. The fix is local: `readMaintenance` drops the `hotspot:` sub-map before parsing, and `yaml_maint`
reads direct children of `maintenance:` only. The shared parser is unchanged.
