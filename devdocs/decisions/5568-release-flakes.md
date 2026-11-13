---
status: fresh
anchor: bin/lean/release-flakes.mjs
created: 2026-11-12
---

# ADR: release flake ledger and exempt policy

## Context

Flaky checks cost whole CI rounds and operators hand-posted statuses to pass them (#5568, epic #5549, design 5.5, I15/I20/I29, R2).

## Decision

- `release-flakes.mjs` holds the policy as pure functions; no model call. Infra failures are matched against a fixed signature list.
- `flakes.json` lives on `forge-ledger/_active` beside `active.json`, committed together through `updateActive` (`out.files`), so GitHub stays the register.
- `rerunInfraFlakes` (release.mjs) reruns `--failed` once per job through `fenced()`, only for infra signatures and inside `ci.rerun_budget_min`; each decision is recorded.
- Repeated flakes (`flake.quarantine_after` flips in `flake.window_days`) file one `flake` issue. `release exempt --mode quarantine` needs that open, `flake`-labelled issue, is refused at `quarantine.max`, and lapses after `quarantine.days`. Every exempt needs an existing issue. Unskippable classes (one shared matcher `isUnskippable`) are refused for both modes.
- Live exemptions are appended to the release PR body (`exemptionsSection`).
- The cache marker writer belongs to the target repo's workflow; the engine ships the rule as `shouldWriteMarker` (a retry-pass run writes none, I29).

## Not in this change

The `forge-cache` marker writer, test-level retry annotation parsing, and the nightly sampled file-access trace.
