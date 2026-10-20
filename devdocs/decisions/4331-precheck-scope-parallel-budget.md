---
issue: 4331
status: fresh
anchor: bin/lean/precheck.mjs
created: 2026-10-20
---

# ADR: pre-PR checks are change-scoped, run concurrently under one heavy slot, are timed, and defer to CI on a 10-minute budget

## Context

On 1.29.1 every lane ran every `learned.test_commands` entry before the PR, one at a time, each behind its own heavy-semaphore slot. The measured `waits by phase: precheck` were 14.0 min (#4318, 1 lane) and 24.7 min (#4322 + #4323, 2 lanes). All commands passed whatever the lane changed, and nothing recorded where the time went.

## Decision

- **Scope by the test map (`testmap.mjs` `scopeChecks`).** A learned command the map covers (an entry's command, with its `cd <cwd> && ` prefix, has the same `checkKey`) runs only when one of its globs matches a changed file. A learned command with no entry still runs. This narrows #4315's "the map only adds" rule per command: a partial map still never skips a suite it does not know.
- **One heavy slot per round, workers = `verifyParallelism()`.** The whole round sits inside one `heavyStep("precheck")`; `runChecks` runs up to `FORGE_HOST_PARALLELISM` (else cores / live lanes, #4182) commands at once. Results stay in input order, so the event and the builder's fix prompt are deterministic.
- **One budget, not two.** `verify.precheck_total_seconds` (#4318) already capped a round; its default drops from 1800 to 600 s, and forge.yaml `lean.precheck.max_minutes` overrides it. The one-level forge.yaml parser flattens a nested `precheck:` block, so `lean.max_minutes` and flat `lean.precheck_max_minutes` are both read (precedent: `readAdmission`).
- **Deferred, not failed.** A command that never started before the deadline, or that the budget cut short (rc 124 with the remaining budget as its timeout), is `deferred-to-ci`. A command's own per-command timeout stays a failure, as before.
- **Timing.** `PRECHECK_COMMANDS` results carry `ms`, the event carries the round `ms` and `parallelism`, and the batch report prints the summed `precheck_ms`.

## Rejected

- Keep `mergeChecks` additive: the map could never narrow the list, which is the measured cost.
- A slot per command: N queue waits per round behind other lanes, the observed `waits by phase: precheck`.
- A second budget knob next to `verify.precheck_total_seconds`: two caps on one loop with no clear winner.

## Cost

0 LLM calls. A round's wall time goes from the sum of its commands to roughly the slowest command per worker, with one semaphore wait instead of N; scoped-out commands do not run at all.
