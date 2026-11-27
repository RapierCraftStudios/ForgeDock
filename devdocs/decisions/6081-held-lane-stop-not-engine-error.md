---
status: fresh
anchor: bin/lean/orchestrate.mjs
created: 2026-11-26
---

# ADR: an operator-stopped held lane is a hold, never an engine-error

## Context

#6081: after `--hold`, a lane the operator stopped (SIGTERM or kill of its `run-issue` process) ended with the synthetic
`engine-error` "lane pid N exited without a result". That counted toward the circuit breaker (three such stops in 30 min tripped it for
every other lane), spent the issue's one engine-error relaunch, and pointed an operator at a failure that never happened. Separately,
the `run-issue` SIGTERM handler awaited the lane teardown without a bound, so a builder child ignoring SIGTERM left the process alive.
The admission gate (`isReady`) already refused held and paused issues on every path (requeue, relaunch, recovery, re-admit), and the
launch path re-reads holds; that behaviour is now pinned by fixtures (`orchestrate-relaunch-gates.test.mjs`).

## Decision

- `settleLane`: an `engine-error` with no lane result (`lostWithoutResult`, "exited without a result", "interrupted by SIG...") for an
  issue that is operator-held (re-read at settle) is requeued without touching the breaker, the engine-error relaunch count or the
  transient budget. Its row is `hold` ("stopped by operator hold"); the issue stays pending until `--release`.
- The launch-time hold/pause check yields one microtask before clearing the run entry, because `track()` registers the promise after the
  async body's synchronous prefix; without it a hold seen at launch leaked a permanent `running` entry and the runner never ended.
- `run-issue` SIGTERM/SIGINT teardown is bounded (`FORGEDOCK_TEARDOWN_MS`, default 30 s): the lane reports `deferred run.interrupted` and
  exits 128+signo even if the teardown never returns.
- #6042 (breaker pauses admission, runner resumes on clear) is already on staging (PR #6095); #6082 (stall self-heal with backoff, capacity
  waits are not stalls) is the amendment in `5806-stall-recover-env-probe.md`.

## Consequences

Holding a running lane and stopping it is free of breaker side effects. A genuine engine-error of a held issue (a result with a real
detail) still counts, but its relaunch waits for the release like any admission. No extra process, poll or API call.
