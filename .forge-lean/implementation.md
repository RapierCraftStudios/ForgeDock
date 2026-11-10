### Approach
Rerun: verified the existing branch (merged with staging) against the contract; no code change was needed. The earlier CI red no longer reproduces.
### Changes
- bin/lean/stagestamp.mjs, branchlock.mjs: stamp and lock helpers (+tests)
- bin/lean/lean.mjs: wiring (stamp verify, branch lock, worktree-exists check, pgid wait)
- bin/lean/prompts.mjs: stamp header, WIP commit instead of stash
- bin/hooks/pre-tool-use.mjs: deny git stash push|pop|apply|drop in lane worktrees
- tests, devdocs/modules/lean.md, .forge/post-deploy-checks.json (R5)
### Acceptance Criteria Status
- R1 ✅ bin/lean/stagestamp.test.mjs; R2 ✅ bin/hooks/pre-tool-use.mjs:1483; R3 ✅ bin/lean/branchlock.test.mjs
- R4 ✅ bin/lean/lean.mjs:949; R5 post-deploy (.forge/post-deploy-checks.json); R6 ✅ lean.mjs:20; R7 ✅ pre-tool-use.mjs:1415; R8 ✅ lean.mjs:21; R9 ✅ lean.mjs (waitPidsExit)
### Verification
- node --test over bin/lean, bin/engine, bin/hooks tests: 2743 pass, 0 fail
- targeted stamp/branchlock/pre-tool-use/lean tests: 1282 pass, 0 fail
- forgedock lean checks.mjs: PASS; forgedock check: PASS
### Notes
No new env vars beyond FORGE_LANE_WORKTREE=1 (engine-set lane marker).


Follow-up: the 20 sibling-enumeration findings (branchlock, stagestamp vs ten V4 tests) are recorded as not_members in result.json; none of those tests lists lean modules.
