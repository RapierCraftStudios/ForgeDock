# 5208: release post-merge step (#5213)

`postMergeStep` in `bin/lean/release-postmerge.mjs` is the last step of `forgedock release`. It runs after promotion merged
the release PR; decisions:

- The merge commit comes from `gh pr view <release PR> --json state,mergeCommit`. A PR that is not MERGED returns `stopped`
  (nothing to publish yet), not an error.
- Publish: `gh run list --workflow <release.publish_workflow | publish.yml> --commit <sha>`, polled a bounded number of times.
  A merge made by a bot token does not trigger `publish.yml`, so when no run appears the step dispatches one
  (`gh workflow run --ref <default>`; the workflow has `workflow_dispatch`) and polls again. Then it waits for the run to
  finish; a failed run or an exhausted wait is `blocked`.
- `release.artifact_check` is a shell command from the repo's own forge.yaml (the target repo's truth, like its test commands).
  It is retried with exponential backoff (5s doubling, capped at 120s, 8 tries) for the npm propagation delay.
- `release.version_sync`: the version is read from `package.json` at the merge commit, the branch is
  `chore/sync-version-<VERSION>` (what `publish.yml` pushes). An existing sync PR to the staging branch is reused, a merged one
  counts as done, otherwise the PR is opened once the branch exists. It is merged with `--match-head-commit` only when it has
  checks and all are green. A PR opened with `GITHUB_TOKEN` gets no CI, so "no checks" is a stop with the instruction to close
  and reopen it, never a force-merge.
- Every exhausted bound returns `{blocked}` (exit 3). The runner does not mark the step done, so `--resume <id>` retries it;
  every sub-step is idempotent. Bounds are overridable with `ctx.config.postMerge` (tests use tiny ones; waits go through
  `io.sleep`, commands through `io.run`).
