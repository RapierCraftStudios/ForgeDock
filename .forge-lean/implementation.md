### Approach
CI recovery: the Unit tests job failed at "Test temp cleanup lint" because selftest-journey.test.mjs used mkdtemp directly. Switched to the shared tmpDir helper.
### Changes
- bin/lean/selftest-journey.test.mjs: tmpDir from bin/tests/_tmp.mjs instead of mkdtempSync.
### Acceptance Criteria Status
- R1-R7: ✅ (delivered earlier: bin/lean/selftest-journey.mjs, bin/forgedock.mjs:3414, snapshots under bin/tests/fixtures/journey-snapshots)
### Verification
- V1 selftest tests: exit 0 (63 pass). V2 review-staging: exit 0 (56 pass).
- check-test-tmp-cleanup.sh: OK (failed before this fix). forgedock check: PASS.
### Notes
No behaviour change. The remaining CI failure (scripts/remediate-basesync.test.sh shell test) is unrelated to this branch.

## Sibling lists (#5305 follow-up)
selftest-journey is not a member of any of the 10 flagged tests (each tests its own module and lists no selftest-* or bin/lean modules); recorded as not_members in result.json.
