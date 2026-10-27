### Approach
Narrow the pinned-env allowlist in `bin/lean/schedd.mjs`, sanitise PATH at pin time, read `orchestration.env_passthrough`/`path_exclude`/`execution.token_env` from forge.yaml, and add operator commands to show/set/unset the pinned env.

### Changes
- bin/lean/schedd.mjs: exact allowlist (no `CLAUDE_CODE_*`, `CLAUDE_PID`, `ANTHROPIC_*`; secret-looking names dropped unless named), `sanitizePath`, `globToRegExp`, `redactEnv`, `batchEnv` options.
- bin/engine-cli.mjs: `readPinnedEnvConfig`, `envBatch` (--show-env/--set-env/--unset-env, wired in client and runBatch), re-sanitise fresh pin, per-lane spawn wrapper re-reading plan.json env, usage.
- bin/forgedock.mjs: help line.
- docs/CONFIG.md: new orchestration keys.
- bin/lean/schedd.test.mjs: updated env test; new unit and end-to-end regressions.

### Acceptance Criteria Status
- R1 ✅ bin/lean/schedd.mjs:41-45,76-81; bin/engine-cli.mjs (readPinnedEnvConfig, submit and runBatch pin)
- R2 ✅ bin/lean/schedd.mjs:62-73 (sanitizePath)
- R3 ✅ bin/engine-cli.mjs (envBatch, laneSpawn)
- R4 ✅ bin/lean/schedd.test.mjs ("#4691: plan.json holds none of ...")

### Verification
- V1 `node --test bin/lean/schedd.test.mjs`: 21 pass. Without the fix the file fails (new exports missing / assertions).
- V2 `node --test bin/lean/execution.test.mjs`: pass (75 with V1).
- Also recovery, batch, lean, plan-validate-live tests: 596 pass. `forgedock check`: PASS. checks.mjs widened to the full suite (not run, host rules).
- No formatter is configured in the repo.

### Notes
- Docs freshness: added a #4691 entry to devdocs/modules/lean.md.
- Behaviour change: client `ANTHROPIC_*` and `CLAUDE_CODE_*` are no longer pinned; lanes use the daemon's `ANTHROPIC_*`. List names in `orchestration.env_passthrough` to pin them.
- `--set-env` edits plan.json directly (no daemon); running lanes keep their env, new lanes pick it up.
