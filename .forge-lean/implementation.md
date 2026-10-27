### Approach
Time the guard gate beside the validate rerun; added wall time is the part not hidden behind the rerun. Emit it per gate pass and sum it per lane onto RUN_TERMINAL.
### Changes
- bin/lean/lean.mjs: `added_wall_ms` on guard_run; lane total `guard_added_ms` on RUN_TERMINAL.
- bin/engine/telemetry-seam.mjs: `guard_added_ms` in the run_terminal payload.
- bin/engine/telemetry-seam.test.mjs: regression test.
### Acceptance Criteria Status
- R1 ✅ bin/lean/lean.mjs (guard_run, RUN_TERMINAL), bin/engine/telemetry-seam.mjs
- R2 post-deploy: median measured from shadow telemetry after deploy.
### Verification
- V1 node --test telemetry-seam, guardgate, lean tests: 519 pass, 0 fail. New test fails without the fix (1 fail).
- `forgedock check`: PASS. checks.mjs widened to the full suite (848 referencing files); not run per host rules. No formatter configured.
### Notes
Skipped-gate lanes (no guard selected) add 0 and omit the field. No new env vars.
- Docs: devdocs/modules/lean.md describes guard_added_ms / added_wall_ms (docs freshness check).

Fix: guardGate now stages its guard_run event; the caller emits it after the Promise.all with added_wall_ms = max(0, total - validate rerun ms), 0 when the gate errored (error:true).
