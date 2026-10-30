### Approach
Do both options of the issue: an operator `FORGE:DECISION` newer than the frozen contract marks it stale (re-plan), and its text is added to the plan/implement prompts. Deterministic, no LLM call.

### Changes
- bin/lean/lean.mjs: `operatorDecision` (tells operator decisions from engine-posted `## Decision: `/`## Decision (batch` and #4695 JSON records), `decisionsNote` (newest first, 2 KB); `readFrozenContract` tracks decisions since the last contract and sets `decisionAfter`; rerun check reports "a FORGE:DECISION was posted after it"; `decisionNote` appended to plan, restart and unplanned implement prompts.
- bin/lean/lean.test.mjs: regression test.
- devdocs/modules/lean.md: documents the behaviour.

### Acceptance Criteria Status
- R1 ✅ lean.mjs (readFrozenContract / plan prompt)
- R2 ✅ decisionNote in plan prompt
- R3 ✅ decisionAfter -> stale
- R4 ✅ devdocs/modules/lean.md:90

### Verification
- V1 `node --test bin/lean/lean.test.mjs`: 514 pass in the first run; the new test fails against the base lean.mjs (513 pass/1 fail). A later run hit one failure in the unrelated #4690 lane-limit test, which passes alone (load flake).
- V2 `node --test bin/lean/decisions.test.mjs bin/lean/context.test.mjs`: 38 pass.
- Devdocs freshness script: OK.

### Notes
No env vars. A decision older than the contract is not re-injected (the contract embodies it).

## Fix: scoped contracts
The stale check consulted `fc.scope` first, so engine-written (scoped) contracts never reached `decisionAfter`. `decisionAfter` is now checked first. Added a regression test using a scoped contract (`scoped()`), which fails without the reorder.
