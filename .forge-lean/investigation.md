**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: low (new feature module in a read-only watcher; no live path changes)
**Task Type**: feature

### What Was Claimed
#4837 (part of #4768) asks for `bin/lean/prodwatch-metrics.mjs`: per signal and source timings (signal to issue, merge, deployed-verified), false-positive, fix-ineffective and recurrence rates emitted through the telemetry seam, plus `sourceMode(source, stats)` dropping a source to shadow when its false-positive rate stays above a threshold over a minimum sample, calibrated like decision-engine `effectiveMode`.

### What We Found
- No `bin/lean/prodwatch-metrics.mjs` exists; only prodwatch-sources.mjs and prodwatch-triage.mjs (+ tests, fixtures/prodwatch) are present at the base (origin/main 5d9dd72ab).
- Template: `effectiveMode` at bin/lean/decision-engine.mjs:125-129 (rate gated by a minimum sample `REVERSAL_MIN_SAMPLE = 5` at :23, returns `{mode, gated, rate}`).
- Telemetry seam: bin/engine/telemetry-seam.mjs:83-86 maps `DECISION_ENGINE` to `decision_engine` with `compact()`; unmapped records return null (:90). A new record (e.g. `PRODWATCH_METRICS`) needs a mapRecord branch plus a doc-comment line at :11, and a test in bin/engine/telemetry-seam.test.mjs.
- Signal and cluster shapes: prodwatch-sources.mjs:27 `normalizeSignal` (`first_seen`, `source`), prodwatch-triage.mjs:35 `signalRef`, :123 `tallyClusters`. Metrics should take injected issue rows (signal_ref fp, createdAt, closedAt, mergedAt, verifiedAt, reopened, labels) and a clock, with no gh or fs.
- Depends on #4834 (merged) and #4836 (closed invalid: no prodwatch-verify module exists), so verified/reopen data comes only from caller-supplied rows (FORGE:VERIFIED comments, reopen events).
- The investigation comment already on #4837 describes the relay 413 bug (#4831). It is already fixed by dcd066c63 and is unrelated to this issue; ignored.

### Root Cause
The loop-metrics and auto-shadow feature has not been built.

### Affected Files
- bin/lean/prodwatch-metrics.mjs (new)
- bin/lean/prodwatch-metrics.test.mjs (new)
- bin/engine/telemetry-seam.mjs and bin/engine/telemetry-seam.test.mjs (new mapping)
- devdocs/modules/lean.md (module entry)
- Enumerating tests (sibling-list, literal lists at the cited lines): bin/lean/lean.test.mjs:66, bin/lean/execution.test.mjs:43, bin/lean/conformance.test.mjs:404. A new prodwatch file was not a member of these lists for #4834 (28d2de202), so none should need a change; run them to confirm.

### Sibling Sweep
Same defect class: none. Name-collision care: prodwatch-triage exports were renamed in 26d39c77d to avoid collisions, so export `sourceMode`, `computeMetrics` and `emitMetrics` and grep for duplicates across bin/lean first.

### History
Parent #4768 (not_planned, split into #4833-#4838). #4833 sources and #4834 triage are merged. #4835 governor and #4838 runner are open siblings and will consume `sourceMode`.

### Recommendation
Implement one pure module with an injected `io` (now, emit). `computeMetrics(rows, now)` returns per-source medians of signal-to-issue, to-merge and to-verified, plus FP, fix-ineffective and recurrence rates. `sourceMode(source, stats, opts)` returns `{mode, gated, rate}`: shadow when `stats.sample >= minSample` and the FP rate exceeds the threshold, otherwise live, mirroring `effectiveMode`. `emitMetrics` emits a `PRODWATCH_METRICS` record that mapRecord maps to a `prodwatch_metrics` event. Defaults are a minimum sample of 5 and a threshold of 0.5, both overridable.

### Related Issues
#4768 (parent), #4833, #4834, #4835, #4836, #4838, #4766 (effectiveMode precedent).
