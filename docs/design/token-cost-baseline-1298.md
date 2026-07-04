# Token-cost baseline measurement plan — issue #1298

**Parent**: #1255
**Depends on**: #1295, #1296, #1297 (tooling), #1246, #1247, #1249, #1254 (optimization PRs)

## Purpose

Close the loop on #1255's "measured, not estimated" savings claim by capturing
before/after token-cost baselines using `scripts/bench-topology-cost.mjs` around
the landing of each optimization PR.

## Tooling

`scripts/bench-topology-cost.mjs` — reads a `runs.json` file of per-issue token
usage records and emits a cost comparison table across pipeline topologies.

Baseline inputs are `FORGE:USAGE_JSON` annotations written to GitHub by the
pipeline (via `bin/runner.mjs`'s `renderSummaryCard`). Collect them with:

```bash
# Collect FORGE:USAGE_JSON annotations from the last N issue runs
gh issue list -R <repo> --state closed --label workflow:merged --limit 20 \
  --json number,comments \
  | jq '[.[] | {number: .number, comments: [.comments[].body | select(contains("FORGE:USAGE_JSON"))]}]'
```

Then feed the extracted token counts into a `runs.json` for `bench-topology-cost.mjs`.

## Measurement gates

Run the corpus (5 seeded issues in `examples/forgedock-demo/`) through the pipeline
and record token counts **immediately before** and **immediately after** each PR lands:

| Gate | PR | Description |
|------|----|-------------|
| Before #1246 | — | Baseline: current skills-format |
| After #1246  | #1246 | Skills-format migration |
| After #1247  | #1247 | Single-source FORGE protocol |
| After #1249  | #1249 | Model/effort tiering (Haiku/xhigh) |
| After #1254  | #1254 | Agent topology refactor |

## Results

_To be filled in as each dependency PR lands. Record before/after deltas as comments
on issue #1298 and update this table._

| PR | Topology | Avg input tokens | Avg output tokens | Delta vs prior |
|----|----------|-----------------|-------------------|----------------|
| (baseline) | spawned | — | — | — |
| #1246 | spawned | — | — | — |
| #1247 | spawned | — | — | — |
| #1249 | spawned+tiering | — | — | — |
| #1254 | inline-sequential | — | — | — |

## Status

Dependencies #1246, #1247, #1249, #1254 are all open as of 2026-07-04. Measurements
cannot be taken until those PRs land. This document serves as the tracking record and
protocol so that whoever executes the measurements has the exact steps available.
