forge-stamp: issue=5978 contract=a7611d9659c0
### Approach
Reconcile is a runner-side tick (reconcile.mjs pure policy) that feeds the existing getAdded/getRequeued paths (K1), so DAG/priority/lane rules are unchanged. The selector is the gh search query (issue-watch `search` semantics, K2, passed to gh unchanged). The schedd-hosted runner runs the tick: no watcher process.
### Changes
- bin/lean/reconcile.mjs: new: selectArgs/parseSelected, diffSelection, readmitDue (deferred backoff cap 2h, held/engine-error on version change or 6h, conformance one retry after base moves, parked digest), humanCode, environmentalDetail, closesManually.
- bin/lean/orchestrate.mjs: `reconcile`/`select` seams; reconcileTick (join, leave, env.* join, re-admission via requeue path, digest decision), standing-order idle loop, breaker auto-reset with FORGE:DECISION, closeOnLane on merge; `select`/`readmit` persisted in state.
- bin/lean/batch.mjs: coverage classifier. bin/lean/clear-breaker.mjs: decideAutoReset. bin/lean/schedd.mjs: doc note (tick hosted in runner, no liveness change).
- bin/engine-cli.mjs: `--select`, `--status <id>`, makeReconcile seam, ORCH_USAGE. bin/help-text.mjs, commands/orchestrate.md: docs.
- Tests: orchestrate-reconcile.test.mjs (new), batch.test.mjs.
### Acceptance Criteria Status
- R1 ✅ engine-cli.mjs (select flag, plan.argv + state.select)
- R2 ✅ orchestrate.mjs reconcileTick
- R3 ✅ runner-hosted tick, no watcher
- R4 ✅ reconcile.mjs humanCode / readmitDue skips human codes
- R5 ✅ reconcile.mjs readmitDue deferred
- R6 ✅ reconcile.mjs readmitDue held/engine-error
- R7 ✅ orchestrate.mjs reconcileTick envSigs join
- R8 ✅ reconcile.mjs conformance + digest
- R9 ✅ clear-breaker.mjs decideAutoReset, orchestrate.mjs breaker block
- R10 deferred (#5966), R17 deferred (post-deploy)
- R11 ✅ orchestrate.mjs closeOnLane, engine-cli.mjs makeReconcile.closeIssue (rollup comment when FORGE_POSTDEPLOY_ROLLUP set)
- R12/R16 ✅ batch.mjs coverage, engine-cli.mjs statusBatch
- R13/R14/R15 ✅ orchestrate-reconcile.test.mjs
### Verification
V1 pass (147), V2 pass (102), V3 pass (88), G1 pass (81); forgedock check PASS. New tests fail without the fix (reconcile.mjs/seams absent).
### Notes
Breaker auto-reset only for selector batches (P1). Rollup folding needs env FORGE_POSTDEPLOY_ROLLUP. Held-state reconcile test uses a preseeded store.

### Docs
Dossier devdocs/modules/lean.md updated (entry 2026-11-25, #5978) for the docs freshness check.


## Enumeration follow-up
The flagged tests do not enumerate bin/lean modules or batch.mjs exports at the cited lines; recorded as not_members in result.json.
