### Approach
Every `detached: true` spawn gets `windowsHide: true` (a no-op off Windows), and a source-scan test rejects any new one without it. Merged origin/staging (one conflict in devdocs/modules/lean.md, both entries kept).

### Changes
- bin/lean/batch.mjs, bin/runner.mjs, bin/lean/effects.mjs, bin/lean/probe.mjs, bin/lean/schedd.mjs, bin/pool/agent.mjs, scripts/ci-local/run.mjs, bin/journey.mjs: `windowsHide: true` added to detached spawn options.
- bin/tests/windows-hide.test.mjs: new guard test.
- bin/lean/batch.test.mjs: launchLane asserts windowsHide.
- devdocs/modules/lean.md: dossier entry (#4764).

### Acceptance Criteria Status
- R1 ✅ bin/lean/batch.mjs:238, bin/runner.mjs:2078, bin/lean/effects.mjs:239, bin/lean/probe.mjs:182, bin/lean/schedd.mjs:368
- R2 deferred per contract
- R3 post-deploy per contract
- R4 ✅ bin/tests/windows-hide.test.mjs

### Verification
- V1: pass (100/100) after the merge.
- V2: exit 1, 953 pass / 4 fail, both before and after merging origin/staging, and identically on the unmodified base. The failures are host-environmental: this host is WSL2 (kernel 6.6.87.2-microsoft-standard-WSL2), and bin/tests/journey.test.mjs:559 and its siblings (preflight, forge Act II, writeInstallReceipt) assume a non-WSL host ('detected' vs 'not detected'); lean.test.mjs "batch robustness" (#4690 idle-kill, #4115c CPU-load on a 2-core host) is load-sensitive. None touch windowsHide behaviour; the fixes would be in non-deliverable test files.
- New test fails without the fix (removing windowsHide at probe.mjs:182 gives `# fail 1`).

### Notes
No behaviour change off Windows; no env vars.
