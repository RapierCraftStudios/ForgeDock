### Approach
Two deterministic layers, no LLM calls. `ensureSignedOff` (new `bin/lean/signoff.mjs`) runs inside `gitPush` and before `ciVerify` reads the head. It lists commits reachable from HEAD but not from `origin/<branch>` or `origin/<lane>`, picks those authored or committed `*@localhost` or lacking a `Signed-off-by` that names their author, and rewrites only those with `git filter-branch` over that range, using the lane identity (`GIT_AUTHOR_*`, else `git config`) plus a sign-off. Commits on either remote ref are never in the range. A DCO gate before `gh pr merge` ends needs-human `ci.dco` when a check named DCO failed on the current head, regardless of `merge_wait` or required checks.

### Changes
- bin/lean/signoff.mjs: new helper (`ensureSignedOff`, `needsSignoff`, `offendersOf`).
- bin/lean/lean.mjs: `signOffUnpushed` called from `gitPush` and `ciVerify`; pre-merge DCO gate reusing the last poll's states; `git` wrapper forwards opts (env).
- bin/engine/outcome-codes.mjs: `CI_DCO: "ci.dco"` (not recoverable).
- bin/lean/signoff.test.mjs: real-git fixtures (bare origin + clone).
- bin/lean/lean.test.mjs: DCO gate tests; one existing poll-count test no longer counts `checkStates`.
- bin/tests/engine-outcome-codes.test.mjs, docs/OUTCOME-CODES.md: register `ci.dco` (amendment).
- devdocs/modules/lean.md: documents both layers.

### Acceptance Criteria Status
- R1 ✅ bin/lean/signoff.mjs:ensureSignedOff, bin/lean/lean.mjs gitPush; test signoff.test.mjs "rewrites unpushed placeholder-author commits…"
- R2 ✅ range excludes origin/<branch> and origin/<lane> (signoff.mjs); tests "never rewrites commits already on origin/<lane>" and the merge-commit case
- R3 ✅ lean.mjs pre-merge DCO gate; lean.test.mjs "a failed DCO check blocks the merge with ci.dco" (merge_wait required and none)
- R4 ✅ signoff.mjs + lean.mjs gitPush
- R5 ✅ lean.mjs DCO gate, outcome-codes.mjs CI_DCO

### Verification
- V1 `node --test bin/lean/signoff.test.mjs`: pass (6 tests); fails without the fix (module absent).
- V2 `node --test bin/lean/lean.test.mjs bin/lean/recovery.test.mjs bin/lean/sandbox-provider.contract.test.mjs`: pass. With bin/tests/engine-outcome-codes.test.mjs: 594 pass, 0 fail. The DCO-gate test fails with lean.mjs and outcome-codes.mjs reverted.
- scripts/check-devdocs-freshness.sh: OK. `forgedock check`: PASS. checks.mjs widened to the full suite (fan-out cap), so only the targeted files above were run.

### Notes
- Behaviour: pushes may now rewrite the lane's own unpushed commits (new SHAs, never pushed before). No usable identity or a failed rewrite ends `ci.dco`.
- `git filter-branch` runs with FILTER_BRANCH_SQUELCH_WARNING=1 via env; refs/original is deleted afterwards.
- No new env vars; no formatter is configured in the repo.

## Sibling-list check
The ten flagged bin/lean tests hold no list of lean modules or files; signoff recorded in result.json not_members.
