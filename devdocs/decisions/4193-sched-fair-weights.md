---
issue: 4193
status: fresh
anchor: bin/lean/sched.mjs
created: 2026-10-20
---

# ADR: weighted fair share across repos within a priority, weights in the host registry

## Context

The host registry (#4191) granted slots by (priority, FIFO seq). When one priority was saturated, the repo that offered first or offered most (one repo's 14 batches against another's one, #4166 baseline) took every freed slot.

## Decision

- `sched.mjs` `grantOrder(s)` orders the queue for `tryAcquire` and `list()`. Priority ascending always dominates. Within a priority, it repeatedly picks the repo with the smallest (live slots, all priorities, + entries already ordered) / weight. Ties go to the higher weight, then the lowest seq. Inside a repo the order is FIFO. An entry with no repo groups by batch.
- Weights are host policy, stored beside `cap` in `registry.json` as `weights: {"owner/repo": N}`; a missing repo weighs 1. They are set with `forgedock sched weight <owner/repo> N|--clear`.
- Load counts running slots, so a 2:1 weighting holds the running lanes at ~2:1 while both repos stay saturated. Running lanes are never revoked: a weight change converges as lanes end.

## Rejected

- `forge.yaml` `scheduler.weights: {owner/repo: N}`. `parseForgeYaml` reads neither `owner/repo` keys nor maps nested two levels deep, and a repo's own forge.yaml should not set its share of a host shared with other repos.
- Stride scheduling with persisted virtual time: it needs extra state per repo that must be reset as repos come and go. The running-slot count is already in the registry and self-corrects.
