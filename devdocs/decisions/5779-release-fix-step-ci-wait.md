---
status: fresh
anchor: bin/lean/release-review.mjs
created: 2026-11-21
---

# ADR: the release fix step never idles on a CI run that does not complete

## Context

After a BLOCK DEPLOY review the job went idle and never filed the fix issue (#5779). Root cause: `realSeam.failedJobs` polled `gh run list --commit <head>` in a 60 x 60 s `setTimeout` loop until every run completed. A stale run stuck `in_progress` on a shared sha held the fix step for an hour with no output.

## Decision

- `failedJobs({head, wait})` waits at most `CI_WAIT_MS` (10 min), polling every `CI_POLL_MS` (60 s), and prints a `waiting on N CI run(s)` line per poll and a `going on without them` line at the deadline. It returns the completed jobs plus `.pending` (names of unfinished runs).
- `fixStep` passes `wait: false` when the review has blocking findings: the fix issue and lane start at once, and the lane's own CI re-runs every check.
- With no finding and only pending runs, the step blocks with `required checks ... still running`, which exits blocked (not silent).
- `realSeam` takes optional `io {sleep, now, print}` (the release io); runs are not filtered by branch or event, since release heads can share the staging sha.

## Consequences

Fail-late batching (#5567) holds for the red-CI-only case, bounded to 10 min.
