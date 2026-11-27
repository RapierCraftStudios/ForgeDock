# 6117: the sandbox run log is copied before teardown; probes keep system dirs on PATH

Status: accepted (2026-11-27). Issue: #6117.

## Problem

1. A remote lane's run log (`~/.forge/runs/<repo>__<n>.jsonl`: REMOTE_PROVISIONED, REMOTE_TOOLS_GENERIC, preflight probes) lived only inside the sandbox. The dispatcher merged it only when the lane wrote a result, and the lane log was pulled one 256 KB chunk per poll. Any path that ended without a result, or with a log longer than one chunk, lost the evidence at `DELETE /sandboxes/:id`, so env parks could not be triaged.
2. A lane parked `env.tool_missing` "Remote sandbox lacks bash" while the sandbox had `/usr/bin/bash`. The freeze-time probe runs `spawn("bash", ["-c", "command -v -- <tool>"])` with the lane env, whose PATH holds only toolchain pins. Node resolves `bash` through that PATH, so the spawn failed with ENOENT (rc 127) and the probe blamed the tool.

## Decision

- **Single choke point.** `remoteProvider.teardown(h)` runs `collectEvidence(h)` before `destroy`. Every terminal path (merged, needs-human, engine-error, deferred, no result) ends in `tear()`, so none can skip it. It drains the lane log until empty, fetches `GET /sandboxes/:id/runlog`, writes `lanes/<n>.runlog.jsonl` beside the lane log, merges the events into the host run log (idempotent, existing dedup), and, only when the live log could not be drained, appends the last ~200 lines of the sandbox log to the lane log. It never throws and never blocks the destroy.
- **Agent.** New `GET /sandboxes/:id/runlog` returns `{run_log, tail}`: the run log is copied out of the container with `docker cp` (works on a running or exited container), the tail is the last 200 lines of `lane.log`. On `destroy` the agent keeps the last log, tail, run log and result in memory for `keep_log_s` (default 600 s) and serves `/logs`, `/runlog`, `/result` from it, so a late fetch still works. A restart of the agent drops the copy; that is accepted (best effort, the normal path fetches before destroy).
- **Router.** After a successful DELETE it remembers the placing agent for the same grace period and forwards GET `/logs`, `/result`, `/runlog` for it. Without this the router answers 404 "gone" and the agent's copy would be unreachable.
- **Probe PATH.** `runCheckCommand` (probes and validate commands) appends `/usr/local/bin:/usr/bin:/bin` to the child PATH when missing (`withSystemDirs`). Appended last: a pinned tool still wins, nothing moves. Not applied on Windows.

## Rejected

- Mounting the sandbox runs dir to the agent host: it changes where the engine writes and assumes the lane user is root.
- Fetching only in `fetchResult`: misses the no-result paths, which are the ones that need triage.
- A new bundled module: all changes stay in `bin/pool` and existing modules, so `AGENT_BUNDLE_PATHS` is unchanged.

## Tests

`bin/tests/runlog-teardown-6117.test.mjs`: every terminal path (evidence before destroy, complete lane log, `runlog.jsonl`), undrainable log falls back to the tail, 404 endpoint, late teardown, agent and router grace (including expiry), and the `PATH=/opt/x` bash probe fixture.
