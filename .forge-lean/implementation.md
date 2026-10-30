### Approach
Treat an unreachable pool as a wait (like #4528), derive pool liveness from `/agents` when `/status` lacks it (so #4547 fallback works), and report a sustained zero-agent pool once.

### Changes
- bin/lean/orchestrate.mjs: `sandbox.unreachable` added to UNCAPPED_DEFERRALS; grant() tracks `online===0` and emits one `pool-offline` event after `remote.poolOfflineMin` (default 10) min, reset when online > 0.
- bin/lean/sandbox-remote.mjs: `httpTransport.capacity()` falls back to `GET /agents` (online = ok && !paused, total).
- bin/lean/batch.test.mjs, bin/lean/sandbox-provider.contract.test.mjs: regression tests.

### Acceptance Criteria Status
- R1 ✅ bin/lean/orchestrate.mjs:124
- R2 ✅ bin/lean/orchestrate.mjs:~484-491 (one batch event; no separate notification channel exists)
- R3 ✅ report-only when fallback_local unset (same block)
- R4 ✅ bin/lean/sandbox-remote.mjs:80-98

### Verification
- V1 `node --test bin/lean/batch.test.mjs bin/lean/sandbox-provider.contract.test.mjs bin/lean/execution.test.mjs`: 145 pass, 0 fail. The new tests fail without the source change (3 failures).
- checks.mjs widened to the full suite (748 referencing files); not run, per host rules.

### Notes
`remote.poolOfflineMin` is not yet wired to config (execution.mjs/engine-cli.mjs are not deliverables); the default 10 applies. No devdocs change required (freshness script OK). No formatter is configured in the repo.

## Precheck rerun
classify-finding.test.sh and verify-phase-trail.test.sh timed out at 300s under host load; neither touches changed files. Reran: both pass (exit 0). No code change.
