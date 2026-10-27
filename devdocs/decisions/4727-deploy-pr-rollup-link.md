# 4727 — the deploy PR links the post-deploy rollup

`commands/deploy-pr.md` (2B) appends `Post-deploy checklist: #N` to a staging → default deploy PR body.
`scripts/postdeploy-rollup-link.sh` resolves N deterministically: the lowest open, trusted, non-PR issue carrying `FORGE:POSTDEPLOY_ROLLUP: <FORGE_RELEASE_LANE>`, using the filer's search and trust rule (#4724).
No rollup or a failed lookup prints nothing and exits 0, so a missing link never blocks a deploy.
Deferred: the deploy-green lane that ticks rollup items with evidence and files issues only for failures.
