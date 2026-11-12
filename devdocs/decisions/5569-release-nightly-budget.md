---
status: fresh
anchor: bin/lean/release-nightly.mjs
created: 2026-11-12
---

# ADR: nightly results and Actions-minutes accounting for managed releases

## Context

CI runs ~106k Actions minutes a month against a 50k target and a release's cost cannot be forecast (#5569, epic #5549 Phase 7, design 5.6 and 5.8).

## Decision

- `release-nightly.mjs`: read the newest nightly run on the integration branch. T0-T2 reds come from the newest run, T3-T4 from the newest run inside the weekly window. Any red files or refreshes one open `nightly-red` issue. `blocksRelease` blocks only `lane: release`, by T0-T2 or `unskippable` reds; T3/T4, train and p0 never.
- `release-minutes.mjs`: minutes = sum of ceil(job minutes) from the jobs API (`billable_ms` is 0 for the repo). The total is stored as `state.minutes` and mirrored by the existing ledger write. The forecast is the lane's trailing median of recorded releases; `budget.on_exceed` is local-first, hold or proceed, and p0 always proceeds (I14).
- `RELEASE_STEPS` has no PLANNED/APPROVED state, so `managedGate` in `release.mjs` runs before the first step of a release that has not started yet. A resumed, partly done release is not re-gated.
- Off by default: the blocks are read only with `release.managed`, so an unmanaged release makes no extra call. Every read is best effort; unreadable facts proceed.
- The existing `releaseRuns` (wall-time, report line only) is unchanged.

## Not in this change

Forecast beyond "record and report", the bloat gate, the Actions quota (Q1, owner), and reading history from other hosts' ledgers (the forecast reads the local release cache).
