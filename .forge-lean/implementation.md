### Approach
Prior run's work verified against the contract; no code changes needed this run. Re-ran validate commands and the wider node --test suites.
### Changes
- bin/review-context.mjs: staleness detection (R3-R5), age advisory (R7), refresh flow with diff (R1)
- bin/forgedock.mjs: --refresh-context flag, doctor REVIEW_CONTEXT_STALE warning
- scripts/review-prepare.sh: REVIEW_CONTEXT_STALE, context_generated_at/stale/advisory
- commands/review-pr.md, forge.yaml.example, devdocs/modules/lean.md: docs/prompt
- tests: bin/tests/review-context.test.mjs, scripts/review-prepare.test.sh
### Acceptance Criteria Status
R1 ✅ bin/forgedock.mjs:1046; R2 ✅ bin/forgedock.mjs:2715, scripts/review-prepare.sh; R3-R5 ✅ bin/review-context.mjs; R6 ✅ same; R7 ✅ commands/review-pr.md
### Verification
V1 exit 0 (74 pass); V2 exit 0; devdocs freshness OK; forgedock check PASS. New tests fail without the fix (module absent).
### Notes
Locally bin/tests has 3 failures (journey Platform/WSL row, bootstrap orphaned .tmp cleanup, preflight) in files untouched by this branch; they look environmental (WSL/root) and were not confirmed on base. engine/stats/lean/protocol suites: 0 fail. No repo formatter is configured (no prettier config), so none was applied.

## Enumerating-test follow-up
- bin/lean/lean.test.mjs is not a list of bin/ siblings (only incidental engine/gc/runner tokens); recorded review-context under not_members in result.json. No code change.

## CI follow-up (Unit tests)
CI log not available; failure not reproduced. V1/V2 pass and about 60 targeted suites show 0 failures. The only 3 local failures (journey.test.mjs: WSL/platform, root chmod) are in untouched code and environmental. No code change; needs the CI log to go further.
