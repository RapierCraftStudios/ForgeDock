---
status: fresh
anchor: bin/lean/admit.mjs
created: 2026-11-28
---

# ADR: a deterministic admit probe runs before the first builder or plan session (#6206)

## Context

Part of #6199 (lane economics). About 61% of non-merged spend was avoidable: lanes started on a base whose required checks were already red, in a placement that could not run their validates, or re-queued on an input and base that had not changed since the last park (about $139 of e2e lanes red on an unchanged base).

## Decision

`admitProbe()` in `bin/lean/lean.mjs` runs once per lane, after the reused frozen contract is read and before the first builder or plan session. Pure logic lives in `bin/lean/admit.mjs`. No LLM call. Each outcome is one `ADMIT_PROBE` telemetry event with `builder_spend_usd: 0` (the #6203 FORGE:TELEMETRY emitter and run log).

1. Failure fingerprint (not for recovery lanes). Every stampable NEEDS_HUMAN/PARKED comment now ends `sig=<F> base=<head12> in=<hash16> code=<code>`. The input hash is `computeInputHash` (#5986) over title, body, trusted FORGE:DECISIONs, the frozen contract hash and the engine major.minor; labels are state and are left out. The newest trusted stamp after the last FORGE:DECISION stops admission when the base head and input hash both equal the current ones: the lane ends `failure.repeated` (parked, not recoverable). Engine-owned env codes, `builder.blocked`, `base.red` and `base.conflict` are never stamped, so they keep their own recovery.
2. Base health. The required checks of the base head (`io.baseRequiredChecks`, its own read, plus check runs and commit statuses of the head sha). A failing required check that neither the issue text nor a file named in the check output touches defers the lane `base.red` (retry 900 s) with one comment per base head carrying the check links. Unreadable or unknown required sets fail open. The existing guard probe (`probeBase`, `guardRed`) still covers `verify.invariants` after the build.
3. Environment. `io.claudeAuthProbe` (`claude auth status`, no model call, skipped under a rotator or a sandbox credential) answering "not logged in" defers `backend.auth`. gh reachability needs no extra call: the lane has already read the issue through gh, with its retry and token refresh.
4. Contract dry-run. For a reused frozen contract in a local placement the existing `preflightValidates` (tool probes, collect-only, `runPreflight`) runs once on the tree. Docker-only gaps are recorded as a FORGE:DECISION deferring those validates to CI (the #6196 classification and recovery stay the fallback); a missing command not owned by the repo's manifests and without a lane_tools recipe ends `env.tool_missing` before any builder session. A fresh lane has no frozen contract before the plan session, and a remote lane keeps its own preflight, so this step does not apply to them.

`o.admitProbe: false` turns the probe off.

## Rejected

- Probing the contract of a fresh lane by running a plan session first: that is the spend the probe avoids.
- An orchestrator-side stop only: #5986 already refuses an unchanged input hash, but it ignores the base head and acts after a lane slot is taken. The lane-side stamp works for resumes and direct runs, and the dispatcher needs no change.
- Counting labels in the input hash: workflow labels change between a park and the next admit, so the stop would never fire.
- A new `env.*` code for an unreachable gh: not needed, see item 3.
