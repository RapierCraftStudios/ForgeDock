### Approach
Host-capability placement now reads three sources: the issue body, the FORGE:DECISION comments and the frozen contract's validate commands. A first remote run whose frozen contract needs a declared host tool now stops before building and is recovered on the host. `env.tool_missing` recoveries also run on the host. Everything is pure and deterministic, with no new gh calls and no LLM calls.

### Changes
- bin/lean/execution.mjs: adds `placementText({body, comments})` and `contractHostNeeds(contract, caps)`. The header comment names the #4785 inputs. It imports `parseContractComment` from render.mjs.
- bin/engine-cli.mjs: both `readBody` variants fetch `comments` in the same `gh issue view` call and compute `needsOf` from `placementText`. They still return only the body.
- bin/lean/lean.mjs: after the contract freeze/resume block, a lane that is placed remote, is not a recovery, and whose validate commands name a declared host capability ends `env.capability_remote` before any implementation turn.
- bin/lean/orchestrate.mjs: `placeOf` places `env.tool_missing` recoveries local, as it already does for `env.capability_remote`.
- devdocs/modules/lean.md: adds the #4785 entry.
- Tests: bin/lean/execution.test.mjs (placementText, contractHostNeeds, orchestrate tool-missing relaunch) and bin/lean/lean.test.mjs (remote early exit, plus the unchanged local, undeclared and recovery cases).

### Acceptance Criteria Status
- R1 ✅ bin/lean/execution.mjs:222 (placementText), bin/engine-cli.mjs:1808-1809 (readBody), bin/lean/lean.mjs:1607 (frozen-contract check)
- R2 ✅ bin/lean/lean.mjs:1607 (`env.capability_remote` before building), bin/lean/orchestrate.mjs:292 (tool-missing recovery runs local); the existing endBlocked mapping (lean.mjs:867-875) is unchanged

### Verification
- V1 `node --test bin/lean/execution.test.mjs`: pass
- V2 `node --test bin/lean/lean.test.mjs`: pass
- V3 `node --test bin/lean/recovery.test.mjs bin/tests/engine-outcome-codes.test.mjs bin/tests/engine-cli.test.mjs`: pass
- V4 `node --test --test-name-pattern=4785 bin/lean/execution.test.mjs bin/lean/lean.test.mjs`: pass. Fails without the fix: with lean.mjs and orchestrate.mjs reverted, the early-exit and tool-missing relaunch tests fail, and the placementText/contractHostNeeds tests cannot import functions that don't exist.
- Extra targeted run: bin/tests/orchestrate-preflight, orchestrate-runtime-paths, bin/lean/precheck, bin/lean/batch: pass.
- `checks.mjs --base origin/staging` widened to the full suite (921 files reference the change). The host rules forbid running the full suite, so only the targeted commands above were run.
- No repo formatter is configured.

### Notes
- Behaviour change: a remote lane whose frozen validate commands name a declared `execution.host_capabilities` entry (for example promtool) now ends `env.capability_remote` right after the freeze and is relaunched on the host. A rerun of such an issue is placed local from the start. Undeclared built-in needs (sops etc. not in host_capabilities) do not trigger the early exit; this follows the same rule as hostCapabilityBlock.
- Comments are not trust-filtered for placement: a detected need can only move a lane local (contract K1).
- The AlterLab lanes cited in the issue ran engine v1.32.1 in the sandbox, which predates the #4542/#4685 recovery mapping.
- No new env vars.
