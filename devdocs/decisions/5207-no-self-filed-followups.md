# 5207: the pipeline stops filing its own engineering follow-ups

Lanes deferred work they could do themselves (`new-issue`, unbucketed `engineering` rows) and the engine filed it as
per-parent `follow-up:` issues and, since #5188, a per-batch backlog. Those issues made up a large share of new issues
and were rarely picked up. Builds on #4149 (deferred follow-ups), #4664 (one issue per class), #5078 (routing by kind),
#5188 (the backlog aggregate) and #5197 (one routing source).

## Policy
- Engineering and `new-issue` deferrals are not allowed. `inLaneDeferral` (`bin/lean/conformance.mjs`) is true for a
  defer/post-deploy row whose `followupClass` is `engineering` (bucket `new-issue`, or no bucket and no out-of-lane class).
  `decide()` emits `conformance.unjustified_deferral` for it whatever the reviewer's `deferral_ok` says, once per row, and
  the existing one-shot builder resume delivers it. `SHADOW_BLOCKS` includes the code, so this holds in shadow mode too.
- `bucketProblems` still accepts `new-issue`: in-flight frozen contracts stay valid, and the rejection happens at review.
- `pendingTracking` never files an in-lane deferral; `scripts/file-deferred-followups.sh` rejects an engineering or
  backlog row (exit 2, `DEFERRED_TSV=INVALID`, nothing filed) as a safety net.

## Sinks
Only aggregates are filed, never a per-parent issue:
- post-deploy, `verify-now`, `date`, `owner:orchestrator`, `owner:promote:*` and post-promotion text: the release rollup
  (`FORGE:POSTDEPLOY_ROLLUP: <lane>`).
- external and ops: the batch external aggregate (`FORGE:EXTERNAL_BATCH: <batch>`, `needs-human`). The engine's own
  carries (a degraded review re-run, an unanswered investigation question) are class `ops`.
- host (read-only production data or capture, needed before promotion): the batch host aggregate
  (`FORGE:HOST_BATCH: <batch>`, `followup:host` + `host-task`, never `needs-human`).

The backlog class and `FORGE:BACKLOG_BATCH` are removed. Existing per-parent follow-ups are not migrated: the script never
reads, edits, reopens or closes them, and `prefilter.mjs` / `review-finalize.sh` keep handling them.

## Measure
`forgedock stats --self-filed [--repo R] [--since D]` (`bin/stats/selffiled.mjs`) reports the share of new issues the
pipeline filed, by kind (follow-up, review-finding, staging-review, rollup), from the markers and labels the pipeline
writes, never from the author (lane-created issues share the bot author). Target: under 15%. Unreadable gh output is an
error, never 0%.

## Rejected
- Rejecting `new-issue` in `bucketProblems` at freeze: invalidates frozen contracts of in-flight lanes.
- Keeping the backlog aggregate: it is the same unbuilt work in one issue instead of many.
- Host items in the external aggregate: that aggregate is `needs-human`, which #5078 keeps off host tasks.
- Closing or folding the existing per-parent follow-ups: a migration the issue rules out.
