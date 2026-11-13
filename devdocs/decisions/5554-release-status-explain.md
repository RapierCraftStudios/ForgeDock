---
status: fresh
anchor: bin/lean/release-status.mjs
created: 2026-11-12
---

# ADR: release status and explain are read-only views over the ledger and GitHub

## Context

Operators could not see where a release is, or why an issue is in or out, without reading host-local files (#5554, epic #5549 Phase 0).

## Decision

- `release status|explain` make no GitHub write. They read the ledger (`readLedger`, new `readActive`/`listLedgers`) only when `release.managed` is on, else the local cache, and read the gate with the existing `gateState`.
- Output omits host names and wall clock (only timestamps recorded in the ledger), so a second host prints identical bytes. JSON: `forgedock.release.status/v1` and `forgedock.release.explain/v1`, each with `next_actions[]`.
- `status --watch [--interval s]` polls with an injected sleep, prints only on change and ends on a terminal status; the bare `release --watch` delegates to the same loop. Control verbs (`hold|resume|cancel|rollback|lane`) appear in `next_actions[]` with `--reason` placeholders and parse under `parseNextAction`; `hold|resume|cancel|lane` run through `release-control.mjs` (#5556); `rollback` has no CLI verb yet.
- `explain #N` emits `trace[]` of `{step, rule, config_key, result: pass|fail|n/a, would_change}`: classification (`FORGE:CLASSIFY`, else `classification: absent`), `plan.skip_labels`, `classify.min_confidence`, `risk.rules[i]`, `forces[i]` (a rule that fires is `fail`), priority, `theme_map`, `Depends on`, release set, the planner (`PLANNER_RULES` registry; `planner: not installed` until #5559 registers), and the lane (latest `lane` entry in `controls.jsonl`, else the plan). Records that #5556/#5557 will produce are read tolerantly and reported absent/`unknown`.
- `explain <PR>` lists every required check with its outcome at the head plus the gate marker and `forge/deploy-gate`; a failing check with an exemption record in `controls.jsonl` is `n/a` and names actor, expiry (printed, not compared to a clock), reason and issue.

## Rejected

Importing `release.mjs` from `release-status.mjs` (circular): the local cache and `gateState` are injected instead.
