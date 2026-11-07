# 5208: the release is one resumable job

The staging to default release was a manual procedure (PR, review panel, findings, gate, merge, publish, version sync).
`forgedock release` (`bin/lean/release.mjs`) runs it as ordered steps: preflight, release-pr, review, fixes, promotion,
post-merge. Decisions:

- State is `state.json` under `~/.forge/releases/<id>/` (`FORGEDOCK_RELEASE_DIR`), written with `writeAtomic` from
  `batch.mjs` (tmp, fsync, rename; tmpfs refused). A step is marked done only when it completes; `--resume <id>` skips done steps.
- Every effect goes through an injected `io` (gh, batches, lanes, clock), so steps are unit-tested without a network.
- Preflight refuses (exit 1) while lanes of the repo run or PRs to the staging branch are open, then sets each unfinished
  batch of the repo to K=1 through `orchestrate --set-parallel`. The previous K is saved in the state and restored when the
  run ends (done, refused, stopped, blocked or thrown); a killed job restores on resume.
- Promotion is opt-in. Without `--merge` or `release.auto_merge: true` it stops at GATE_PASS and prints the merge command.
  With either, it merges with `--match-head-commit <head>` only when `forge/deploy-gate` is success at that head.
- Review/fixes (`release-review.mjs`) and post-merge (`release-postmerge.mjs`) are stubs returning a blocked result (exit 3)
  that points to the manual path. Parts 2 and 3 (#5212, #5213) fill them in without touching `release.mjs`.
