---
issue: 4376
status: fresh
anchor: bin/lean/orchestrate.mjs
created: 2026-10-23
---

# ADR: `forgedock orchestrate --cancel <id>` stops one batch, never the shared schedd

## Context

A batch stuck in preflight GC (#4361) could not be stopped on its own. The only options were to wait, or to kill `forgedock schedd`, which hosts every batch on the host, including other repos' batches. The daemon had per-batch controls for K (`parallel` file) and issues (`add` file, #4408), but none for stopping a batch.

## Decision

- **Cancel file:** a per-batch `cancel` file (`{at, reason}`, `batch.mjs` `requestCancel`/`readCancel`/`clearCancel`), the same pattern as `parallel` and `add`. The schedd `cancel` op writes it. With no daemon, the client writes it directly. It works for daemon-hosted, foreground and unhosted batches, and survives a daemon restart.
- **Runner:** `orchestrate()` re-reads the file every pass through `getCancelled`, and polls it at `pollMs` while lanes run or the batch waits on a delay. On a cancel it:
  - admits nothing more;
  - logs one `cancelled` row and one batch decision;
  - sends SIGTERM to each running local lane through `stopLane` (`killLedgerPid` to the lane's process group, with a pid-reuse check on the result path).
- **Lane teardown:** the lane's #4179 teardown saves the checkpoint, worktree and lease, then reports `deferred run.interrupted`. That result (or an engine-error from a lane that died) is requeued with no deferral and no usage-limit hold. Once nothing runs, the batch ends with every unfinished issue `held: cancelled by operator` and writes its report, so a daemon restart does not resume it.
- **Resume:** `--resume <id>` is the operator's decision to continue. It clears the file, as it resets the breaker. A daemon restart (`keepBreaker`) keeps the cancel.

## Rejected

- **Killing the daemon:** this is the problem being fixed.
- **SIGKILL of lanes:** it skips the teardown and loses the builder's work (non-negotiable 5).
- **Destroying remote sandboxes:** provider teardown has no checkpoint. Remote lanes run to their result while admissions stay closed.
- **A terminal `cancelled` outcome:** it would need its own resume path. `held` already has one, and its dependents stay pending instead of being skipped.
