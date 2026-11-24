---
status: fresh
anchor: bin/lean/orchestrate.mjs
created: 2026-11-24
---

# ADR: a batch-level pause, separate from per-issue holds

## Context

`orchestrate --hold` (#4592) records a set of issue numbers. An issue that becomes ready later (a dependency merge, an engine/env re-admit, a requeue or an add) is not in that set and dispatches, so an operator cannot drain a batch for a release cut.

## Choice

- `forgedock orchestrate --pause <id> [--for 2h] --reason T` writes a `pause` file (`batch.mjs` `setPause`: owner, since, expiresAt, reason); `--unpause <id>` removes it. The file is the authority; the runner re-reads it every pass (`getPause`).
- One gate in `isReady` (`orchestrate.mjs`), next to the preflight gate `pfAll`: every admission path ends in `isReady`, so dependency merges, env/engine re-admits, requeues, adds and recovery are all covered. The post-launch recheck also honours it. Running lanes are never stopped.
- Expiry mirrors #5469: `expirePause` lifts a pause past `expiresAt` (row `pause-expired` + decision). A timed pause keeps the batch open; an untimed one ends it pending for `--resume` after `--unpause`.
- Display: `paused (reason, until …)` in `sched show`, the first-hour report and the held row detail; `evaluateDispatchStall` treats a pause as an intended wait, not a stall. Preflight and usage-limit gates stay independent.

## Rejected

- Extending the `hold` file: it is a set of issue numbers and cannot cover issues that appear later.
- `--hold --all` (pause every non-terminal issue, now and later): optional sugar in the issue, deferred; `--pause` covers the drain.
