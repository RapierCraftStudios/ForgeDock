forge-stamp: issue=5749 contract=532cfc5618e0
### Approach
Freeze-time runnability: static host-only/busy-loop rule, recipes, precheck tail in recovery text, overload deferral of env.validate_timeout recovery.
### Changes
- bin/pool/lane-tools.mjs: `yaml` (apt python3-yaml), plus `forgedock` and `vite` npm recipes (R5 quote names them; owned/manifest deps are still skipped by the lane's notOwned check, so remote placement is unchanged).
- bin/lean/preflight.mjs: `hostOnlyProblems`.
- bin/lean/lean.mjs: hostOnlyProblems in the freeze correction and a contract.invalid park; `failTail` (quietFailure) on precheck_block messages.
- bin/lean/orchestrate.mjs: env.validate_timeout recovery waits (max 30 min, one decided row) while overload() is true.
- devdocs/modules/lean.md: documented.
- Tests: lane-tools, preflight, lean, orchestrate-overload-recovery (#5749).
### Acceptance Criteria Status
- R1 ✅ preflight.test.mjs repro_test probe test; lean.mjs remote probe unchanged
- R2 ✅ lean.test.mjs "#5749 remote probe installs a recipe tool or re-places"
- R3 ✅ same test (before builder)
- R5 ✅ lane-tools.mjs:20-22
- R6 ✅ preflight.mjs hostOnlyProblems
- R7 ✅ lean.mjs freeze correction + park
- R8 ✅ lean.mjs failTail
- R9 ✅ orchestrate.mjs overload deferral
- R10 ✅ lean.test.mjs "keeps remote placement"
- R11 ✅ orchestrate-overload-recovery.test.mjs
- R4, R12: post-deploy amendments (AlterLab replay and batch metric; checks R4-alterlab-replay, R12-recovery-share).
### Verification
V1/V2/V3 exit 0 (prior run; V1 re-run: 10 pass). Tests fail without the fix (new symbols/behaviour). `forgedock check` PASS. checks.mjs widened to the full suite (fan-out cap) so was not run, per host rules.
### Notes
Decisions: forgedock and vite recipes added because R5 quotes both; decision amendments supersede K1 and K2.
