forge-stamp: issue=5990 contract=61dca7590176
### Approach
Rerun: verified the earlier commits against the contract; all validates pass, nothing missing.
### Changes
- bin/lean/gh-reader.mjs: schedd GitHub read client (batched GraphQL, TTL cache, stale-serve, nice, spawn budget log)
- bin/lean/gh-reader.test.mjs, lane.test.mjs, orchestrate-transient-git.test.mjs: regression tests
- bin/lean/lane.mjs, orchestrate.mjs, effects.mjs, bin/engine-cli.mjs, bin/engine/outcome-codes.mjs: route reads via reader; network error -> gh.unavailable
### Acceptance Criteria Status
- R1 ✅ gh-reader.mjs; R2 ✅ lane.mjs; R3 ✅ gh-reader.mjs/effects.mjs; R5 ✅ gh-reader.test.mjs; R6 ✅ orchestrate-transient-git.test.mjs; R7 ✅ instrumented (out_of_band, schedd-load.test.mjs); R9 ✅ lane.mjs/orchestrate.mjs
### Verification
V1, V2, G1 pass (exit 0); forgedock check PASS.
### Notes
No new env vars.

### Enumeration check
Recorded gh-reader as a not_member of the 10 flagged bin/lean tests (none list lean modules); see result.json not_members.
