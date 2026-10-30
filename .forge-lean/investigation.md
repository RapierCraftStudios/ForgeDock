**Verdict**: ALREADY-FIXED
**Confidence**: high
**Severity**: high (was: remote batches stall silently)
**Task Type**: bug

### What Was Claimed
With every compute-pool agent offline, `sandbox.unreachable` lanes exhaust `max_deferrals`, the router gives no `online` count so `fallback_local` never fires, and nothing alerts.

### What We Found
- bin/lean/orchestrate.mjs:125 `UNCAPPED_DEFERRALS` now includes `sandbox.unreachable`.
- bin/lean/orchestrate.mjs:487-495 tracks `poolOfflineSince` and emits one `pool-offline` update after `poolOfflineMin` (default 10); it resets when online > 0.
- bin/lean/sandbox-remote.mjs:88-93 `capacity()` derives `online` and `total` from `GET /agents` (`ok && !paused`) when `/status` has none.
- bin/lean/batch.test.mjs:982 covers the one-shot event and the reset.

### Root Cause
Fixed by 9fde433eb (#4788, closed).

### Affected Files
None remaining.

### Sibling Sweep
`sandbox.auth` stays capped on purpose (needs a human).

### History
9fde433eb "fix(orchestrate): offline compute pool no longer exhausts max_deferrals; derive online from /agents; report pool stall (#4788)".

### Recommendation
Close #4763 as a duplicate of #4788.

### Related Issues
#4788, #4528, #4547, #4672
