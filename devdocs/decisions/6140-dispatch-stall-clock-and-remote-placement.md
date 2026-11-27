# Stall clock follows operator input; remote mode never places on the host

Dispatch stall (#6140). `evaluateDispatchStall` measured idle time from the newest mtime of `state.json` / `log.jsonl`. A batch whose
remaining issues were all held writes neither, so releasing a hold after hours made the issues "ready" with hours of idle behind them,
and the stall recovery restarted the hosting schedd at once (a false positive that stops every hosted batch). The schedd now uses
`batch.lastDispatchClockMs()`: the newer of the last progress and the last operator input that can make an issue ready (`hold`,
`hold-info`, `requeue`, `add`, `parallel`, `execution`, `gates`, an unpause marker, `clear-breaker`). Real stalls are unaffected: with no
operator input the clock is the last progress, as before. The capacity sampler (`bin/lean/capsample.mjs`) refreshes before it throws, so
the first good sample after a failed probe clears `capacity probe failed` (before, one failed probe disabled capacity gating until a restart).

Placement (#5746 follow-up). In `execution.mode: remote` with `host_fallback` not true, no path may place a lane on the host:
`placeOf` rewrites any `local` answer (a host-only `needs` capability from `placeLane`, a host pin, a failed placement) to remote, and
`liveRemote.place` does the same at the source. The one exception is the operator's own live `--set-placement local`, which is not a
fallback. Hybrid mode keeps its light-lane host placement. Every running entry records `placement.where`; a lane admitted without a
recorded placement derives it instead of leaving it blank. Alternative rejected: leaving the host pin alone because the lane then fails
remotely on the missing credential; that is the intended outcome (a needs-human the owner sees) rather than running credentials work on the orchestrator.
The lanes observed running locally ran on 1.67, before the #5746 fix shipped in 1.68.0; the `needs` and host-pin branches above were the
paths still open after it.
