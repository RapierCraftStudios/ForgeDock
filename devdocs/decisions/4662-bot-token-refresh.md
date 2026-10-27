# 4662: bot token refresh, doctor lifetime check, gh.auth

- The refresh runs from a systemd user timer template (`scripts/systemd/`), not an in-process scheduler: no schedd refresh path exists, and `scripts/refresh-bot-token.sh` is the existing refresh.
- The script writes `~/.forge/bot-token.json` (expiry assumed `refreshedAt` + 1h) because its stdout is token-only; `forgedock doctor` reads it through `bin/bot-token-status.mjs`.
- A 401 inside a core run refreshes once and retries once, then defers with `gh.auth`. The batch already requeues any deferred code that carries `retryInSeconds`, so `batch.mjs` is unchanged.
- `scripts/wait-ci-green.sh` splits 401 (bounded retry, then an auth error) from 403 (still fail-fast, forge#4037).
