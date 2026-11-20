---
status: fresh
anchor: bin/lean/release-merge-hold.mjs
created: 2026-11-20
---

# ADR: hold lane merges while a release PR's CI runs

## Context

A lane merge into staging while a staging to main release PR's CI runs restarts that CI (~40 min per restart on AlterLab, #5709, epic #5549). `release freeze` only sets the deploy variable, and the hook allowed only `--head staging` for a PR to the default branch.

## Decision

- `releaseMergeHold` (bin/lean/release-merge-hold.mjs) answers held or not from facts: a manual hold (`mergeHold` in the `_active` record) or an open PR whose head is the lane's merge target, whose base is a default branch, and whose check rollup has an unfinished entry. No LLM, fail-open when GitHub cannot be read.
- The lane merge step (bin/lean/lean.mjs) polls it every 30 s before `gh pr merge`, records `merge.held_release`, leaves the PR open and green, and merges once the release PR merges, closes or finishes its checks. The wait is bounded by `ciMaxMinutes` and ends `ci-pending` (resumable).
- `forgedock release merge-hold|merge-release --reason ...` set and clear the manual hold through the audited control path; `release status` shows it.
- Policy `release.hold_merges_during_release_ci` (default true) turns the automatic hold off.
- The pre-tool-use hook also allows `--head release/<id>` for a PR to the default branch (snapshot release branches); other heads stay blocked.

## Consequences

Auto-sync commits made outside the engine are not held. Milestone-lane merges are held only when an open release PR has that lane branch as its head.
