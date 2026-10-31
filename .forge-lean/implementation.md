### Approach
One pure module for loop metrics and the auto-shadow decision, calibrated like decision-engine `effectiveMode`, plus a telemetry-seam mapping for its record.

### Changes
- bin/lean/prodwatch-metrics.mjs: `computeMetrics`, `sourceMode`, `emitMetrics`.
- bin/engine/telemetry-seam.mjs: `PRODWATCH_METRICS` -> `prodwatch_metrics`.
- bin/lean/prodwatch-metrics.test.mjs, bin/engine/telemetry-seam.test.mjs: tests.
- devdocs/modules/lean.md: module entry.

### Acceptance Criteria Status
- R1 ✅ bin/lean/prodwatch-metrics.mjs:27
- R2 ✅ bin/engine/telemetry-seam.mjs:84, prodwatch-metrics.mjs:73
- R3 ✅ bin/lean/prodwatch-metrics.mjs:56
- R4 ✅ bin/lean/prodwatch-metrics.mjs:56 (min sample from REVERSAL_MIN_SAMPLE; test compares with effectiveMode)
- R5 ✅ same
- R6 ✅ no gh/fs, injected emit

### Verification
- V1: 51 pass, 0 fail.
- V2: 890 pass, 0 fail.
- forgedock check: PASS; devdocs freshness: OK.
- The new seam test fails without the telemetry-seam.mjs change (1 fail).
- No formatter is configured in package.json; none run.

### Notes
Rows are caller-supplied since #4836 does not exist. Defaults: min sample 5, max FP rate 0.5. No env vars.
