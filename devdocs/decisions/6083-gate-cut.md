# 6083: gate cut (advisory and deleted lane gates)

## Context
Phase 1 of #6083 measured every lane gate (inventory comment on the issue): over 400 issues per repo since November, 35-65% of needs-human parks came from rules about the shape of the work, the environment, or reviewer opinion, and about $500 of resume cost, with no real defect identified that they caught. The owner approved the full cut list and asked to cut now.

## Decision
Deleted (code, prompts and tests removed): amendment syntax validation and the builder correction round (an invalid amendment is not applied), `substitute-validate` and its engine rerun, post-deploy `check_unknown` (precheck and freeze), hotspot and counter growth, recurrence design routing (design lane, design block requirement, prompt note), docs-freshness forcing in lanes (docs round, implied doc deliverables, docs plan note; the repo's own CI script is untouched), the CI-budget annotation gate (the `CI_NET` report stays), and the `engine.validate_result_lost` park (recorded as an anomaly, the lane continues).

Advisory (recorded once per lane through `splitAdvisory`/`noteAdvisory`, never parking): scope creep, no-status and deferral rows, e2e and ui-browser unverified, `env.*` and dependency-install parks at the precheck, validate missing/timeout/env/drift/invalid-command, repro environment failures and mutation, guard_broken, reviewer `unimplemented` rows, page/design/outcome-evidence/prod-parity families, seams and preserve, route, coupled, relaxation, activation. `forge.yaml engine.conformance_kinds: <code>=enforce` re-promotes any of them.

Still blocking: frozen requirements with a linked passing test (test_missing/test_weak), validate_failed, bug repro red-green, source_deliverable_untouched, conformance.regression, conformance.omission, ci.red with one fix round, DCO, builder.blocked/no_commit, base-conflict handling, orchestrate breaker and holds.

## Rejected
A 14-day advisory trial before deleting. The owner chose to cut now; advisory rows keep the evidence in the trajectory and `enforce` is the escape hatch.
