---
issue: 4580
status: fresh
anchor: bin/hooks/reread-nudge.mjs
created: 2026-10-25
---

# Decision: a deterministic re-read guard, and calls/turn retired as a gate

## Context

#4491 measured both #4410/#4456 targets after v1.32.0 and found them unmet (`4491-efficiency-ab.md`): builder calls/turn
p50 stayed 1.00 (p90 1.08) and re-reads per merge did not drop even though the advisory nudge fires.

## Decision

- **Calls/turn p50 > 1.5 is retired as a gate.** Whether two tool calls are independent is a judgment; no script can
  enforce batching, and the prompt rule was measured not to move it. The metric stays informational in
  `stats --efficiency`. Success is judged on turns/merge and implement wall.
- **Re-reads get a PreToolUse guard.** `bin/hooks/reread-nudge.mjs` also denies a full-file `Read` of a path already read
  twice whose mtime has not changed. A ranged read (offset/limit) and Bash always pass, so the builder is never stuck, and
  every error allows. A changed mtime resets the path's count. `rereadNudgeFlags` registers it on `PreToolUse` `Read`.

## Judging it

`forgedock stats --efficiency --compare v1.32.0 --offline --repo <r>`: `rereads_per_merge` should fall on batches after
this change ships.
