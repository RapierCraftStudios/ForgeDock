forge-stamp: issue=5821 contract=be1dcb4511a8
### Approach
One-shot roles (reviewer, verifier, grouper) route through a Messages API runner at the makeLeanRunner seam, gated by lean.api_roles (default empty) with lean.api_fallback cli|fail. Builder stays on CLI.
### Changes
- bin/lean/api-runner.mjs: fetch runner with cache_control, runner result shape, typed errors, #5347/#2385 note
- bin/lean/effects.mjs: apiRoles/apiFallback/apiRunner routing, route on result
- bin/lean/lean.mjs: eligibility (diff within bound, no relaxations), route on attempt record
- bin/lean/prompts.mjs: stable prefix plus tail, CLI text byte-identical
- bin/engine-cli.mjs: read lean.api_roles/api_fallback at both sites
- bin/lean/api-report.mjs, api-parity.mjs: before/after report; parity replay
- tests and devdocs/modules/lean.md
### Acceptance Criteria Status
- R1 ✅ bin/lean/effects.mjs, lean.mjs
- R2 ✅ bin/lean/api-parity.mjs (live run out of band)
- R3 ✅ bin/lean/api-report.mjs
- R4 ✅ effects.mjs, engine-cli.mjs
- R5 ✅ api-runner.mjs
- R7 ✅ api-report.mjs (measured out of band)
- R8 ✅ api-runner.mjs header, devdocs/modules/lean.md
### Verification
V1, V2, V3 pass via forgedock check. Devdocs freshness OK.
### Notes
Default off; no new env vars beyond ANTHROPIC_API_KEY use.

Stale-list check: api-parity, api-report, api-runner are not members of any flagged test list (flagged lines are unrelated fixtures/comments); recorded in result.json not_members.
