forge-stamp: issue=5760 contract=71f48f04cc65
### Approach
Rerun: verified the three existing commits against the contract; the earlier park listed only unverified preserve rows. Recorded each below. No code changes.
### Changes
- bin/lean/ci-gate.mjs: parseCiBudget, scanWorkflow, parseAnnotation, singleTestFileSteps, ciGateFindings, ciBudgetFailures, netCiChange, CLI.
- bin/lean/conformance.mjs, lean.mjs: ciBudgetFailures wired into precheck (default null, so unchanged).
- bin/config-schema.mjs, docs/CONFIG.md, engine-cli.mjs: ci.budget keys.
- commands/review-pr-agents/infra.md, prompts.mjs: hygiene (blocking) and builder rules.
- scripts/review-staging-pre.sh, commands/review-pr-staging.md: CI_NET line; devdocs ADR/dossier.
### Acceptance Criteria Status
- R1-R5, R8, R10 ✅ bin/lean/ci-gate.mjs (ciGateFindings), ci-gate.test.mjs
- R6, R7 ✅ commands/review-pr-agents/infra.md
- R9 ✅ scripts/review-staging-pre.sh, ci-gate.mjs netCiChange
### Verification
V1-V5 pass (V1/V2 within a 353-test run); V6 PASS; V7 exit 0; G1, G2 pass. forgedock check PASS.
Preserve: P3 conformance.test.mjs:156 deepEqual passes; P4 ci-gate.test.mjs:170 asserts one git call; P6 check-spec-size PASS; P5 review-staging-pre.test.sh 62/0; lean.test.mjs 702 pass (guards H1-H5 area). New tests fail without the fix (module absent).
### Notes
No new env vars; gate is on by default; max_* only when set.

## Enumerating-tests fix
The ten flagged bin/lean tests only import or mention sibling modules; none is an exhaustive list of bin/lean files. ci-gate recorded under not_members in result.json; no test edits needed.
