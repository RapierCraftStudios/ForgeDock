### Approach
A remote lane branch with no open PR whose diff against the base holds only tool-state paths (`isToolState`, i.e. `.forge-lean/` scratch) is no longer treated as a resume. The worktree is still created from `origin/<branch>` so later pushes stay fast-forward; the scratch is removed in a normal commit and the run plans fresh.

### Changes
- bin/lean/lean.mjs: `toolOnly` check and `scratchOnly` detection before worktree creation; scratch removal commit, `resumed=null`, `SCRATCH_BRANCH_DROPPED` event and decision line; `keepLocal` skips a scratch-only local branch; `changedFiles()` ignores tool-state paths; import `isToolState`.
- bin/lean/lean.test.mjs: two regression tests (scratch-only plans fresh; scratch plus code still resumes).

### Acceptance Criteria Status
- R1 ✅ bin/lean/lean.mjs:1084-1088, 1112-1119
- R2 ✅ not-applicable (contract recovery already re-validated, lean.mjs ~1490)
- R3 ✅ bin/lean/lean.mjs:1084-1088

### Verification
- V1 `node --test bin/lean/lean.test.mjs`: pass (515 pass). One earlier run had a failure in the unrelated #4690 scope-limit test; it passed on three reruns (timing flake).
- V2 `node --test bin/lean/toolstate.test.mjs`: pass (8).
- The new scratch-only test fails without the fix (the rerun note appears and no `git rm` happens); not run separately against the reverted code.
- checks.mjs widened to the full suite (fan-out); not run, per host rules. No formatter configured in package.json. Devdocs freshness: not required.

### Notes
No env vars. A scratch-only branch is kept as a ref; the scratch is deleted by a commit, no force-push.
