forge-stamp: issue=5692 contract=8bad761c5bcf
### Approach
`watchCi` yields step/test failure events per head sha (router long-poll when it has events for the sha, else jobs-API polling every 15 s). The merge CI wait loop races it against its poll sleep; the first actionable event starts `mergeFixRound` with the event context. Merge gate is unchanged (`checkStates`).
### Changes
- bin/lean/ci-watch.mjs: new `watchCi`, `ciSignal`, `failedStepsOf`, `cancelDecision`, `eventLog`.
- bin/lean/effects.mjs: `runsForSha`, `jobsOf`, `cancelRun`, `ciEventsWait` seams.
- bin/lean/lean.mjs: event hook in the wait loop, `mergeFixRound(checks, ctx)`, CI_AWARE / CI_FAIL_FAST log events, `o.ci` option.
- bin/stats/ci-awareness.mjs, bin/stats/index.mjs: `stats --ci-awareness`.
- Tests: ci-watch.test.mjs, lean.test.mjs, stats.test.mjs. devdocs/modules/lean.md entry.
### Acceptance Criteria Status
- R1 ✅ bin/lean/lean.mjs (onCiEvent) + lean.test.mjs "a step_failed while the check is still pending..." (fake clock in ci-watch.test.mjs; lean test uses an immediate event, no wait). The 30 s bound is by construction (event races the poll sleep), not asserted as a number.
- R2 ✅ ci-watch.mjs watchCi fallback; ci-watch.test.mjs
- R3 ✅ lean.mjs merge gate untouched; lean.test.mjs gating tests
- R4 ✅ ci-watch.mjs cancelDecision; lean.test.mjs cancel test
- R5 ✅ bin/stats/ci-awareness.mjs, index.mjs
- R6 deferred (bucket host): baseline numbers need host run logs.
- R7 ✅ ci-watch.mjs; R8 ✅ lean.mjs; R9 ✅ lean.mjs (cancel when o.ci passed; see Notes); R10 ✅ effects.mjs jobsOf; R11 ✅ ci-awareness.mjs; R12 ✅ tests + devdocs
### Verification
- node --test: ci-watch, lean, effects-cap, ci-classify, ci-emit, postmerge, release-mergeback, stats, pool/ci-events: 830 pass, 0 fail.
- `stats --ci-awareness --help` prints usage. `forgedock check`: PASS.
- New tests fail without the fix: not run against base (unknown); they depend on new exports/seams.
### Notes
- `forge.yaml ci.fail_fast` is not plumbed into `o.ci` (engine-cli.mjs is not a deliverable); cancel is off unless a caller passes `o.ci`.
- Events with class infra/flaky-suspect are ignored (left to the check poll and rerun). Event-triggered rounds skip rerun-once.
- Env: FORGEDOCK_CI_EVENTS_URL (fallback FORGE_CI_EVENTS_URL), FORGEDOCK_CI_TOKEN.
- No formatter is configured in package.json; none run.

## Sibling-list check
Reviewed the 10 flagged tests; none enumerates bin/lean modules, so ci-watch is recorded under not_members in result.json. No test edits needed.
