### Approach
Scheduler gains issue-level readiness: `trusted(n)` gates `Blocked by`/`Depends on` edges to trusted authors, `getBlocked()` withholds dispatch of labelled issues and polls so removing the label releases them. `--add` reports the edges it creates.
### Changes
- bin/lean/orchestrate.mjs: `trusted`, `getBlocked`, `declared`, `refreshBlocked`, isReady/wake handling.
- bin/engine-cli.mjs: readBody fetches author, `getBlocked` wiring, `blocked_label` in readOrchestration, `addedEdges` + edge report in addToBatch.
- docs/CONFIG.md, commands/orchestrate.md, devdocs/modules/{lean,orchestrate}.md: docs.
- bin/lean/orchestrate-blocked.test.mjs, bin/tests/orchestrate-add-edges.test.mjs (new), bin/lean/batch.test.mjs (readOrchestration shape).
### Acceptance Criteria Status
- R1 ✅ orchestrate.mjs declared(); engine-cli.mjs addedEdges
- R2 ✅ engine-cli.mjs addedEdges (OPEN only), trusted gate
- R3 ✅ orchestrate.mjs refreshBlocked/isReady
- R4 ✅ engine-cli.mjs addToBatch edges line
- R5 ✅ orchestrate-blocked.test.mjs first test
- R6 ✅ orchestrate-blocked.test.mjs second test
### Verification
`forgedock check` PASS: V1 (new tests) and V2 (batch/preflight/runtime-paths) exit 0, plus all repo scripts. New tests fail without the fix (seams/edges absent).
### Notes
New forge.yaml key `orchestration.blocked_label` (default `blocked`, empty disables).
