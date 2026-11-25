forge-stamp: issue=5978 contract=-
**Verdict**: CONFIRMED
**Confidence**: medium
**Severity**: medium (operator toil; large batches silently stall)
**Task Type**: feature

### What Was Claimed
`forgedock orchestrate` freezes its issue list: no selector reconcile (`--select`), ended-deferred/held/engine-error/env-held/conformance-failed issues are not re-admitted automatically, the breaker needs a human, staging-lane merges leave issues open, and there is no coverage `--status`.

### What We Found
- No `--select` / `--status` in the orchestrate CLI: `bin/engine-cli.mjs:1399` (ORCH_USAGE) lists only --add/--requeue/--hold/--pause/--clear-breaker etc.
- Admission is a frozen set plus operator-fed `--add`/`--requeue` files: `bin/lean/orchestrate.mjs:339` (getAdded/getRequeued seams), `:491` (requeueApplied).
- Only typed deferrals and transient engine errors are retried with backoff (`orchestrate.mjs:25`, `:199`, `:261`); `HOLD_ROOT` (`:151`) lists held/deferred/engine-error as terminal roots.
- Breaker trips at `orchestrate.mjs:854-860` and is cleared only by `--clear-breaker` (`bin/lean/clear-breaker.mjs`); no auto-reset.
- env.* issues are filed per signature (`orchestrate.mjs:369` envSigs) but not added to the batch.
- `postdeploy_rollup` exists only in issue-watch (`bin/lean/issuewatch*.mjs`), not in orchestrate.
- Batch state/health helpers: `bin/lean/batch.mjs`, `batch-health.mjs`, `schedd.mjs` (host for a reconcile tick).

### Root Cause
The orchestrator was designed as a one-shot DAG over a fixed list; continuous ownership (selector, re-admission policy, breaker auto-reset, coverage reporting) lives in a separate watcher (issue-watch) or with the operator.

### Affected Files
- `bin/lean/orchestrate.mjs` (reconcile tick, re-admission, env.* join, breaker auto-reset, lane-merge close)
- `bin/lean/batch.mjs` (persist selector, status coverage computation)
- `bin/engine-cli.mjs` (`--select`, `--status`, usage)
- `bin/lean/clear-breaker.mjs` (auto-reset signature check)
- `bin/lean/schedd.mjs` (host reconcile interval)
- `bin/lean/batch-health.mjs` (coverage/status input, optional)
- docs: `commands/orchestrate.md`, `bin/help-text.mjs`

### Sibling Sweep
issue-watch (`bin/lean/issuewatch.mjs`, `issuewatch-decisions.mjs`) has selector and rollup logic that should be reused, not duplicated. `--add` path (`engine-cli.mjs:1457`, `:1736`, `:1868`) is the existing admission entry the reconcile should feed.

### History
Related prior work: #4550 (--requeue), #4765 (issue-watch watches), #5933/#5938/#5947 (pool/breaker classes), #5964 (--clear-breaker), #5966 (schedd handover), #5975 (batch pause). Two earlier lane attempts on this issue were interrupted (no result).

### Recommendation
Implement in one lane as an ordered checklist: (1) selector persisted in batch + `--select`; (2) reconcile tick via schedd feeding the existing add path (join/leave); (3) re-admission policies (deferred backoff cap 2h, held on agent/lane-image version change or 6h cooldown, conformance one retry after base moves, needs-decision digest); (4) env.* join; (5) breaker auto-reset for environmental signatures with FORGE:DECISION; (6) staging-lane close on merge + rollup; (7) `--status` coverage with 0 unscheduled. R10 and R17 are deferred.

### Related Issues
#4550, #4765, #5933, #5938, #5947, #5964, #5966, #5967, #5975.

### Test plan
Tests (node --test, targeted): selector join within one reconcile interval (R13); deferred/held/engine-error re-admission without operator command (R14); env.* issue joins order (R15); `--status` reports 0 unscheduled with only human-coded outside running/queued/backoff (R16); breaker auto-reset on environmental signature; staging-lane close on merge. New tests in `bin/lean/orchestrate-reconcile.test.mjs`, extending `batch.test.mjs`.
