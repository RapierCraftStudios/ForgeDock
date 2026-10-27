### Approach
Before `issue create`, look up an existing FORGE:REGRESSION issue for the follow-up and fix commit and reuse it, so a retry after a failed `finish()` files nothing new. Covers schedd and `probe --due` (both call `monitorOne`).
### Changes
- bin/lean/postdeploy-monitor.mjs: `findRegression` (search, all states, exact marker/follow-up/fix match) used in `monitorOne`.
- bin/lean/postdeploy-monitor.test.mjs: mock handles search lists; 3 regression tests.
- devdocs/modules/lean.md: dossier note on idempotent filing (amendment add-deliverable).
### Acceptance Criteria Status
- R1 ✅ postdeploy-monitor.mjs:15-23,66-68
- R2 ✅ same lookup covers both sweepers
- R3 ✅ tests in postdeploy-monitor.test.mjs
### Verification
- V1 node --test postdeploy-monitor, postdeploy-check, schedd tests: 56 pass. New tests fail without the fix (2 fail).
- forgedock check: PASS; devdocs freshness OK. No formatter configured in repo.
### Notes
Search-index lag can leave a narrow duplicate window. A search failure throws (error row, retried), never files blind.

### CI follow-up (Unit tests, node --test)
The CI log was unavailable. Locally, bin/lean, bin/engine and bin/stats pass (1750/0 fail) and bin/tests passes except 3 environment tests (preflight Platform/WSL/Shell rows, install receipt platform capture, copyFile .tmp cleanup), none touching the changed files; they look WSL/host specific. No code change made; cause not reproduced.
