---
issue: 4267
status: fresh
anchor: bin/lean/orchestrate.mjs
created: 2026-10-20
---

# ADR: the batch recovers mechanical needs-human itself

## Context

A batch ended every `needs-human` as final and skipped its dependents, including codes an agent can fix (`ci.red`, base conflicts, an untyped in-scope choice, a contract invalidated by a mid-run issue edit). The operator then ran `/fix-ci` and relaunched by hand, one issue at a time.

## Decision

- `classifyNeedsHuman` (outcome-codes.mjs) splits rows into recoverable, human (`builder.blocked`: credentials, spend, promotion, customer, product-decision) and terminal. No enum code changes.
- `orchestrate()` requeues a recoverable row as one recovery lane per issue (`orchestration.recovery.max_attempts`, default 1), under the same admission as any lane; dependents stay queued. The count is persisted, so a resume never adds an attempt.
- The recovery lane is the existing rerun path with a per-code prompt note: the repo's own failed-check logs and declared checks, push new commits only, no extra Actions trigger.
- Every runner decision is a `FORGE:DECISION` comment (what, why, alternative), fire-and-forget. Only human codes reach the end-of-batch escalation list.
- `DECISION` joins the spec-marker registry so `commands/orchestrate.md` can name the marker.

## Alternatives

- Recover in the orchestrator spec only: depends on a live session and asks per issue.
- Unbounded retries: a red check that needs a human would loop and burn lanes.
