### Approach
New `bin/lean/prodwatch.mjs` composes the merged prod-watch modules (sources, triage, governor, metrics) into one poll round with an injected `io`; `forgedock.mjs` only gets wiring. State is a rebuildable cache; dedup and metrics rows come from GitHub issues.

### Changes
- bin/lean/prodwatch.mjs: `parseProdWatch`, `targetLabel`, `roundOnce`, `prodWatchFromCli`, helpers (`humanOnly`, `metricRows`, `issueBody`, `formatProdWatchStatus`).
- bin/lean/prodwatch.test.mjs: 16 tests with fake io.
- bin/forgedock.mjs: usage line, known-commands entry, `prod-watch` dispatch case (13 lines).
- docs/PROD-WATCH.md: new doc. docs/CONFIG.md: `prod_watch` section (32 lines).
- devdocs/modules/lean.md: dossier sentence.

### Acceptance Criteria Status
- R1 ✅ docs/PROD-WATCH.md:1
- R2 ✅ bin/lean/prodwatch.mjs (`prodWatchFromCli`), bin/forgedock.mjs `case "prod-watch"`
- R3 ✅ bin/lean/prodwatch.mjs `parseProdWatch`
- R4 ✅ bin/lean/prodwatch.mjs `roundOnce`
- R5 ✅ `roundOnce` llm call, cost counted vs `max_cost_usd_per_round` (test "llm cost counts against...")
- R6 ✅ kill-switch check at top of `roundOnce`; dry-run tests
- R7 ✅ `digest()`, P0-incident-only page in `roundOnce`
- R8 ✅ bin/forgedock.mjs usage, KNOWN_COMMANDS, dispatch
- R9 ✅ docs/PROD-WATCH.md, docs/CONFIG.md `prod_watch`

### Verification
- V1 node --test (prodwatch + sources/triage/governor/metrics + issuewatch): 71 pass, 0 fail. The new test file fails without the fix (module does not exist).
- V2 node --test (lean, telemetry-seam, batch, checks, conformance, context, drift, execution, fixround): 832 pass, 0 fail.
- Also bin/tests/forge-utils.test.mjs: 31 pass. `forgedock check`: PASS. checks.mjs widened to the full suite (978 referencing files); not run per host rules.
- No formatter is configured in the repo.

### Notes
- Default kill switch `.forge/prod-watch.off`; default label `prod-watch`; state under `~/.forge/watch/<repo>/prod-watch/` (`FORGEDOCK_WATCH_DIR`).
- Verify step is the deployed_probe check only; reopen-on-ineffective not built (#4836 invalid, decision K2).
- Clusters deferred by the LLM cost cap after admission are reported in the round, not in the governor's storm summary.

### Enumerating-test fix
The ten flagged tests mention bin/lean file stems only as unrelated string literals (fixtures, kinds, paths); none enumerates the bin/lean directory. Recorded `prodwatch` as a non-member for each in result.json `not_members`. No test edits.
- Fix: renamed export formatStatus -> formatProdWatchStatus (collided with issuewatch.mjs).

### CI follow-up (Unit tests job)
The CI log was not available (no GitHub access allowed), so the failure could not be read. Reproduced the job's scope locally at capped concurrency: `bin/lean/**` + `bin/engine/**` (1883 pass, 0 fail), `bin/stats/**` + `packages/protocol/**` (266 pass, 0 fail), `bin/tests/*.test.mjs` (2610 pass, 3 fail). The 3 failures (journey.test.mjs: preflight / forge Act II platform-WSL row; router.test.mjs: writeInstallReceipt copyFile-failure cleanup) are environmental: this host runs as root on WSL2, and the diff touches none of those files. No code change was made.

### CI follow-up 2 (Unit tests job, run 41157197021)
Log unreadable again (no GitHub access). Checked: no commits on origin/staging beyond HEAD; prodwatch tests are stable over 3 repeats and pass under a clean env (`env -i`, no HOME); the 3 local `bin/tests` failures (journey.test.mjs, router.test.mjs) fail identically with `bin/forgedock.mjs` reverted to origin/staging, so they are pre-existing and caused by this root/WSL2 host, not by this change. No code change; needs the failing test names from the CI log to go further.

### CI follow-up 3 (Unit tests job, run 41158849530)
Cause found by running the job's lint steps locally: `scripts/check-test-tmp-cleanup.sh` flagged `bin/lean/prodwatch.test.mjs` for using `mkdtemp` without `bin/tests/_tmp.mjs`. Fixed by using `tmpDir` from the helper. Both lint scripts now pass (18/18); prodwatch + issuewatch tests 71 pass.
