forge-stamp: issue=5690 contract=7098c1e0eb8a
### Approach
A pure classifier (`classifyCiFailure`) plus a decision function (`failFastDecision`). Pool ingest fills `class` on failure events that have none. The classifier takes the flake ledger as an argument, so there is no I/O.
### Changes
- bin/lean/ci-classify.mjs: new classifier, signature tables, `failFastDecision`, `failFastPolicy`.
- bin/pool/ci-events.mjs: `createCiEvents` takes optional `classify` and `flakes()`. `ingest` classifies `step_failed`/`test_failed` events that have lines or a test and no `class`.
- bin/lean/ci-classify.test.mjs: 48-excerpt corpus (5 classes, at least 5 each, 4 ecosystems, at least 2 per class) with a printed accuracy table, flaky-suspect entries carrying their ledger, the override rules and the fail-fast matrix.
- bin/pool/ci-events.test.mjs: ingest classification tests.
- devdocs/modules/pool.md and lean.md: entries.
- bin/lean/release-flakes.mjs: unchanged. The needed symbols were already exported.
### Acceptance Criteria Status
- R1 ✅ bin/lean/ci-classify.mjs:46
- R2 ✅ ci-classify.mjs:47
- R3 ✅ ci-events.mjs `withClass`
- R4 ✅ ci-classify.mjs `failFastDecision`
- R5 ✅ the decision is pure; the router is untouched
- R6 ✅ nothing to export
- R7 ✅ ci-classify.test.mjs, plus the devdocs entries
- R8 ✅ 48/48 correct in the corpus, 0 false setup, test asserts >=40, >=5 per class (flaky-suspect included), >=2 ecosystems per class
- R9 ✅ ci-classify.test.mjs, failFastDecision describe
- R10 ✅ ci-classify.test.mjs, flake ledger describe
- R11 ✅ release-flakes.test.mjs passes unchanged
- R12 deferred in the contract (owner:promote:fail_fast)
### Verification
- V1, V2 and G1 (release-flakes + ci-events, exit 0) all pass.
- `forgedock check`: PASS.
- eslint on the changed files: clean.
- The new tests fail without the fix: the module and the ingest `class` do not exist on the base.
- The full lean test fan-out that checks.mjs printed was not run, per the host rules.
### Notes
- The router does not yet pass a flake ledger, so `flaky-suspect` is inactive in the pool until the lane consumer wires `flakes()`.
- A test failure (one carrying `test`) is never classed setup or stale.
- `ci-events.mjs` now imports `../lean/ci-classify.mjs`.

## Stale-list follow-up
Checked the ten bin/lean tests flagged for ci-classify; none enumerates bin/lean modules, so all are recorded as not_members in result.json. No test edits.
