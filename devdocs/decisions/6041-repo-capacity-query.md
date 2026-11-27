# 6041 — dispatcher capacity sample is per repo

`httpTransport.capacity({repo})` in `bin/lean/sandbox-remote.mjs` now appends `?repo=<encoded slug>` to `GET /status` and `GET /agents`, and the provider's `capacity()` passes its repo. The router answers with only the agents the repo may use (`router.json` `repos.<slug>.agents` / `exclude_agents`, via `placeable()`), so the dispatcher never admits a batch against capacity the repo cannot be placed on. With no repo the URLs are unchanged; an older router ignores the query and returns the whole pool.
