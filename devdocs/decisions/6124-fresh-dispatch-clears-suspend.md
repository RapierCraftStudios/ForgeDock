# 6124: a fresh dispatch clears a stale kept-for-adopt suspend marker

A lane kept for adopt gets a `suspend` marker on its FORGE:STATE (#6008), so it refuses push/merge until a dispatcher adopts it.
The marker was cleared only on adopt. A lane relaunched fresh kept the marker and refused its own push (`lane.suspended`)
on every attempt, until the batch gave up after its deferral budget.

`providerLanes.runOne` (`bin/lean/execution.mjs`) now calls `resumeKept` before it starts the sandbox: the dispatcher that
launches the lane owns it. The clear is best effort; a failure does not stop the lane.
