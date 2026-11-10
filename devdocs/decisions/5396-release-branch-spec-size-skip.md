---
status: fresh
anchor: scripts/check-spec-size.sh
created: 2026-11-10
---

# ADR: release/* PRs to main skip the spec-size budget (#5396)

## Context

The spec-size budget skipped only PRs whose head was the literal `staging`. Releases are now cut from `release/<date>[-n]` branches, so their cumulative growth, already checked per PR, was judged again and failed.

## Choice

- `scripts/check-spec-size.sh` and the `spec-size-budget` job `if:` in `check-commands.yml` skip same-repo PRs to `main` whose head is `staging` or `release/*`.
- Forks, non-main bases and a missing `PR_SAME_REPO` are still budgeted.
- Both change because CI runs the script from the base ref, so the job `if:` takes effect first.
