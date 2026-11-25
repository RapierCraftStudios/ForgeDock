forge-stamp: issue=5990 contract=-
**Verdict**: CONFIRMED
**Confidence**: medium
**Severity**: medium (availability/perf: dispatch stalls and false lane deferrals on a loaded host)
**Task Type**: bug

### What Was Claimed
The schedd dispatcher reads GitHub with one `gh` subprocess per issue (milestone, state, labels, comments), with no shared cache or batching. On a 4-thread host this stalls the event loop. A transient network error on a milestone read becomes `lane.unresolved`, a lane-level requeue, instead of serving cached data.

### What We Found
- `bin/lean/lane.mjs:81-84`: `resolveLane` runs `gh issue view N --json milestone` per issue when no pre-read milestone is passed. Any failure becomes `transient()` with `lane.unresolved` (line 77). There is no network-vs-lane distinction, no retry and no cache.
- `bin/engine-cli.mjs:2075-2077`: the pre-read milestone is consumed once (`milestoneOf.delete`), so every retry re-reads live.
- `bin/engine-cli.mjs:2227` (`labelNames`) and `:2358` (`viewOf`): per-issue `gh issue view` with no TTL or ETag.
- `bin/lean/orchestrate.mjs:1035,1217,1853`: per-issue `issueLabels`; `:1871` runs `watchHeldRoots` every `WATCH_EVERY_MS` (`:175`, 60 s), each tick spawning `gh` per held root and per blocker via `makeDispatchCheck` (`engine-cli.mjs:2428,2565`).
- `bin/lean/orchestrate.mjs:1323,1332`: a transient `lane.unresolved` goes through `retryLane` with backoff, so each issue pays the requeue delay.
- `bin/lean/effects.mjs:495`: `gh: run("gh")` is a bare spawn with no nice, no budget and no shared client. `makeGhCache` (`effects.mjs:461`) only isolates the gh config cache per run.
- `bin/engine/outcome-codes.mjs:43`: `GH_UNAVAILABLE` exists but is only used for the `--repo` identity check.
- `bin/lean/gh-reader.mjs` does not exist at the base ref.

### Root Cause
The dispatcher's read path has no shared GitHub client. Reads are per-issue `gh` spawns from several loops, with no cache or batching. Every failure is mapped to a lane problem (`lane.unresolved`), even when GitHub is simply unreachable.

### Affected Files
- `bin/lean/gh-reader.mjs` (new: batched GraphQL read client, TTL cache serving last good value, `isNetworkError`, spawn counter and budget, nice)
- `bin/lean/lane.mjs` (milestone read through the reader; network error becomes `gh.unavailable`, not `lane.unresolved`)
- `bin/engine-cli.mjs` (wire the reader into `labelNames`, `viewOf`, `milestoneOf`, `makeDispatchCheck`)
- `bin/lean/orchestrate.mjs` (held-root watcher and retry path use the cached reads; treat gh-unavailable as an uncapped 60 s deferral)
- `bin/lean/effects.mjs` (nice wrapper for the read `gh`)

### Sibling Sweep
- `bin/lean/lean.mjs:411` lane-start reads already use the per-run gh cache, so they are out of scope.
- review-staging has the same N+1 pattern (#4760, closed invalid); not touched here.
- `gh api .../comments --paginate` calls in the dispatcher path should go through the reader's comment count and updatedAt.

### History
- Related fixes: #4780 (schedd responsiveness), #5531 (event-loop stalls), #5966 (watchdog), #4791 (lane.unresolved transient retry), #4157 (`gh.unavailable`). None batches the reads.

### Recommendation
Add `bin/lean/gh-reader.mjs` with one GraphQL query per refresh, chunked, plus a TTL cache that serves the last good value. Route lane resolution, label/view reads and the held-root watcher through it. Map network errors to `gh.unavailable` (uncapped, 60 s). Spawn `gh` under nice and log a per-pass spawn budget. Defer the optional `dispatcher_host` placement (R4) and the ledger measurement (R8).

### Related Issues
#5966, #4780, #4760, #5945, #5531.

### Test plan
- Unit test with an injected `io.gh`: a pass over 200 issues makes at most 2 GraphQL calls and 0 per-issue spawns when nothing changed.
- Unit test: `io.gh` fails with a network error for the simulated 15 minutes (fake clock); no `lane.unresolved` result, the cached milestone is used, and no admission is lost.
- Unit test: `isNetworkError` classification; a spawn-budget log line.
- Run `node --test` on the new reader test and the existing lane and orchestrate tests only.
