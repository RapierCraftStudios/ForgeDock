### Approach
unmetDependencies now treats a merged closing PR as on the lane when its base equals the lane or its merge commit is an ancestor of the lane (injectable isAncestor).

### Changes
- scripts/plan-validate-live.mjs: fetch mergeCommit, ancestry check, refusal names the short merge commit.
- bin/engine-cli.mjs: wiring of an isAncestor using `git -C cwd merge-base --is-ancestor` against origin/<base> then <base>.
- bin/tests/plan-validate-live.test.mjs: three new tests.
- devdocs/decisions/4659-live-plan-validate.md: gate description.

### Acceptance Criteria Status
- R1 ✅ scripts/plan-validate-live.mjs:86
- R2 ✅ scripts/plan-validate-live.mjs:91
- R3 ✅ only unmet deps are listed (test "lists only the unmet dependency")
- R4 deferred (new-issue) per contract

### Verification
- V1 node --test plan-validate-live + lean.test.mjs: 561 pass, 0 fail. The new ancestor test fails without the fix.
- V2 node --check both files: ok. forgedock check: PASS.

### Notes
No env vars. Hold-instead-of-refuse is deferred.

### Docs
- devdocs/modules/lean.md entry + index.yaml glob `scripts/plan-validate-live*` so the freshness check maps the script to the lean dossier.

### Follow-up (scope)
devdocs/index.yaml and devdocs/modules/lean.md are changed too: check-devdocs-freshness.sh fails without a dossier mapping for scripts/plan-validate-live.mjs. Recorded as add-deliverable amendments in result.json.
