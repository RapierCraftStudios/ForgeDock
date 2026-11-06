# pool

ForgeDock's built-in remote compute pool (imported from computeshare; AGPL-3.0-or-later).

- `bin/pool/` router, agent, docker/http/store helpers and `cli.mjs` (`node bin/pool/cli.mjs router|agent|install-command ...`).
- `pool/image/` lane image recipe (Dockerfile, shims, entrypoint, `cs-cred` credential relay, `cs-relay` read-only capability relay: allowlisted commands executed on the dispatching host, #4778).
- `pool/install/` agent installers (Windows/WSL, native Linux, router).
  Native Linux agent (root, systemd): `pool/install/install-agent-linux.sh --router URL --token CODE [--name N --cpus N --mem GB --dry-run]`.
- Tests: `bin/tests/computeshare.test.mjs`.

The module boundary is the ForgeDock HTTP sandbox protocol: the router speaks it to the dispatcher and relays to agents over HTTP. Sandboxes receive only short-lived GitHub and Claude access tokens; refresh tokens stay on the router host.

Claude login choice (#5165): among the router host's logins with 30+ minutes left, the router hands out the one with the lowest 5-hour use in tokenbaton's `live.<n>` (account `n` = `~/.claude-<n>`), read from router.json `usage_source` (default `$TOKENBATON_HOME`, else `~/.tokenbaton`); validity only breaks ties. An account at or above `usage_ceiling_pct` (default 95) or at 100% weekly use is skipped; when every login is, `/agent/creds/claude` answers a typed 429 (`code: rate_limited`, `reset_at` = the earliest reset, `retry-after`), which the agent passes through and `cs-cred` prints as `usage limit hit; resets at <ISO>` so the lane defers. Without readable usage it falls back to the longest validity and logs a warning. The selected account index and usage are logged, never the token.

The `forgedock pool` CLI wiring is tracked separately (#4544).
