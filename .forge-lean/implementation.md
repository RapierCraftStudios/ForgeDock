### Approach
`decide()` now checks each implemented `[type:e2e]` deliver row: its `validated_by` V-ref must resolve to a contract validate command that is a real e2e check. Otherwise it emits `conformance.e2e_unverified`.

### Changes
- bin/lean/conformance.mjs: `isE2eCommand`, `e2eVerified`, and the new check in `decide`.
- bin/engine/outcome-codes.mjs: `CONFORMANCE_E2E_UNVERIFIED`.
- bin/lean/lean.mjs: passes `e2e` (`checks`, `isSpec`) into the conformance ctx.
- bin/lean/prompts.mjs: one-line rule in the plan and implement prompts, plus a sentence in the rubric.
- commands/work-on/investigate.md: step 7.5 widened to route/URL/link findings.
- Tests: conformance.test.mjs (new regressions), lean.test.mjs (prompt token budgets raised by about 50), engine-outcome-codes.test.mjs (coverage entry; doc regex now allows digits).
- docs/OUTCOME-CODES.md: row for the new code (amendment).

### Acceptance Criteria Status
- R1 ✅ bin/lean/conformance.mjs (decide, e2eVerified)
- R2 ✅ bin/lean/prompts.mjs (plan and implement prompts)
- R3 ✅ commands/work-on/investigate.md (step 7.5)
- R4 ✅ the new check applies only to `[type:e2e]` rows
- R5 ✅ bin/lean/conformance.test.mjs ("#4726" describe)

### Verification
- V1 (conformance, e2e, conformance.e2e tests): pass.
- V2 (lean, verify tests): pass.
- V3 (outcome-codes test): pass.
- The enumerating tests (batch, checks, context, execution, fixround, heavy): pass (865 total).
- `forgedock check`: PASS.
- The new test fails without the fix (verified by reverting conformance.mjs).

### Notes
A new outcome code was added. There is no formatter config in the repo.

### Docs freshness fix
Added a dated entry to `devdocs/modules/lean.md` describing the `[type:e2e]` conformance check, `ctx.e2e` and the prompt/investigate changes. `scripts/check-devdocs-freshness.sh` now passes. V1 re-run: 116 pass, 0 fail.

## Enumerating-test fix
Added `isE2eCommand` and `e2eVerified` to the import list and assertions in bin/lean/conformance.test.mjs.

### CI follow-up
The CI log was not readable (no GitHub access). I reran the unit job's globs locally (`bin/tests`, `bin/engine`, `bin/lean`): 4258 pass, 4 fail. The failures are batch robustness #4690 (CLI_LANE_LIMIT scope), preflight (Platform/WSL rows), forge Act II (stale-copy cleanup) and writeInstallReceipt (platform info). They are host-specific (WSL, root user) and sit in code this change does not touch. No code change was made.
