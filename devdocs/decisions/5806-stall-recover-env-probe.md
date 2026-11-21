---
status: fresh
anchor: bin/lean/batch-health.mjs
created: 2026-11-21
---

# ADR: setup/dispatch stalls are probed, recovered once, then alerted

## Context

A daemon batch sat in `phase: setup` (0/4 issues read) for half an hour. Its pinned env PATH had been reduced to one bogus entry (`sanitizePath` split a Windows `;` PATH on `:`), and the schedd was down. `dispatch-stalled` fired only after 23 min, as a log line with `--resume`/`--cancel` suggestions; nothing acted on it.

## Decision

- `sanitizePath` splits on the platform PATH separator. `probeBatchEnv` (`lanecheck.mjs`) resolves `gh`, `git` and `node` on the batch env PATH with `which` (no shell; on win32 `;` and PATHEXT). `runBatch` refuses a create or resume whose pinned env fails it, naming the missing tools and the `--set-env` fix.
- `DEFAULT_STALL_MIN` drops from 10 to 3 (`FORGEDOCK_SCHEDD_STALL_MIN` still overrides); the setup phase is named in the stall detail.
- `decideStallAction` (pure): broken env → alert at once; first stall of a ready set → `resume` (unhosted) or `restart-daemon` (hosted runner wedged; the #5204 handover path); same ready set again, or 3 recoveries spent → alert with the probed cause. The recovery is stored in `health.json` `stallRecovery`, so a restarted daemon never re-arms it, and logged as a `FORGE:DECISION ... stall-recovery` line.
- `forgedock schedd watchdog` starts a down daemon while daemon batches are unfinished.

## Consequences

A stall is acted on within about 4 min (3 min window plus the 60 s scan). A hosted runner started less than a window ago is never restarted. A legitimately long admission hold with free lanes costs one daemon restart, then alerts. Recovery cannot loop: one per ready set, at most three per batch.
