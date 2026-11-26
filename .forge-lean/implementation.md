forge-stamp: issue=5990 contract=61dca7590176
### Approach
Verified the earlier run's commits against the contract; no gaps found. One schedd read client batches GraphQL reads with a TTL cache, and network errors become gh.unavailable.
### Changes
- bin/lean/gh-reader.mjs: reader (batched GraphQL, TTL cache, isNetworkError, spawn budget log)
- bin/lean/gh-reader.test.mjs: tests for R5, R6, R3
- bin/lean/lane.mjs: reader use; network error gives gh.unavailable
- bin/lean/lane.test.mjs: network vs non-network case
- bin/engine-cli.mjs: one reader per schedd, per-pass refresh, routed reads
- bin/lean/orchestrate.mjs: gh.unavailable uncapped, 60 s, admission kept
- bin/lean/orchestrate-transient-git.test.mjs: 15 min outage test
- bin/lean/effects.mjs: readGh under nice
- bin/engine/outcome-codes.mjs: comment
### Acceptance Criteria Status
- R1 ✅ bin/lean/gh-reader.mjs:32 (no ETag; GraphQL batch plus TTL cache)
- R2 ✅ bin/lean/lane.mjs:89
- R3 ✅ bin/lean/effects.mjs:494, gh-reader.mjs:26
- R5 ✅ bin/lean/gh-reader.test.mjs
- R6 ✅ bin/lean/orchestrate-transient-git.test.mjs
- R7 ✅ out-of-band: per-pass spawn log in schedd.log
- R9 ✅ bin/lean/orchestrate.mjs:1329
- R4, R8 deferred in the contract
### Verification
V1, V2 and G1 all pass (27, 61 and 20 tests, 0 fail). forgedock check: PASS. I did not re-run the new tests without the fix.
### Notes
No new env vars. Dispatcher reads now run under `nice -n 10`.

### Enumeration check
gh-reader is not a member of any of the ten flagged test lists (batch, checks, conformance, context, execution.e2e, execution, fixround, guardgate, ledger, release-mergeback); recorded in result.json not_members.
