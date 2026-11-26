forge-stamp: issue=5979 contract=696abcdea9a9
### Approach
Rerun/recovery: the earlier commits already deliver R1-R9. CI "Unit tests" failed in the lint step (no-use-before-define); fixed the two sites this lane introduced.
### Changes
- bin/lean/lean.mjs: `iss` declared before the new `allComments` helper.
- bin/lean/lean.test.mjs: #5979 test moved after the `depWorld` helper it uses.
### Acceptance Criteria Status
- R1-R9: ✅ delivered by earlier commits (amendment-schema.mjs, conformance.mjs, failure-stop.mjs, recurrence.mjs, commentstate.mjs, lean.mjs); unchanged this pass.
### Verification
- node --test lean.test.mjs: 795 pass, 0 fail. Contract test files (conformance, failure-stop, recurrence, commentstate, churn, guardgate, statuscomment, outcome-codes, orchestrate-recovering, orchestrate-envhold): pass.
- forgedock check: PASS. eslint on the changed files shows no new errors; 27 no-use-before-define errors in lean.mjs pre-exist on staging.
- Lint fix only, so no new test.
### Notes
No behaviour change, no env vars.

## Sibling-list check
Flagged tests do not enumerate bin/lean modules; recorded as not_members in result.json. No test edits.

### Not-member records
The 28 flagged sibling-list rows (amendment-schema, commentstate, failure-stop vs batch/checks/conformance/context/execution/execution.e2e/fixround/guardgate/ledger/release-mergeback tests) point at fixtures/assertions, not module lists; recorded in result.json not_members, no test edits.

### Requirements R10-R15
- R10: ✅ bin/lean/commentstate.mjs:36 decidePost skips unchanged state; bin/lean/lean.mjs post(); test commentstate.test.mjs:18
- R11: ✅ bin/stats/churn.mjs:15 churnStats/formatChurnLines; wired bin/engine-cli.mjs:2514; test bin/stats/churn.test.mjs:8
- R12: ✅ bin/lean/conformance.test.mjs:1724 (G2 supersedes rejected with substitute-validate hint; substitute-validate validates)
- R13: ✅ bin/lean/lean.test.mjs:582 (second identical failure parks with one PARKED summary, no relaunch)
- R14: ✅ bin/lean/recurrence.test.mjs:40 (symptom match required; path-only overlap does not fire)
- R15: ✅ bin/lean/lean.test.mjs:582 and commentstate.test.mjs:18 (unchanged DEPENDENCY/STATUS not re-posted)
- R16: deferred to post-deploy check R12-followup (contract defer).

## CI fix pass (Unit tests, node --test)
CI log was unavailable. Ran every changed test file plus all of bin/lean and bin/stats locally: 4702 pass, 4 fail. The failing tests (ensureSignedOff placeholder-author rewrite, toolchain pins #4163 pnpm/corepack, post-checkout hook #5435 R2) exercise git hooks, sign-off and pnpm/corepack resolution on this host; this diff touches none of those files, so they are environmental and unrelated. No code changed.

### CI follow-up (run 45738975244)
Unit tests failed in lint:js: eslint exit 2 for a stale suppression (the iss count in bin/lean/lean.mjs dropped after the declaration move). Ran eslint --prune-suppressions; eslint-suppressions.json updated (amendment add-deliverable); npm run lint:js now exits 0.

## CI: Spec-size budget (unrelated, no code change)
The check fails on `commands/orchestrate.md` being over its 17399-byte ceiling (18178 bytes). This diff touches no `commands/*.md` file: the file is 18178 bytes at the merge-base and at origin/staging, so the same check fails on staging itself (reproduced with `scripts/check-spec-size.sh origin/staging`). It needs a fix on staging (shrink the spec or raise the ceiling), not an amendment here.
