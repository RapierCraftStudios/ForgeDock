---
status: fresh
anchor: bin/stats/weekly.mjs
created: 2026-11-28
---

# Quality ledger: per-merge telemetry, queue_wait by cause, escape linker, weekly scorecard (#6203)

Status: accepted. Part of #6199 (lane economics). Every other #6199 change is judged on these numbers.

## Decision

1. **Per-merge record.** At merge, `finishOnce` (bin/lean/lean.mjs) emits one `MERGE_LEDGER` event through the existing FORGE:TELEMETRY
   emitter (same comment, same run log), built by `buildMergeLedger` (bin/stats/quality-ledger.mjs): `first_pass`, `human_touch`,
   `test_files`/`files_changed`, `ci_attempts`/`ci_fix_rounds`, `cost_usd`, `wall_ms_by_phase`, `engine_version`, `model_tier`.
   It reuses facts the lane already holds (builder triggers, CI events, usage, phase ledger). No model call.
   `first_pass` is false after any recovery run, relaunch (attempt > 1), CI fix round or builder rework trigger after the first build.
   `cost_usd` is this run's single total; the scorecard sums distinct runs per lane and de-duplicates the cumulative rows a recovery
   chain writes (a row at or above the previous cost adds the difference; a lower one starts a new run).
2. **queue_wait by cause.** `createQueueClock` (bin/lean/queuecause.mjs) accrues each pending issue's wait per cause
   (hold, pause, capacity, breaker, dependency, host_offline, other) from the first time it is seen pending. A requeue does not reset it,
   and it stops while the issue runs. `orchestrate.mjs` ticks it once per pass with a pure `causeOf` (precedence: pause, breaker, hold,
   dependency, host_offline, capacity, other) and puts `causes` on the row's `phases.queue_wait`. It is saved in batch state.
3. **Escape linker.** `forgedock stats escapes [--days 14] [--repo R]`: gh reads only. For merged lane PRs (branch `feat/issue-N-*`),
   later fix/revert PRs and bug-labelled issues created within 14 days that blame the PR or its issue, plus reopen events. A citation
   blames when the number sits within 100 characters of a causal word (regress, broke, caused, revert, follow-up...), except that a
   fix/revert PR may cite the lane PR directly. A bare mention in a tracker does not count, so the rate is a lower bound.
   Results go to `~/.forge/stats-cache/escapes-<repo>.json`, which the scorecard reads. It is left as a command: nothing in the
   existing schedule mechanisms runs `stats`-shaped GitHub crawls nightly without a new unit, and a nightly run is one cron line.
4. **Weekly scorecard.** `forgedock stats scorecard --weekly [--repo R] [--json]` (bin/stats/weekly.mjs) reads
   `~/.forge/batches/*/log.jsonl`, plan/state, MERGE_LEDGER records in the run logs and the escape cache.

## Degradation on historical data

- Engine version: a merge row's own version, else the batch's "vA -> vB" transition rows, else state.json when the batch ran under a day,
  else `unknown` (a long batch may have straddled an upgrade nobody recorded).
- Queue causes for rows without the live clock are derived from the log: ready = first `added` row or batch creation, minus lane active
  time; gaps take the cause of the row that ended the previous attempt; pause/breaker spans and operator holds override. What the log cannot
  explain stays `other`; only the live clock can tell capacity from other waiting for a first admission.
- first_pass uses the row's `first_pass`; human touches count operator `--requeue`, needs-human label removals and hold placements, and
  the lane's own non-bot issue comments once MERGE_LEDGER exists. Non-merged spend % is spend on issues no batch merged.
- Missing fields print `n/a`, never 0.

## Rejected

- A new nightly service or a model-graded escape check: against NORTHSTAR (deterministic first, no new LLM calls).
- Counting every citation as an escape: measured 33% on 21 days of ForgeDock against 6-7% with the blame rule.
