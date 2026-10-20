---
issue: 4334
status: fresh
anchor: scripts/acceptance-red-green.sh
created: 2026-10-20
---

# ADR: the repro harness runs in the lane's environment, and a head it cannot run is an environment error

## Context

A bug lane in a pnpm + turbo monorepo ended `needs-human conformance.unimplemented` with `BASE=SKIPPED HEAD=UNRUNNABLE`, even though the fix was correct. `io.redGreen` ran `scripts/acceptance-red-green.sh` with the engine's bare `process.env`, so the toolchain pin's `pnpm` shim was not on PATH (exit 127). The base worktree only got the root `node_modules`, not the per-package trees a workspace installs (`apps/web/node_modules`). `reproFailures` also turned "could not run" into a code defect, which spent the builder resume (the builder stubbed React) and ended terminal.

## Decision

- **Lane env.** `reproOf` passes `{TMPDIR: runTmp, ...toolchain.env}`, the same env the validate reruns use (#4323), and `effects.redGreen` merges it over `process.env`.
- **Dependency trees on base.** The script symlinks every head `node_modules` that sits next to a tracked `package.json`, plus a root `.venv`, into the base worktree, but only where the base has none. This matches the depcache layout (`depcache.mjs` `treesOf`). Links are never copies: worktree removal unlinks them, and head's trees survive.
- **New code `env.repro_unrunnable`.** `HEAD=UNRUNNABLE`, or no harness result, gets this code. It is recoverable (`RECOVERABLE_CODES`, `RECOVER_HOW`) and goes to `gate()`'s environment state with `env.tool_missing`, so no builder resume and no reviewer run.
- **Scope.** `BASE=UNRUNNABLE` with `HEAD=RAN` stays `conformance.unimplemented`: the builder can pick a command that runs on base. A `BASE=SKIPPED` detail now says the base was not run because head did not pass. A new test file was already overlaid on base (#3630).

## Rejected

- Reusing `env.tool_missing`: that code names a missing host tool, and a harness failure has none.
- Running an install in the base worktree: it costs minutes per gate, and head's installed trees are already the lane's truth.
