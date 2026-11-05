# 5131: `remote` and `pool` share one token resolver; daemon secrets win over the client's pin

**Context**: two failures with the same symptom, a remote lane deferred three times on `sandbox.auth` (HTTP 401 from the router):

1. `execution.provider: remote` resolved `token_env` from the env and the keychain only. With an empty keychain and the token only in the local router's `forgedock.token`, it sent no bearer. `pool` already fell back to that file (#4546/#4685).
2. A daemon-hosted batch sent an empty bearer even though the daemon's own `process.env` held `COMPUTESHARE_TOKEN`.

**Root cause of item 2**: the client pins the configured `execution.token_env` as a passthrough (`engine-cli.mjs` `readPinnedEnvConfig`). `batchEnv` kept an empty value, and `mergeEnv(process.env, kept)` let `kept` win for every key, so on a fresh daemon-hosted batch the in-memory pin overrode the daemon's token. Resume was unaffected because `writePlan` scrubs secret-named keys from `plan.json`, so the daemon's value was the only one left. `preflight.pool_auth` passed regardless: it fell back unconditionally to the router token file, a different credential path than lane dispatch. Host evidence: in the router journal at 08:00:50 IST, preflight was accepted through the token file and the provider probe was rejected; plan.json had `envSecrets: [COMPUTESHARE_TOKEN]`.

**Decision**:
- `execution.mjs` `poolCredential(exec, { env, router, keychain })` is the one resolver for `pool`, `remote`, `remoteTransportFor` (and so `gc`) and `preflight.pool_auth`. Order: `token_env` (env, then keychain), then `execution.token_file`, then the router token. The router token applies to `remote` only when its endpoint is unset or equals the local router's.
- `schedd.mjs`: `batchEnv` never pins an empty value. In `mergeEnv`, a secret-named key keeps the daemon's non-empty value, and the client's non-empty pin only fills a secret the daemon lacks.
- `lanecheck.mjs`: `checkPoolAuth` and the agents read use `io.poolToken`, which `hostLaneIo({ env })` wires to `poolCredential` on the dispatch env. A null or rejected (401/403) token FAILs `preflight.pool_auth`, and the #4866 hold pauses remote admission before any lane starts.

**Rejected**:
- Ending the batch on a `pool_auth` failure instead of holding admission. The hold already stops every remote lane before launch and clears without a restart once the token is fixed. Ending the batch would discard pending lanes.
- Sending the router token to any `remote` endpoint. That would leak the local pool credential to a third-party runner or a GitHub Actions endpoint. `execution.token_file` is the explicit option for other endpoints.
- Injecting a transport in the regression test. It would bypass `remoteTransportFor`'s resolution. The test injects `fetch` instead (`deps.sandboxFetch` -> `fetchFn`).

Regression tests: `bin/tests/remote-token-daemon.test.mjs`, plus the tests named `5131` in `bin/lean/execution.test.mjs`, `lanecheck.test.mjs` and `schedd.test.mjs`.
