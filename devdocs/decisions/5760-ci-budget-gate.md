---
status: fresh
anchor: bin/lean/ci-gate.mjs
created: 2026-11-20
---

# ADR: lanes declare the cost and trigger of every CI addition (#5760)

## Context

Lanes added workflows, jobs and one-file test steps without saying what they cost or when they ran, and seldom extended an
existing shared job. Nothing in the lane check or the release review counted CI growth.

## Choice

- `bin/lean/ci-gate.mjs` is a deterministic precheck input (0 LLM calls, no YAML dependency). An added workflow, job or
  single-test-file step must join forge.yaml `ci.budget.shared_regression_job` or carry
  `# FORGE:CI_BUDGET trigger=<scope> minutes=<N>/month why=<text>`. New workflows and jobs need concurrency,
  `timeout-minutes`, path scoping (a tag-only `push` is exempt; `# FORGE:CI_PATHS_EXEMPT why=<text>` opts out, #5792) and (issue/comment events) a job-level `if:`. `max_workflows`/`max_ci_jobs` fail only
  when set and the diff does not remove as many as it adds. Kinds: `ci_budget_unannotated`, `ci_budget_annotation_invalid`,
  `ci_budget_exceeded`, `ci_hygiene` (all `conformance.unimplemented`, through the repo's conformance mode).
- The annotation is a YAML comment in the diff, not a PR-body marker: the lane check runs before the PR exists.
- `scripts/review-staging-pre.sh scope` runs `node bin/lean/ci-gate.mjs net` fail-soft and prints the bundle's `CI_NET:`
  line (net workflows, jobs, annotated minutes), also written as `ci_net` in `<N>_scope.json`. A failure prints
  `CI_NET: unknown (...)` and never blocks the scope step.
- forge.yaml's one-level parser flattens `ci`, so `ci.budget.monthly_minutes` is the same key as `ci.monthly_minutes`.

## Rejected

- A YAML library: forge.yaml is already parsed by indentation and the gate only needs key presence.
- An LLM-only review rule: the infra review agent cites the `ci_hygiene` findings; it does not replace them.
