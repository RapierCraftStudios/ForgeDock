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
- `status --watch` polls with an injected sleep and ends on a terminal status; the bare `release --watch` stays accepted and unchanged.
- `explain #N` traces only the rules in this repo today (skip labels, priority, `theme_map`, `Depends on` closure, recorded release set), each naming its config key. The wave planner and risk rules of the design do not exist yet; the later `release plan` issue adds them to the trace.
- `explain <PR>` reports the gate marker, `forge/deploy-gate` and failing checks. Who demoted a check and until when needs the later `exempt` records and is not shown.

## Rejected

Importing `release.mjs` from `release-status.mjs` (circular): the local cache and `gateState` are injected instead.
