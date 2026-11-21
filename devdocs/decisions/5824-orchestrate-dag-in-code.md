---
status: fresh
anchor: bin/lean/dag.mjs
created: 2026-11-21
---

# ADR: the orchestrate dependency DAG is built in code

## Context

`/orchestrate` ran its lanes from code (`bin/lean/orchestrate.mjs`), and the runner already honoured trusted `Depends on` / `Blocked by` lines through the engine's parser (`parseDependsOn`). But the command spec (`commands/orchestrate.md` §2) still asked the model to build the DAG from prose: read each issue, guess "logical" edges, and print a plan table. The model over-declared edges. Each extra edge held a ready issue back until another lane merged (a false hold), and nothing measured how often that happened.

## Decision

- `bin/lean/dag.mjs` builds the batch DAG before the first lane, without an LLM call. Edge X -> N (N waits until X merges) has two sources:
  - declared: a trusted `Depends on #X` / `Blocked by #X` line in N's body. The parser is the engine admission's own, so bold, list, `:`, comma/`and` lists and any case all match, and the plan and the admission check agree.
  - logical: X's last trusted FORGE:CONTRACT comment delivers a file that is not on the base yet, and N's body names that path. An issue with no frozen contract gives no logical edge.
- Predicted file overlap (paths named in both bodies, or a shared deliverable that already exists) is a warning in the plan table and never an edge. A cycle that a logical edge closes drops that edge. A declared cycle stays, and the runner reports it as before (#5162).
- At a fresh start, `forgedock orchestrate` prints `plan:` and one table row per issue (title, waits on, likely files, overlap warning), and stores the edges in the batch `plan.json`. A resume keeps that DAG. The runner adds the logical edges through a new `logicalDeps(n)` seam next to the declared ones. The plan pass reads each issue once, and the runner's first read reuses that view.
- False holds: at batch end, the dependents of planned declared edges are re-read. A planned edge that is no longer declared was removed by an operator. The report prints `false holds: R/P planned edge(s) removed by an operator (...)`, and `report.json` keeps `dag: {planned, falseHolds}`.
- `commands/orchestrate.md` §2 now defers to the code. It no longer has the prose triage or the DAG and plan steps. `scripts/check-spec-size.sh` caps the file at its pre-change size.

## Consequences

- Plans are reproducible, and a body edit is the only way to add or remove a declared edge. An edge the model would have guessed must now go on the dependent as a `Depends on #X` line.
- Logical edges exist only once a dependency has a frozen contract, so they come from a requeued or resumed issue, not from a first run.
- The legacy multi-phase specs (`commands/orchestrate/phase-*.md`, `legacy.md`) are kept. `--path full` still loads `legacy.md`. `commands/work-on.md` points to helpers in `phase-4-execution.md`. Several tests, the protocol fixtures and the `check-commands` workflow read these files.
