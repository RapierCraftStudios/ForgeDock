---
issue: 6164
status: fresh
anchor: bin/lean/release-cigreen.mjs
created: 2026-11-27
---

# 6164 — Release flow: CI green before review, one review pass, one fix round

**Context:** The release conductor ran `release-pr -> review -> fixes`. Reviewers started as soon as the release PR existed and CI was judged only at the gate summary. A red or flaky check then moved the head, which forced a delta review and another CI wait, in a loop. Since #6150 PRs into staging run no CI, so the release PR holds the first full run. Owner target: a release approved in about 20 minutes with no loops.

**Decision (default for every repo that uses `forgedock release` or `review-staging`; there is no off switch, forge.yaml keys only tighten or loosen):**
- (1) New `ci-green` step after `release-pr` (`bin/lean/release-cigreen.mjs`, `RELEASE_STEPS`, status, resume). It waits for every required check on the head (protection, rulesets, `gate.required_checks`; `forgedock/verify`, `forge/deploy-gate` and the gate-marker check excluded). Cancelled or failed runs are rerun once under the existing attempt cap (#5502, #6014). A real red runs the existing fix path (`fixRound`) and CI is awaited again. A head move during review returns to `ci-green` before the delta review.
- (2) `forgedock review-staging <PR>` pre-dispatch (also `--delta`) refuses with `REVIEW_RESULT: status: BLOCKED, blocker: CI not green on <sha> (pending: ..., failing: ...); review starts after CI is green`. `--allow-ci-pending` overrides and adds `allow_ci_pending=true` to the `FORGE:REVIEW_ROUTE` marker.
- (a) Flakes: a required check that fails and passes on its one rerun is green. A `flaky-test` issue is filed (deduplicated by title), naming the test from the log when a known pattern matches.
- (b) Findings: after `ci-green` there is one review pass. Only CONFIRMED findings at or above `release.block_severity` (default HIGH) block. Others are filed for the next release and never cause a fix or a head move; `fixes` acts only on blocking findings.
- (c) One fix round per release: all fixes in one head move, `ci-green` once, one delta review of the touched domains. A new blocker aborts with `aborted: second blocking round` (exit 3, state `aborted`); the fixes stay on staging. A resume never opens a third round.
- (d) `state.timing` records `ci_green_min`, `review_min`, `fix_rounds`, `review_passes`; `release status` prints it and the ledger mirrors the state.
- Knobs: `release.block_severity`, `release.ci_green_max_wait_min`. A draft release PR (host preflight mode) has no Actions CI, so `ci-green` records a skip there.

**Why safe:** the pre-dispatch refusal is the backstop even if a caller skips `ci-green`. Marker texts are unchanged apart from the optional `allow_ci_pending=true` attribute, which the existing marker readers ignore (they match on the `sha=` field). Unreadable CI state fails closed.
