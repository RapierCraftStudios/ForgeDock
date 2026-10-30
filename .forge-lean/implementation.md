### Approach
resolveLane marks gh/git command failures `transient:true`. The orchestrator treats a transient refused lane as a wait: it re-resolves, and on repeated failure returns a `deferred` lane.unresolved with exponential backoff through the existing uncapped deferral path (no `max_deferrals` count). `--requeue` / `--add` accept `lane-refused`.

### Changes
- bin/lean/lane.mjs: `transient()` helper; milestone read, default-branch read and ls-remote failures use it.
- bin/lean/orchestrate.mjs: `lane.unresolved` added to UNCAPPED_DEFERRALS; catch sites set transient; `retryLane` + `laneRetries` in start().
- bin/lean/batch.mjs: REQUEUABLE includes lane-refused; addIssues requeues lane-refused rows.
- bin/lean/lane.test.mjs, bin/lean/batch.test.mjs: regression tests.

### Acceptance Criteria Status
- R1 ✅ bin/lean/orchestrate.mjs:124,700-709
- R2 ✅ bin/lean/lane.mjs:50-84 (only command failures transient)
- R3 ✅ bin/lean/batch.mjs:79
- R4 ✅ bin/lean/batch.mjs:138

### Verification
- V1 node --test lane.test.mjs batch.test.mjs: pass (69). The 3 new tests fail with the source files reverted.
- V2 node --test lean.test.mjs prefilter.test.mjs engine-outcome-codes.test.mjs: pass in the `forgedock check` run. The #4690 idle test in lean.test.mjs failed in two earlier runs under host load; it passes in isolation with and without my change.
- scripts/check-devdocs-freshness.sh: OK.
- `forgedock check`: V1, V2 and the spec/drift checks PASS; it still reported FAIL because scripts/classify-finding.test.sh and scripts/verify-phase-trail.test.sh hit the 300s timeout under host load (files untouched by this change). An earlier run failed 1 (the #4690 test).

### Notes
No new env vars. Transient lane retries are uncapped, backoff 120s doubling to 30min. Genuine refusals (branch missing, default branch, mismatch) stay terminal.

### Docs (#4791)
Added a #4791 entry to devdocs/modules/lean.md (transient lane retry, lane-refused requeueable) for the docs freshness check.
