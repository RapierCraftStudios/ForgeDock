forge-stamp: issue=5555 contract=a98bc6f632d0
### Approach
Recovery: CI failed on the test-temp-cleanup lint (intake.test.mjs used raw mkdtemp). Switched to the shared tmpDir helper.
### Changes
- bin/lean/intake.test.mjs: use tmpDir from ../tests/_tmp.mjs
### Acceptance Criteria Status
R1-R6 ✅ (delivered earlier in bin/lean/intake.mjs, issuewatch.mjs, release.mjs, forgedock.mjs; unchanged)
### Verification
- V1/G1 passed last run, not re-run beyond intake.test.mjs (8 pass); scripts/check-test-tmp-cleanup.sh OK; forgedock check PASS. The lint fails without the fix.
### Notes
No behavior change.

## Sibling-list failure
Checked the 10 flagged tests; none enumerate bin/lean modules/siblings of `intake`, so all are recorded as not_members in result.json. No test edits.
