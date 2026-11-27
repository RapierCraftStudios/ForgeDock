---
issue: 6164
status: fresh
anchor: bin/lean/release-cigreen.mjs
created: 2026-11-27
---

# 6164 — Release flow: restore the v1.0 contract (CI green first, one review pass, nothing fixed by review)

**Context:** The original release contract is `commands/review-pr-staging.md` at dcfb86bf (2026-06-05): open-finding gate, CI, one review pass, every finding filed, a confirmed blocker blocks, everything else merges on GATE_PASS. It drifted: #4358 and #4360 moved pre-dispatch and delta passes into the review loop; #5212 (2026-11-07) added review fix lanes and review-driven delta passes to the release conductor (`release-pr -> review -> fixes`); #5567 started CI and the panel on the same head (`coStartCi`) and added second-push policies. Result: reviewers ran before CI was judged, a red or flaky check moved the head, a delta review followed, then CI again, in a loop. Since #6150 PRs into staging run no CI, so the release PR holds the first full run. Owner target: a release approved in about 20 minutes with no loops.

**Decision (default for every repo using `forgedock release` or `review-staging`; no switch turns it off):**
- Open-finding gate first (`review-staging --gate-only`, run by the new step before anything else).
- New `ci-green` step after `release-pr` (`bin/lean/release-cigreen.mjs`, `RELEASE_STEPS`, status, resume): waits for every required check on the head (protection, rulesets, `gate.required_checks`; verify, deploy-gate and gate-marker excluded). A failed check is rerun once under the #5502/#6014 attempt cap; a pass on the rerun is a flake: green, plus a deduplicated `flaky-test` issue naming the test when the log shows it. Still red after the rerun: ONE CI fix round in the release PR (`fixRound`), then wait again; red again blocks.
- `review-staging <PR>` (also `--delta`) refuses with `REVIEW_RESULT: status: BLOCKED, blocker: CI not green on <sha> (pending: ..., failing: ...); review starts after CI is green` after the gate passes. `--allow-ci-pending` overrides and adds `allow_ci_pending=true` to the `FORGE:REVIEW_ROUTE` marker.
- ONE review pass on the green head. Every finding is filed (Phase 7). Nothing found by review is fixed in the release PR: the review-step fix lanes and review-driven delta passes of #5212 are off. A head that moves during review stops the job; a re-run goes through ci-green again.
- Verdict: a CONFIRMED CRITICAL/HIGH finding (at or above `release.block_severity`, default HIGH) or a failed guard is BLOCK. The job ends `blocked: review blockers #A #B`, the release PR is closed with the verdict, the blockers are added to the open orchestrate batch (`--add`) when there is one, and the next release starts fresh after they merge (the open-finding gate enforces it). No blockers: merge on GATE_PASS; the rest stays filed for later.
- `coStartCi` (#5567) is no longer called. The second-push machinery stays only behind `release.review_fixes: true` (default off, compatibility), which also restores the #5212 fix lanes and delta passes.
- `state.timing` records `ci_green_min`, `review_min`, `fix_rounds`, `review_passes`; `release status` prints it and the ledger mirrors the state.

**Why safe:** the pre-dispatch refusal is a backstop if a caller skips `ci-green`. The `allow_ci_pending=true` attribute on the route marker is ignored by existing readers (they match on `sha=`). Unreadable CI state fails closed. A draft release PR (host preflight mode) has no Actions CI, so ci-green skips it. In-flight release state from before this change resumes at `ci-green`.
