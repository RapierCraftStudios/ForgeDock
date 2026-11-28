forge-stamp: issue=6175 contract=b8111ceb583d
### Approach
A block that tells the operator to re-run must leave ci-green and review undone. `blockedForRerun` (already on the branch) is now also used by legacyFixStep's cancel-only and pending-only blocks.
### Changes
- bin/lean/release-review.mjs: legacyFixStep cancel-only (:386) and pending-only (:390) blocks use blockedForRerun.
- bin/lean/release-review.test.mjs: legacy pending-only test, next to the two earlier #6175 tests.
### Acceptance Criteria Status
- R1 ✅ release-review.mjs:354-359, :386, :390
- R2 ✅ release-review.mjs:350-351 and the same helper; release-review.test.mjs:690-721
### Verification
- node --test bin/lean/release-review.test.mjs bin/lean/release.test.mjs: 130 pass, 0 fail.
- The new legacy test fails (1 fail) with the pending-only change reverted.
- forgedock check: PASS.
### Notes
No export added; the reviewBlocked path is unchanged.

## Precheck failure (spec-markers)
Only failure: scripts/symbol-move.test.sh needs python libcst (SYMBOL_MOVE_REQUIRE_LIBCST=1), absent in this sandbox. Unrelated to this diff (bin/lean/release-review*.mjs only); recorded as an environment-limitation amendment in result.json. No code change.
