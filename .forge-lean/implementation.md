### Approach
`merge-gate` gets a boolean `--manual-pr` (plus `--owner-requested`). It skips only the phase-trail preflight and records that on the PR. All other gates run unchanged. Eligibility is decided from facts (issue labels and markers, `closingIssuesReferences`), never from PR prose. With no issue, gate comments and labels go to the PR through two small helpers.

### Changes
- scripts/review-finalize.sh: flag parsing; `gate_comment` / `gate_label` / `is_pipeline_issue` / `manual_pr_eligibility`; trail preflight skipped with `FORGE:PHASE_TRAIL_SKIPPED`; degraded-gate and previously-escalated issue reads skipped when there is no issue; header usage.
- commands/review-pr.md: parse `--manual-pr` / `--owner-requested`, relaxed `--issue` rule, Phase 8 fence passes the flags, outcome note.
- scripts/review-finalize.test.sh: stub cases plus 14 manual-mode cases (merge, CI red, stale head, conflict, CHANGES REQUESTED, pipeline --issue, closing ref with/without owner flag, unreadable refs, absent flag keeps exit 4).
- scripts/review-pr-arguments.test.sh: parse cases.
- devdocs/decisions/4770-merge-gate-manual-pr.md: decision record required by check-devdocs-freshness (amendment add-deliverable).

### Acceptance Criteria Status
- R1 ✅ scripts/review-finalize.sh:1336 (`--manual-pr` mode), commands/review-pr.md:122
- R2 ✅ scripts/review-finalize.sh:1338 FORGE:PHASE_TRAIL_SKIPPED
- R3 ✅ only the trail block is bypassed; tests scripts/review-finalize.test.sh:859-885 show CI, reviewed-head, mergeability and verdict gates still block
- R4 ✅ scripts/review-finalize.sh:1281 manual_pr_eligibility
- R5 ✅ scripts/review-finalize.test.sh:861 (merges, `--match-head-commit` path)
- R6 ✅ scripts/review-finalize.test.sh:886-887 (exit 4 without the flag)

### Verification
- V1 `bash scripts/review-finalize.test.sh`: 655 passed, 0 failed. The new cases fail without the fix by construction (`--manual-pr` was an unknown argument, exit 2); not re-run against the base because the suite takes about 12 minutes.
- V2 `bash scripts/review-pr-arguments.test.sh`: 72 passed, 0 failed.
- V3 `bash scripts/check-spec-size.test.sh`: pass=45 fail=0.
- `scripts/check-devdocs-freshness.sh origin/staging`: OK.
- checks.mjs widened to the full node suite (fan-out cap); not run per host rules, and this change touches only shell and markdown.

### Notes
No env vars. No formatter is configured for shell or markdown in this repo. Behaviour without `--manual-pr` is unchanged.
