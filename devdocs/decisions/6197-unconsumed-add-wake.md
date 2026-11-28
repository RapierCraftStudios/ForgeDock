# 6197: an --add/--requeue to an idle or all-held batch must not strand

- The runner's idle wake is capped to pollMs when getAdded/getRequeued is set and issues are pending (orchestrate.mjs). Polling, not fs.watch.
- schedd watchPass treats an add/requeue unconsumed for over 60 s (UNRUN_STALE_MS) as a stall. An unhosted batch, reported ones included, is re-hosted at most once per window. A hosted one gets a stall alert. Cancelled and breaker-tripped batches are skipped.
- `rehostUnrun` stays one-shot per signature for younger adds.
