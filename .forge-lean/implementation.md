### Approach
Additive `warnings` channel in the bootstrap validator for `deploy-last`; bootstrap spec rules; a pure `settle-scope` module (freeze, classify, convergence, STOP report) with spec wiring in orchestrate.md. The settle loop itself is not code in this repo, so wiring is spec-level.

### Changes
- scripts/bootstrap-validate.mjs: `warnings` + `deploy-last`, `formatWarnings`, CLI prints warnings on stderr, exit stays 0.
- bin/tests/bootstrap-validate.test.mjs: deploy-last warns / does not warn tests.
- commands/bootstrap.md: layering and deployable-slice rules (trimmed to stay under the 4096-byte spec budget).
- scripts/settle-scope.mjs, bin/tests/settle-scope.test.mjs: new module and tests.
- commands/orchestrate.md: section 3b, settle scope.

### Acceptance Criteria Status
- R1 ✅ scripts/settle-scope.mjs classifyNew (targets); follow-up script unchanged (no milestone, scripts/file-deferred-followups.sh:195)
- R2 ✅ scripts/settle-scope.mjs convergence / formatStopReport; commands/orchestrate.md section 3b
- R3 ✅ commands/bootstrap.md plan rules, step 7
- R4 ✅ scripts/bootstrap-validate.mjs deployWarnings

### Verification
- V1 node --test (4 files): 63 pass, 0 fail. New tests fail without the fix (functions and warnings absent).
- V2 bash scripts/file-deferred-followups.test.sh: 33 passed.
- `forgedock check`: PASS. checks.mjs widened to the full suite, which host rules forbid; not run. No formatter configured in package.json; none run.

### Notes
Docs: devdocs/modules/lean.md entry for #4665 (freshness check).

`validatePlan` result gains `warnings`; `ok` and exit codes unchanged. No env vars.

## Fix: deploy-last now also warns when no deploy-class issue sits in milestones 1-2 (e.g. only milestone 3 of 4); test added.
