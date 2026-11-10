---
status: fresh
anchor: bin/lean/phaseledger.mjs
created: 2026-11-10
---

# ADR: the phase ledger attributes non-model time by cause

## Context

Two thirds of merged-lane wall time was non-model time, and the run log did not say what it was (#5349). The lane already collected heavy-slot and host-load waits (`addWait` in `lean.mjs`), but only for the batch report, never per phase.

## Choice

- `phaseledger.mjs` adds `wait` per phase (`heavy_queue`, `host_load`, `rate_limit`, `sandbox`, `command`, in ms) next to `ms` and `model_ms`. Time no typed wait explains is `command` (`sandbox` in `sandbox_start`), so model time plus the causes closes to the phase wall time.
- `lean.mjs` feeds it from the existing heavy-slot, shim-wait and host-load-pause sites and from the session-limit pause. FORGE:TELEMETRY gets flat `phase_<id>_wait_<cause>_ms` keys.
- `forgedock stats --efficiency` reports merged-lane non-model time by phase and cause; runs recorded before this change show `n/a`.
- Plan, precheck and base-sync changes wait for this data (issue acceptance: explain the plan wait before changing it).
