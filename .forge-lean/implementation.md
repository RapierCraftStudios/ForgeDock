forge-stamp: issue=5584 contract=c421b3e98030
### Approach
New pure classifier plus a plan/dispatch pair in `release-regate.mjs`; the `regate` verb in `runControl` refuses first, writes one audit commit, then makes one fenced dispatch of `verify.workflow` at the fix ref for the same release sha.
### Changes
- bin/lean/release-regate.mjs: `classifyGateOnly`, `hunkSteps`, `gateScriptSha`, `regatePlan` (refusals), `regateDispatch` (fenced, `forge_epoch`, `gate_fix_ref`, ledger `state.regates`).
- bin/lean/release-control.mjs: `regate` verb, `--ref`/`--gate-fix-ref` flags, `regates` owned key, `rel` passed through the CLI.
- bin/lean/release.mjs: opens the release state for `regate`; stamps later gate telemetry with the regate gate sha.
- bin/lean/release-config.mjs: `gates.paths`, `gates.workflow_steps`.
- bin/lean/release-gates.mjs: `GATE_PATHS_DEFAULT`, `parseGatesConfig` paths/workflowSteps, `gate_sha` on gate records.
- docs/CONFIG.md: regate section, `gate_fix_ref`.
- Tests: release-regate.test.mjs (new), release-control.test.mjs, release-config.test.mjs.
### Acceptance Criteria Status
- R1-R2 ✅ release-regate.mjs:regateDispatch
- R3-R5 ✅ release-regate.mjs:classifyGateOnly
- R6 ✅ release-control.mjs regate branch, release-regate.mjs:regateDispatch
- R7 ✅ release-regate.mjs:regatePlan
- R8 ✅ buildDispatchArgs unchanged; test "replay of 11-12"
- R9 ✅ non-gate paths refused (regatePlan)
- R10 ✅ audit line + state.regates + telemetry stamp (release.mjs)
- R11 ✅ gate_fix_ref input, docs/CONFIG.md
- R12 ✅ nothing runs unless verb is called
- R13-R16 ✅ bin/lean/release-regate.test.mjs
- R17 deferred (owner action, per contract)
### Verification
- V1 node --test of the 7 listed + fence/verify/ledger/status files: 215 pass, 0 fail. New tests fail without the fix (no module/verb).
- V2 check-config + node --check: pass. G1: pass. `forgedock check`: PASS. eslint on changed files: clean.
### Notes
Dispatch inputs: `sha`, `regate=true`, `gate_sha`, `forge_epoch`, optional `gate_fix_ref`; the verification workflow must accept them. The freeze refusal is "variable set and not set before the deploy, plus migration files between target and release sha". No formatter is configured in the repo (eslint only).
- Docs: added devdocs/decisions/5584-release-regate.md and linked it under release-pipeline in devdocs/index.yaml (docs freshness check).

## Sibling-list follow-up
The ten flagged tests do not enumerate release modules; release-regate recorded under not_members in result.json. No test edits.
