# 5565: the managed P0 lane

A production fix (p0) branches from the **live sha** (`deploy.live_release_command`), never the default branch (I10).
`forgedock release p0 <#issue | --branch B> [--units a,b] [--preempt] [--yes]` deploys it through the `hotfix` pipeline
(#5560 step runner, #5562 verification, #5563 rollback on failure), then opens the landing PR to the default branch.

- `laneStartGuard(ctx, lane)` (`bin/lean/release-p0.mjs`): fast lanes (train) refuse while default != live (live is an ancestor of
  the default branch and the trees are identical); p0 is exempt and records the divergence in `_active.p0` (#5570 calls this guard).
- WAVE_DONE (I11): a p0 wave is done only once the landing PR is merged and live == default.
- RECUT: `recut` merges the default branch into `release/<id>` as one recorded `main-sync` pick; the release merge refuses unless
  the default branch is an ancestor of the head.
- One deploy at a time: `claimDeploy` sets `_active.deploying`; a p0 queues behind it and only `--preempt` cancels (audited as `p0-preempt`).
- Budget never blocks a p0 (I14). The engine never sets `acknowledge_hotfix_revert` or `override_freeze` (I26).
- No new forge.yaml keys. Drill and wall-time are post-deploy check `release-p0-drill`.
