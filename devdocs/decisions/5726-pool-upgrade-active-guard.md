---
status: fresh
anchor: bin/pool/router.mjs
created: 2026-11-26
---

# ADR: `pool upgrade` refuses while sandboxes are active (#5726)

## Context

The pool host is shared with other projects. `/agents/:name/upgrade` restarts the agent under its live sandboxes, and the `preflight.pool_version` hint pointed at the bare `forgedock pool upgrade`.

## Choice

- The router guards the route: unless the body has `force: true`, it reads the agent's `/capacity` and answers 409 `{error, active}` when `active > 0`. Guarding server-side covers every caller, not only the CLI.
- The CLI reads `active` from `GET /agents` and refuses (non-zero, names the count, no POST) unless `--now` (POSTs `{force:true}`) or `--wait` (polls until idle, `--timeout` seconds, default 1800, then upgrades or fails without POST). An agent with no `active` upgrades as before.
- `preflight.pool_version` recommends `npx forgedock pool upgrade --wait` and says the host is shared. Its pass/fail decision is unchanged.
- `/admin/update` on the agent is unchanged.
