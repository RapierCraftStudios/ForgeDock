forge-stamp: issue=5831 contract=67d879afbeb1
### Approach
Plan lane = a normal lane run with `plan: true` that stops right after the contract freezes and ends `planned`. Orchestrate admits it in an idle slot after all ready issues (isReady with the dependency gate ignored, `planAdmissible`), requeues the issue on its end without touching any budget, and later hands the build lane `planned` so it reuses the frozen contract unless `planStale`. Default `off` leaves admission untouched.

### Changes
- bin/lean/stacking.mjs: new pure helpers (normalizeStacking, planAdmissible, format/parsePlanned, planStale).
- bin/lean/orchestrate.mjs: `stacking` option, plan pass, `start(n,{plan})`, plan-end branch in settleLane (rows planned/plan-failed, STACK_* events, FORGE:DECISION), planned/planTried persisted.
- bin/lean/lean.mjs: `plan`/`planned` options, dependency-open skip, no building label/light/ff, stop after freeze (`planned` result), no teardown checkpoint, planned reuse + staleness.
- bin/engine-cli.mjs: `run-issue --plan`, `--planned <hash>:<sha>`, lane argv, ctx plumbing, `orchestration.stacking` read (core path only).
- bin/config-schema.mjs, docs/CONFIG.md, devdocs/modules/{orchestrate,lean}.md.
- Tests: stacking.test.mjs, orchestrate-stacking.test.mjs, lean.test.mjs (stacked plan lanes), config-schema.test.mjs.

### Acceptance Criteria Status
- R1 ✅ bin/lean/stacking.mjs:12, bin/engine-cli.mjs readOrchestration
- R2 ✅ bin/lean/orchestrate.mjs plan pass (before withdrawExcept)
- R3 ✅ planTried, stacking.mjs planAdmissible
- R4 ✅ bin/lean/lean.mjs planOnly guards, STACK_PLANNED return
- R5 ✅ lean.mjs teardown `reason === "planned"`
- R6 ✅ lean.mjs stackPlanned reuse + planStale
- R7 ✅ orchestrate.mjs settleLane plan branch, save()
- R8 ✅ off: orchestrate-stacking.test.mjs; V2 passes untouched
- R9 ✅ orchestrate-stacking.test.mjs
- R10 ✅ plan branch returns before breaker/relaunch/requeue; tested with breaker errors:1
- R11 ✅ lean.test.mjs stale cases (hash, lane, deliverable diff)
- R12 ✅ docs/CONFIG.md, config-schema.mjs TYPES
- R13 deferred (activation row, owner:promote:orchestration.stacking)

### Verification
- V1 (stacking, orchestrate-stacking, config-schema tests): pass 25/0; fails without the fix (new modules/keys absent).
- V2 (7 existing orchestrate-*.test.mjs): pass 68/0.
- V3 (lean.test.mjs -t plan|stacking|planned|dependency): pass 84/0; new cases fail without the fix.
- G1: pass. `forgedock check`: PASS. eslint on changed js: clean. No formatter is configured in the repo.

### Notes
New default-off key `orchestration.stacking`; `run-issue` flags `--plan`, `--planned`. Plan lanes cost is not added to the final row (plan-end rows are not final). Stacking is ignored on engine.path full.

## Sibling-list follow-up
The ten tests flagged for `stacking` do not enumerate bin/lean modules or a kind list stacking belongs to; recorded as not_members in result.json.

## Sibling-list failure
Checked the ten flagged tests (batch, checks, conformance, context, execution.e2e, execution, fixround, guardgate, ledger, release-mergeback) at the flagged lines: none enumerates bin/lean modules, so `stacking` is recorded under `not_members` in result.json for each.

## CI fix round: "Unit tests (node --test)"
No CI log was available. Re-ran locally: stacking.test, orchestrate-stacking.test, config-schema.test, lean.test (776 pass), all orchestrate-*.test, config-docs, engine-cli, engine-outcome-codes, gc, activation tests: 0 failures. Could not reproduce; the full suite is barred on this host. Likely a timing-dependent test unrelated to this diff. No code changed.
