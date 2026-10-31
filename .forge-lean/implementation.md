### Approach
Lane preflight (lanecheck.mjs) with typed codes, wired into daemon start, batch admission passes (pause, not breaker) and `forgedock doctor --lanes`. Sandbox clone failures defer with `sandbox.clone`. This pass fixed the CI red: the lanecheck test now uses the shared `tmpDir` helper.
### Changes
- bin/lean/lanecheck.mjs: checks and formatter
- bin/lean/lanecheck.test.mjs: unit tests (now via tmpDir)
- bin/lean/heavy.mjs: findShimLoops export
- bin/lean/orchestrate.mjs: preflight seam
- bin/engine-cli.mjs, bin/lean/schedd.mjs, bin/forgedock.mjs: wiring
- bin/lean/execution.mjs: sandbox.clone deferral
- bin/engine/outcome-codes.mjs, docs/OUTCOME-CODES.md, bin/tests/engine-outcome-codes.test.mjs: codes
- devdocs/modules/lean.md: dossier
### Acceptance Criteria Status
- R1 ✅ bin/lean/orchestrate.mjs, lanecheck.test.mjs
- R2 ✅ bin/lean/lanecheck.mjs
- R3 ✅ bin/lean/lanecheck.mjs, heavy.mjs
- R4 ✅ bin/lean/execution.mjs
- R5 ✅ bin/forgedock.mjs
- R6 ✅ bin/lean/lanecheck.mjs
- R7 ✅ engine-cli.mjs, schedd.mjs, forgedock.mjs
- R8 ✅ bin/lean/orchestrate.mjs
### Verification
- V1 node --test bin/lean/lanecheck.test.mjs: 12 pass, 0 fail
- V2 node --test (9 lean suites): 758 pass, 0 fail
- scripts/check-test-tmp-cleanup.sh: exit 0 (failed before the fix)
- forgedock check: PASS
### Notes
No new env vars.

## CI follow-up: sibling lists
Checked ten tests flagged for not naming lanecheck. None enumerates bin/lean modules (matches were the word "lane" in unrelated code), so all are recorded as not_members in result.json.

### Review follow-up
- docs/OUTCOME-CODES.md and bin/tests/engine-outcome-codes.test.mjs are recorded as add-deliverable amendments: the test requires the doc and enum to agree and every enum code to be in its coverage map, and D3 adds five enum codes.
- The base copy of engine-outcome-codes.test.mjs fails against any tree that adds an enum code ("every enum code has a declared coverage entry"), so that guard failure is inherent to D3. The updated test passes.
