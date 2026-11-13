forge-stamp: issue=5531 contract=a02c158904f1
### Approach
Earlier commits moved schedd main-thread work off the event loop, added orphan cleanup and abandoned-batch handling. This pass fixes the CI failure: eslint reported a stale suppression (`bin/lean/schedd.mjs` no-use-before-define, 9 suppressed, 0 remaining), after staging merged the eslint config.
### Changes
- eslint-suppressions.json: removed the stale schedd.mjs entry.
- Merged origin/staging; earlier files unchanged (bin/lean/schedd.mjs, batch.mjs, effects.mjs, engine-cli.mjs, tests, devdocs/modules/lean.md).
### Acceptance Criteria Status
- R1 ✅ bin/lean/schedd.mjs
- R2 ✅ bin/lean/schedd-load.test.mjs
- R3 ✅ bin/lean/schedd.test.mjs
- R4 ✅ bin/lean/batch.mjs, batch.test.mjs
### Verification
V1-V3 passed on the previous run and no covered code changed. forgedock check: PASS. eslint with no suppressions shows engine-cli.mjs has 10 (matches its suppression) and schedd.mjs 0 (entry pruned). Tests fail without the fix: unknown this pass.
### Notes
No behavior change. The full eslint run could not be done locally (package 'globals' missing), so a temp config with an inline globals list was used.

## Follow-up: scanStats sibling-list check
scanStats (batch.mjs) is a parse counter, not a member of the liveElsewhere batchMod stub in autochildren.test.mjs:94; recorded in result.json not_members.
