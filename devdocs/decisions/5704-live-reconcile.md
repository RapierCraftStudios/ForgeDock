# 5704: live reconcile (merged, promoted, live, verified)

Context: with `release.managed` off nothing re-checked or closed a `workflow:merged` issue after a release. "Merged", "promoted" and "live" were not told apart: `probe.mjs` and the parked sweeps infer "live" from ancestry of `origin/<default>`, the probe labels were one-way, and a remediation merge posted nothing (AlterLab#40851).

Decisions:
- Live SHA, not default-branch ancestry. `bin/lean/live-reconcile.mjs` reads the deployed SHA from `deploy.live_release_command` (`.forge/release.yaml` on the default branch, else forge.yaml `deploy.engine`) through `readTarget`. Main ahead of a failed deploy (release #40906) must leave its issues open with `awaiting-promotion`.
- Fail closed (K3). An unset command, a failing command, or a live SHA missing from the clone is a no-op. An unresolvable fix commit is skipped and reported. A named check missing from the checks file keeps the issue open.
- Helper-level reuse of #5562 (K1). `verifiedMarker`, `hasVerified`, `readTarget`, `checksAt`, `runNamedChecks`, `tickItems` and `addMonitoringLabel` are shared, so managed and unmanaged modes write one marker and run one check implementation. `closeIssues` and `verifyStep` are not called: they need the managed release ctx, state and fence (`release-verify.mjs` `closeIssues`), which do not exist in unmanaged mode.
- Wiring (K2). `reconcileLive` runs from `probe --due`, which the schedd timer already runs after releases, and on demand as `forgedock close reconcile [--dry-run]`. No new scheduler or deploy hook.
- A failing check adds `post-deploy-failed` and comments the output; the issue is never closed and later passes skip it until a person or a new fix clears the label. The "reopen into the remediation queue" alternative was not taken: the issue is already open and the label is the queue signal.
- Positive evidence: a checks-file entry may carry `expect`, a command that must also exit 0 after `run` passes.
- The remediation merge posts `FORGE:TRACKED kind=remediation`. The reconcile does not count it as a hand-off; any other FORGE:TRACKED with no checks keeps the issue open.

Rejected:
- Closing on default-branch ancestry: main is not live.
- Calling `closeIssues` with a synthetic ctx: it would fake a release lease and fence.
- A new deploy webhook or timer: `probe --due` already runs after releases.

Out of scope: `parked-sweep.mjs` and `prefilter.mjs` still infer promotion from default-branch ancestry for parked follow-ups; the AlterLab `postdeploy-40851-4xx-memo.sh` script (R16, another repo).
