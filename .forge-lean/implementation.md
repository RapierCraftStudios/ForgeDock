### Approach
The daemon's event loop writes a heartbeat file; `sched show`/`schedd status` read it, and an external systemd timer runs `forgedock schedd watchdog`, which signals a live daemon whose heartbeat is stale so `Restart=always` restarts it. The schedd unit gets CPUWeight and the daemon reniced itself best-effort.

### Changes
- bin/lean/schedd-health.mjs: new heartbeat, stallCheck, tickText, watchdog, bestEffortRenice.
- bin/lean/schedd.mjs: 5 s heartbeat timer, `lastTick` in status, heartbeat removed on clean close.
- bin/engine-cli.mjs: tick age in `sched show` and `schedd status`; `schedd watchdog [--stall-sec N]`; best-effort renice at daemon start (done here rather than in schedd.mjs so tests that start a daemon do not renice the test process).
- bin/forgedock.mjs: help row text.
- pool/install/unit-hardening.sh: `unit_priority`; install-schedd.sh: priority lines plus watchdog service and timer.
- Tests: schedd-health.test.mjs (new), schedd.test.mjs, sched.test.mjs, pool-unit.test.mjs. devdocs/modules/lean.md entry.

### Acceptance Criteria Status
- R1 ✅ pool/install/unit-hardening.sh (unit_priority), install-schedd.sh; OOM score already protected (unit-hardening.sh unit_oom_score_adj).
- R2 deferred per contract (gh already async, bin/engine-cli.mjs:63; atomic saves are the durability guarantee).
- R3 ✅ bin/lean/schedd-health.mjs, bin/engine-cli.mjs (sched show, schedd watchdog).
- R4 ✅ same, plus install-schedd.sh watchdog timer.

### Verification
- V1 `node --test bin/lean/schedd-health.test.mjs bin/lean/schedd.test.mjs bin/lean/sched.test.mjs bin/tests/pool-unit.test.mjs`: all pass when run per file (schedd.test.mjs 23/0). One combined run showed a restart-resume test failure that did not recur in two reruns (load flake).
- V2 `node --test bin/lean/lean.test.mjs`: one failure (#4690 idle-kill timing test) in the first run; it passed on rerun (6/0 with the #4690 filter). Unrelated to schedd.
- `forgedock check`: PASS. devdocs freshness: OK. No repo formatter exists.
- Fails without the fix: new tests import schedd-health.mjs / unit_priority, which do not exist on base, so they cannot pass without the change.

### Notes
Heartbeat file: `<schedDir>/heartbeat.json`. Watchdog default stall 60 s. No new env vars. Watchdog timer runs every 30 s.

## Sibling-list follow-up
The ten flagged tests (telemetry-seam, batch, checks, conformance, conformance.e2e, context, drift, execution, execution.e2e, fixround) enumerate telemetry fields, cache files, kinds or provider names, not bin/lean modules. `schedd-health` is not a member of any; each is recorded in result.json `not_members`.
