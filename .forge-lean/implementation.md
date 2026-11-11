forge-stamp: issue=5421 contract=491e16c7e424
### Approach
Add the missing triggers (timer, free disk) and widen gc ownership conservatively. Ownership additions are limited to what ForgeDock provably creates; everything else stays report-only.

### Changes
- bin/gc.mjs: `hygiene.schedule` and `hygiene.min_free_gb` in `readHygiene`; legacy `.forge/worktrees/*` scan (reclaim only when clean, HEAD on a remote, no live process, past TTL); compose project `forgedock-lane-<n>` containers and volumes owned by name; marked top-level `~/.forge/tmp` dirs follow the run-dir rule; `hygieneCheck` warns on low disk and shows owned reclaimable bytes.
- bin/lean/admission.mjs: `diskLow`; `nearCeiling({minFreeGb})` counts disk.
- bin/lean/effects.mjs: `hygienePaths` host probe, `guardHeavyDisk` (gc once, then refuse with `DISK_LOW`), `markOwned` (used for the gh-cache scratch dirs).
- bin/lean/lean.mjs: `heavyAcquire` rethrows `DISK_LOW`; lane env `COMPOSE_PROJECT_NAME=forgedock-lane-<issue>`.
- bin/engine-cli.mjs: `beforeAdmit` passes `hygiene.min_free_gb` to `nearCeiling`.
- bin/gc-schedule.mjs (new): systemd user timer, cron fallback, injectable exec/fs.
- bin/forgedock.mjs: `installHygieneSchedule` from `init` and `doctor --fix`; Check 13 passes free disk.
- bin/lean/prompts.mjs: compose label hint (kept within the token budget).
- docs/CONFIG.md, devdocs/decisions/4180-gc-reaper.md, devdocs/modules/lean.md: documented.
- Tests: bin/tests/gc.test.mjs, bin/tests/gc-schedule.test.mjs (new), bin/lean/lean.test.mjs.

### Acceptance Criteria Status
- R1 ✅ bin/gc-schedule.mjs:34-83, bin/forgedock.mjs (installHygieneSchedule)
- R2 ✅ bin/lean/admission.mjs (nearCeiling, diskLow), bin/engine-cli.mjs beforeAdmit
- R3 ✅ bin/lean/effects.mjs guardHeavyDisk, bin/lean/lean.mjs heavyAcquire
- R4 ✅ bin/lean/effects.mjs markOwned (gh-cache dirs; run tmp already marked), bin/gc.mjs marked-scratch rule. No creator of unmarked `wt-*`/`stg*`/`text-*`/`zero-*` exists in this repo (K1): those stay report-only.
- R5 ✅ COMPOSE_PROJECT_NAME in bin/lean/lean.mjs + gc ownership by project name (K2; a label override file is only prompted, not generated)
- R6 ✅ bin/gc.mjs legacy worktree block
- R7 ✅ bin/gc.mjs hygieneCheck, bin/forgedock.mjs Check 13
- R8 ✅ timer runs `gc --apply` (owned scope); covered by gc.test.mjs apply tests
- R9 ✅ bin/tests/gc-schedule.test.mjs, bin/tests/gc.test.mjs (disk pressure via injected host)
- R10 ✅ gc.test.mjs legacy/foreign volume/unmarked tmp tests

### Verification
- V1 `node --test bin/tests/gc.test.mjs bin/tests/gc-schedule.test.mjs`: pass (new tests fail without the fix: missing exports/behaviour).
- V2 `node --test --test-name-pattern='admission|ceiling|disk' bin/lean/lean.test.mjs`: pass.
- V3 `node --test bin/tests/doctor-verbosity.test.mjs`: pass.
- Full bin/lean/lean.test.mjs: the implement-prompt budget test failed (1855/1700) until the prompt line was shortened; passes now. Other failures in an interrupted run passed when rerun by name.
- `forgedock check`: PASS.
- No repo formatter is configured (no prettier/biome config), so none was run.

### Notes
- New forge.yaml keys: `hygiene.schedule` (default unset: no timer), `hygiene.min_free_gb` (default 5, 0 = off). A default-off schedule needs no activation row.
- Lanes now run with `COMPOSE_PROJECT_NAME=forgedock-lane-<issue>`.
- Heavy steps are refused (DISK_LOW) when disk stays below the threshold after gc.

## Sibling-list check
- gc-schedule vs bin/tests/bench-feature.test.mjs:30: no enumerated list there (fake runner helper); recorded in result.json not_members.
