---
issue: 4658
status: fresh
anchor: bin/lean/train.mjs
created: 2026-10-27
---

# Decision: native milestone train with one durable state file

## Context

Unattended multi-milestone runs were external scripts around `orchestrate`. They rewrote `forge.yaml` `branches.staging` to steer lanes, set different lane caps, hard-coded milestone order per script and recorded no current policy.

## Choice

- **State:** `<batchRoot>/trains/<id>/state.json`, written tmp + fsync + rename (`batch.mjs` `writeAtomic`). It holds `order`, `active`, per-milestone `status` and `lifecycle` (#4657), and the typed `stop`.
- **Base:** each milestone runs as one orchestrate batch. Lanes already resolve their base from the issue's milestone (`lane.mjs`), so the train never touches `branches.staging` and never writes `forge.yaml`.
- **Lifecycle:** after each batch the #4657 `onBatchEnd` seam records `shipped:staging` and closes at `milestones.close_on`. Open issues left stop the train (`milestone-open`).
- **Order:** defined once, in the state. `--insert <id> <slug> [--before|--after]` is the only way to add one; it re-runs `classifyEdges` and refuses a cycle or a dependency on a later milestone.
- **Caps:** one source, `orchestration.global_parallel` (default 3), split across active milestones. A conflicting `--parallel` warns and is ignored.
- **STOP reasons:** `dependency-unmet`, `needs-human`, `breaker`, `budget`, `cancelled`, `milestone-open`, `error`. `--resume <id>` clears the STOP and re-runs stopped milestones through their batch.

## Rejected

- **An LLM planner for order.** Order is a fact (state plus `Depends on` edges).
- **A lane-resolution change.** `lane.mjs` already does the right thing.

## Cost

0 LLM calls. Per tick: one live milestone/issue read; one lifecycle read and at most one PATCH per finished milestone.
