---
status: fresh
anchor: bin/lean/lean.mjs
created: 2026-11-28
---

# One builder session, deps in parallel, builder tier flag (#6207)

Status: accepted. Part of #6199 (lane economics). Measured on 392 merged lanes: builder spend is 60% of lane cost, a cold plan session is
21% on its own, there are about 2.2 sessions per lane, and `deps_install` takes a median 4.9 min.

## Decision

1. **One builder session.** The plan, contract and implement calls already resume one CLI session id. The second session came from the
   route hand-off (#5812): a plan above `engine.route_handoff_tokens` (40000, which most plans exceed) made the build start cold from a
   digest and re-read the code. Now the hand-off bound defaults to 0 (always resume) unless `engine.split_plan: true`, which restores the
   old two-session behaviour. An explicit `route_handoff_tokens` still wins. The contract is written, validated and frozen exactly as
   before (FORGE:CONTRACT, same hash, same correction loop), so conformance, guards and recovery are unchanged.
   A host-kill restart resumes the same session id when one exists (not for a plan call, not in split mode). An idle or timeout kill still restarts cold: a hung session may be poisoned. The
   context-ceiling path already compacts in place before it restarts.
2. **Deps in parallel.** The install starts right after the toolchain pin, concurrent with everything up to the first builder session.
   The heavy-step shim write no longer runs after the install: it runs beside it and is awaited before `env.setup`. The plan, hotspot
   and context-pack steps keep their bounded wait; implement, precheck and the contract checks wait through `gateBuild`/`gateSetup`
   only when they first need dependencies, and that residual wait is the `deps_install` phase.
3. **Tier flag.** `engine.builder_model_tier: auto|mid|top`, default `auto` (today's routing, unchanged). `mid` and `top` pin the tier
   for the A/B; risk-class lanes stay top under `mid`; mid-lane escalation on a failed validate is unchanged. The setting is reported as
   `builder_tier_setting` on RUN_TERMINAL. The default is not changed here: it needs an A/B on the #6203 scorecard.

## Telemetry

`wall_ms_by_phase.plan` and `.contract` stay as sub-phases of the one builder session (the ledger phases are unchanged). RUN_TERMINAL and
MERGE_LEDGER gain `builder_sessions` (distinct CLI session ids) and `split_plan`, so the scorecard can compare session counts per lane.

## Expected

Sessions per lane about 2.2 to about 1.3 (the remaining extras are fresh fix sessions and context restarts). Deps overlap is already
mostly in place for the plan, so the gain there is the shim write and keeping nothing serial before the first builder call.
