---
issue: 4211
status: fresh
anchor: bin/lean/refactor.mjs
created: 2026-10-20
---

# ADR: the `refactor:split` lane is a label-routed step inside `runCore`, with one tool-less grouping call and no reviewer

## Context

#4208 (symbol index), #4209 (`refactor-verify.sh`) and #4210 (`symbol-move.py`) give a deterministic move and its proof, but nothing called them. `refactor:split` issues filed by `scripts/maintenance-scan.sh` went through the normal builder lane, which retypes code and cannot prove that only locations changed. The lease, worktree, teardown, PR and merge logic all live as closures inside `bin/lean/lean.mjs` `runCore`.

## Decision

- **A hook, not a second lane.** `runCore` calls `bin/lean/refactor.mjs` `runSplitStep` in place of the builder (step 3) when the issue carries `refactor:split`. Lease, worktree, toolchain, declared checks, structure and docs checks, push, PR, base-sync and merge are the same code as for builder runs. The conformance reviewer is skipped: `refactor-verify.sh` is the proof, so the optional review of non-moved lines is not spent.
- **Routing in `runCore`, not `engine-cli.mjs`.** The labels ride on the issue read `runCore` already makes (`--json ...,labels`). That costs zero extra gh calls and covers `run-issue` and orchestrate's detached lanes alike.
- **One grouping call, input = index only.** `compactIndex` keeps top-level symbols (`name, kind, lines, public`) and deduplicated `from->to` edges. It drops spans, imports and methods, so the prompt grows with the symbol count, never with the file length. The call runs with `noTools` (`--tools ""`, or every file tool disallowed) from an empty scratch cwd, so it cannot read a body even by accident. It uses the reviewer model: grouping an index is a small judgment.
- **Refuse before editing.** Steps that need nothing written run first: target and language (neither `.py` nor TypeScript since #4212 → `split.unsupported`), test command, a libcst or ts-morph probe. Any later refusal resets the worktree to its start commit (`git reset --hard` + `git clean -fd`; ignored `.forge-lean/` stays), so nothing partial is pushed.
- **No LLM fixes.** A split has no builder session. A failing declared check, red or unavailable CI, a base-sync conflict, or a failed merge check ends `needs-human`. A clean base-sync re-baselines at the new base and re-verifies before merging.
- **Chains.** `slicePlan` orders modules after the modules they reference and takes whole modules up to `splitMaxLines` (default 4000 moved lines). After the merge, the rest is filed as one `refactor:split` issue with the same `FORGE:MAINT` marker, `**Target**:` and a `FORGE:SPLIT-PLAN` JSON block. The next run applies that plan with `symbol-move.py --extend` into the same package, with no grouping call. Each PR is a verified move plus shim, so it merges on its own.

## Rejected

- **A standalone `refactor.mjs` lane that imports lease/PR/merge.** Those are `runCore` closures. Extracting them is a large refactor of the canonical runtime for one lane.
- **Routing in `engine-cli.mjs`.** It needs an extra `gh issue view` per run and misses nothing that `runCore` cannot see.
- **A `readOnly` grouping call.** Read, Grep and Glob would let the model read the file the index replaces.
- **A conformance review of the split.** The reviewer cannot tell a move from a change better than `git diff --color-moved`, and it costs one call per split.
- **One PR per new module, each in its own package.** The issue asks for one target package. `--extend` keeps every chain step in it.
- **Re-grouping for each chain step.** That costs one call per PR instead of one per split, and the groups could drift between steps.

## Known limits

- Python and, since #4212, TypeScript (`scripts/symbol-move.mjs`, ts-morph; `decisions/4212-ts-symbol-move.md`). Go and JS have no mover yet, and their issues end `split.unsupported` with the reason.
- A rerun on a branch that already holds the move re-verifies it, but does not recompute a chained remainder. The maintenance scan re-files the hotspot if it is still over budget.
- The chain issue is filed best-effort after the merge. A failed filing is a trajectory anomaly.
