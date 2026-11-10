---
issue: 5341
status: fresh
anchor: scripts/bench-feature.mjs
created: 2026-11-10
---

# ADR: feature-level scoreboard and benchmark

## Context

Every stat and benchmark graded one issue, so features looked as good as fixes while the assembled milestones arrived with dozens of defects.

## Decision

`forgedock stats --milestone` builds a scoreboard per milestone (`bin/stats/scoreboard.mjs`) from GitHub and run logs, reusing the #5336 FORGE:ACCEPTANCE records for journey status. `scripts/bench-feature.mjs` grades a `full` and a bare `control` arm on a spec with hidden journey tests (`docs/eval/feature-specs/`). The promotion gate is a predicate (`scoreboardGate`) plus the `aggregate` exit code, not a new flag.

## Consequences

Missing signals print n/a. Hand PRs and defect classes are read from head-branch names and labels, so a repo that does not use those conventions under-reports them. Real arm runs are manual and not part of CI; baselines for other repos come from running the stats command on the host.
