---
issue: 5839
status: fresh
anchor: bin/lean/mergetrain.mjs
created: 2026-11-24
---

# ADR: merge train phase 3, A/B method and the default

## Decision

`orchestration.merge_train` stays **off**. The lane work (no lane base-sync, one queue per base, post-merge record replay) ships behind the flag, with the per-batch report and the A/B reader. The default flips to `on` only when batch reports from real runs meet the target (throughput 1.5-2x). No measurement is invented here: a live A/B needs real batches on both settings and the state lives on GitHub, so it cannot run inside a lane.

## A/B method

Run two batches of the same size and parallelism (`global_parallel` equal), one with `merge_train: off`, one with `on`, on the same repo and base. Compare, from each batch report:

- merged issues per hour (`throughput:` line, `mergeThroughput` in `bin/engine-cli.mjs`);
- slot-hours per merge (summed lane minutes over merged);
- post-merge fix sessions (fix lanes for a merged tree) and `base.conflict` hand-backs (`merge train:` line: train count next to the lane-side count, wait p50/p90).

Baseline: the serial lane merge measured in epic #5823 (off). Target: 1.5-2x merged/hour with no rise in post-merge fix sessions. First cohort: one low-risk repo batch.

## Hand-over per lane kind

| Lane kind | At PR-ready (train on) | Why |
|---|---|---|
| plain, green | hands over | one merge queue per base |
| plain, pending checks | hands over | slot freed |
| conflicting PR | hands over, no lane base-sync | the train hands back `base.conflict` to a fix lane |
| e2e-gated | e2e gate runs in the lane at the head, then hands over | merge-time work is in the record |
| numbered sequence files | hands over with `postMerge.sequence` | taken numbers surface as a conflict/CI red and are handed back |
| close-time records / pending follow-ups | hands over with a `postMerge` record (notes, `keepOpen`) | the train replays it after the merge |
| split (`refactor:split`) | stays in-lane | a split is never resolved by an LLM and is re-split on the new base |
| stacked PR | stacked syncs stay in-lane | they move the dependency head, not the base queue |

The record is persisted in the train snapshot (and the lane result), so a resumed batch replays it.

## Measured values

Not yet measured: no live A/B has run, so no before/after numbers are recorded and none are invented. Fill this table from the `throughput:` and `merge train:` report lines of the two batches (off, on), then decide the default against the 1.5-2x target.

| Setting | merged/hour | slot-hours per merge | post-merge fix sessions | base.conflict (train / lane) |
|---|---|---|---|---|
| off (baseline, epic #5823) | pending | pending | pending | n/a |
| on | pending | pending | pending | pending |
