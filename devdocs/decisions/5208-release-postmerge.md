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
- `release.version_sync` (#5513): the version is read from `package.json` at the merge commit and compared with
  `package.json` on the staging branch; staging at or above it is "already synced" and makes no further calls. The branch is
  `chore/sync-version-<VERSION>` (what `publish.yml` pushes). A merged sync PR counts as done, an open one is reused, otherwise
  the PR is opened with a `docs-not-needed:` body line. `publish.yml` cannot open it (enterprise policy: Actions may not create
  PRs), so the host does, with its own identity. When the branch never appeared, it is cut from the staging head through the gh
  API (`git/refs`, then a contents PUT of the version in `package.json` and `.claude-plugin/plugin.json`), no local git. The PR is
  then set to `gh pr merge --merge --auto` and polled (`autoPolls`/`autoPollMs`) for MERGED. A timeout, a closed PR or an
  auto-merge that cannot be enabled is a `warning` on the result and a `release: WARNING` line, not `blocked`: the publish
  already succeeded. The PR number is in the step result (`sync.pr`) and the final line.
- Every exhausted bound returns `{blocked}` (exit 3). The runner does not mark the step done, so `--resume <id>` retries it;
  every sub-step is idempotent. Bounds are overridable with `ctx.config.postMerge` (tests use tiny ones; waits go through
  `io.sleep`, commands through `io.run`).
