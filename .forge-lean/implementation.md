forge-stamp: issue=5990 contract=61dca7590176
### Approach
One schedd GitHub read client (`gh-reader.mjs`): one chunked GraphQL call refreshes every tracked issue, a TTL cache serves the last good value when gh fails, spawns are counted per pass. A network error on the milestone read becomes `gh.unavailable` (uncapped 60 s) instead of `lane.unresolved`.
### Changes
- bin/lean/gh-reader.mjs: new reader (refresh, get/labels/milestone, isNetworkError, spawn counter, budget log).
- bin/lean/gh-reader.test.mjs: 200-issue, 15 min offline, classifier, budget tests.
- bin/lean/lane.mjs: `reader` option; network error on milestone read gives `gh.unavailable`.
- bin/lean/lane.test.mjs: network vs non-network case.
- bin/engine-cli.mjs: one reader per schedd; labelNames, laneOf milestone, makeDispatchCheck state read, viewOf spawn go through it; batch refresh per pass.
- bin/lean/orchestrate.mjs: `gh.unavailable` uncapped; retryLane defers 60 s without backoff growth, keeps the admission.
- bin/lean/orchestrate-transient-git.test.mjs: 15 min unreachable test.
- bin/lean/effects.mjs: `readGh` runs gh under `nice -n 10`.
- bin/engine/outcome-codes.mjs: comment.
### Acceptance Criteria Status
- R1 ✅ bin/lean/gh-reader.mjs:28-60
- R2 ✅ bin/lean/lane.mjs:86-89, bin/lean/orchestrate.mjs retryLane
- R3 ✅ bin/lean/effects.mjs readGh, gh-reader.mjs beginPass/endPass
- R4 deferred (contract), R8 deferred (contract)
- R5 ✅ gh-reader.test.mjs first test
- R6 ✅ orchestrate-transient-git.test.mjs, gh-reader.test.mjs
- R7 ✅ (out_of_band, instrumented): spawn bound tested in gh-reader.test.mjs:25; per-pass spawn log via reader.endPass in bin/engine-cli.mjs; stall count read from schedd.log on the host with the existing bin/lean/schedd-load.test.mjs
- R9 ✅ lane.mjs
### Verification
- V1, V2, G1: pass (forgedock check PASS). eslint on changed files clean; engine-cli.test.mjs 84 pass.
- New tests exercise new code (gh-reader.mjs is new; lane test fails without the isNetworkError branch).
### Notes
No env vars. Reader TTL 30 s, chunk 100, per-pass budget 60 spawns. `viewOf` still spawns a full `gh issue view` (body/comments are needed) but through the counted, niced reader. No formatter beyond eslint.
### Docs
Added the #5990 entry to devdocs/modules/lean.md (docs freshness check).

## Sibling-enumeration check
The ten flagged tests (batch, checks, conformance, context, execution.e2e, execution, fixround, guardgate, ledger, release-mergeback) do not list bin/lean modules; gh-reader recorded under not_members in result.json. No test edits needed.

Amendment: devdocs/modules/lean.md added as a deliverable (dossier entry for the read client, per the freshness rule).
