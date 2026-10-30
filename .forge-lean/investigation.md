**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: high (remote batches stall silently for hours; lanes give up)
**Task Type**: bug

### What Was Claimed
With every computeshare agent offline, `sandbox.unreachable` lanes burn `max_deferrals` and give up; new launches loop on `sandbox.capacity` 503 forever; nobody is alerted. The addendum says `execution.fallback_local` cannot fire because the computeshare router gives no `online` count.

### What We Found
- bin/lean/orchestrate.mjs:123 `UNCAPPED_DEFERRALS` holds only `host.busy` and `sandbox.capacity`. `sandbox.unreachable` goes through the capped path (:175-179, :600-619) and ends "gave up after N deferrals".
- bin/lean/execution.mjs:~519 `unreachable()` returns deferred `SANDBOX_UNREACHABLE` with retryInSeconds 60. It is the code that is capped.
- bin/lean/orchestrate.mjs:481 the fallback needs `cap.online === 0`.
- bin/lean/sandbox-remote.mjs:80-91 `httpTransport.capacity()` reads only `GET /status` for `{free, online, total}`. A 404 or malformed reply gives null, so `online` is unknown and the fallback never fires.
- bin/pool/router.mjs:89-94 and :230 the built-in router derives `online` (`ok && !paused`) and serves `/status`. The computeshare router has `/agents` only (`/status` and `/capacity` are 404 there).
- bin/engine-cli.mjs:1628 samples capacity and `online`, so a transport that returns `online` is enough.
- Nothing emits a pool-offline event or alert. Grep for notify in orchestrate.mjs and engine-cli.mjs found nothing relevant.

### Root Cause
1. `sandbox.unreachable` is capped like an ordinary deferral, although it means the pool is down (a wait, not a failure; see #4528).
2. The remote transport derives liveness only from `/status`, so against a router without it `online` is undefined and #4547 is dead.
3. No stall detector or alert.

### Affected Files
bin/lean/orchestrate.mjs, bin/lean/sandbox-remote.mjs, bin/lean/execution.mjs (config key if added), tests: bin/lean/batch.test.mjs, bin/lean/sandbox-provider.contract.test.mjs, bin/lean/execution.test.mjs.

### Sibling Sweep
- `SANDBOX_AUTH` (401/403, 300s) is also capped; correct, since it needs a human fix.
- The `engine-error` relaunch (`TRANSPORT_TEXT` breaker, orchestrate.mjs:~530) is related, but out of scope.
- No other transport reports liveness, only httpTransport.

### History
#4528 uncapped `sandbox.capacity`. #4547 added `offlineFallback`, gated on `online`. #4672 added unreachable-window retries and the `sandbox.unreachable` code.

### Recommendation
1. Add `sandbox.unreachable` to `UNCAPPED_DEFERRALS`. Its retry is already bounded by `unreachable_window_min` plus the 60s delay.
2. In `httpTransport.capacity()`, when `/status` yields no `online`, query `GET /agents` and compute `online = count(ok && !paused)` and `total`. A failed `/agents` leaves it unknown; keep `free` if present.
3. In orchestrate `grant`, track the first time `cap.online === 0`. Once it has lasted more than N minutes (default 10, configurable via `execution`), emit ONE `update({outcome:"pool-offline"...})` batch event, plus the status-line report and a notification if an existing mechanism is reachable. Reset when online > 0. With `fallback_local` unset the batch stays in remote mode and reports only; a default host fallback is deferred (it overrides an opt-in and risks host overload).

### Related Issues
#4528, #4547, #4672, #4540; AlterLab lanes #37297, #37313, #37402, #37532.
