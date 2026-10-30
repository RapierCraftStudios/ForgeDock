**Verdict**: ALREADY-FIXED
**Confidence**: high
**Severity**: high (was: remote batches stall silently when the pool is offline)
**Task Type**: bug

### What Was Claimed
With every computeshare agent offline, `sandbox.unreachable` lanes burn `max_deferrals` and give up, and nothing alerts. `online` is unknown because the router has no `/status`, so `execution.fallback_local` cannot fire.

### What We Found
- bin/lean/orchestrate.mjs:128 `UNCAPPED_DEFERRALS` now includes `sandbox.unreachable` (and `lane.unresolved`); :183 `deferPolicy` requeues it uncapped.
- bin/lean/sandbox-remote.mjs:~86-96 `capacity()` falls back to `GET /agents` and derives `online` (`ok && !paused`) and `total` when `/status` has no valid `online`; a failing `/agents` leaves it unknown.
- bin/lean/orchestrate.mjs:494-502 `grant` tracks `poolOfflineSince` and emits ONE `pool-offline` batch update after `POOL_OFFLINE_ALERT_MIN` (10, :129) minutes, and resets when online > 0.
- Tests: bin/lean/batch.test.mjs:814 and :971; bin/lean/sandbox-provider.contract.test.mjs:328.
- Docs: devdocs/modules/lean.md:2053.
- Commit 9fde433eb is an ancestor of both origin/staging and HEAD.

### Root Cause
Fixed upstream: unreachable was capped like an ordinary deferral, liveness came only from `/status`, and there was no stall report.

### Affected Files
None to change.

### Sibling Sweep
`SANDBOX_AUTH` stays capped on purpose, since it needs a human fix. Minor gap: `remote.poolOfflineMin` is read at orchestrate.mjs:497 but no `execution` key sets it, so the 10-minute default is not configurable. The issue's "configurable" wording was an optional detail.

### History
9fde433eb "fix(orchestrate): offline compute pool no longer exhausts max_deferrals; derive online from /agents; report pool stall (#4788)". Earlier: #4528, #4547, #4672.

### Recommendation
Close as already fixed. Optionally file a follow-up to wire `execution.pool_offline_min` into `remote.poolOfflineMin`.

### Related Issues
#4788, #4528, #4547, #4672, #4540.
