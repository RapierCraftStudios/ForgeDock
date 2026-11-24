---
status: fresh
anchor: bin/lean/release.mjs
created: 2026-11-24
---

# ADR: `release --merge` refuses visibly and never shows an older record

## Context

#5848: `release --merge --watch` was routed to the status loop, so it printed the newest stored record (an older refused one) and exited 0 without starting anything.

## Decision

- `--watch` delegates to the status loop only without `--merge`; bare `release --watch` stays a status loop (#5554).
- A managed start with no valid `.forge/release.yaml` (and not `--resume`) prints `release: refused: no valid .forge/release.yaml on the default branch (run release check-config)` and exits 1, the same reason as `release plan`.
- After a start with `--watch` that did not finish `done`/refuse/block, the loop watches the id this start created, never the newest stored record.
