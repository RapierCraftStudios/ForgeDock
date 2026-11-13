---
status: fresh
anchor: bin/lean/release-start.mjs
created: 2026-11-13
---

# ADR: `release start` / `release go` (managed runner)

## Context

#5571 (epic #5549, Phase 8, I25) composes the planner (#5559), train lane (#5570), CI loop (#5567) and verify (#5562) into one call whose only owner steps are approvals.

## Decision

- `startRelease` drives `plan.waves` in order: every train, then the release wave. All effects go through injected `runners` (`build`, `train`, `release`, `verify`, `mergeback`, `rollouts`) and `fenced()` (#5553).
- **WAVE_DONE** is derived, not external: the wave ran live, `verify` reports verified, and `mergeback` reports validated. It is recorded in the plan ledger state (`state.waves[id].state`: PENDING, BUILT, CUT, LIVE, WAVE_DONE). A second `start` skips WAVE_DONE waves and does not redeploy a LIVE wave (it only re-verifies).
- **CUT gate** (`cutAllowed`): the release wave cannot be CUT until every train is WAVE_DONE. Building the release wave (`build`) is not gated, so it pipelines with train deploys.
- **Soak**: the release wave runner receives `soak: "full"`, which `release.mjs` passes as `config.verifyRisk` (`SOAK_MIN.full`, #5562).
- **Flag policy**: `features.flag_policy: require|warn|off` (policy schema); a lane's own `lanes.<lane>.flag_policy` wins. A feature wave that adds no rollout key is refused / WARNed / ignored. Default-off keys stay off at deploy (`keepOff`); activation is a separate `recordActivation` step (existing `activation_missing`, `activation.mjs`).
- **Milestone lane**: `--milestone <slug>` collapses the plan to one `full` release wave on `milestone/{slug}` (`branches.feature_pattern`); `--lane milestone` without `--milestone` is refused; nothing auto-plans it.
- **Approval**: `release go <id> [--plan|--merge]` posts `<!-- FORGE:DECISION plan|merge <hash> -->` on the `release-plan` tracker; `start --approve` does the same. `approvalOf` still decides (trusted actors, hash-bound).
- Unmanaged repos: `start` and `go` print and write nothing.

## Consequences

The default `rollouts` seam is not wired from the CLI yet (a repo without it gets no flag-policy action); activation recording is a library step.
