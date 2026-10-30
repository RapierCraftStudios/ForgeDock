### Approach
A pure module (`activation.mjs`) detects new default-off keys in the PR diff of a forge.yaml-declared rollout registry. `precheck` fails when no activation row covers them. A post-deploy check that reports `BLOCKED: <flag> = off` becomes one owner ask per flag instead of a failure. The dormancy report takes an injected read-only flag-state hook.

### Changes
- bin/lean/activation.mjs (new): `readRollouts`, `detectNewOffKeys`, `coversFlag`, `activationFailures`, `dormancyReport`.
- bin/lean/conformance.mjs: `precheck` takes `newOffKeys` and pushes `activation_missing` and `mode_unreachable` failures.
- bin/lean/lean.mjs: `newOffKeysOf()` diffs the registry files against the base and feeds `precheck`.
- bin/lean/prompts.mjs: activation-row rule; promotion is listed as an owner action.
- bin/lean/postdeploy-check.mjs: `blockedRollout`, `postRolloutAsks` (marker `FORGE:ROLLOUT_ASK`, flag and evidence hash), `measureItems` handling.
- docs/CONFIG.md, devdocs/modules/lean.md: documentation.
- Tests: activation.test.mjs (new), postdeploy-check.test.mjs; lean.test.mjs plan-prompt token budgets raised by 50 (the new rule costs about 30 tokens).

### Acceptance Criteria Status
- R1 ✅ activation.test.mjs "a contract without an activation row fails…"
- R2 ✅ activation.test.mjs "an 'in shadow' AC fails…"
- R3 ✅ postdeploy-check.test.mjs "the next release with the same evidence raises nothing…"
- R4 deferred in the contract (needs #4768 adapters and production access).
- R5 ✅ conformance.mjs precheck, prompts.mjs
- R6 ✅ activation.mjs `detectNewOffKeys`
- R7 ✅ postdeploy-check.mjs `postRolloutAsks`
- R8 ✅ activation.mjs `dormancyReport`
- R9 ✅ activation.test.mjs keep-off test

### Verification
- V1 `node --test bin/lean/activation.test.mjs bin/lean/postdeploy-check.test.mjs bin/lean/conformance.test.mjs bin/lean/precheck.test.mjs`: 168 pass, 0 fail. The new tests cannot pass without the fix, since the module and the behaviour are new.
- lean.test.mjs: 512 pass, 1 fail. The failure is "#4690 a scope whose events show a limit…": the CLI is killed as idle while a `sleep 30` child is live. It exercises the host's scope/process handling, not the code in this change. I did not confirm it fails on the base.

### Notes
- Opt-in: nothing changes without a forge.yaml `rollouts:` section (`files`, `dormant_days`).
- A blocked rollup item parks as `awaiting-measurement` (existing callers branch on that state), with `blocked: [flags]` on the return value.
- The owner ask is deduped within the rollup issue by flag plus evidence hash.
- The dormancy report is library-only: nothing calls it yet, because production state needs #4768.
