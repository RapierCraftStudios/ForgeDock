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
