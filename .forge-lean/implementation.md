### Approach
Fix at the deterministic layer: the client consults the systemd unit before spawning, the unit stands by instead of exiting 0 on "already running", one-shot requests get a timeout, status exposes stall data, and admission waits are bounded per request.

### Changes
- bin/lean/schedd.mjs: `unitState`/`startUnit`; `connectDaemon` waits for an active/activating unit, starts an installed stopped unit, spawns only without a unit; `request(..., {timeoutMs})`; status per batch with `lastProgressAt`, `lastProgressAgeSec`, `pendingAdds` (also unhosted batches with pending adds); `hostBounded` (`FORGEDOCK_SCHEDD_ADMIT_MS`, default 120 s) for add/requeue/attach and a stall log for start-up resume; event-loop lag watchdog.
- bin/engine-cli.mjs: bounded `schedd status` output (age, pending adds, "not responding" with exit code 1); control clients pass `REQUEST_MS`; daemon stands by under systemd (`INVOCATION_ID`) while a live owner holds the lock.
- bin/lean/batch.mjs: `lastProgressMs()`.
- bin/lean/schedd.test.mjs: 7 regression tests.
- devdocs/decisions/4775-schedd-load-restart.md: decision note (required by the devdocs freshness check; amendment add-deliverable).

### Acceptance Criteria Status
- R1 ✅ bin/lean/schedd.mjs hostBounded + lag watchdog; gh calls audited: daemon path already has timeouts (effects.mjs:35,280), none added
- R2 ✅ bin/lean/schedd.mjs connectDaemon; bin/engine-cli.mjs standby in scheddFromCli
- R3 ✅ bin/engine-cli.mjs schedd status, schedd.mjs request timeoutMs, statusBatches
- R4 ✅ schedd.mjs statusBatches pendingAdds

### Verification
- V1 `node --test bin/lean/schedd.test.mjs`: pass (29 tests incl. 7 new). The new tests fail without the fix (they import `unitState` and use the timeout/status fields that do not exist on base).
- V2 `node --test bin/lean/batch.test.mjs bin/lean/recovery.test.mjs`: pass (126 pass, 0 fail across all three files).
- scripts/check-devdocs-freshness.sh origin/staging: OK. `forgedock check`: PASS on the second run (the first run hit a 300 s timeout in an unrelated gate-script suite at host load ~125).
- No formatter is configured in the repo.

### Notes
Env: `FORGEDOCK_SCHEDD_ADMIT_MS`. A stalled `schedd status` now exits 1. Standby applies only when `INVOCATION_ID` is set. I did not audit every gh call site beyond the daemon path.

## R1 follow-up
Audited gh execs on the daemon path: all already have timeouts; added 60s to the untimed `decisions list` gh calls (engine-cli.mjs). Reaping is libuv's job once the loop is responsive (lag watchdog logs starvation). A timed-out host() is not cancelled on purpose (would orphan/duplicate a launched batch); recorded as an amendment in result.json.
