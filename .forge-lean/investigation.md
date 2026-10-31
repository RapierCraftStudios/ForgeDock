**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: medium (the prod-watch pieces #4833/#4834/#4835/#4837 exist but nothing runs them; no CLI, no docs)
**Task Type**: feature

### What Was Claimed
Add `bin/lean/prodwatch.mjs` and the CLI `forgedock prod-watch run [--once] [--dry-run] | status`: parse `forge.yaml` `prod_watch:`, poll loop sources -> triage -> governor -> file issues (with `signal_ref` and the `target_watch` label) -> verify -> metrics; one `io.llm` call per new cluster (counts against the cost cap); kill-switch file; `--dry-run` makes no writes; human-only actions go into a daily owner digest; only P0 incidents page; wire `bin/forgedock.mjs`; write `docs/PROD-WATCH.md` and a `prod_watch` section in `docs/CONFIG.md`.

### What We Found
- No `bin/lean/prodwatch.mjs`, no `docs/PROD-WATCH.md`, no `prod_watch` in `docs/CONFIG.md` (`ls bin/lean | grep prodwatch` lists sources, triage, governor, metrics + tests only).
- Building blocks already merged: `parseSources`/`runAdapter`/`closeSignal` (`bin/lean/prodwatch-sources.mjs:44,114,152`); `cluster`/`classifyCluster`/`validateCluster`/`tallyClusters`/`signalRef`/`parseAlertRules` (`bin/lean/prodwatch-triage.mjs:35,49,72,90,103,123`); `admit` (`bin/lean/prodwatch-governor.mjs:29`, caps `max_issues_per_hour`, `max_open_prod_issues`, `max_cost_usd_per_round`, `cost_per_issue_usd`); `computeMetrics`/`sourceMode`/`emitMetrics` (`bin/lean/prodwatch-metrics.mjs:24,55,63`). #4836 (verification loop) is CLOSED as invalid, so there is no verify module: the verify step must be implemented here (or reduced to a documented gap, see Recommendation).
- Pattern to copy: `bin/lean/issuewatch.mjs`: `scalar` flow-map parser (:30), 3-level forge.yaml parse (`parseWatches`:41, because `parseForgeYaml` reads one nested level), `acquireLock`:182, `watchDir`:176, `runWatch`:310, `formatStatus`:301, `issueWatchFromCli`:355 (injectable `deps.io/cwd/env/print`), `loadPolicy` import from decision-engine.mjs:47.
- CLI wiring points in `bin/forgedock.mjs`: usage line :3362, known-commands list :3949, dispatch `case "issue-watch"` :4210 (dynamic import + try/catch).
- `docs/CONFIG.md` `issue_watch` section at :627 is the template for the new section; file is 2020 lines (hotspot).
- `target_watch` (#4765) selects the label; `validateWatch` in issuewatch.mjs:63 is the reference for what a watch selects.

### Root Cause
Missing feature: the orchestrating module and CLI of #4768 were never written; the four component modules are unwired.

### Affected Files
- bin/lean/prodwatch.mjs (new; all logic)
- bin/lean/prodwatch.test.mjs (new; injected io fixtures)
- bin/forgedock.mjs (wiring only: usage line, known-commands entry, dispatch case; hotspot, 4488 lines, keep < 150 added)
- docs/PROD-WATCH.md (new)
- docs/CONFIG.md (new `prod_watch` section, keep < 150 added lines; hotspot)
- devdocs/modules/lean.md (dossier line for prodwatch.mjs)
- Enumerating tests (literal sibling lists; prodwatch-* files are already non-members, so a new `prodwatch.mjs` is a non-member too): bin/lean/lean.test.mjs:66, bin/engine/telemetry-seam.test.mjs:24, bin/lean/batch.test.mjs, checks.test.mjs, conformance.e2e.test.mjs, conformance.test.mjs, context.test.mjs, drift.test.mjs, execution.e2e.test.mjs, execution.test.mjs, fixround.test.mjs. None should need edits; the validate runs them to confirm.

### Sibling Sweep
Same class (orchestrator + CLI over pure modules): `bin/lean/issuewatch.mjs` + `issuewatch-release.mjs` are the only precedents; all four prodwatch-* modules take injected `io`. Any docs-listing or usage-list tests that scan `bin/forgedock.mjs` usage will be run in validate.

### History
Parent #4768; components #4833 (sources), #4834 (triage), #4835 (governor, merged at 5aaaacaea), #4837 (metrics). #4836 closed invalid. Issue-watch precedent #4765/#4767.

### Recommendation
Implement in a new module with pure functions and injected `io` (exec/gh/llm/now/emit/fs), `forgedock.mjs` getting only wiring.
- `parseProdWatch(raw)`: 3-level parse of `prod_watch:` (poll_minutes, sources, deployed_probe, governor, target_watch, kill_switch path, alert_channel) reusing `parseSources` for sources; throw on unknown keys.
- `roundOnce({cfg, io, state, dryRun})`: kill-switch check (file exists -> no-op, report) -> `runAdapter` per source (skip sources `sourceMode` puts in shadow) -> `cluster` vs open prod issues -> `classifyCluster` rules from `loadPolicy` via `parseAlertRules` -> `validateCluster` -> `tallyClusters` -> `admit` -> per admitted cluster ONE `io.llm` call (hypothesis + body), cost added to round cost and fed to governor as `cluster.cost_usd`; body embeds `signalRef(fp)` -> `io.gh` issue create with the `target_watch` label; the governor's summary issue filed once. `--dry-run`: no gh writes, no llm writes, no state writes; prints the would-file set.
- Human-only actions (cluster `owner` set and class needing a human, or `closeSignal` not permitted) are never executed; collected into one digest issue/comment per day (state keyed by UTC date). Only `severity P0` + `incident` calls `io.page` through `cfg.alert_channel`; nothing else.
- Verify step: after filing, a minimal deterministic check using `deployed_probe` (read-only command via io.exec) posts a `FORGE:VERIFIED`-style comment when the signal stays gone; reopen-on-ineffective is out of scope (#4836 invalid) and is recorded as a deferral, not silently dropped.
- Metrics: `computeMetrics` over issue rows, `sourceMode` gating, `emitMetrics` via `io.emit`.
- `prodWatchFromCli(argv, deps)` mirrors `issueWatchFromCli` (`run [--once] [--dry-run] [--interval]`, `status`), with lock + `status.json` under `watchDir`-style dir; wire it in forgedock.mjs.
- Docs: `docs/PROD-WATCH.md` (flow, kill-switch, digest, paging, dry-run) and a concise `prod_watch` table in CONFIG.md.

### Related Issues
#4768 (parent), #4833, #4834, #4835, #4836 (closed invalid), #4837, #4765, #4767, #1347.
