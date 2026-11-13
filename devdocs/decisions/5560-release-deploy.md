# 5560: release deploy stages (MERGED to LIVE)

Context: `forgedock release` ended at merge plus publish; a deploy workflow that concluded `success` without changing live
(DEPLOY_FREEZE skip, superseded run) counted as done (epic #5549, Phase 3, I9/I26/I28).

Decisions:
- `deploy` is a new optional step after `post-merge` (`bin/lean/release-deploy.mjs`). It runs only when the default-branch policy
  has `deploy.pipelines`; otherwise `{skipped}` and no trace, so unconfigured and unmanaged releases are unchanged.
- The policy `deploy` block reaches `runRelease` as `config.deploy` (and `config.deployPipeline` from `--lane`) from `releaseFromCli`, read through `readPolicy` (default branch only, I13).
- Observe-then-act: progress is `state.deploy` ({phase, target, runId, attempts, reruns}); the run is looked up by `(workflow, head sha)` before any dispatch, dispatch and rerun go through `fenced()` + `buildDispatchArgs` (epoch, hold, no break-glass input).
- I9: the rollback target (`deploy.live_release_command` output, JSON `{sha, images}` or a bare sha) is read with `io.rehearse` and frozen before dispatch; unreadable means `{blocked}`.
- I28: after the run finishes the live record is read again; `success` with live not equal to the merge sha (or `deploy.expected_digests_command` digests) is a failed deploy. A freeze newly set by the run also fails LIVE_CHECK.
- I26: while the freeze variable is set the engine never reruns or redispatches; it blocks and leaves `override_freeze` to a human.
- Pipeline kinds: a pipeline with `trigger: dispatch` (service/hotfix lanes, chosen by `--lane` through `lanes.<lane>.pipeline`) dispatches at once with its unit inputs and `forge_epoch` (after one look for an existing run, so a resume never dispatches twice); `full` observes the push run and dispatches after `start_timeout_s`. A `skipped` run is not a run; a `cancelled` run with a newer run in the workflow is a concurrency supersede (expected, never rerun); any other cancelled run is LIVE_CHECKed first and rerun only when transient.
- Recovery: `gh run rerun --failed` only for a `failure`/`timed_out`/non-superseded `cancelled` run whose log matches `release-flakes.mjs` `INFRA_SIGNATURES` or `deploy.recovery.signatures`, bounded by `rerun_max` (2) and `max_attempts` (3); counted before the act, so a crash can only spend budget. A deterministic build failure or a migration failure is never retried: `{blocked, hold:{kind, label:"needs-agent"}}` with an owner ask. Spent budget hands off to the rollback ladder (#5563, not built here).
- Intent keys are `(release, step, epoch, action)` (`idemKey`), so the write-ahead intent names the epoch and a takeover epoch never reuses a key.
- Verification (layers, `FORGE:VERIFIED`, close-after-verified) is #5562: VERIFYING is a bare transition to LIVE here.
- Out of scope (deferred): rollback ladder and incident PR, conductor, SLI soak, CLOSING/SYNCING, AlterLab workflows. The publish run still treats `success` as sufficient (no live record there).
