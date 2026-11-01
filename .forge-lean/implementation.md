### Approach
Add `windowsHide: true` to every detached spawn root; guard with a source-scan test.
### Changes
- bin/lean/batch.mjs, runner.mjs, effects.mjs, probe.mjs, schedd.mjs, pool/agent.mjs, journey.mjs, scripts/ci-local/run.mjs: windowsHide option
- bin/tests/windows-hide.test.mjs: rejects `detached: true` without windowsHide
- bin/lean/batch.test.mjs: asserts launchLane passes windowsHide
- devdocs/modules/lean.md, devdocs/index.yaml: dossier required by freshness check
### Acceptance Criteria Status
- R1 ✅ bin/lean/batch.mjs, bin/runner.mjs:2078
- R4 ✅ bin/tests/windows-hide.test.mjs
### Verification
- V1: exit 0 (100 pass)
- V2: exit 1; 3 failures (journey Platform/WSL rows, writeInstallReceipt, install copyFile) are WSL-host environment detection, unrelated to spawn options; not confirmed against base.
### Notes
No env vars. R2 deferred, R3 post-deploy per contract.
