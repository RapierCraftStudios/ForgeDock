### Approach
A pure module (`needs-human-premise.mjs`) holds predicates, closed-edge helpers and the ask registry; the batch runner, the lane's `needsHuman()`, the relabel hook and the daemon timer call into it. Recovery budgets are counted per class in the batch state.

### Changes
- bin/engine/outcome-codes.mjs: `MECHANICAL_CODES`, `recoveryClassOf`.
- bin/lean/orchestrate.mjs: per-class recovery counts (`recoveryClasses`, seeded from older saved state), `mechanicalMaxAttempts` budget, `final` per class, closed (completed) blockers ignored in the parking path via `dispatchCheck`.
- bin/engine-cli.mjs: `readOrchestration` adds `recovery.mechanicalMaxAttempts` (default 2, never below `max_attempts`); `makeRelabelNeedsHuman` checks the premise, links identical asks, writes the `FORGE:PREMISE`/`FORGE:ASK` annotations; `scheddDue` runs `sweepPremises`.
- bin/lean/needs-human-premise.mjs (new): `Premise:` predicates (issue-closed, date-after, pkg-version), `sweepPremises`, `closedEdges`/`closedEdgeNote`, `registerAsk`.
- bin/lean/lean.mjs: `needsHuman()` skips the label when the premise already holds (re-queues as `deferred`), links the owner ask for `builder.blocked`, flags closed `Depends on` edges.
- devdocs/modules/lean.md: dossier entry.
- Tests: needs-human-premise.test.mjs (new), recovery.test.mjs, batch.test.mjs (call order and orchestration shape updated).

### Acceptance Criteria Status
- R1 ✅ bin/lean/needs-human-premise.mjs:sweepPremises, engine-cli.mjs (scheddDue)
- R2 ✅ bin/lean/orchestrate.mjs (parking path, `dispatchCheck`), lean.mjs resolveBlock
- R3 ✅ bin/lean/needs-human-premise.mjs:registerAsk
- R4 ➖ deferred in contract
- R5 ✅ bin/lean/orchestrate.mjs (class budget requeues a mechanical row with a PR instead of parking)
- R6 ✅ lean.mjs needsHuman + sweepPremises (the sweep runs on the schedd timer, not strictly daily)
- R7 ✅ lean.mjs closedDeps note, orchestrate.mjs guard
- R8 ⚠ linking delivered; closing ask-only issues is deferred by amendment
- R9 ➖ deferred in contract
- R10 ✅ outcome-codes.mjs `recoveryClassOf`, engine-cli.mjs readOrchestration

### Verification
- V1 `node --test … needs-human-premise.test.mjs recovery.test.mjs parked-sweep.test.mjs bin/tests/engine-outcome-codes.test.mjs`: 75 pass, 0 fail.
- V2 `node --test … batch.test.mjs gatewatch.test.mjs decompose.test.mjs`: batch 55 pass; gatewatch and decompose passed in the earlier combined run (69 pass, failures were only the batch tests since updated).
- V3 `node --check` on lean.mjs, engine-cli.mjs, needs-human-premise.mjs: ok.
- The new orchestrate tests fail with orchestrate.mjs reverted to base (2 fail).
- `forgedock check`: PASS. `check-devdocs-freshness.sh origin/staging`: OK. No formatter is configured in the repo. `checks.mjs` widened to the full suite (fan-out), so it was not run.

### Notes
- New config: `orchestration.recovery.mechanical_max_attempts` (default 2). `max_attempts: 0` still disables all recovery.
- The premise sweep runs on each schedd timer tick (cheap predicates), not on a separate daily timer.
- Builders opt in by writing a `Premise: <kind>:<arg>` line in the block summary.

### Sibling-list check
- The 10 flagged tests (batch, checks, conformance, conformance.e2e, context, execution, execution.e2e, fixround, heavy, lean) enumerate no lean modules; recorded as `not_members` in result.json, no test edits.

### Export collision
- `compareVersions` in needs-human-premise.mjs collided with bin/registry.mjs; renamed to `comparePremiseVersions` (module + its test). V1-V3 pass.

### Rerun fix
R6 ✅ pkg-version now resolves in production: `registryPkgVersion` (npm view) is passed as `io.pkgVersion` in engine-cli.mjs (relabel + sweep) and as a fallback in lean.mjs:488. V1-V3 re-run: exit 0.
