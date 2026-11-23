forge-stamp: issue=5730 contract=a4c93f575786
### Approach
Classify a remote validate_failed's output before deferring to the host; only env signatures defer, everything else resumes the builder. Pass the sandbox tail in the placement note.
### Changes
- bin/lean/conformance.mjs: `isEnvValidateFailure`, `output` on validate_failed failures.
- bin/lean/lean.mjs: defer gate uses isEnvValidateFailure; sandbox output tail in ENV_VALIDATE_PLACEMENT note; `!recover` guard kept.
- bin/lean/validate-catalog.mjs: DRIFT_RE widened.
- tests: lean, conformance, validate-catalog; devdocs/modules/lean.md.
### Acceptance Criteria Status
- R1 ✅ conformance.mjs:878-886, lean.mjs:3683
- R2 ✅ validate-catalog.mjs:94
- R3 ✅ lean.mjs:3685
- R4 ✅ lean.mjs:3683 (!recover)
- R5 ✅ lean.test.mjs, conformance.test.mjs, validate-catalog.test.mjs
- R6 ✅ lean.test.mjs (5730 tests)
- R7 deferred in contract (post-deploy measure)
### Verification
- V1: exit 0 (1025 pass, 0 fail). G1: 11 pass. 5730 tests: 3 pass. forgedock check: PASS.
### Notes
No env vars. No behavior change for local/recover lanes.

## CI fix round (Unit tests node --test)
No log was available. Re-ran every lean/engine test file touching this diff (lean, conformance, validate-catalog, orchestrate-recovering/hostfallback, drift, verify, execution, engine-outcome-codes, journey, engine-cli): all pass. The remaining bin/lean files show 4 failures in ensureSignedOff (placeholder-author commits), toolchain pins (#4163, corepack/pnpm on PATH) and the post-checkout hook (#5435): git-identity / host-toolchain tests in files this diff does not touch (signoff, toolchain, hooks), so environment-dependent and unrelated; no code changed for them.
