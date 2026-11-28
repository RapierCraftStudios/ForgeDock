forge-stamp: issue=6239 contract=5f49ad576b52
### Approach
Pure detector (`execbit.mjs`) plus an engine gate beside `duplicateGate`: mechanical `git update-index --chmod=+x` first, one builder round for leftovers, then an anomaly. It never blocks.
### Changes
- bin/lean/execbit.mjs: `execBitFindings`, `applyExecBits`, `invokesDirectly`.
- bin/lean/execbit.test.mjs: detector and fix tests, including negatives.
- bin/lean/effects.mjs: `io.execBits`, `io.execBitsFix`.
- bin/lean/lean.mjs: `execBitGate("hand-off")`.
- bin/lean/prompts.mjs: `execBitsPrompt`.
- bin/lean/verify.mjs: `verify.exec_bits` parsed into `vcfg.execBits` (only present when false).
- bin/lean/verify.test.mjs, bin/lean/lean.test.mjs: tests.
- devdocs/modules/lean.md: entry.
### Acceptance Criteria Status
- R1 ✅ execbit.mjs (execBitFindings)
- R2 ✅ lean.mjs execBitGate
- R3 ✅ execbit.mjs execBitFindings (shebang, direct *.sh)
- R4 ✅ applyExecBits and execBitsPrompt
- R5 ✅ regression kind in execBitFindings
- R6 guidance, no work
### Verification
V1, V2, V3, V4 and G1 all pass. `forgedock check` passes. The new tests fail without the fix because the module and gate don't exist. I did not run the full suite, per the host rules. No formatter is configured in the repo.
### Notes
On by default. Opt out with `verify.exec_bits: false`. New event `EXEC_BIT_FINDINGS`.

## Sibling-enumeration follow-up
The 10 flagged tests only mention a few bin/lean module names incidentally; recorded execbit as not_members in result.json for each.
