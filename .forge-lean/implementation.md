### Approach
A deterministic guard gate in a new module `bin/lean/guardgate.mjs`, called from `gate()` in parallel with the validate rerun. It selects guards by blame of the lane's touched old-side lines (or by edits to a guard's test files), reruns each selected test file as it exists on the merge base against the lane tree, and reports `conformance.guard_broken` through the pure `precheck`. A `supersedes` amendment retires it. No LLM call, no new phase or turn.

### Changes
- bin/lean/guardgate.mjs: index loader, `oldRanges`, `selectGuards`, `commandFor`, `runGuards` (pool, 120 s cap, skip-not-block), `guardFailures`, supersession helpers.
- bin/lean/guardgate.test.mjs: git-fixture tests (revert plus weakened test, supersedes, no-guard no-git, deleted test, cap/no-runner skip, pytest command, parsing, stale index).
- bin/lean/conformance.mjs: `supersedes` amendment kind (`contract.supersedes`); `precheck` takes `guardFailures` and drops retired guards.
- bin/engine/outcome-codes.mjs: `CONFORMANCE_GUARD_BROKEN`.
- bin/lean/lean.mjs: `guardGate()`, run beside `rerunFailedValidates`, trajectory note, events `guard_run`/`guard_broken`/`supersedes_accepted`, supersession comment on the guarded issue after merge.
- devdocs/modules/lean.md: dossier section.

### Acceptance Criteria Status
- R1 ✅ bin/lean/guardgate.mjs selectGuards
- R2 ✅ bin/lean/guardgate.mjs runGuards, commandFor
- R3 ✅ guardFailures; conformance.mjs precheck; resume via the existing conformance fixRound (lean.mjs gate)
- R4 ✅ conformance.mjs applyAmendments, lean.mjs supersession comment
- R5 ✅ guardgate.test.mjs "reverts a guarded fix"
- R6 ✅ guardgate.test.mjs "accepted supersedes" (precheck pass, comment text); the comment post is in lean.mjs at merge
- R7 ✅ guardgate.test.mjs "no guarded hunk" (zero git calls); selection in T.decisions
- R8 ✅ shadow records `would` in CONFORMANCE_SHADOW; enforce blocks
- R9 ✅ no LLM or prompt change
- R10 ✅ candidates filtered by changed files before any git call
- R11 ✅ runGuards cap, pool; run in parallel with validate rerun
- R12 post-deploy: `guard_run` carries `wall_ms`
- R13 ✅ failure detail is why + test + output tail only

### Verification
- V1 `node --test bin/lean/guardgate.test.mjs`: 9 pass. The test imports the new module, so it fails without the change.
- V2 guards/conformance/lean/conformance.e2e tests: 611 pass.
- V3 `node --test bin/stats/compounding.test.mjs`: 7 pass.
- `forgedock check`: PASS. Devdocs freshness: OK.

### Notes
- Base test copies are written beside the original as `<name>__guardbase.<ext>` (so relative imports resolve) and removed afterwards, not in a separate temp dir.
- "Reviewer accepts" means the lane reaches CONFORMS with the amendment on the effective contract; no separate reviewer row.
- `FORGE_HOST_PARALLELISM` caps guard test concurrency (default 2). No formatter is configured in the repo.

## Enumerating-test follow-up
The ten flagged tests only mention a few bin/lean file stems incidentally; recorded `guardgate` as not_members for each in result.json.
