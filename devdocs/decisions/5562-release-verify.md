# 5562: release verification and close-after-verified

Context: after LIVE_CHECK (#5560) a release went straight to LIVE and nothing gated issue closing on evidence (epic #5549, Phase 3, I19/I22).

Decisions:
- `bin/lean/release-verify.mjs` is the VERIFYING stage, called from `deployStep`. It runs only when the default-branch policy has a non-empty `verify` block; otherwise VERIFYING is the bare transition it was, so unconfigured releases are unchanged.
- Layers run in a fixed order (results, verification workflow, SLI soak, per-issue checks, flags off). Progress lives in `state.verify`; a resume re-runs no passed layer and the workflow dispatch reuses `runFor` (fenced, write-ahead intent, never repeated).
- I5: any input that cannot be read (run list, metric, issue, check registry) blocks the transition.
- Rollback is not built here (#5563). An SLI breach or a real smoke/edge/verify-workflow failure records `state.verify.rollback` and calls the optional `ctx.rollbackTrigger` sink. A smoke identity/transport failure gets one re-verify, then a hold: never a blind rollback.
- A convergence failure with deploy and smoke green is `released-with-convergence-failures`: one repair issue, no rollback, issues still verified.
- SLI soak reads an injected read-only `io.metrics({sli, minutes, sha})` returning `{baseline, current}`. Without it the layer is skipped and reports `sli: skipped (no host)`. Soak minutes: low 10, medium 20, full 30, p0 15, overridden by `lanes.<lane>.soak_min`.
- Checks come from `verify.post_deploy_checks_file` on `origin/<default>` (I13) and run once per id; entries with `for` are windowed and are filed as a comment on the open `FORGE:POSTDEPLOY_ROLLUP` issue, never blocking. Flag-gated features are observed off via `verify.flags[].off_command`; activation is never performed.
- I19: `FORGE:VERIFIED <deploy sha>` (an HTML comment, distinct from prod-watch's `fp=` form) is written on each included issue only after every layer passed. `closeIssues` closes (through `fenced()`) only an issue holding that marker for the deploy sha; `verify.close_requires: deployed` is the documented opt-out.
- I22: the module has no write path to production. `release-verify.test.mjs` scans its source for write verbs (ssh, scp, systemctl, docker mutation, SQL, kubectl mutation) and the scan is proven against seeded violations.
- Out of scope: the rollback ladder (#5563), conductor (#5564), AlterLab `verify-release.yml` / POSTDEPLOY fix, a read-only metrics credential in GitHub (D5).
