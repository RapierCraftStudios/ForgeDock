### Approach
The 0B.1 per-PR reads became a function (`scope_one_pr`) run in subshells, `FORGE_SCOPE_PARALLELISM` (default 8) at a time. Each result goes to a scratch dir and is merged serially in PR order. Reads use `gh_retry`. A PR whose reads still fail is degraded: no commits credited, so they stay unreviewed (scope only widens). The bundle stays `scoped`. Only global failures still set `full`.

### Changes
- scripts/review-staging-pre.sh: new scope loop, `degraded_prs` in scope.json, progress on stderr, header docs.
- scripts/review-prepare.sh: progress lines for the index and slice phases. Slicing itself is not optimised, because I did not measure it as slow.
- scripts/review-staging-pre.test.sh: `scopefail` now expects scoped with `degraded_prs [5]`. New one-failed-PR case and a 300-PR run.
- scripts/review-pr-staging-scope.test.sh: the genuine-read-failure case now expects scoped plus a degraded notice. The text guard matches the new file-list lines.

### Acceptance Criteria Status
- R1 ✅ scripts/review-staging-pre.sh (scope_one_pr, parallel batches); the code-index walk was fixed earlier in #4126.
- R2 ✅ gh_retry on the three reads plus per-PR degrade, in the same block.
- R3 ✅ "0B.1:" stderr lines in the scope loop; "review-prepare:" lines in scripts/review-prepare.sh.
- R4 ✅ scripts/review-staging-pre.test.sh section (7): 300 PRs with a stubbed gh. The stub has no latency, so this measures script overhead, not network time.
- R5 ✅ scripts/review-staging-pre.test.sh section (6).

### Verification
- V1 `bash scripts/review-staging-pre.test.sh`: pass (55/0). With the old script, 5 checks fail, so the new tests fail without the fix.
- V2 `bash scripts/review-pr-staging-scope.test.sh`: pass (126/0).
- V3 `bash scripts/review-prepare.test.sh`: exit 0, but it printed "SKIP: yq not installed", so I can't say how much of it ran.
- V4 `node --test bin/tests/review-staging.test.mjs`: pass (51/0). Also ran engine, review-pool-exhaustion and review-finding-dedup tests: 258 pass in total.
- `forgedock check`: PASS. No formatter is configured in the repo.

### Notes
- New env var `FORGE_SCOPE_PARALLELISM` (default 8).
- scope.json gains `degraded_prs` (numbers).
- A failing PR now costs up to ~46s of retry backoff.
- The gate and bundle loops are unchanged (still serial, already retried).

## Docs
Added devdocs/decisions/4960-review-staging-scope-degrade-per-pr.md and a lean.md entry (docs freshness check).
