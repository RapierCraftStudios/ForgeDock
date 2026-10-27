### Approach
A deterministic `bin/lean/guards.mjs` (0 LLM calls, git and gh injected). It reads a merged issue's FORGE:CONTRACT comment, the merged PR and the merge commit, builds one guard and posts it as `<!-- FORGE:GUARD {json} -->` on the issue. The lane hook, `guards list` and `guards backfill` all share `guardIssue`.

### Changes
- bin/lean/guards.mjs: buildGuard, guardTests, parseHunks, render/parseGuard, guardIssue (idempotent), collectGuards, writeIndex/readIndex, listGuards, backfill, guardAfterMerge, guardsCli.
- bin/lean/guards.test.mjs: 10 tests, including node --test and pytest fixtures.
- bin/lean/lean.mjs: best-effort `guardAfterMerge` call after `label("merged")` (+3 lines).
- bin/engine-cli.mjs: `guardsFromCli`.
- bin/forgedock.mjs: `guards` case, known-commands entry, help row.
- devdocs/decisions/4692-fix-guards.md: decision record.

### Acceptance Criteria Status
- R1 ✅ guards.mjs guardIssue (existing-guard check), lean.mjs hook; test "guardIssue posts exactly one FORGE:GUARD and is idempotent"
- R2 ✅ guards.mjs guardsCli/listGuards, forgedock.mjs `case "guards"`; test "guards list prints guards for a path"
- R3 ✅ guards.mjs backfill; test "backfill guards merged lanes and logs why"
- R4 ✅ guards.test.mjs node --test fixture and pytest fixture
- R5 ✅ guards.mjs renderGuard, collectGuards/writeIndex (index rebuilt from comments)
- R6 ✅ guards.mjs guardTests/idsOf (no language parser; ids: [] is file granularity)

### Verification
- V1 `node --test bin/lean/guards.test.mjs`: pass. It fails without the change because the module does not exist.
- V2 `node --test bin/lean/lean.test.mjs bin/lean/train.test.mjs`: pass.
- `forgedock check`: PASS. checks.mjs widened to the full suite (931 files reference the change); per host rules I did not run it.
- check-devdocs-freshness.sh: OK.

### Notes
- Guards need the merge commit locally. The hook fetches the base first; backfill reports a skip with the reason when the commit is missing.
- A deletion-only hunk is anchored at the line after the deletion in the post-image.
- No formatter config exists in the repo, so none was run.
- No env vars added.
- Stale-list check: the nine flagged tests (batch, checks, conformance, conformance.e2e, context, execution, execution.e2e, fixround, heavy) do not enumerate lean modules or guards-like symbols; recorded as not_members in result.json.

### CI fix
- The CI step `bash scripts/check-test-tmp-cleanup.sh` failed on `bin/lean/guards.test.mjs`: it used `mkdtempSync` without importing `bin/tests/_tmp.mjs`. The test now uses `tmpDir` from that helper. The lint and its own test (`check-test-tmp-cleanup.test.sh`, 18 pass) are clean.
- The CI log was not readable, so I found this by running the workflow's lint step locally. I also ran all of bin/lean (1453 pass) and bin/engine, bin/stats, bin/tests and packages/protocol (2951 pass, 3 fail). The 3 failures (preflight, forge Act II, writeInstallReceipt) are WSL/platform-detection tests in this host and are unrelated to this change; I did not confirm they pass on the base.

## Conformance fix (R1 hook)
guardAfterMerge now strips `origin/` from the lane base before `git fetch origin <branch>`, and guardIssue falls back to `git fetch origin <merge_sha>` when the diff cannot be read locally. Merge SHA still comes from `gh pr view --json mergeCommit` (explicit PR from the lane). Added a test with a git mock that fails on invalid refspecs.
