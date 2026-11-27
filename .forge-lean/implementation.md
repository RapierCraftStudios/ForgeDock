forge-stamp: issue=5990 contract=61dca7590176
### Approach
Schedd-wide gh read client (gh-reader.mjs) batches GraphQL reads, caches with TTL, serves last good value on network errors; resolveLane maps network errors to gh.unavailable.
### Changes
- bin/lean/gh-reader.mjs: reader, isNetworkError, spawn budget log, nice
- bin/lean/lane.mjs, orchestrate.mjs, engine-cli.mjs, effects.mjs, outcome-codes.mjs: wiring
- tests: gh-reader, lane, orchestrate-transient-git
- devdocs/modules/lean.md: dossier entry
### Acceptance Criteria Status
- R1 ✅ gh-reader.mjs; R2 ✅ lane.mjs; R3 ✅ gh-reader.mjs/effects.mjs; R5 ✅ gh-reader.test.mjs; R6 ✅ orchestrate-transient-git.test.mjs; R7 out-of-band (schedd-load.test.mjs); R9 ✅ lane.test.mjs
### Verification
V1, V2, G1 pass (27/66/27 tests ok); forgedock check PASS. New tests exercise new code paths absent before.
### Notes
No env vars.

### Precheck amendment
spec-markers job failed only in scripts/symbol-move.test.sh: libcst is not installed on this host (SYMBOL_MOVE_REQUIRE_LIBCST=1). Unrelated to this diff (no scripts/ changes); recorded as an environment amendment in result.json.
- Precheck failure (spec-markers job): the only failing line is `FAIL: libcst required (SYMBOL_MOVE_REQUIRE_LIBCST=1) but not available` in scripts/symbol-move.test.sh. This is a toolchain/environment problem (python has no libcst); this branch changes nothing under scripts/ (0 files), and every other step in that job passed. Not fixable in the diff; reported as environment.

## Sibling-enumeration follow-up
The 10 flagged tests (batch, checks, conformance, context, execution.e2e, execution, fixround, guardgate, ledger, release-mergeback) do not list bin/lean modules; recorded gh-reader as not_members in result.json. No code changed.
