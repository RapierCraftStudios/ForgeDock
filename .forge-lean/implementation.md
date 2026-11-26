forge-stamp: issue=5990 contract=61dca7590176
### Approach
One GitHub read client per schedd (bin/lean/gh-reader.mjs): one batched GraphQL refresh per pass, TTL cache serving last good value, nice-wrapped gh, spawn budget logged. Network errors become gh.unavailable (uncapped 60 s).
### Changes
- bin/lean/gh-reader.mjs: reader, isNetworkError, spawn counter/budget log
- bin/lean/gh-reader.test.mjs: 200 issues ≤2 GraphQL calls, 0 per-issue spawns; 15 min outage serves cache
- bin/lean/lane.mjs: milestone read via reader; network error -> gh.unavailable
- bin/lean/lane.test.mjs: network vs non-network cases
- bin/engine-cli.mjs: reader per schedd, refresh per pass, labelNames/viewOf/dispatchCheck/resolveLane route through it
- bin/lean/orchestrate.mjs: gh.unavailable uncapped; retryLane defers 60 s without lane failure
- bin/lean/orchestrate-transient-git.test.mjs: 15 min GitHub outage, no lane.unresolved rows
- bin/lean/effects.mjs: readGh under nice
- bin/engine/outcome-codes.mjs: comment
- devdocs/modules/lean.md: dossier entry
### Acceptance Criteria Status
- R1 ✅ bin/engine-cli.mjs:2087,2249
- R2 ✅ bin/lean/lane.mjs:88
- R3 ✅ bin/lean/effects.mjs:494, engine-cli.mjs:2251
- R5 ✅ bin/lean/gh-reader.test.mjs
- R6 ✅ bin/lean/orchestrate-transient-git.test.mjs
- R7 ✅ out-of-band: per-pass spawn count logged to schedd.log; measured on host
- R9 ✅ bin/lean/orchestrate.mjs retryLane
### Verification
- V1 node --test (gh-reader, lane, transient-git): 27 pass; new tests exercise new code and fail without it
- V2: 61 pass
- G1: 20 pass
- forgedock check: PASS
### Notes
No new env vars. Reads run under `nice -n 10` on non-Windows.

## Enumeration check follow-up
The ten flagged tests (batch, checks, conformance, context, execution.e2e, execution, fixround, guardgate, ledger, release-mergeback) hold no list that gh-reader belongs to; each is recorded in result.json `not_members`.
