# pool

ForgeDock's built-in remote compute pool (imported from computeshare; AGPL-3.0-or-later).

- `bin/pool/` router, agent, docker/http/store helpers and `cli.mjs` (`node bin/pool/cli.mjs router|agent|install-command ...`).
- `pool/image/` lane image recipe (Dockerfile, shims, entrypoint, `cs-cred` credential relay, `cs-relay` read-only capability relay: allowlisted commands executed on the dispatching host, #4778).
- `pool/install/` agent installers (Windows/WSL, native Linux, router).
  Native Linux agent (root, systemd): `pool/install/install-agent-linux.sh --router URL --token CODE [--name N --cpus N --mem GB --dry-run]`.
- Tests: `bin/tests/computeshare.test.mjs`.

The module boundary is the ForgeDock HTTP sandbox protocol: the router speaks it to the dispatcher and relays to agents over HTTP. Sandboxes receive only short-lived GitHub and Claude access tokens; refresh tokens stay on the router host.

Claude login choice (#5165): among the router host's logins with 30+ minutes left, the router hands out the one with the lowest 5-hour use in tokenbaton's `live.<n>` (account `n` = `~/.claude-<n>`), read from router.json `usage_source` (default `$TOKENBATON_HOME`, else `~/.tokenbaton`); validity only breaks ties. An account at or above `usage_ceiling_pct` (default 95) or at 100% weekly use is skipped; when every login is, `/agent/creds/claude` answers a typed 429 (`code: rate_limited`, `reset_at` = the earliest reset, `retry-after`), which the agent passes through and `cs-cred` prints as `usage limit hit; resets at <ISO>` so the lane defers. Without readable usage it falls back to the longest validity and logs a warning. The selected account index and usage are logged, never the token. A sample whose 5-hour reset has passed is stale (#5205): unknown usage, never 0%, ranked after fresh samples. A lane that hits a usage limit runs `cs-cred claude --limited <reset>`, which drops the sandbox's cached token and posts to `/sandboxes/<id>/creds/claude/limited`; the agent drops its own cache and forwards to the router's `POST /agent/creds/claude/limited`, which excludes the account it last handed that agent until the reset (default one hour), then the lane fetches the next login and relaunches at once. With every login excluded or blocked, the 429 carries the earliest reset, limited accounts included.

Disk reporting (#5535, all fields optional; absent from an old agent means unknown): the agent's `GET /capacity` carries `disk_free_gb` (free space under its state dir) and `sandbox_disk_mb` (`{sandbox id: MB}`, refreshed at most every 60s). The router's `GET /agents` passes `disk_free_gb` through in `agents[]` and adds `disk_used_mb` to each `sandboxes[id]`. `forgedock gc` prints the disk used per pool entry (`unknown` when absent) and `forgedock doctor` shows each agent's free disk, warning below `hygiene.min_free_gb`.

The `forgedock pool` CLI wiring is tracked separately (#4544).
