forge-stamp: issue=5821 contract=be1dcb4511a8
### Approach
One runner seam in makeLeanRunner routes configured one-shot roles to a Messages API runner, default off, with CLI fallback. Rerun: verified the branch against the contract and added the `design` block the recurrence gate demanded to contract.json.
### Changes
- bin/lean/api-runner.mjs: fetch runner with cache_control, result shape, typed errors, #5347/#2385 note.
- bin/lean/effects.mjs: apiRoles/apiFallback/apiRunner routing, route recorded.
- bin/lean/lean.mjs, prompts.mjs: eligibility, route on attempt, stable prefix.
- bin/engine-cli.mjs: lean.api_roles / lean.api_fallback.
- bin/lean/api-report.mjs, api-parity.mjs: R3/R7 report and R2 replay.
- tests and devdocs/modules/lean.md.
### Acceptance Criteria Status
- R1 ✅ effects.mjs, lean.mjs
- R2 ✅ api-parity.mjs (live run out of band)
- R3 ✅ api-report.mjs
- R4 ✅ effects.mjs, engine-cli.mjs
- R5 ✅ api-runner.mjs (R5b deferred)
- R7 ✅ api-report.mjs (out of band measurement)
- R8 ✅ api-runner.mjs header, lean.md
### Verification
V1, V2, V3 pass via forgedock check. Routing tests fail without the fix (no API route existed).
### Notes
Default off. New config: lean.api_roles, lean.api_fallback; env ANTHROPIC_API_KEY.

## Enumerating-test follow-up (2)
Re-inspected the flagged lines in the 10 test files: none holds a list of bin/lean modules. The 30 (symbol, test) pairs are recorded in result.json not_members with reasons. No code changed.
- R5b ✅ bin/lean/lean.mjs:2399, :2685 (delivered; amendment replaces the deferral)
- R9 ✅ bin/lean/api-runner.mjs:40-42 cache_control on system and prefix (amended)

### Test strengthening (conformance.test_weak)
The R5 repro test in effects-cap.test.mjs now asserts the API result passes through (text, turns, baselineTokens), the runner receives system, the cacheable prefix, the tail and the key; dropping the prefix split fails it (mutation checked).
