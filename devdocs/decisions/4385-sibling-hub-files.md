---
issue: 4385
status: fresh
anchor: bin/lean/sequence.mjs
created: 2026-10-23
---

# ADR: sibling hub files are serialised from declared files; numbered documents renumber by number only

## Context

A split's sibling sub-issues ran in parallel and each edited the same hub files: a barrel export list, an events union, shared test fixtures, the domain doc. The first sibling merged. Every later one conflicted in the same files, and the base-sync resolution was brittle. Union merge (#3969) does not help, because these files are not append-only. Two siblings also each created `docs/adr/0016-*.md`. #4322 already detected the duplicate number, because detection works for any dense series. But `verifyRenumber` required a renamed file to stay byte-identical, and nothing checked the ADR index. A correct ADR renumber, which also changes the number in the title, therefore ended `needs-human`.

## Decision

- A `split-required` sub-issue may list `files`. `serializeShared` (`bin/lean/lean.mjs`) adds a `Depends on` edge from each later sub-issue to the nearest earlier one it shares a file with, unless it already reaches that one. Each added edge is recorded as a decision. Orchestrate already honours `Depends on`. Sub-issues without `files` behave as before.
- The split rule in `BLOCK_RULES` asks the builder to pre-stage the hub's slots in the earliest sub-issue, or to give each sibling its own per-feature file. The engine serialises whatever overlap remains (layer 1 plus layer 3).
- `verifyRenumber` (`bin/lean/sequence.mjs`) accepts a renamed file whose content differs only in its own number (`numberOnlyChange`, zero-padded or not). It reports any tracked file that still names the old stem (the index or links). `RENUMBER_RULE` now covers numbered documents and the series index.

## Rejected

- Engine-imposed glob or codegen barrels: repo-specific, and they reimplement the target's tooling.
- An LLM agent that predicts conflicts: a new agent for a fact that a file list makes exact.
- Editing `commands/work-on/decompose.md` and `build/architect.md`: the lean runtime does not load them (NORTHSTAR runtime map).
- An ADR-format parser for titles and indexes: the number-only diff and the stale-stem check are format-agnostic.
