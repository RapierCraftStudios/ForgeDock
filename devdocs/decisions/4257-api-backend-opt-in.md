---
issue: 4257
status: fresh
anchor: bin/runner.mjs
created: 2026-10-20
---

# ADR: the api agent backend is an explicit, owner-approved option, never the default

## Context

Running an agent on the API backend instead of the CLI backend (subscription accounts) saves about 265 MB per agent, but it bills an API key. `--backend auto` (the default) used to fall back to `api` whenever the `claude` CLI was missing and `ANTHROPIC_API_KEY` was set (`resolveBackend`'s `cliFallback: () => "api"`, `checkExecutionBackend`, two fallbacks in `runCommand`). A sandbox image without an authenticated CLI (#4170) would therefore bill an API key silently.

## Decision

- The API backend is **never the default**. `auto` uses the CLI. Without a usable CLI it resolves to `api` only when the owner opted in. Otherwise `runCommand` throws the typed `CLI_BACKEND_UNAVAILABLE`, and the message names the fixes. The engine fails fast on that error with `engine.error`.
- Opt-in has two parts (`isApiBackendApproved` in `bin/runner.mjs`): forge.yaml `execution.agent_backend: api` (the repo owner) AND env `FORGEDOCK_ALLOW_API_BACKEND=1` (the host owner).
- An explicit `--backend api` / `FORGEDOCK_BACKEND=api` keeps working: that flag is the explicit choice.
- The engine records the runner's `backend` on `PHASE_ATTEMPT_USAGE`, `PHASE_COMMIT` and the `phase_attempt` telemetry event, so API use is visible.
- The lean engine and its lanes stay CLI-only (`bin/lean/effects.mjs` `makeLeanRunner`).

## Rejected

- forge.yaml alone: a committed config edit, which an agent PR can make, would start billing.
- Env alone: the repo would have no record that it runs on a paid backend.
- Keeping the fallback with a warning: a warning in a headless lane is still a silent bill.

## Not changed

`init` enrichment (`bin/init-enrich.mjs` `resolveEnrichBackend`) still uses the API when a key is set and no CLI exists. It is a one-shot, user-run setup call, not an agent, and is outside this decision.
