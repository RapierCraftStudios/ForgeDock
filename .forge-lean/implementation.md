### Approach
One pure module, `admit`, over validated triage clusters. Candidates are fileable, non-duplicate, non-expected-class clusters sorted incident, defect, then severity, size and fingerprint. A cluster is admitted while the hourly, open-issue and cost allowances all remain. Everything else goes into one summary.

### Changes
- bin/lean/prodwatch-governor.mjs: new `admit`.
- bin/lean/prodwatch-governor.test.mjs: 9 tests covering each cap, window expiry, ordering, single summary, skips, determinism, and the 70-memo storm.
- devdocs/modules/lean.md: dossier entry with the key mapping to signal-planner `max_issues_per_run`/`max_cost_usd`.

### Acceptance Criteria Status
- R1 ✅ bin/lean/prodwatch-governor.mjs:31
- R2 ✅ bin/lean/prodwatch-governor.mjs:31
- R3 ✅ bin/lean/prodwatch-governor.mjs:40-47
- R4 ✅ bin/lean/prodwatch-governor.mjs:49-57
- R5 ✅ bin/lean/prodwatch-governor.mjs:14-19
- R6 ✅ devdocs/modules/lean.md (prodwatch-governor entry)
- R7 ✅ pure, no fs/gh/exec, clock injected

### Verification
- V1 (governor, triage, sources tests): 31 pass, 0 fail.
- V2 (sibling-list tests): 314 pass, 0 fail.
- V3 (node --check + devdocs freshness): pass.
- The new test file fails without the module (import error).
- checks.mjs scoped run: 889 pass, 3 fail. All 3 failures are in bin/tests/journey.test.mjs (WSL platform detection, a tmp copyFile case), a file this change does not touch. They look environmental, but I did not run them on the base to confirm.
- `forgedock check`: PASS.

### Notes
- No env vars. No sibling-list test needed editing; the new file is not a member of any of them.
- Cost per cluster is `cluster.cost_usd ?? governor.cost_per_issue_usd ?? 0`.

## Sibling-list check
Ten flagged tests enumerate unrelated literals (telemetry events, ledgers, kinds, stubs); prodwatch-governor is not a member of any, recorded in result.json not_members.
