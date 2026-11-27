---
status: fresh
anchor: bin/lean/ci-precheck.mjs
created: 2026-11-26
---

# ADR: lane checks include the release branch's required CI

## Context

Release-only CI (formatters, suite-wiring checks) ran only after a release PR opened, so release rounds rediscovered cheap failures (#6013). The lane precheck (#5820) only knew the lane base's required checks and PR-gate workflows.

## Decision

Extend the `scripts/ci-local` plan with a `--release-branch` option instead of parsing workflows in `bin/lean` (ADR 5820 rejected a second parser). The adapter treats workflows that gate a PR into, or push on, that branch as gates. `selectCiPrecheck` unions the release branch's required checks into the required set and returns `parity`, the required contexts with no job the lane runs. Gaps are reported as `CI_PRECHECK_PARITY` and filed as issues deduped by a marker keyed on the context name, as base-red does (#5945).

## Consequences

An extra required-checks read per lane when the release branch differs from the lane base. Repo-specific names stay out of the code: only required-check contexts and job names from the repo's own CI are used.
