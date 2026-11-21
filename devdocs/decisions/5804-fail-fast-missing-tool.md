---
status: fresh
anchor: bin/lean/lean.mjs
created: 2026-11-21
---

# ADR: a lane whose install tool is missing ends before the builder

## Context

Dependency installs overlap the plan session (#5434), so a `DEPS_PREPARED failed: tool not found` result was only read at the validate gate. A lane on a host without the package manager ran its plan and implement sessions for 10 to 15 minutes, then ended `env.tool_missing` for the same cause. That spend was knowable at setup.

## Decision

- `toolMissingInstalls()` in `bin/lean/preflight.mjs` picks the failed install rows that could not start: depcache's `tool not found: ...` (ENOENT) reason, or a row coded `env.tool_missing` (#5651). It names the binary from `spawn <tool> ENOENT`, or the ecosystem if there is none. It is scoped to what the change may need: the root (primary) install always counts, but a sub-project install (`dir` other than `.`) counts only when an issue-named path or a frozen deliverable falls under that dir.
- Before the first session, the lane waits for the install result inside the existing `contextWaitSeconds` bound (counted from the hotspot wait, so most of it overlaps work already running). If a row matches, the lane ends `needs-human env.tool_missing` with no builder session.
- An install that settles later is checked by `gateBuild()` (`gateSetup()` plus the same stop) before the light build, after the plan, and before a resumed lane implements. Only the plan session is spent.
- The evidence uses the validate-time wording (`the host is missing <tool>, so validate command(s) could not run`), so orchestrate's `toolsOf` recovery classification (same tools, same host) is unchanged.
- A declared test-plan env on a frozen contract (resume or recovery) is already probed and provisioned before any session. On a fresh lane the contract only exists after the plan session, so that probe still runs before implement.
- Install failures that are not tool-not-found, and tool-not-found installs of a sub-project the change is not placed in, keep the #5447 behaviour: they're logged, the lane continues, and the gate judges them against the changed files.

## Consequences

- No implement spend on a host that lacks the install tool. A fast ENOENT costs no session at all.
- A tool-not-found root install now ends the lane even if the change turns out to need no dependencies; the primary toolchain is assumed to be needed. A sub-project install ends it early only when the issue names a path in it or the frozen deliverables include one.
- On a cache-miss install, the plan can start up to `contextWaitSeconds` later. In practice the hotspot and context-pack waits already use most of that bound.
