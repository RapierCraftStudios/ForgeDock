# 5564: release conductor (host-less recovery)

Context: a managed release whose host died mid-deploy had no driver; the lease went stale and nothing finished or rolled back (epic #5549, Phase 3, I17/I22/I24, R6).

Decisions:
- `forgedock release recover <id>` (`bin/lean/release-conductor.mjs`) takes a stale lease (`CONDUCTOR_TTL_S` 900) through `takeFence` (now exported from `release-rollback.mjs`, `ttlS` default 300 so `release rollback` is unchanged), replays unfinished intents via `deployStep` and continues from the last `done`. A fresh lease is a no-op.
- It acts only when the ledger says merged, for actors in `trust.actors`, fenced by the new epoch, and refuses while HELD (I24). A zombie driver with the old epoch is refused by the fence.
- `CAPABILITIES` is the matrix of design 2.6: rerun, redispatch, observe, LIVE_CHECK, smoke are GitHub-only; full rollback runs only with `rollback.full_workflow`; SLI soak and purge are host-only and listed under `waiting_host` in `release status`. plan, build, review, merge and patch are refused.
- Safe end state: roll back to the recorded target, else hold and file one `needs-agent` issue (marker `FORGE:CONDUCTOR <id>`).
- `templates/github-actions/forge-conductor.yml` is pinned to an exact forgedock version (`release init --conductor` fills version, `controls.conductor.watchdog_cron`, workflows); its no-op check on `_active` runs before any checkout. `forge-conductor.scopes.json` is the token scope list asserted by a static test (no production secrets, no merge).
- Bootstrap guard: with `controls.conductor.enabled`, a managed `release start` refuses while the workflow is absent from the default branch. Unmanaged releases are unchanged.
