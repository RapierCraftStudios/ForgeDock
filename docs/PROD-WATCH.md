# Prod-watch

`forgedock prod-watch` is the production-side watcher (#4768). It polls read-only signal sources, triages them, and files deduplicated, rate-limited issues that the normal lanes (or an [issue-watch](ISSUE-WATCH.md) watch) pick up. It never writes to production.

```
npx forgedock prod-watch run [--repo owner/repo] [--once] [--interval <s>] [--dry-run]
npx forgedock prod-watch status [--repo owner/repo]
```

Config lives in `forge.yaml` under `prod_watch:` (see [CONFIG.md](CONFIG.md#prod_watch-optional)).

## One round

1. **Kill switch.** If the `kill_switch` file exists (default `.forge/prod-watch.off`; a relative path is resolved under the working directory, an absolute path is used as given), the round does nothing. A running loop idles and resumes when the file is removed.
2. **Sources.** Each `prod_watch.sources` entry runs only its declared `list`/`read`/`run` commands (memo, Alertmanager, SQL, Prometheus) and yields normalised signals. `close` is never used by the loop.
3. **Triage.** Signals are fingerprinted and clustered, deduplicated against open prod-watch issues (each embeds `<!-- FORGE:SIGNAL_REF fp=<fp> -->`), classified from the repo's `Alert rules:` list (then built-in defaults) and validated by re-running the declared queries. A cluster without reproduced evidence is not fileable; expected-class is counted, never filed.
4. **Governor.** `max_issues_per_hour`, `max_open_prod_issues` and `max_cost_usd_per_round` bound the round (incidents before defects). Overflow becomes ONE storm-summary issue: later rounds edit the open summary instead of filing another, it does not count toward `max_open_prod_issues`, and it is closed only once a round defers nothing for any reason (a cluster held back by the cost cap keeps it open).

   **Markers are trailer-only.** The engine writes its `FORGE:` markers (`SIGNAL_REF`, `PRODWATCH`, the summary tag) as the last lines of a body, and later rounds trust only that trailing run. Signal text copied into an issue body, an LLM prompt or the digest has `<!--` escaped to `&lt;!--`, so a signal cannot forge a marker to hide, dedup-break, edit or close a prod issue.
5. **File.** One LLM call per admitted cluster (`io.llm`) writes the root-cause hypothesis and body. Its cost (read from `claude --print --output-format json`) counts against `max_cost_usd_per_round`. A call that reports no cost is charged `cost_per_issue_usd`, or the whole cap when that is unset; once spent, the remaining clusters wait for the next round. The issue carries the SIGNAL_REF, a `FORGE:PRODWATCH source=<name>` marker and the label chosen by `target_watch`.
6. **Verify.** For fixed (closed, completed) prod-watch issues, once `deployed_probe` exits 0 and the signal no longer appears, the loop comments `FORGE:VERIFIED`. A signal that persists is reported in the round errors and the issue is not verified. Reopen-on-ineffective is not automated (#4836 was closed as invalid).
7. **Metrics.** Per-source rates are computed from the prod-watch issues on GitHub (`computeMetrics`) and emitted as `PRODWATCH_METRICS`. A source whose false-positive rate is above the cap over the minimum sample drops to shadow: triaged and counted, nothing filed.

## Safety rules

- **Dry run.** `--dry-run` runs one round and prints what it would file. It makes no GitHub write, no LLM call, no page, and no state, lock or metrics write.
- **No blind filing.** If the issue list cannot be read, nothing is filed. Open issues are listed in full (paginated), closed ones only as a recent window for metrics and verify.
- **Human-only actions** (the classes in the repo's decisions policy, `decisions.human_only`) are never taken or filed. They are collected into one owner digest issue per UTC day, created on the first item and edited as more arrive.
- **Paging.** Only a P0 incident pages, once per cluster, through `alert_channel` (a command that receives the title and body on stdin). Nothing else pages.
- **State.** `~/.forge/watch/<repo>/prod-watch/` (or `FORGEDOCK_WATCH_DIR`) holds a lock, `status.json` and a rebuildable `state.json`; GitHub is the register.

## Governor keys and signal-planner

`max_cost_usd_per_round` is signal-planner's `governor.max_cost_usd` applied per poll round; `max_issues_per_hour` is a rolling-hour rate where `governor.max_issues_per_run` is per run; `max_open_prod_issues` has no planner equivalent. A missing key is unlimited. `cost_per_issue_usd` is the cost estimate the governor uses before the real LLM cost is known.
