### Approach
Fix the shared verbatim-quote normalization (`norm`), show the nearest issue line when a quote misses, and let a contract that is still invalid only because of unmatched quotes end `contract.invalid` as recoverable.

### Changes
- bin/lean/conformance.mjs: `norm` folds unicode punctuation, zero-width chars, markdown links, `~`, `#`, backslash escapes; new `nearestSpan`; the quote problem carries the nearest issue text.
- bin/lean/lean.mjs: `contract.invalid` result sets `quoteMismatch` when all problems are quote misses; RECOVER_HOW wording updated.
- bin/engine/outcome-codes.mjs: `classifyNeedsHuman` treats `contract.invalid` with `quoteMismatch` as recoverable.
- bin/lean/orchestrate.mjs: passes `quoteMismatch` from the lane result into the recovery facts (not in the contract; amendment added).
- devdocs/modules/lean.md: entry and classification text.
- Tests: conformance.test.mjs, engine-outcome-codes.test.mjs, lean.test.mjs.

### Acceptance Criteria Status
- R1 ✅ bin/lean/conformance.mjs:34
- R2 ✅ bin/lean/conformance.mjs (nearestSpan, quoteMiss)
- R3 ✅ bin/engine/outcome-codes.mjs:224, bin/lean/lean.mjs:1591, bin/lean/orchestrate.mjs:654

### Verification
- V1 `node --test bin/lean/conformance.test.mjs`: pass (106).
- V2 `node --test bin/tests/engine-outcome-codes.test.mjs bin/lean/recovery.test.mjs`: pass (64).
- V3 `node --test bin/lean/lean.test.mjs`: 513 pass when run on a quiet moment. Under host load (load average ~117) 1-3 load-governor/timing tests fail (#4690 CLI_LANE_LIMIT, #4115c, batch robustness); they pass when run alone with a name filter (51 pass).
- Also passing: orchestrate*.test.mjs and engine-cli.test.mjs (78).
- New tests were not run against the pre-fix code; the norm test cannot pass with the old `norm` (it has no unicode folding).
- `forgedock check` FAILED: V3 (load flakiness above) and `scripts/verify-phase-trail.test.sh` timed out at 300s; cmd5/cmd8/cmd10 earlier timed out the same way. These are host-load timeouts, not assertions about this change.

### Notes
No env vars. Behaviour change: a quote-only invalid contract is now recoverable instead of terminal.

### Follow-up
`nearestSpan` is not a member of the missingTool test list at conformance.test.mjs:146; recorded in result.json not_members.
