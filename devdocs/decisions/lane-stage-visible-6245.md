---
status: fresh
anchor: bin/lean/stage.mjs
created: 2026-11-28
---

# ADR: a lane's sub-phase is visible from outside (FORGE:STAGE, LANE_STAGE, status lines)

## Context

A lane shows "build" for 10+ minutes while it is in plan, a separate implement session, precheck or a fix round. The status comment, the labels, `orchestrate --status` and `schedd status` could not tell working from stuck (#6245). The real phase events lived only in the sandbox run log.

## Decision

- The phase ledger is the single source of transitions: `createLedger` takes an `onEnter` hook, and `stage.mjs` turns it into (a) a `LANE_STAGE` run-log event and (b) a `FORGE:STAGE` section of the one status comment (`statuscomment.mjs`), with start and last-activity times. The only lean.mjs changes are the hook wiring, a fix-round reason note, and serialising status writes (so a stage edit cannot overwrite a section another post just wrote).
- Writes are throttled to one per 60 s per issue (a transition inside the window goes out at its end); a run-log event only refreshes last-activity, at most every 5 min.
- Remote lanes: `sandbox-remote.mjs status()` reads the sandbox run log at most every 30 s (an endpoint the dispatcher already uses at teardown) and keeps `{stage, round, reason, since, lastEventAt}` on the handle; a change is noted in the lane log and saved to the `running` entry of state.json. Lane-log growth also counts as activity.
- `orchestrate --status <batch>` and `schedd status` print `#N <sub-phase> for Xm (last activity Ys ago)`; a lane in a model phase (plan, contract, implement, fix, review) with no activity for more than `FORGE_LANE_QUIET_MIN` (default 15) minutes gets ` quiet`. Informational only: nothing acts on it.

## Consequences

- Local (non-sandbox) lanes show the stage in the issue comment and run log but not in the dispatcher status lines; they have no remote log to drain.
- The stage line is last written at the final transition; it is not cleared at lane end (the outcome comments carry the result).
- Rejected: a per-event status edit (API cost), and a new `stuck` action on quiet (stays a signal until measured).
