---
issue: 4453
status: fresh
anchor: scripts/bench-lightlane.mjs
created: 2026-10-23
---

# ADR: three-way light-lane benchmark (light vs full vs control), oracle-graded

## Context

The #4442 benchmark (light lane rationale, 2026-10-22) was run by hand: three more-itertools bugs, a full ForgeDock lane against a plain `claude -p` session, graded by upstream tests. Its procedure and grading were never committed, so the light lane (#4450, #4451, #4452) had no reproducible way to be measured against the #4442 targets.

## Choice

- **One script, three subcommands.** `scripts/bench-lightlane.mjs` has `calibrate`, `run` and `aggregate`. It drives the real CLIs (`forgedock run-issue --result-file`, `claude -p --output-format json`) through an injectable `run`, and it never writes to GitHub itself.
- **Oracle grading.** The upstream fix's test files are overlaid on the arm's head (`git checkout <fix_sha> -- <files>`) in a fresh clone, and the oracle command is scoped to the test ids the fix PR added or changed. `calibrate` proves each oracle is red on the base and green on the fix.
- **Claimed and false fix.** A lane claims a fix with a `merged` or `ci-pending` terminal reason; the control claims one with exit 0 and `is_error: false`. Either way the diff must be non-empty. A false fix is a claimed fix whose oracle fails.
- **Cost and time.**
  - Lane cost is the run result's `cost_usd`, the sum of the #4407 per-session deltas. Lane model time is `model_ms`, summed session time (#4451).
  - Control cost is `total_cost_usd`, and its model time is `duration_ms`. That is the same per-session quantity for a single session.
- **Light fields on the run result.** `bin/lean/lean.mjs` adds three additive fields: `light`, `light_eligibility` and `light_upgrade`. With them the bench can restrict cost and wall to eligible issues and count an API-shape change on a light finish as undetected.
- **Targets.** Cost and wall are judged on eligible light rows, with cost compared to the control on the same issues. Oracle, false fix and API shape are judged on all light rows. A target with no rows on one side is `null`, never a pass.

## Rejected

- **Parsing run-log events or FORGE:LITE comments for the light fields.** The run log is a local cache keyed by repo, and the comment is prose. The result file is the CLI's structured output (NORTHSTAR non-negotiable 1).
- **An LLM grader.** Pass or fail is a test exit code.
- **Extending `scripts/bench-scorecard.mjs`.** That is the UI-taste pairwise aggregator, with a different schema and an n≥3 rule.
- **Class-wide oracle commands.** On `670b715`, `SeekableTest` already has tests that fail for an unrelated, earlier upstream fix.
