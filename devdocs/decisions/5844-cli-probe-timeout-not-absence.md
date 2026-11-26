---
status: fresh
anchor: bin/runner.mjs
created: 2026-11-26
---

# ADR: a timed-out claude probe is not an absent CLI

## Context

On a loaded host the `claude --version` probe could time out. The miss was cached as "unavailable", the lane spawned the bare name, got ENOENT and ended needs-human `cli.spawn_failed` although the CLI was installed.

## Decision

- `isClaudeCliAvailable` retries a timed-out probe once at 3x the bound and never caches a timeout. `cliProbeTimedOut(cwd)` exposes that the miss was a timeout. Non-timeout failures stay cached as false.
- A spawn ENOENT is `spawnDeterministic` only when the binary is on no PATH x PATHEXT entry. Otherwise it is relaunchable.
- `makeLeanRunner` defers `host.busy` (existing `deferCode` route in `lean.mjs`) instead of spawning a bare name when absence is not proven. No new outcome code.

## Consequences

`cli.spawn_failed` is emitted only for a CLI that is really absent from PATH. Other deterministic errnos (E2BIG, EACCES, ENOEXEC, ENAMETOOLONG) are unchanged.
