# 5712: deploy stage engine (resumable stages, smoke before traffic, changed services only)

Context: `deployStep` (#5560) treats a deploy as one workflow run. Baseline over 21 days of one production repo (48 deploy
runs): 24 of 38 attempts never reached live, three releases in a row failed on the same smoke assertion and each paid a new
release PR, full CI and a full deploy; the deploy job takes 46.7 min, about 12.8 of it redeploying ~20 unchanged services;
users reach the new version at minute 44 and smoke runs after traffic has moved.

Decisions:
- A new module `bin/lean/deploy-stages.mjs`, entered from `deployStep` after the rollback target is recorded (I9), only when
  forge.yaml `deploy.engine.enabled` is true (`ctx.config.deployEngine`). Off: `deployStep` is unchanged (no extra call).
  `readEngine` makes no git call unless the working copy turns the engine on; then the default branch's forge.yaml wins when
  the file is tracked there (I13). The block lives in forge.yaml (vendored js-yaml), not `.forge/release.yaml`: it is an
  opt-in switch per repo like the other workstream blocks, and it works for an unmanaged release (`live_release_command`
  falls back to the engine block).
- Data model. A stage is `{id, kind, run | workflow, inputs, needs, services, check, outputs_command, timeout_s}`. A checkpoint
  is `{key, parts, status, outputs, sha, release, at, ms, attempt}`. `parts` are five hashes: the stage definition, the git
  blobs at the deploy sha matching `inputs` (default `**` = the tree id), the service slice (stages with `services: true`),
  the outputs of the stages it needs (default: all earlier stages; a needed stage that declares no outputs contributes its
  own key, so its changed inputs are never invisible downstream), and the baseline (rollback target sha + new colour).
  The key is the hash of the parts. Outputs are the last stdout line when it is a JSON object, or `outputs_command`.
- Skip rule: checkpoint `done`, same key, and the optional read-only `check` passes. A failed `check` means the environment
  drifted: that stage and every later one run. Everything else is independent, so a smoke-fix commit re-runs smoke only, and a
  rebuilt image with the same digest does not redeploy the idle colour (propagation is through outputs, not "upstream ran").
- Durability. Checkpoints are in `state.deploy.stages` (mirrored to the release ledger with the state). A managed release
  also writes them to `_active.deploy_stages` (`updateActive`, own key), so the next release starts from what the failed one
  finished. The baseline part makes them worthless once another release went live. A unit or full rollback clears them
  (`clearStages` from `runRollback`). After a shift-back or abort the records stay with status `rolled-back` / `aborted`, so
  the attempt count survives and a workflow stage is dispatched afresh.
- Execution reuses the existing hooks: `io.rehearse` for commands (environment passed as an `export` prefix, since the hook
  takes none), `dispatchOnce` (the generalised `dispatchRung` of release-rollback.mjs: baseline run id, fenced dispatch with
  `forge_epoch`, never redispatched for the same attempt) for workflows, `fenced()` for every mutating command, `readTarget` /
  `liveMatches` for LIVE_CHECK (I28), `verifyStep` for the verification layers, `freezeValue` (I26: no stage while frozen).
- Traffic position decides what a failure means. Before the first `shift` stage: nothing moved, the old colour serves, the
  result is `{blocked, preTraffic}` with no hold, no rollback trigger and no freeze; optional `rollback.abort_command` tears
  the idle colour down. From the shift up to (not including) `retire`: `rollback.shift_back_command` with
  `FORGE_TRAFFIC_PCT=0`, timeout `rollback.budget_s` (60), result `{blocked, rolledBack}`; if it fails or is unset the ladder
  trigger (#5563) is emitted as today. From `retire` on: hold for a roll-forward (`needs-agent`). A verification layer that
  blocks without a rollback verdict (a run not finished, identity/transport) is a wait, not a failure.
- Validation (`validateEngine`) is closed and structural: a `verify` stage is required (no weaker gate: LIVE_CHECK and the
  layers always run), a `smoke` stage must precede the first `shift`, `retire`/`contract` come after `verify`.
- Changed services only. `diffServices(desired, live)`: unchanged needs the same digest and the same config hash on both
  sides; anything missing is changed. `services.mode`: `shadow` (default when a `desired_command` exists) deploys everything
  and records `would_skip` plus `agreement` (those services still equal the desired set after the full deploy); `enforce`
  passes only changed services (`FORGE_SERVICES`) and skips service stages when nothing changed. `ctx.promote`
  (`serviceDigests(sha)`, `liveDigests()`, `canPromote({service, digest, sha})`) replaces the commands when the build-once
  workstream provides it; a refused `canPromote` blocks before any stage.
- Canary: `deployRisk` = `riskOf(deriveFacts(policy, files target..sha))`; unreadable diff = high. Defaults: low `[100]`,
  medium `[10, 100]` wait 120 s, high `[10, 50, 100]` wait 300 s; `canary.<class>` overrides. Step progress is kept in
  `state.deploy.engine.shift`, so a resume never restarts a wait.
- CLI: `release deploy --plan [<id>] [--sha]` is read-only (`planStages`). `release deploy --resume <id> [--sha]` validates
  and then runs the normal release job for that id (lease, fence, holds, ledger mirroring all as before); `--sha` must be on
  the default branch and contain the release merge (a fix that landed through its own PR), and is deployed under the same
  release record with the same rollback target.
- Conductor: stages are host-side, so a release the engine started is never continued by the workflow pipeline; on a host
  without the engine `deployStep` returns a hold (`needs-agent`), which the conductor turns into hold + issue.

Idempotency contracts (also `KINDS` in the module, printed by `--plan --json`):

| Kind | Contract |
|---|---|
| build | Content-addressed: the same inputs give the same image digests; a re-run changes nothing that serves. |
| migrate | Expand only (additive, compatible with the old colour); the migration tool skips what is applied. |
| deploy | Converges the idle colour to the given digests; never touches the serving colour or the router. |
| smoke | Read-only against the new colour's own address; no traffic, no production writes. |
| shift | Sets the new colour's share to `FORGE_TRAFFIC_PCT`; the same share again is a no-op. |
| verify | Read-only; a passed verification layer is not repeated. |
| retire | Stops the old colour; a no-op when already stopped. No instant shift-back after it. |
| contract | Destructive migrations, only after retire; the migration tool skips what is applied. |
| run | Declared by the repo: safe to run twice. |

Lease: the engine heartbeats the release lease before each stage and every 60 s of a canary wait, and stops when another
host holds it. A single command stage longer than the conductor TTL (900 s) cannot heartbeat (the command hook is
synchronous): with `controls.conductor.enabled`, use a workflow stage for it or keep stages under the TTL (follow-up).

Failure modes: unreadable checkpoints block (I5); an invalid block blocks (never falls back to the workflow pipeline); a
crash mid-stage leaves no checkpoint, so the stage runs again (its contract) and a workflow stage observes its run; a stale
`_active.deploy_stages` after a failed clear is caught by the baseline part or a stage `check`.

Measured by: `state.deploy.stages.<id>.ms` and `attempt`, `state.deploy.engine.started_at` / `traffic_at` (time to first
traffic), `state.deploy.services` (`skipped` or `would_skip` + `agreement`), `forgedock release deploy --plan <id> --json`
(stages skipped on resume).

Rejected: putting the block in `.forge/release.yaml` (closed schema, managed-only); "upstream re-ran" invalidation (redeploys
on a no-op rebuild); letting the conductor run stages (needs host access; follow-up for workflow-only stage sets); tearing
the idle colour down by default after a smoke failure (it is what makes the smoke-fix resume cheap).
