---
issue: 4270
status: fresh
anchor: bin/lean/verify.mjs
created: 2026-10-20
---

# ADR: deterministic gate results post as an opt-in forgedock/verify check run

## Context

The lean lane's deterministic checks (declared checks, contract precheck, red-green proof, structure delta, hotspot gate) ran inside the lane and reported only in comments. A target repo with no required checks merged right after review, and nothing a repo could mark required carried that evidence (#4199 "Verify", additive).

## Decision

- forge.yaml `verify.check_run: true|false` (`parseVerify`, `readVerify`), default `false`. Off is byte-identical to before: no Checks API call, same outcomes and run log.
- On, `lean.mjs` `reportVerify()` posts one `forgedock/verify` check run per pushed head (PR push, base-sync, merge fix round) through `effects.mjs` `createCheckRun`. The payload is built by the pure `verifyReport` from `verifyFacts`, the results the existing gates already computed. No new gate logic. `success` iff every gate passed.
- The run log records a `VERIFY` event. A Checks API failure, or a lane without the seam, is an anomaly in the trajectory and never fails the lane.
- ForgeDock never sets the check as required: that is the repo's branch-protection choice.
- The check's own name is excluded from `runCiVerify` commit checks and from `scripts/wait-ci-green.sh` via `--ignore-check`, so the lane never waits on its own report.

## Rejected

- Making the check required from ForgeDock: it edits repo policy the owner did not ask for.
- Computing separate results for the check: two sources of truth for one gate.
