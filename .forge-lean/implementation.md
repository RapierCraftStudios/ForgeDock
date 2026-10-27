### Approach
New pure report core `compoundingReport` plus a gatherer (guards via `collectGuards`, reopen events via one paginated `gh api`, git probes), exposed as `forgedock stats --compounding`. No LLM, no lane-path work.

### Changes
- bin/stats/compounding.mjs: reintroduction (reopen after lane close, or blame of a later guarded fix's old-side lines within 90 days), reopen-after-close, guard/decision counts from gate events (n/a when never recorded), rolling/per-release/lane-age grouping, renderer, git and gh gatherers.
- bin/stats/compounding.test.mjs: fixtures for each metric, n/a handling, buckets, git degradation, flag parsing.
- bin/stats/index.mjs: `--compounding`, `--bucket`, `--window` allowed with it, HELP, buildReport dispatch, text rendering.
- docs/STATS.md, devdocs/modules/lean.md: definitions, event names, baseline procedure.

### Acceptance Criteria Status
- R1 ✅ bin/stats/compounding.mjs (git, gh, telemetry only)
- R2 ✅ bin/stats/index.mjs (--compounding dispatch/render), compounding.mjs renderCompounding
- R3 post-deploy (baseline procedure in docs/STATS.md)
- R4 ✅ compounding.mjs blameLineage and reopen handling in compoundingReport
- R5 ✅ compoundingReport reopen_after_close
- R6 ✅ summarize guard counts
- R7 ✅ summarize decisions
- R8 ✅ bucketLabel / by_lane_age
- R9 ✅ rolling + by_release
- R10 ✅ no model calls
- R11, R12 not-applicable per contract

### Verification
- V1 `node --test bin/stats/compounding.test.mjs bin/stats/stats.test.mjs bin/stats/pool.test.mjs bin/stats/efficiency.test.mjs bin/stats/release.test.mjs bin/lean/guards.test.mjs`: 125 pass, 0 fail. The new test cannot pass without the fix (the module does not exist).
- `forgedock check`: PASS. scripts/check-devdocs-freshness.sh: OK. No formatter configured in the repo.
- checks.mjs widened to the full suite, which the host rules forbid, so only V1 was run.

### Notes
Event names guard_run, guard_broken, supersedes_accepted, decision_superseded, decision_violation are the contract #4693/#4695 must emit. Reopen-event fetch failure reads as 0 reopens (sources.reopens shows the count). Blame matching uses guard merge_sha equal to the blamed commit, so true merge-commit merges are not matched.
