---
issue: 4450
status: fresh
anchor: bin/lean/lightlane.mjs
created: 2026-10-23
---

# ADR: light lane: one builder session, derived contract, in-process upgrade

## Context

On easy, well-specified bugs the full lean lane cost about 1.7× a plain single-session agent with no accuracy gain (#4442, benchmark of 2026-10-22). Most of the surplus is the separate plan step and fixed overhead. #4448 added the eligibility and upgrade-trigger rules, and #4449 added the public-API-shape detector; #4450 wires them into `runCore`.

## Choice

- **Gate.** Only forge.yaml `lean.light.mode: on`, verdict `eligible` and a fresh lane run light. `ambiguous` stays full. Shadow (the default) logs `LIGHT_ELIGIBILITY` and changes nothing.
- **One session.** One builder session writes the failing test, the fix and the targeted tests. Its result names one verbatim issue sentence, the repro test and the test commands.
- **Derived contract.** The engine derives the contract (`deriveLightContract`, pure) from the diff and those fields. The same `validateContract` checks it, so conformance and review see an ordinary frozen record.
- **Deterministic triggers.**
  - The engine runs the targeted tests: one in-session fix round, then a rerun.
  - The red/green repro, the numstat, the API-shape detector and `upgradeTriggers` decide the upgrade.
  - An unknown API shape or a missing repro upgrades: the light lane is more conservative than a plain agent.
- **In-process upgrade.** On a trigger the same run continues into the existing plan path, with `PLAN_RERUN_NOTE`, the #4400 resume digest and the trigger reasons. The branch keeps the light commits.

## Rejected

- **End the lane and requeue it as full.** This pays the lane setup again (worktree, deps, lease) and loses the session's place in the batch. The plan path already handles a branch with commits.
- **Let the builder write the contract after the fact.** That is a second unverified artifact. A deterministic derivation from the diff is cheaper and cannot drift from what changed (NORTHSTAR non-negotiable 1).
- **A model classifier for `ambiguous` issues in this change.** It adds a call per lane. It stays a seam for later work, measured by #4453.
- **Strip the context pack, hotspots and structure delta on light lanes.** That is #4451.
