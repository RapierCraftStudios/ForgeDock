**Verdict**: CONFIRMED
**Confidence**: medium
**Severity**: high (a red staging base stalls every later lane and burns a human touch)
**Task Type**: feature

### What Was Claimed
A lane merged and left staging red on a repo-wide static guard test it never ran; the next, unrelated lane met the failure as "pre-existing", and went needs-human. Wanted: (1) a declared pre-merge guard set that every lane runs on the merged result and that blocks the merge; (2) a base failure attributed to its introducing commit/issue, which is reopened or filed, with the blocked lane deferred instead of needs-human.

### What We Found
- `verify.invariants` (#4585) already is a repo-wide always-run command list, never scoped away by the test map: `bin/lean/verify.mjs:62`, `bin/lean/precheck.mjs:129-141`, `bin/engine-cli.mjs:427-428`, `docs/CONFIG.md:981,1005`. It is the natural "guard set"; no new key is strictly needed.
- But it does not block. A failure goes to the builder's precheck fix round; after `maxRounds` (or no builder commit) the lane only records an anomaly and opens the PR, unless the separate opt-in `verify.precheck_block` is true: `bin/lean/lean.mjs:1933,1947`, `docs/CONFIG.md:986`, `bin/lean/verify.mjs:71`. So "cannot merge" (AC1) is not guaranteed.
- Invariants run once, pre-PR, on the lane tree (`bin/lean/lean.mjs:1905-1935`). I found no rerun on the base-synced merged tree before merge (base-sync: `lean.mjs:2719-2760`; `post_merge` typecheck only: `lean.mjs:2133`). Implementer must confirm.
- Nothing classifies a failing precheck/invariant command as "also fails on the base". `guardgate.mjs:166-170` does a base comparison but only for guard-gate test files (#4968). Failures reach `needsHuman(..., CI_RED)` (`lean.mjs:1931-1947,2237,2879`) with no attribution.
- No outcome code for "base is red, lane deferred". Deferred codes exist for other causes (`bin/engine/outcome-codes.mjs:63-70`), e.g. `SANDBOX_CAPACITY`, `DEPENDENCY_OPEN`.
- A seam to run a command on the base worktree exists: `io.preflightRun` (`lean.mjs:1524-1560`).

### Root Cause
The guard set exists (`verify.invariants`) but is advisory by default and runs only on the lane tree, so a lane can merge with it red/unrun. And a failing check has no base-vs-lane classification or attribution, so any base red becomes `ci.red` needs-human for an innocent lane.

### Affected Files
`bin/lean/lean.mjs` (precheck failure branch ~1925-1950, base-sync path), `bin/lean/verify.mjs`, `bin/lean/precheck.mjs`, `bin/engine/outcome-codes.mjs`, `bin/engine-cli.mjs`, new `bin/lean/basered.mjs` (+ test), `docs/CONFIG.md`, `devdocs/modules/lean.md`.

### Sibling Sweep
Same class (check fails on base, lane blamed): CI-red path `lean.mjs:2237,2879` (`splitFlaky` only separates known flakes); `post_merge` verify (`lean.mjs:2133`); conformance precheck repro already has a base-passes check (`lean.mjs:2524`, #5080). Reuse the new classifier at the precheck and CI-red sites; keep the first change to precheck/invariants.

### History
`17e94b58e` introduced invariants (#4585); `precheck_block` added in #5079 (opt-in, default off); #4968 base comparison for guard gate only. No prior fix for attribution.

### Recommendation
1. Pure module `basered.mjs`: `classify({failed, baseRuns})` -> lane-own vs base-red; `attribute({base, files, git})` -> introducing commit via `git log -1 --format=%H %s base -- <files named in failure output or the check's test path>`, then issue number from `(#N)` / `Closes #N` in the message (0 LLM calls).
2. When an invariant/precheck command still fails after the fix round, run it once on the base worktree (`io.preflightRun`). Fails on base too: new `base.red` outcome (deferred, not needs-human, not counted by breaker), comment on or reopen the introducing issue (or file one when unattributable) with a FORGE annotation, requeue the lane behind it. Fails only on the lane: block (ci.red).
3. Make invariant failures blocking: `verify.guard_block` default true when `invariants` is non-empty (or treat invariants as always blocking); document the behaviour change in CONFIG.md. Rerun invariants on the merged tree after base-sync if not already done.
4. Tests: classifier/attribution unit tests, verify parse test, lean.test.mjs lane test with a mocked failing invariant (lane-own blocks; base-red defers and comments).

### Related Issues
#4585 (invariants), #5079 (precheck_block, coupled files), #4968, #4693 (guard gate), #5080. External: AlterLab #39805, #39996, #40006, #40011, #40016.
