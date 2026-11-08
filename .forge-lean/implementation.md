### Approach
`verify.invariants` is already the repo's always-run guard set; the gaps were blocking and base attribution. Invariants now block (switch `verify.guard_block`, default on), also run on the base-synced merged tree, and a failing one is first run on the merge base: failing there too defers the lane with new code `base.red` and tells the introducing issue; failing only on the lane blocks with `ci.red`.

### Changes
- bin/lean/basered.mjs (new): classify, namedPaths, issueOf, attribute, runOnBase, reportBaseRed.
- bin/lean/lean.mjs: guardOn/guardFailing/guardRed; precheck failure branch defers on base red and blocks on lane-own; postMergeGate adds invariants and returns `stuck`; base-sync caller blocks/defers.
- bin/lean/verify.mjs: guard_block parsing (key only present when false).
- bin/engine/outcome-codes.mjs: BASE_RED.
- bin/engine-cli.mjs: readVerify doc comment only (guard_block already flows through `...sec`).
- docs/CONFIG.md, devdocs/modules/lean.md: documented.
- docs/OUTCOME-CODES.md, bin/tests/engine-outcome-codes.test.mjs: required by the enum/doc agreement test (amendment add-deliverable).
- Tests: bin/lean/basered.test.mjs, verify.test.mjs, lean.test.mjs.

### Acceptance Criteria Status
- R1 ✅ bin/lean/lean.mjs (postMergeGate command list, guardOn)
- R2 ✅ bin/lean/basered.mjs attribute/reportBaseRed, lean.mjs guardRed
- R3 ✅ lean.mjs guardFailing in precheck exhaustion branches; test "guard failing only on the lane tree blocks"
- R4 ✅ lean.mjs guardRed finish("deferred", base.red); test "also fails on the base defers"

### Verification
- V1 `node --test bin/lean/basered.test.mjs bin/lean/verify.test.mjs bin/lean/precheck.test.mjs`: pass (68).
- V2 `node --test --test-name-pattern='base.red|guard' bin/lean/lean.test.mjs`: pass.
- New lean tests fail without the fix (2 of 3 fail with lean.mjs reverted).
- Also: lean.test, conformance.test, engine-cli.test, config-docs, engine-outcome-codes, decision-engine tests pass; `forgedock check` PASS. No formatter configured in the repo.
- The scoped-checks tool widened to the full suite (outcome-codes fan-out); not run per host rules.

### Notes
- Behavior change: repos with `verify.invariants` now block on a failing invariant (previously advisory unless precheck_block). Opt out with `verify.guard_block: false`.
- Base-red lane retries after 900 s (retryInSeconds). Attribution uses git log on files named in the failure output; falls back to test files.

### Stale-list fix
- Inspected the 10 cited tests at the cited lines: none enumerates lean modules/symbols; recorded `basered` as a non-member of each in result.json `not_members`. No test edits needed.

### Export collision fix
- Renamed basered exports `classify` -> `classifyBaseRed` and `namedPaths` -> `baseRedPaths` (collided with decision-engine.mjs and prefilter.mjs); updated lean.mjs, basered.test.mjs, devdocs. Validate commands pass.
