---
issue: 4689
status: fresh
anchor: bin/lean/parked-sweep.mjs
created: 2026-10-27
---

# ADR: due-date gate, parked sweep and owner asks for post-deploy follow-ups

## Context

#4389, #4626 and #4627 park post-deploy follow-ups and measure them, but a date-gated item had no state, nothing re-checked
a parked issue between batches, and a pass or fail left no per-criterion record or typed owner ask.

## Choice

- `due:<date>` is a token in the post-deploy item text (`post-deploy: [check:x] due:2026-11-03 why`) with `awaiting-due`
  and `due:<date>` labels; no FORGE:STATE field (a label is filterable and needs no lease, as in 4389).
- `sweepParked` runs on the schedd timer next to `sweepDue` and re-runs the existing gate with `gateOnly`; re-queue means the
  wait labels are removed and the next scheduler pass takes the issue.
- The verification lane is deterministic: only the default branch's named checks and the minimal probe env
  (`acceptance_probe.env` allowlist) run; a pass ticks the items, a fail files one engineering issue per failing check,
  and a missing check or a `decision:` item gets one `FORGE:OWNER_ASK`.

## Rejected

- An agent with SSH or DB access reading free-text criteria: commands must come from reviewed default-branch code (4626).
