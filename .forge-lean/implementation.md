### Approach
`bin/review-context.mjs` compares forge.yaml `review.tech_stack`/`review.context` with manifests and the decision log (no LLM). doctor, review-prepare and `init --refresh-context` use it.

### Changes
- bin/review-context.mjs: stale rules, age advisory, diff, refresh flow, `check` CLI
- bin/forgedock.mjs: `--refresh-context` flag, doctor warn, help
- scripts/review-prepare.sh: REVIEW_CONTEXT_STALE findings, config.context_* keys
- commands/review-pr.md: generation date, advisory, warning line
- forge.yaml.example: new keys documented
- bin/tests/review-context.test.mjs, scripts/review-prepare.test.sh: tests
- devdocs/modules/lean.md: dossier (freshness check requires it)

### Acceptance Criteria Status
- R1 ✅ bin/forgedock.mjs:1046
- R2 ✅ bin/forgedock.mjs:2715, scripts/review-prepare.sh:235
- R3 ✅ bin/review-context.mjs
- R4 ✅ bin/review-context.mjs
- R5 ✅ bin/review-context.mjs
- R6 ✅ scripts/review-prepare.sh:246
- R7 ✅ commands/review-pr.md:512

### Verification
- V1 `node --test bin/tests/review-context.test.mjs bin/tests/init-detect.test.mjs bin/tests/init-enrich.test.mjs`: 74 pass, 0 fail. New tests fail without the module (it would not exist).
- V2 `FORGEDOCK_HOME=$PWD bash scripts/review-prepare.test.sh`: exit 0, but the script printed "SKIP: yq not installed", so the new case did not execute on this host.
- check-devdocs-freshness.sh: OK. forgedock check: PASS.

### Notes
No new env vars. Advisory only; checks never block a review.
