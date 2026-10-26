---
issue: 4592
status: fresh
anchor: bin/lean/orchestrate.mjs
created: 2026-10-25
---

# ADR: `forgedock orchestrate --hold` / `--release` hold single issues of a batch

## Context

`--cancel` (#4376) is all-or-nothing. After it, `--resume <id> 67 72` printed `skipped #67 (already in batch)`, because `--add` only takes issues that are not in the batch (#4408). There was no way to pause one issue and re-admit it later. A resume that only reattached to a batch the daemon still hosted also left the pending cancel in force.

## Decision

- **Hold file:** a per-batch `hold` file (sorted unique issue numbers, `batch.mjs` `holdIssues`/`releaseIssues`/`readHeld`), the same pattern as `parallel`, `add` and `cancel`. The schedd `hold`/`release` ops write it; with no daemon the client writes it directly.
- **Runner:** `orchestrate()` re-reads it every pass through `getHeld`. A held issue is never ready, so it and its dependents stay pending. A running lane is not stopped. One `hold`/`release` row and decision are logged when the set changes. When only held issues remain and nothing runs, the batch ends with them `held: held by operator`, the existing `held` outcome that a resume re-admits.
- **Resume:** `--resume <id> N...` releases the named issues that are held, so they run. The schedd `attach` op takes `resume: true` and clears a pending cancel even when the batch is still hosted, as the rehost path already did (`engine-cli.mjs` `runBatch`). A daemon restart keeps both the cancel and the holds.

## Rejected

- **Holding in `state.json`:** the runner owns that file, so a client could not write it while the batch runs.
- **A new terminal outcome:** `held` already has a resume path (see ADR 4376).
- **Stopping remote lanes at cancel:** the sandbox provider has no checkpoint (ADR 4376); deferred as separate provider work.
