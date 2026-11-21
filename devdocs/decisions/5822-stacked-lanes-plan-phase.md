---
status: fresh
anchor: bin/lean/orchestrate.mjs
created: 2026-11-21
---

# ADR: stacked lanes, phase 1: a dependent plans while its dependency is open (`orchestration.stacking: plan`)

## Context

`forgedock orchestrate` admits an issue only when every in-batch dependency ended `merged` or `invalid` (`isReady`), and the
lane refuses an open `Depends on` with `dependency-open` before its lease. A dependency link costs about 50 min p50 (28 before
the PR, 17 after), so a depth-3 chain runs 150+ min serially, although a dependent's investigation and contract seldom need
the dependency's code. Epic #5822 splits stacked lanes into four phases (#5831 plan, #5832 stacked build, #5833 retarget and
cascade, #5834 metrics). This records phase 1.

## Decision

1. **Config.** `orchestration.stacking: off | plan | full`, default `off` (admission unchanged). `full` runs as `plan` until
   #5832 lands. Unknown values are `off`; the config schema types the key.
2. **Admission (orchestrate.mjs).** After every ready issue had its chance, a slot no ready issue wants goes to a pending
   dependent whose unmet edges are all in-batch dependencies still pending or running (not held, blocked, base-held, delayed or
   recovering). It runs once per issue per batch as a *plan lane*: `ctx.plan`, run record `plan: true`, row `plan-admitted`
   and a FORGE:DECISION. The plan lane does not count as a maintenance dispatch.
3. **The plan lane (lean.mjs `plan: true`, `run-issue --plan`).** It skips the `dependency-open` refusal (a `STACK_PLAN_START`
   event names the open dependencies), never takes the light or fast-forward build, does not label `workflow:building`, and
   returns right after the contract is frozen and posted: terminal reason `planned`, outcome code `stack.planned`, with
   `contractHash` and `baseSha` (the lane base commit it planned on). Teardown skips the checkpoint for `planned`, so a plan
   lane never commits or pushes; the worktree is removed. A recovery is never a plan lane; an adopted PR or a
   `refactor:split` lane ends `planned` without a contract.
4. **Settle.** `planned` puts the issue back in pending (`planned` row; `planned` map `{hash, baseSha, at}` and `planTried`
   persisted for `--resume`). Any other end returns it to pending as `plan-failed` without touching the breaker, the
   engine-error relaunch, the requeue or deferral budgets, except a real verdict (`invalid`, `decomposed`) and a usage-limit
   or auth deferral (`rate_limited`, `quota.exhausted`, `backend.auth`), which settle as usual so account holds apply.
5. **Build lane after a plan (`ctx.planned`, `run-issue --planned <hash>[:<sha>]`).** It starts only once the dependency
   merged, as today. It reads the frozen contract back like a recovery does and reuses it (`CONTRACT_REUSED` `planned: true`,
   no second plan session) unless `reuseStale` finds it stale: the issue scope or lane changed, or `git diff --name-only
   <baseSha> origin/<lane> -- <deliverables>` lists a path (the dependency changed something the plan delivers), or the plan's
   base commit cannot be compared. Then it re-plans on the current base.
6. **Unchanged on purpose.** A dependency that ends unsatisfied still holds or skips the dependent (`HOLD_ROOT` / `skip`);
   dependents still never build or merge before their dependency (phase 1 never writes a branch). DAG edge parsing is #5824.

## Consequences

- A chain link's investigation and contract overlap the dependency's run; the dependent's build lane starts at implement.
- A plan lane spends model time that is lost when the build re-plans (dependency touched a deliverable) or the dependency
  fails. #5834 measures it before the default changes.
- Plan lanes use only idle slots, so a batch with more ready issues than slots behaves exactly as with `off`.
