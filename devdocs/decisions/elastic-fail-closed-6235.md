---
status: fresh
anchor: bin/pool/agent.mjs
created: 2026-11-28
---

# ADR: elastic admission fails closed on heavy-step gating (#6235)

## Context

Elastic lane admission is the default (#6204): a lane is charged its measured base (about 0.4 cpu / 0.3 GB), and the memory safety rests on heavy steps (installs, test suites, builds) leasing a token from the pool agent (#6047). Three gaps let that overcommit the host. The remote backend failed open on any agent error or timeout, so a step ran with no lease. A lane whose image predates the remote backend (mixed rollout) never leases anything yet was still charged only its base. And nothing stopped granting tokens while host memory was already under the floor.

## Decision

1. `acquireRemote` (`bin/lean/heavy.mjs`) fails closed. An unreachable or erroring agent is retried with exponential backoff (2 s to 15 s) for `errorBudgetMs` (120 s); that budget, or a wait past `max_wait_s`, returns `{denied: true, reason}` (no `failOpen`). `runWrapped` then does not run the step: it exits 75 (EX_TEMPFAIL) with a one-line reason, so the caller defers or retries. `FORGE_HEAVY_FAIL_OPEN=1` is the explicit operator escape hatch.
2. The agent charges the elastic base only to a lane whose image carries the remote heavy backend. At launch it reads the image's `org.opencontainers.image.version` label (the engine version, inherited by tools and project-layer images) and requires 1.72.0 or newer (`HEAVY_REMOTE_MIN`). An older, missing or unparseable label means the lane is charged what it asked for (worst-case) and gets no `CS_HEAVY_BASE`. The result is stored as `rec.heavyRemote`; records from before the field count as false, so the first agent restart is conservative.
3. `heavyAcquire` refuses a new lease while host memory is under the floor (`hostMemView().host_mem_low`, the #5967 gate: `host_mem_floor_gb`, default 4). The reply is `granted: false, reason: "host_mem"` with `retry_after_s`; a lane that already holds a token is not cut off mid-step. This applies to the first holder too, which is otherwise always admitted.

## Rejected

- Running a denied step in the local file semaphore: it is per container, so it does not bound host memory.
- Charging worst-case after the fact when a step runs ungated: a lane's charge is fixed at admission and cannot be raised under it.
- Detecting the old image by probing the lane at runtime: a label read is free, deterministic and works before the lane starts.
- Treating an unknown image version as capable: that is the fail-open this ADR removes.
