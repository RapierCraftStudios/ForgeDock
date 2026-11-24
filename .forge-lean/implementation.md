forge-stamp: issue=5836 contract=e45609db6b96
### Approach
Continued the checkpoint: merge train module, lean pr-ready terminal, orchestrate wiring were present; fixed leftover merge-conflict markers in orchestrate.mjs (kept both train params and upstream envIssue).
### Changes
- bin/lean/mergetrain.mjs: serial train, hand-backs, stats, summary line
- bin/lean/lean.mjs: mergeTrain option, pr-ready terminal for plain merges
- bin/lean/orchestrate.mjs: train tick, state, resume; conflict markers resolved
- bin/lean/batch.mjs, outcome-codes.mjs, config-schema.mjs, devdocs, tests
- bin/engine-cli.mjs: reads orchestration.merge_train, builds train, report line (amended in)
### Acceptance Criteria Status
R1-R19 ✅ (lean.mjs:4167, mergetrain.mjs, orchestrate.mjs); R20 deferred (contract)
### Verification
All validate commands V1-V4, G1 pass; forgedock check PASS. Tests in mergetrain/lean/orchestrate-train cover new behaviour.
### Notes
orchestration.merge_train: off|on, default off.

## Sibling-enumeration check
Inspected the ten flagged test locations; none enumerates bin/lean modules or symbols, so mergetrain is not a member of any. Recorded each in result.json `not_members`.
