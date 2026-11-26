# 6047: heavy-phase tokens behind pool.elastic_lanes

- Routes are nested per sandbox (`/sandboxes/:id/heavy/*`) like creds/relay so a token dies with its lane.
- The remote client is a mode of `heavy.mjs` (fail-open, local file semaphore as fallback); the pool does not import lean.
- Everything ships default-off; promotion needs the live host measurement (>=2x lanes at equal peak memory, no OOM or wall-time rise).
