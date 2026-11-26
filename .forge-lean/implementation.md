forge-stamp: issue=5821 contract=be1dcb4511a8
### Approach
Recovery pass: the branch was 104 commits behind staging. Merged origin/staging, resolving conflicts in bin/lean/lean.test.mjs (kept both appended test blocks) and bin/lean/effects.mjs (makeLeanRunner takes both the API-route params and staging's resolveBin/probeTimedOut/platform/binMissing). No new feature code.
### Changes
- bin/lean/effects.mjs, bin/lean/lean.test.mjs: merge-conflict resolution only.
### Acceptance Criteria Status
- R1-R5, R7, R8: ✅ unchanged from the earlier run (bin/lean/api-runner.mjs, api-parity.mjs, api-report.mjs, effects.mjs, lean.mjs, prompts.mjs, devdocs/modules/lean.md).
### Verification
- V1 api-runner.test.mjs: pass. V2 effects-cap.test.mjs: pass. V3 name-pattern run of lean.test.mjs: 1 failure, `#4182 operator-set FORGE_HOST_PARALLELISM` (expected '2', got '1'). It exercises quotaCores via the sandbox's cgroup CPU quota, in code this branch does not touch; treated as host-dependent.
- The CI-failing tests seen locally (signoff, warmtree, toolchain, ci-emit) are in files this branch does not touch.
### Notes
No behaviour or env changes beyond the earlier run.

## Enumerating-test follow-up
The 30 flagged (symbol, test) pairs for api-parity/api-report/api-runner are false positives (word-stem matches, no module lists); recorded in result.json not_members.
