---
status: fresh
anchor: bin/lean/ci-precheck.mjs
created: 2026-11-21
---

# ADR: the lane runs the PR's required CI jobs before it opens the PR

## Context

A failing required CI check (`ci.red`) was the most common `needs-human` cause in a sample of 343 lane runs: 60 of 160 needs-human runs, about 59 minutes p50 each. Lanes found these failures in CI, after the PR was open. A local run of the same checks would have caught them first. The lean pre-PR round (#4240) only ran commands someone had declared: forge.yaml `learned.test_commands`, the test map and `verify.invariants`. Required jobs that nobody listed only ran in CI. `scripts/ci-local` (#4040) already derived and scoped a repo's pull-request checks from its CI definitions, but only the full pipeline's validate phase used it, not the lean lane.

## Decision

- `bin/lean/ci-precheck.mjs` does not parse workflows itself. It narrows the `scripts/ci-local` plan of the change, which `io.ciLocalPlan` runs as a child process. That plan already reads the base ref plus the lane's edits and applies path filters, matrix, secrets/deploy deferral and change scoping. The narrowed set has:
  - the jobs whose name or job id is a required status check on the lane base (`io.requiredChecks`: classic protection plus rulesets). A context matches as the bare name, with a matrix suffix, or behind a caller prefix;
  - the jobs a required aggregator job `needs`;
  - when no required check maps to a job, the conservative lint, typecheck and unit-test jobs instead.
- Heavy jobs stay CI-only by default: e2e, visual/Storybook, Lighthouse, app builds and docker images. forge.yaml `lean.ci_precheck_include` opts a kind or a job in. `lean.ci_precheck_exclude` always wins. `lean.ci_precheck_max_jobs` (default 8) caps the set, and `lean.ci_precheck: off` turns the feature off.
- Each selected job becomes one more command in the existing pre-PR round: `ci-local.sh run --plan <one-job plan>`. It shares the round budget, the per-command timeout (ci-local's own budget ends a minute earlier) and one heavy slot per command, and ci-local keeps its machine-wide slots, services and result cache. No second runner and no second fix loop.
- Outcomes:
  - Exit 1 is a failure. It goes to the builder in the existing `precheck` fix round, with the job name and steps added to the command line.
  - Exit 2 (ci-local degraded), 124, 127, a deferred job, or a planner failure (no `yq`) counts as unrunnable. It is recorded with its reason as an anomaly, is not rerun in later rounds, and never blocks the PR.
- Events: `CI_PRECHECK_PLAN` (source, commands with `why` and steps, skipped, unrunnable) and `CI_PRECHECK_RESULT` (per-job status, `green`), both before `PR_OPENED`.

## Consequences

- A required lint, typecheck or unit-test failure costs a local fix round instead of a CI run plus a CI fix round. CI stays authoritative. A job still red after `verify.max_rounds` follows the declared-check rule: an anomaly, or `ci.red` with `verify.precheck_block`.
- The feature needs mikefarah `yq` v4 on the host, as ci-local does. Without it, every lane records `CI check plan unavailable` and behaves as before.
- The in-session `forgedock check` (`check-plan.json`) does not run the derived jobs yet: the engine round is the only place they run.
- To measure the effect, compare `ci.red` needs-human per 100 runs before and after on a sample, and read the `CI_PRECHECK_RESULT` rows to see which jobs failed locally.

## Rejected

- **A new workflow parser in bin/lean.** ci-local already handles path filters, matrices, `needs`, secrets and scoping. A second parser would drift from it.
- **Running the whole ci-local plan as one command.** One command per job keeps the failure attributable to a job, lets the round run jobs in parallel under the heavy slots, and lets one unrunnable job be dropped without dropping the rest.
