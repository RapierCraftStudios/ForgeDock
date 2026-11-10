---
status: fresh
anchor: bin/lean/surfaces.mjs
created: 2026-11-10
---

# ADR: sibling-aware lanes: context default, shared-surface slots, prerequisite pull-in

## Context

Lanes of one feature each saw only their own issue. Siblings collided on registries, route tables and migration directories (35 migrations renumbered by hand), and a dependent run started while its prerequisite was open and ended `dependency-open`.

## Choice

- Context pack defaults to `on` for a lane with a milestone or parent epic; an explicit `engine.context_pack` always wins. Sibling facts and in-flight declarations rank first.
- Shared surfaces are declared in `engine.shared_surfaces`. A lane touching one holds a one-slot lease built on `seqlease.mjs` (no second lock mechanism), and its declaration is readable by sibling packs. Generated registries (`glob => command`) are exempt and the builder is told to regenerate.
- `orchestrate` pulls an open out-of-batch prerequisite into the batch so the DAG orders it first. Engine admission stays as the fallback.

## Rejected

- A new lock service for surfaces: `seqlease.mjs` already has the primitives.
- Defaulting all lanes to `on`: lanes with no siblings gain nothing and keep the shadow default.
