# 5053: pool 401s name their hop; 401 on status/result is transient

Status: accepted

- The hop is a `hop` field in the JSON body (`router` or `agent`, plus `agent` name), because `httpTransport.call` exposes only status and parsed body.
- A 401 on `status`/`result` is marked `transient` in the transport, reusing the #4672 retry (`isTransportError`, `guard`), bounded by `unreachable_window_min`. A launch 401 stays `sandbox.auth`.
- The router logs responses with status >= 400 by wrapping `writeHead`, with method, path, sandbox id and repo slug. Query strings and tokens are never logged.
- No repo allow-list exists in the router, so "repo not allowed" is not a distinct 401 reason; reasons are `router auth` (router body) and the `agent` hop.
- Per-repo root cause: not provable from the repo. Hypotheses and the diagnosis query are in `modules/lean.md`; the hop tag and the log make the next occurrence attributable.
