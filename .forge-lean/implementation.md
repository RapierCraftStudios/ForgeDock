### Approach
Built on #4595's blocker re-check. Dependency skips are marked `waiting` while a re-check can still re-admit them; `--add` of a skipped issue goes through the #4550 requeue path; a not-planned close is `final`; log rows carry `trigger`.

### Changes
- bin/lean/batch.mjs: addIssues re-queues an issue whose result is `skipped` (returns `requeued`); openBatch returns `self`.
- bin/lean/orchestrate.mjs: skip() sets `waiting` and logs `trigger`; watchBlockers honours `final` (settled blockers), logs `readmitted` rows with trigger; requeued dependents logged; waiting cleared at batch end; formatTable shows `waiting on #X`.
- bin/engine-cli.mjs: makeDispatchCheck reads stateReason (not planned => final); addToBatch reports requeued, clears a finished report; formatRowLine shows waiting.
- bin/lean/schedd.mjs: add op reopens a finished unhosted batch when it re-queued issues.
- commands/orchestrate.md: documents the above.
- tests: lean.test.mjs, batch.test.mjs.

### Acceptance Criteria Status
- R1 ✅ orchestrate.mjs watchBlockers (readmit + log), lean.test.mjs "#4687 a dependency skip waits"
- R2 ✅ batch.mjs addIssues, batch.test.mjs "#4687 --add re-queues"
- R3 ✅ engine-cli.mjs makeDispatchCheck `final`, orchestrate.mjs watchBlockers, lean.test.mjs not-planned test
- R4 ✅ orchestrate.mjs skip/readmitted/requeued update rows with `trigger` (log.jsonl via store.log)
- R5 ✅ orchestrate.mjs formatTable, engine-cli.mjs formatRowLine
- R6 ✅ waiting flag + per-pass re-check (#4595 loop)

### Verification
- V1 lean.test.mjs: 500 pass, 0 fail. V2 batch.test.mjs: 54 pass. V3 schedd.test.mjs: 21 pass. bin/tests/engine-cli.test.mjs run too. `forgedock check`: PASS.
- New tests (batch #4, lean #15, #16) fail with the source files reverted to HEAD.
- checks.mjs widened to the full suite (889 referrers), not run per host rules.

### Notes
- The dispatch check now requests `--json state,stateReason`; existing test stub updated.
- A resumed batch loses the display-only `waiting` flag for rows skipped before the resume.
- Dependents of an in-batch lane ending `invalid` still run (SATISFIED unchanged).

## Docs
Added a #4687 entry to devdocs/modules/lean.md (waiting state, trigger log, final not-planned, --add requeue) to satisfy the devdocs freshness check.
