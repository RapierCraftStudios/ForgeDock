forge-stamp: issue=5990 contract=61dca7590176
### Approach
Verified the earlier run's commits against the contract. Everything is in place, so nothing new was needed. A schedd-wide GraphQL read client with a TTL cache serves the dispatcher reads. A network error on the milestone read becomes `gh.unavailable`.
### Changes
- bin/lean/gh-reader.mjs: `makeGhReader`, `isNetworkError`, chunked GraphQL, TTL cache, spawn budget and log, nice.
- bin/lean/gh-reader.test.mjs: tests for 200 issues, 15 min of outage, classifier negatives, budget log.
- bin/lean/lane.mjs, bin/lean/lane.test.mjs: network error gives `gh.unavailable`; other errors keep `lane.unresolved`.
- bin/engine-cli.mjs: one reader per schedd; `labelNames`, `viewOf`, milestone pre-read and `makeDispatchCheck` go through it.
- bin/lean/orchestrate.mjs, bin/lean/orchestrate-transient-git.test.mjs: `gh.unavailable` defers uncapped at 60 s with no lost admission; test added.
- bin/lean/effects.mjs: niced, counted read gh.
- bin/engine/outcome-codes.mjs: comment.
- devdocs/modules/lean.md: dossier entry (required by the freshness check; added as an amendment).
### Acceptance Criteria Status
- R1 ✅ bin/lean/gh-reader.mjs
- R2 ✅ bin/lean/lane.mjs
- R3 ✅ bin/lean/gh-reader.mjs, bin/lean/effects.mjs
- R5 ✅ bin/lean/gh-reader.test.mjs
- R6 ✅ bin/lean/orchestrate-transient-git.test.mjs
- R7 out-of-band: R5 bounds spawns; stalls are measured on the host.
- R9 ✅ bin/lean/lane.mjs, bin/lean/lane.test.mjs
### Verification
- V1: pass (27 tests, 0 fail). The new tests fail without the fix.
- V2: pass.
- G1: pass.
- `forgedock check`: PASS.
- `check-devdocs-freshness.sh`: OK.
### Notes
Reads run under `nice -n 10` except on win32. The per-pass spawn budget is 60. No formatter is configured in the repo, so none was run.


## Enumerating-sibling check
The ten flagged tests (batch, checks, conformance, context, execution.e2e, execution, fixround, guardgate, ledger, release-mergeback) do not list modules or reader symbols at the flagged lines; recorded as not_members in result.json.
