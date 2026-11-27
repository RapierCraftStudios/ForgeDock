# 6015: deploy failures are classified, filed once, and stopped after 2

Decisions (details in `5560-release-deploy.md`):
- `recover()` in `bin/lean/release-deploy.mjs` classifies the failed step with `classifyFailedStep` (`bin/lean/release-flakes.mjs`); only `infra` is transient. Secrets-decrypt, SSH, rehearsal and migration failures are never rerun on a log regex.
- One `release-blocker` issue per release+sha (`FORGE:DEPLOY_FAILURE` marker) is filed or commented before any rerun.
- A transient class is rerun once; after 2 recorded failures the step returns `{blocked, hold}` naming the issue. `deploy.recovery` cannot raise the cap.
- `rerunInfraFlakes` (`bin/lean/release.mjs`) skips deploy/rehearsal workflows (`isDeployWorkflow`).
