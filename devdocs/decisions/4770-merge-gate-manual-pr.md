# 4770 — merge-gate `--manual-pr` for hand-built PRs

A PR built by hand has no `/work-on` phase trail, so `review-finalize.sh merge-gate` could not merge it and operators fell back to `gh pr merge`, skipping the CI wait, reviewed-head guard, mergeability and protection handling.
`merge-gate --manual-pr` skips only the phase-trail preflight and records it as `FORGE:PHASE_TRAIL_SKIPPED`; every other gate runs unchanged.
Eligibility is deterministic: an explicit `--issue` that is a pipeline issue (`workflow:*` label or `FORGE:STATE`/`FORGE:STARTED` marker) is always refused; a PR closing a pipeline issue is refused unless the caller passes `--owner-requested`; an unreadable lookup refuses.
With no issue, gate comments and labels go to the PR, and the issue-scoped degraded-gate and previously-escalated checks are skipped.
Without the flag nothing changes (exit 4 `PHASE_TRAIL_FAILED`, "auto-merge requires --issue"). `/work-on` and `/orchestrate` never pass the flag.
