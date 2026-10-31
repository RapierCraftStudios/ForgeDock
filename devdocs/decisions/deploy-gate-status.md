---
status: fresh
anchor: .github/workflows/gate-marker-check.yml
created: 2026-10-31
---

# ADR: the staging→main deploy gate is a commit status that stays pending without a review

## Context

`gate-marker-check.yml` exited 0 for the first 30 minutes after a staging→main PR opened with no gate marker. It was supposed to re-evaluate when a marker was posted, but the bot that posts markers comments with association `CONTRIBUTOR`, so the `issue_comment` run was skipped every time (release PR #4867: 8 skipped runs). Even when it ran, an `issue_comment` run reports against the default branch, not the PR head. So the green job from PR open was the only signal and stood forever: a PR merged at any time with no review on record passed. 1.28.0 shipped that way. `main` also required no status checks. And a `GATE_FAILURE` posted after a `GATE_PASS` still read as passed, because any trusted `GATE_PASS` won (noted out of scope in the #4359 ADR).

## Choice

- The gate is the `forge/deploy-gate` commit status on the PR head: success when the newest trusted marker is `GATE_PASS`, failure when it is `GATE_FAILURE`, pending when there is none, at any age. A status follows the PR head from an `issue_comment` run, which a check run cannot.
- Marker comments from logins in `FORGE_TRUSTED_MARKER_AUTHORS` now run the job. The job guard's substring `contains` only decides whether the job runs; the scan step still trusts a marker on an exact login match.
- Markers are sorted by time across PR comments and reviews, and the newest trusted one decides.
- The job keeps its old exit codes, including 0 inside the window: a red job would block the staging review's own Phase 1E CI read before it posts the marker. The review's 1E read and the `/deploy-pr` fix loop ignore `forge/deploy-gate`, as they ignore `forgedock/verify`. Otherwise an earlier `GATE_FAILURE` would block the re-run that clears it, and `/fix-ci` would be sent to fix a review. `wait-ci-green.sh` still waits on it, so an autonomous merge of a deploy PR waits for the gate.
- Blocking the merge is the repository's setting: `docs/CI.md` § 1b tells operators to require `forge/deploy-gate` on `main`.

## Rejected

- **Failing the job inside the window.** It deadlocks the staging review, which reads CI before it posts the marker.
- **Binding a marker to the head SHA.** A push to staging after a `GATE_PASS` is still covered by that marker. `review-staging --summary` already refuses a head that moved since `--finalize`, and the markers carry no SHA today. This is left for a follow-up that adds one.
