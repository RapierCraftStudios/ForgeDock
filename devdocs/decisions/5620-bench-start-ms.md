# 5620: bench rows carry sandbox start wait

- **Change.** `bench-lightlane.mjs` `runArm` sets `start_ms` on full and light rows from the lane result `phases.sandbox_start.ms` (null when the result has no phases; always null for the control arm). `bench-adversarial.mjs` `aggregateAdversarial` adds per-arm `start_ms` (sum over finite rows) and `start_unobserved` (rows without one); the scorecard prints both. `armMetrics`/`aggregate` and the engine are unchanged.
- **Why phase ms.** SANDBOX_STEP steps overlap and need not sum to the phase (`docs/CONFIG.md`), so the phase total is the wall wait.
- **Use.** Compare runs with and without `execution.warm_sandboxes` (#5543). A null counts as unobserved, not 0, as `light_unobserved` does (#5541).
