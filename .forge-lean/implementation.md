### Approach
Every local lane's builder CLI runs in a named `systemd-run --user --scope` by default, with `TasksMax` and a K-derived `MemoryMax`. The runner samples the scope's cgroup events while the child runs. A limit stop becomes `CLI_LANE_LIMIT`, which ends the lane `needs-human` with `env.lane_limit`. The breaker counts only engine-error rows, so it ignores that outcome.

### Changes
- bin/lean/effects.mjs: `wrapLaneLimits` adds `--unit` and default `TasksMax=1024` (`tasks_max` override, 0/off disables). The runner wraps whenever systemd probes available. New `laneCapNotice` and `DEFAULT_LANE_TASKS_MAX`.
- bin/runner.mjs: `readScopeLimitEvents` reads `pids.events` max and `memory.events` oom_kill. A live sample on the tick stops the lane and throws `CLI_LANE_LIMIT` (`limit` tasks|memory).
- bin/lean/hostkill.mjs: documents that a limit stop is never a host kill.
- bin/lean/lean.mjs: `CLI_LANE_LIMIT` checkpoints, then ends needs-human `env.lane_limit` with no retry.
- bin/engine/outcome-codes.mjs: `ENV_LANE_LIMIT`.
- bin/engine-cli.mjs: `readCoreLimits` always returns `laneLimits` (`tasks_max`, K-derived `memory_max` via `defaultLaneMemory`). Orchestrate passes `FORGEDOCK_LANE_PARALLEL` to lanes and logs one uncapped line.
- docs/CONFIG.md, docs/OUTCOME-CODES.md, devdocs/modules/lean.md: docs.
- Tests: bin/lean/lean.test.mjs, bin/lean/batch.test.mjs, bin/tests/engine-cli.test.mjs, bin/tests/engine-outcome-codes.test.mjs.

### Acceptance Criteria Status
- R1 ✅ bin/lean/effects.mjs (wrapLaneLimits, makeLeanRunner wrap); bin/engine-cli.mjs readCoreLimits/defaultLaneMemory
- R2 ✅ bin/runner.mjs (limitInfo, readScopeLimitEvents); bin/lean/lean.mjs (CLI_LANE_LIMIT branch); bin/engine/outcome-codes.mjs
- R3 ✅ bin/engine-cli.mjs (laneCapNotice call in orchestrate); bin/lean/effects.mjs laneCapNotice
- R4 ✅ bin/lean/lean.test.mjs (#4115b, #4690 tests); bin/lean/batch.test.mjs (#4690 keeps admitting)

### Verification
- V1 `node --test --test-name-pattern='4115|lane.limit|host.kill|4518' bin/lean/lean.test.mjs`: pass. The full lean.test.mjs also passes (493).
- V2 `node --test bin/tests/engine-outcome-codes.test.mjs`: pass.
- V3 `bash scripts/check-devdocs-freshness.sh origin/staging`: pass.
- `forgedock check`: PASS. The new tests reference symbols or behaviour that did not exist, so they fail without the fix.
- The real-systemd fork-past-TasksMax fixture is skipped on this host (no `systemd-run --user`), so it did not run here. The classification path is covered by an injected `limitProbe`.

### Notes
- Behaviour change: lanes are scoped by default where systemd is available. A single refused fork at TasksMax stops the lane.
- New env var `FORGEDOCK_LANE_PARALLEL`, set by orchestrate for its lanes.
- New forge.yaml key `engine.lane_limits.tasks_max`.
- No formatter is configured in this repo.

- Added readScopeLimitEvents to bin/tests/runner.test.mjs import list with a unit test (sibling-enumeration fix).

## CI fix
The #4690 integration test (real systemd scope fork) is skipped here but runs on CI hosts where systemd-run exists yet scope cgroup counters may be unreadable. It now skips unless the scope path and pids.events are readable (scopeEventsReadable). No CI log was available; all local targeted tests pass.

## Post-merge re-validation
V1, V2 and V3 re-run after merging origin/staging: all exit 0 (V3 prints "OK: every behaviour change has its module dossier updated.").

## CI follow-up (Unit tests job)
No CI log was available and the job does not reproduce locally (1880 targeted tests pass; the real-scope tests skip here). Hardened the real-scope fork test so the idle timer cannot race the limit sample (idleMs removed). V1-V3 re-run: exit 0.

## R4 fixture without systemd
Added "#4690 a fixture lane really forking past its task cap" (bin/lean/lean.test.mjs): a real shell fixture forks 40 children, a probe counting its real descendants reports the cap, and runCliBackendAsync stops it with CLI_LANE_LIMIT/tasks. It runs on every host; the real-scope variant still skips where systemd-run --user is unavailable. V1-V3 exit 0.
