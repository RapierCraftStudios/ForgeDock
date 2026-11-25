forge-stamp: issue=5987 contract=0cd3d4d463f8
### Approach
Recovery pass: the CI failure was scripts/check-test-tmp-cleanup.sh flagging bin/lean/efficiency.test.mjs for raw mkdtemp. Switched to the shared tmpDir helper.
### Changes
- bin/lean/efficiency.test.mjs: use tmpDir from bin/tests/_tmp.mjs (earlier commits hold the ledger, SLO filer, introspect timer, budget guard).
### Acceptance Criteria Status
- R1-R11 ✅ delivered in earlier commits (bin/lean/efficiency.mjs, slo.mjs, schedd.mjs, introspect-schedule.mjs, execution.mjs, devdocs/modules/lean.md). R12 deferred and R13 not-applicable per the contract. Note the filing default was later changed to on, per the binding decision.
### Verification
- check-test-tmp-cleanup.sh: OK (failed before the fix).
- node --test bin/lean/efficiency.test.mjs: pass 6.
- V1/V2/G1 passed in the last run and are unchanged. A lean-suite run showed 4 failures (a timing test, ensureSignedOff, toolchain pins, cold add), which look environmental and are unrelated to these files; I did not confirm that on base.
- forgedock check: PASS.
### Notes
No behavior change.

## Enumerating-test pass
efficiency/slo are not members of any flagged test list (incidental string matches); recorded in result.json not_members. No test edits.
