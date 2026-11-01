**Verdict**: CONFIRMED
**Confidence**: medium
**Severity**: medium (release-review latency; the fail-open widens review scope and cost, it does not skip review)
**Task Type**: bug

### What Was Claimed
`forgedock review-staging` pre-dispatch on a ~290-PR bundle takes 25+ min and falls open to `SCOPE_MODE=full` on one failed gh read. Expected: parallel, cached per-PR reads; a single failed read retries then degrades only that PR; per-phase progress output. ACs: a synthetic 300-PR bundle runs pre-dispatch in under 5 min; an injected gh failure on one PR keeps `SCOPE_MODE=scoped` for the rest.

### What We Found
- `scripts/review-staging-pre.sh:341` the 0B.1 scope loop is strictly serial. Each PR costs 3 gh calls (`pr view` :343, `api --paginate comments` :352, `pr diff --name-only` :353) plus 3 `bash trusted-comments.sh count` forks (:356-358) and `jq` forks. ~290 PRs x ~7 process launches plus network round trips is the bulk of the wall time.
- `scripts/review-staging-pre.sh:343,352,353` these three reads do NOT use `gh_retry` (defined :47-64 and already used in the gate step :143 and `bundle_pr_kind` :109). One transient error is immediately fatal.
- `scripts/review-staging-pre.sh:345,347,348,352-359` every failure path runs `SCOPE_MODE=full; break`, so one bad PR (or one malformed head or marker count) abandons the whole bundle. :377 prints the "fell open at bundle PR #N" line seen in the issue.
- `scripts/review-staging-pre.sh:141-166` the gate step is also serial per PR (2 gh calls plus a search each, search rate-limited), but it already retries.
- `scripts/review-staging-pre.sh:112-116` bundle step calls `bundle_pr_kind` serially for every subject-cited number.
- No progress output anywhere in the scope loop (only the final one-line summary :412).
- `scripts/review-prepare.sh:563-651` builds the code index (bounded by `REVIEW_PREPARE_INDEX_TIMEOUT`, #4126 fix at 433776f66) and then runs 10 `slice` calls (:642-651), each an awk pass over the whole diff. On a 2,880-file diff that is a plausible secondary cost. I did not measure it here, so the issue's "building diff slices" time is unverified.
- Tests: `scripts/review-staging-pre.test.sh:150-165` has one scoped case and one `scopefail` case that asserts a failed `gh pr view` yields `full` (:165). That expectation changes. `scripts/review-pr-staging-scope.test.sh` extracts the `bundle-scope-loop`, `bundle-delta-credit` and `bundle-pr-kind` blocks by BEGIN/END marker, so those markers must survive.

### Root Cause
The per-PR scope read is a serial loop with unretried gh calls and a bundle-wide fail-open (`break` with `SCOPE_MODE=full`) for any per-PR read problem. Failures are not isolated per PR, and nothing parallelises or reports progress.

### Affected Files
- `scripts/review-staging-pre.sh` (scope loop, optionally bundle and gate loops)
- `scripts/review-staging-pre.test.sh` (update the `scopefail` expectation; add one-PR-failure and 300-PR cases)
- `scripts/review-prepare.sh` (progress lines per phase; only touch the slice step if the synthetic measurement shows it is slow)
- `commands/review-pr-staging.md` (only if it documents the fall-open wording)

### Sibling Sweep
- The gate loop (:141) and `bundle_pr_kind` loop (:112) are the same serial pattern. They already retry, so only parallelism or progress is optional there.
- `bin/review-staging.mjs` consumes `scope.json`. Check that it tolerates an added `degraded_prs` field and the new scope semantics.
- `scripts/review-finalize.sh` and `scripts/review-finalize.test.sh` reference `SCOPE_MODE`. They only read it, so they are unaffected.

### History
Fall-open was designed in forge#3451 (scoped review gates) and #4127 (issue numbers in subjects). `gh_retry` came with forge#4572. #4126 (closed) fixed code-index walking nested worktrees, in `scripts/code-index.sh` and `review-prepare.sh`. No prior fix covers the serial loop or per-PR isolation.

### Recommendation
1. Split the loop body into a per-PR function `scope_one_pr <pr>` that writes its result to `$_SD/scope-<pr>/` (head, reviewed flag, commit lists, files, status). It wraps the three reads in `gh_retry`. Run it with bounded parallelism (background jobs or `xargs -P`, default 8, env `FORGE_SCOPE_PARALLELISM`). Merge the results serially in sorted PR order so output is deterministic and `_PF` keeps its format.
2. On a per-PR failure after retries (read failure, malformed head, malformed count), record the PR as `degraded`: credit no commits, so its commits land in UNREVIEWED, which is the safe direction. Keep `SCOPE_MODE=scoped`, log `scope degraded for PR #N: <why>`, and expose the PR numbers as `degraded_prs` in `scope.json`. Keep `full` only for global failures (git log or diff failures, empty inputs, missing trusted script). A confirmed issue number is still skipped.
3. Emit a progress line every 25 PRs and at each phase start and end, to stderr.
4. Run both scope-test files and a stubbed 300-PR run to confirm the 5-minute criterion. Time `review-prepare.sh` slicing on a synthetic ~2,900-file diff, and only optimise `slice()` if it is material.

### Related Issues
#4126 (code-index nested worktree hang, closed), forge#3451, #4127, #4572. Evidence PR: AlterLab #37881.
