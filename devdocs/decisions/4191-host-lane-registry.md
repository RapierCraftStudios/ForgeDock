---
issue: 4191
status: fresh
anchor: bin/lean/sched.mjs
created: 2026-10-20
---

# ADR: a locked host file registry gates every orchestrate lane start

## Context

K was per batch (`orchestrate.mjs` `K()`), so 14 batches summed to ~25 lanes on a 4-core host, and admission was FIFO inside each batch: an AlterLab P0 waited over an hour behind P2s in other batches (#4166 baseline).

## Decision

- `bin/lean/sched.mjs`: one JSON registry per host (`~/.forge/sched/`), every mutation under an exclusive lock file holding the owner pid. Slots are `<batch>#<issue>` records; queued offers carry `(priority, seq)`.
- A dispatcher offers the ready issues its free per-batch K allows, and starts one only when `tryAcquire` grants it: slots < cap and its queue rank < free slots. A P0 offered last is first in the queue; FIFO within a priority. Per-batch K stays an upper bound.
- Running lanes are never revoked (non-negotiable 5); only queued work is reordered.
- Liveness: a queued offer dies with its dispatcher pid. A slot dies with its dispatcher **unless its detached lane pid still runs**: that lane still loads the host, so it keeps counting until it exits or `--resume` adopts it.
- Cap: `forgedock sched cap N` (live, host-wide) > the dispatcher's `orchestration.global_parallel` > none (unchanged behaviour).
- Fail-open: an unreadable registry or a lock not taken in 2 s admits without the cap and logs one `sched` row. A stuck registry would otherwise stall every batch on the host (same reasoning as `limits.mjs`).

## Rejected

- The #4166 daemon now: a long-lived process to supervise; the file registry gives the cap and priority today and the daemon can own the same file later.
- Dividing a host K among batches statically: idles slots when one batch drains and still cannot let a P0 jump.
- Preempting running P2 lanes for a P0: destroys running work.

## Follow-up

`limits.mjs` does the same unlocked read-modify-write on `~/.forge/limits.json`; concurrent batches can lose a hold update. The lock here could be reused for it.
