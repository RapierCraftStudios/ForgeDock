# 5735: per-host lane ceiling in the pool router

## Context

Lane limits lived only in each batch's `execution` file (`--set-max-remote`, `--set-parallel`), which any session can
rewrite. One session raising a batch's `max_remote` piled lanes on one shared pool host (#5733). The router
(`bin/pool/router.mjs`) is the only component that sees every batch's sandboxes, but it placed by free CPU and memory
only.

## Choice

- The router enforces a per-agent ceiling on lane sandboxes across all batches. A lane sandbox is one whose id starts
  with `fdrsbx-` (the dispatcher names lanes `fdrsbx-<batch>-<issue>`); other tenants' sandboxes are never counted or
  refused.
- Ceiling source: the agent's router state entry `max_lanes`, set at runtime by `POST /agents/:name/limit`
  (`forgedock pool limit <agent> --lanes N|none`), else router.json `agents.<name>.max_lanes` (read only at startup).
  No valid value means no ceiling, so existing pools are unchanged. Re-enrollment keeps a set ceiling.
- Count = placed `fdrsbx-` sandboxes on the agent plus in-flight reservations. A launch or warm claim reserves its slot
  synchronously before the awaited agent call and releases it in `finally`, so concurrent launches cannot overshoot.
- When every fitting agent is at its ceiling, `POST /sandboxes` answers 503 `pool.host_lane_ceiling` with Retry-After.
  The dispatcher already treats a launch 503 as a retryable capacity error (deferred `SANDBOX_CAPACITY`), so lanes
  beyond the ceiling wait instead of failing. A warm claim skips a capped agent (404), and the cold launch that follows
  gets the 503.
- `GET /agents` adds `lanes {used, ceiling}` per agent and `remote_lanes` (lane sandboxes across all batches).
  `pool status` prints them; `--set-max-remote` prints the total and warns when N exceeds the summed ceiling (best
  effort, 5 s bound, never fails the set).

## Rejected

- Per-batch caps only: any session can raise them, which is how the incident happened.
- Resizing the agent (`pool resize`): caps the whole host's reservation, not ForgeDock lanes, and other tenants' work
  would pay for it.
- Agent-side counting: each agent sees only its own containers, does not know which belong to lanes, and could not
  stop concurrent placements the router has already decided.
