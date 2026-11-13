forge-stamp: issue=5554 contract=d07b0535d432
### Approach
Recovery pass: CI "Unit tests" failed only on scripts/check-test-tmp-cleanup.test.sh (release-status.test.mjs used mkdtemp directly). Switched to the shared tmpDir helper.
### Changes
- bin/lean/release-status.test.mjs: use tmpDir from bin/tests/_tmp.mjs instead of mkdtempSync.
(Earlier commits deliver R1-R11 in release-status.mjs, release-ledger.mjs, release.mjs, help-text.mjs, docs/CONFIG.md, devdocs.)
### Acceptance Criteria Status
- R1-R11 ✅ delivered by earlier commits (bin/lean/release-status.mjs, release.mjs; tests in release-status.test.mjs)
- R12 deferred per contract (post-deploy owner check)
### Verification
- node --test bin/lean/release-status.test.mjs: 14 pass, 0 fail
- bash scripts/check-test-tmp-cleanup.sh: OK (failed before the fix)
- forgedock check: PASS
- checks.mjs widened to the full suite (fan-out); not run per host rules. V1/V2/V3/G1 passed earlier and the covered code is unchanged.
### Notes
No behavior change.

## Stale-sibling check
The 10 flagged tests do not enumerate release-* modules; recorded release-status as not_members in result.json.
- V2 `node --test bin/lean/release-snapshot.test.mjs bin/lean/release-preflight.test.mjs bin/lean/issuewatch-release.test.mjs`: exit 0 (39 pass, 0 fail)
- G1 `node --test bin/lean/release-ledger.test.mjs bin/lean/release.test.mjs`: exit 0 (57 pass, 0 fail)
