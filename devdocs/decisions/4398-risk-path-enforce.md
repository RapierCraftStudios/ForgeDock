---
issue: 4398
status: fresh
anchor: bin/lean/lean.mjs
created: 2026-10-23
---

# ADR: conformance enforces on declared risk paths; unanswered investigations close partial

## Context

The conformance gate runs in shadow by default (`engine.conformance`). Nonconforming PRs merged on AlterLab
(#36341, #36344: "shadow: would block (nonconforming)"). In #36344 the investigation's question was deferred,
yet the issue closed as completed, and the customer failure persisted (#36372).

## Choice

- A lane whose diff matches a forge.yaml `review.risk_paths` glob runs the gate in enforce. The switch is sticky for the run.
  Other lanes stay in shadow until the measured false-block rate allows enforce everywhere.
- An `investigate(` / `investigate:` issue with a deferred or post-deploy requirement, or a deliver requirement the
  review did not mark `implemented`, closes `partial`. The open requirements are filed as a tracked follow-up before
  the PR, and the issue closes `not planned` with a FORGE:TRACKED "Closed as partial" note linking it.
- Per batch, the orchestrate report prints the shadow would-block and false-block shares. False-block = a would-block
  on an unusable review (incomplete, inconsistent or unparseable), the same proxy as `scripts/calibration.mjs`
  `recommendEnforce`.

## Rejected

- Built-in risk words (`review-trigger.mjs` `DEFAULT_RISK_PATTERNS`): words like `token` and `session` hit most diffs,
  which would mean enforce everywhere. The issue asks for declared globs.
- A new forge.yaml key: `review.risk_paths` already declares risk globs (#4273).
- Leaving a partial investigation open: orchestrate would requeue it, and GitHub has no "partial" close reason.
- Calling every shadow would-block a false block: a would-block on a real nonconformance cannot be judged false
  deterministically.
