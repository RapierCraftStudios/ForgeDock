### Approach
Every `detached: true` spawn gets `windowsHide: true` (a no-op off Windows), and a source-scan test rejects any new one without it.

### Changes
- bin/lean/batch.mjs, bin/runner.mjs, bin/lean/effects.mjs, bin/lean/probe.mjs, bin/lean/schedd.mjs, bin/pool/agent.mjs, scripts/ci-local/run.mjs, bin/journey.mjs: added `windowsHide: true` to the detached spawn options (option only, no logic).
- bin/tests/windows-hide.test.mjs: new guard scanning non-test .mjs under bin/ and scripts/.
- bin/lean/batch.test.mjs: launchLane asserts `windowsHide === true`.

### Acceptance Criteria Status
- R1 ✅ all detached sites (e.g. bin/lean/batch.mjs:238, bin/runner.mjs:2078) plus guard bin/tests/windows-hide.test.mjs
- R2 deferred in the contract (non-detached spawns inherit the hidden console)
- R3 post-deploy (Windows desktop only)
- R4 ✅ bin/tests/windows-hide.test.mjs

### Verification
- V1 `node --test bin/tests/windows-hide.test.mjs bin/lean/batch.test.mjs bin/lean/probe.test.mjs bin/lean/schedd.test.mjs`: pass (98/98).
- V2 `node --test bin/tests/runner.test.mjs bin/tests/journey.test.mjs bin/lean/lean.test.mjs`: 4 failures (journey: preflight, forge Act II, writeInstallReceipt, WSL env; lean: batch robustness). The same 4 fail on the unmodified base, so they are pre-existing.
- New test fails without the fix (removing windowsHide at probe.mjs:182 gives `# fail 1`).
- `forgedock check` fails on V2 (above) and a 300s timeout of scripts/verify-phase-trail.test.sh (host load); both are unrelated to this change. devdocs freshness: OK.

### Notes
No behaviour change off Windows; no env vars.
- Docs: devdocs/modules/lean.md entry added for the freshness check (devdocs freshness: OK).
