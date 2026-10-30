**Verdict**: ALREADY-FIXED
**Confidence**: high
**Severity**: high (was)
**Task Type**: bug

### What Was Claimed
With all pool agents offline, `sandbox.unreachable` lanes burn max_deferrals, launches loop on capacity 503, nobody is alerted, and fallback_local cannot fire because the router gives no `online`.

### What We Found
- orchestrate.mjs:128 (origin/staging) `UNCAPPED_DEFERRALS` includes `sandbox.unreachable`.
- sandbox-remote.mjs:47,85-93 `capacity()` falls back to `GET /agents` computing online/total when `/status` lacks `online`.
- orchestrate.mjs:291,494-502 tracks poolOfflineSince, emits one `pool-offline` batch event after `remote.poolOfflineMin` (default 10), resets when online > 0.
- orchestrate.mjs:504 fallback_local now fires on sampled online === 0.

### Root Cause
Was the three points in the issue; all addressed by #4788 / PR #4798.

### Affected Files
None to change.

### Sibling Sweep
SANDBOX_AUTH stays capped by design.

### History
#4788 (PR #4798) delivered exactly the issue's recommendations; this issue duplicates it.

### Recommendation
Close as already fixed.

### Related Issues
#4788, #4789, #4528, #4547, #4672
