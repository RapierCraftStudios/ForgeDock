### Approach
Teach I4 and I6 of the doctor script about lean lanes: wider builder evidence plus an activity grace for I4, author and branch detection for I6.

### Changes
- scripts/doctor-pipeline-state.sh: I4 accepts FORGE:BUILDER|CONTRACT|PLAN|WORK-ON and skips issues whose updatedAt is within --stuck-hours; I6 fetches author,headRefName and skips lean head branches (`feat|fix/issue-N-lean`), the lane bot app and dependabot/renovate; header docs updated.
- bin/tests/doctor-pipeline-state.test.mjs: new, fake gh (applies real --jq) covering R3-R5 plus old-issue-still-critical and hand-made-PR-still-warns.

### Acceptance Criteria Status
- R1 ✅ scripts/doctor-pipeline-state.sh (I4 block)
- R2 ✅ scripts/doctor-pipeline-state.sh (I6 block)
- R3 ✅ test "I4 lean lane with FORGE:CONTRACT produces no finding"
- R4 ✅ test "I4 young workflow:building issue produces no CRITICAL"
- R5 ✅ I6 tests (lean branch, bot, dependabot skipped; hand-made warns)

### Verification
- V1 node --test doctor-pipeline-state + workflow-state-parity (+pre-tool-use): pass; new test fails on base (5 of 7 fail) and passes with the fix.
- V2 bash -n: ok.
- forgedock check: PASS.
- devdocs: lean.md entry + index.yaml glob for the script (freshness check).

### Notes
Grace uses the issue's updatedAt (same as I2), so with the default 48h an I4 finding only appears after 48h of inactivity. No repo formatter is configured for bash or mjs, so none was run.

### Amendments
- add-deliverable devdocs/index.yaml and devdocs/modules/lean.md: the dossier entry is required by scripts/check-devdocs-freshness.sh for a behaviour change under the script (passes).
