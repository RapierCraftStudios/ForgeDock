forge-stamp: issue=5848 contract=a61261f11c2a
### Approach
Kept fix 97bea179 (`--watch` with `--merge` is a start; null policy refuses with check-config hint; watch follows the created id). Added the missing tests.
### Changes
- bin/lean/release.mjs: start/refuse/watch logic.
- bin/lean/release-status.test.mjs: three #5848 tests.
### Acceptance Criteria Status
- R1 ✅ release.mjs:659
- R2 ✅ release.mjs:636
- R3 ✅ release.mjs:659, test status.test:232,241
- R4 ✅ release.mjs:684, test status.test:249
### Verification
- V1 node --test (3 files): 97 pass, 0 fail. The 5848 refusal tests fail without the fix.
- forgedock check: PASS
### Notes
No env changes. Prettier is not applied to these .mjs files (they already fail it at base).
### Docs
- Added devdocs/decisions/5848-release-start-refusal.md and indexed it under release-pipeline (docs freshness check).

### Scope fix
Reverted efdd4df4 (devdocs/index.yaml and the decision record were outside the contract); diff vs staging is the two deliverables only.

### CI fix (Devdocs freshness)
The revert removed the docs update, so CI failed on bin/lean/release.mjs without a docs change. Re-applied the decision record devdocs/decisions/5848-release-start-refusal.md and its index entry; this is the repo's docs freshness rule, not a scope expansion.
