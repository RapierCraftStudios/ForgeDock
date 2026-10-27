### Approach
Merged origin/staging (conflicts resolved keeping both sides); the merge had replaced the result files with another lane's, so both were rewritten. Re-ran every validate command.
### Changes
Timer/service templates, refresh stamp, bin/bot-token-status.mjs, doctor Check 12, retry.mjs refreshAuthOnce/GH_AUTH_RE, lean.mjs wiring, gh.auth outcome code and docs, wait-ci-green 'unauth' class, spec rule, CONFIG.md, devdocs, tests.
### Acceptance Criteria Status
- R1 ✅ scripts/systemd/forgedock-bot-token-refresh.timer:5
- R2 ✅ bin/bot-token-status.mjs:13
- R3 ✅ bin/lean/retry.mjs:48
- R4 ✅ bin/lean/retry.mjs:63, bin/lean/lean.mjs:230
### Verification
- V1 pass (34/34). V2 pass (17/17). V3 pass (2 shell tests). V4 pass.
- New tests not run without the fix (unknown).
### Notes
Env: FORGE_REFRESH_TOKEN_SCRIPT, FORGE_CI_TRANSIENT_RETRIES.
