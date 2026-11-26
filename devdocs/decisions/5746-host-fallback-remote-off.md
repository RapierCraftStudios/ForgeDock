# 5746: host fallback is off by default in remote mode

`hostFallbackAllowed` (`bin/lean/execution.mjs`): explicit `execution.host_fallback` wins, else off when `host.role` is `orchestrator`, else off in `mode: remote`, else on (hybrid/local). `fallback_local` alone no longer opens the host in remote mode.

With it off, orchestrate (`bin/lean/orchestrate.mjs`) retries the #5371 mechanical recovery, a lacked tool and a placement error remotely (fresh sandbox), skips the offline/capacity/max_remote/budget local fallbacks, and holds admissions while `max_remote` is 0 (pinned or live) logging `waiting: max_remote 0`. `liveRemote.place` returns `{where: remote, hold: true}` with reason `max_remote 0 (live override)`. `capDefers` resets on a remote admission and a host-busy refusal is not counted.

A live `max_remote` below the pinned value for longer than `FORGEDOCK_MAX_REMOTE_WARN_HOURS` (default 6) logs one batch WARNING.
