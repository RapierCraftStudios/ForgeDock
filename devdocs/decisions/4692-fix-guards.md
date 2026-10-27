# 4692: fix guards (FORGE:GUARD)

A merged lane whose frozen contract names a regression/repro test records one guard on its issue:
`<!-- FORGE:GUARD {json} -->` with `{v, issue, pr, merge_sha, tests:[{path, ids}], hunks:[{file, start, end, symbol}], why}`.

- **GitHub is the register.** The comment on the issue is the record; `~/.forge/guards/<repo>.json` is a cache that `forgedock guards list` rebuilds from those comments. Idempotent: an issue with a FORGE:GUARD comment is never posted twice.
- **Test identity comes from the contract.** `repro_test` plus path-like tokens of the validate commands that match `isTestPath`; ids from `-k`, `--test-name-pattern`, `-t`, `--grep` or `file::id`. No language parser. No ids means a file-granular guard (`ids: []`).
- **Protected hunks** come from `git diff -U0 <merge_sha>^1 <merge_sha>` (first parent: the base for merge-commit and squash merges), test files excluded, enclosing symbol from the hunk header.
- **No test, no guard.** A lane with `repro_test: "none"` or no test file yields no guard; the reason is logged (run log in a lane, stdout in backfill).
- The merge hook is best effort and never changes the lane outcome. `forgedock guards backfill --since <date>` builds guards from closed issues' FORGE:CONTRACT comments and merged PRs.
- Out of scope: using guards to gate lanes (#4693), contract rows (#4694).
