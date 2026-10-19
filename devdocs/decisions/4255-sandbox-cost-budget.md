---
issue: 4255
status: fresh
anchor: bin/lean/execution.mjs
created: 2026-10-20
---

# ADR: per-lane sandbox cost and a hard execution budget

## Context

Remote lanes (#4253) had no cost visibility and no spending ceiling: once `execution.mode: remote` was on, a batch could start sandboxes without limit. The operator compares sandbox spend with token spend and needs a cap that holds per batch and per host day, also across a dispatcher resume and a schedd restart.

## Decision

- The provider reports usage through an optional `usage(handle, {startedAt, endedAt})`. Without one, usage is wall-clock minutes from the handle's persisted `startedAt` × `cost_per_minute`. The dispatcher attaches it to the lane result, because the lane inside the sandbox cannot see its own sandbox bill.
- The budget is flat keys under `execution:` (`budget_minutes`, `budget_usd`, `day_budget_minutes`, `day_budget_usd`, `on_budget`, `cost_per_minute`), because `parseForgeYaml` reads one level deep.
- The batch total lives in the batch `state.json` (survives `--resume`). The day total lives in a host file in the sched dir (survives a schedd restart), keyed per attempt (`batch#sandbox#startedAt`), so recording an attempt twice after a crash counts it once.
- Admission counts settled usage plus the running remote lanes' elapsed minutes, so a burst of concurrent starts cannot run far past the cap. Running lanes always finish.
- `on_budget` defaults to `stop`, because silently moving load to the host is a bigger surprise than a held issue. `local` is the opt-in fallback.
- The day store fails closed: a corrupt file refuses remote lanes while a day cap is set and is never overwritten, because a hard spend cap must not reset itself.

## Rejected

- An LLM or forecast-based cap: the cap must be deterministic arithmetic.
- A nested `budget:` block: it would need a new YAML parser.
- Counting local lanes against the budget: they add host load, not spend, and the host lane cap (#4191) already bounds them.
- Fail-open on an unreadable day store (the `limits.json` rule): a lost hold costs one extra lane, but a lost spend total resets the cap.
