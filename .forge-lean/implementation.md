### Approach
A standalone, io-injected module (`bin/lean/decision-engine.mjs`) with deterministic policy loading and escalation splitting, one injected `judge` seam, shadow/live settling, veto and a reversal-rate gate. The issue-watch stage (#4765) is not in the repo, so the watcher wiring is deferred (contract R7-R12).

### Changes
- bin/lean/decision-engine.mjs: loadPolicy, splitEscalation, admissible, settle, classify, isVetoed, revertVeto, effectiveMode, tally.
- bin/lean/decision-engine.test.mjs: regression tests, including the six AlterLab fixtures.
- bin/engine/telemetry-seam.mjs: `DECISION_ENGINE` mapped to the `decision_engine` event.
- bin/lean/orchestrate.mjs: batch report lists rows with `decided`.
- docs/DECISIONS.md, docs/NORTHSTAR-TEMPLATE.md, docs/CONFIG.md, docs/TELEMETRY.md, devdocs/modules/lean.md.

### Acceptance Criteria Status
- R1 ✅ decision-engine.mjs loadPolicy
- R2 ✅ decision-engine.mjs splitEscalation; test "six AlterLab fixtures"
- R3 ✅ settle (shadow/live), isVetoed/revertVeto
- R4 ✅ settle calls recordDecisions
- R5 ✅ telemetry-seam.mjs, orchestrate.mjs formatOutcomeLists
- R6 ✅ docs/DECISIONS.md, docs/NORTHSTAR-TEMPLATE.md
- R7-R12 deferred per contract (#4765 watcher, monitor execution, release checklist)
- R13 ✅ admissible/settle escalate
- R14 ✅ isVetoed/revertVeto
- R15 ✅ formatOutcomeLists `decided` section
- R16 ✅ effectiveMode

### Verification
- V1 `node --test bin/lean/decision-engine.test.mjs`: pass; the test fails without the fix (the module does not exist on the base).
- V2 `node --test bin/lean/decisions.test.mjs bin/engine/telemetry-seam.test.mjs bin/lean/batch.test.mjs`: pass (88 tests with V1).
- `forgedock check`: PASS. checks.mjs widened to the full suite (fan-out), which the host rules forbid, so only the targeted tests were run. The devdocs freshness script reports OK.

### Notes
Nothing calls the engine by default, so there is no behaviour change until #4765 wires it. New forge.yaml `decisions:` keys are documented in docs/CONFIG.md. The reversal-rate gate needs at least 5 decisions.

## Stale-list follow-up
Checked the 10 tests flagged as enumerating siblings of decision-engine: none holds a list of lean modules or files, so each is recorded in result.json not_members.
