forge-stamp: issue=6115 contract=481d6258d54b
### Approach
Reuse classifyBaseRed/runOnBase/toolGapFailures. Failing baseline suites and regression:true validate rows are split into tool-gap (env), also-red-on-base (recorded, non-blocking) and lane-own (blocking).
### Changes
- bin/lean/baselines.mjs: classifyFailingRuns, baselineEnvFailures.
- bin/lean/conformance.mjs: precheck takes baseRuns; regression rows with tool gap -> validate_env/env.tool_missing, red on base -> returned baseRed, not validate_failed.
- bin/lean/lean.mjs: after validate reruns, install missing python modules + rerun once, runOnBase for regression rows and baselines; decisions/events recorded.
- tests: baselines.test.mjs, conformance.test.mjs, lean.test.mjs (existing baseline test now fails only on the lane tree).
### Acceptance Criteria Status
- R1 ✅ baselines.mjs classifyFailingRuns; conformance.mjs baseRunRed branch
- R2 ✅ lean.mjs gate install+rerun; env.tool_missing rows
- R3 ✅ baselines.test.mjs, conformance.test.mjs
- R4 ✅ same tests
- R5 ✅ same tests
- R6 ✅ lean.mjs regression/baseline install
- R7 ✅ as R1
### Verification
V1, V2, V3, G1, G2 pass (forgedock check PASS). New tests fail without the fix (helpers/branch absent).
### Notes
No env vars. Behavior: suites also failing on base no longer block. No formatter configured for these files.
### Precheck failure (ci-local spec-markers)
Only failure: scripts/symbol-move.test.sh, `libcst required but not available` (sandbox python has no libcst, no pip). Unrelated to bin/lean changes; recorded as an env amendment, no code change.
