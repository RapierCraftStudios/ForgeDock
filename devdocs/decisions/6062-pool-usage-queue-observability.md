# 6062: pool status shows per-worker usage and queue wait

- `bin/pool/agent.mjs` `usageSummary` rolls live lane samples into `usage_summary` (admitted vs used, utilization) on the agent status; read-only, no admission change.
- `bin/lean/orchestrate.mjs` `phasesOf` now also records the worker on `phases.queue_wait` (additive; queue_wait stays out of laneSum and run minutes).
- `bin/pool/cli.mjs` aggregates queue_wait p50/p95 per worker from batch report rows that name the worker; `pool status` (text and `--json`) shows USED and QUEUE columns, `-` when absent.
