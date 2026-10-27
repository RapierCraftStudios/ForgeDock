### Approach
A deterministic train scheduler in `bin/lean/train.mjs` (0 LLM calls). It runs one orchestrate batch per milestone and keeps state in a single atomic file. Lanes already resolve their base from the milestone (`lane.mjs`), so the train never touches `branches.staging` or `forge.yaml`. The #4657 lifecycle seam handles ship and close.

### Changes
- bin/lean/train.mjs: state file, createTrain, insertMilestone, resolveCaps, runTrain, stopOf, trainCli.
- bin/lean/train.test.mjs: 10 tests.
- bin/engine-cli.mjs: `trainFromCli` wiring (29 lines).
- bin/forgedock.mjs: `milestone train` command, known-commands list, help.
- forge.yaml.example, commands/milestone.md, devdocs/decisions/4658-milestone-train.md: docs.

### Acceptance Criteria Status
- R1 ✅ bin/lean/train.mjs:createTrain/runTrain/trainCli; bin/forgedock.mjs `case "milestone"`
- R2 ✅ train.mjs never writes forge.yaml; test "forge.yaml is byte-identical" in train.test.mjs
- R3 ✅ train.mjs:resolveCaps (warn and ignore); test "conflicting --parallel"
- R4 ✅ train.mjs:insertMilestone/validateOrder; test "insertMilestone re-validates"
- R5 ✅ train.mjs:STOP_REASONS/stopOf, `--resume`; test "typed STOP"

### Verification
- V1 `node --test bin/lean/train.test.mjs lifecycle.test.mjs lane.test.mjs batch.test.mjs`: 81 pass, 0 fail. The new tests fail without the fix because the module does not exist.
- `forgedock check`: PASS. The checks script widened to the full suite because forge.yaml.example changed; per host rules I did not run it in full.
- bin/tests/journey.test.mjs has 3 failures (preflight, forge Act II, writeInstallReceipt) that are identical on the base without my changes.
- No formatter is configured in the repo.

### Notes
New command `forgedock milestone train`. State lives under `<batchRoot>/trains/<id>/`. Cap source is `orchestration.global_parallel` (default 3). Batch id of a running milestone is only recorded after its batch returns, because orchestrate gives no early callback.

## Sibling-list check
The eight bin/lean tests flagged as enumerating siblings of `train` (batch, checks, conformance, context, execution.e2e, execution, fixround, heavy) do not list bin/lean modules or train symbols at the cited lines. Recorded as `not_members` in result.json; no test edits.
