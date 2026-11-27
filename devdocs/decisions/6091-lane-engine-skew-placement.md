# 6091: lane engine version skew

Lanes run the engine from the pool host's lane image, so hosts on different agent versions ran different engines.

- Router (`bin/pool/router.mjs`) orders agents whose engine matches its own version first in launch/seed/claim; lower-engine agents stay a fallback.
- Optional `execution.min_lane_engine` (forge.yaml) is passed in the launch spec by `bin/lean/sandbox-remote.mjs`; if no agent meets it the router answers 503 `pool.engine_old` (a deferral).
- `sandbox-remote.mjs` keeps the placed agent's engine on the result (`engineVersion`); `orchestrate.mjs` keeps it on the row, so the ran version is recorded.
- Lanes held on `env.engine_skew` are re-admitted by the engine of the agent that will run them (`envHold.agentVersion`), not the orchestrator's.
- `pool status` shows ENGINE with a SKEW flag; `pool upgrade` names agents left behind.
