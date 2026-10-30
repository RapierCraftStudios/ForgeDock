# 4727 — the deploy PR links the post-deploy rollup

`commands/deploy-pr.md` (2B) appends `Post-deploy checklist: #N` to a staging → default deploy PR body.
`scripts/postdeploy-rollup-link.sh` resolves N deterministically: the lowest open, trusted, non-PR issue carrying `FORGE:POSTDEPLOY_ROLLUP: <FORGE_RELEASE_LANE>`, using the filer's search and trust rule (#4724).
No rollup or a failed lookup prints nothing and exits 0, so a missing link never blocks a deploy.
Deferred: the deploy-green lane that ticks rollup items with evidence and files issues only for failures.

V3 (`validate-spec-graph.sh`) failed on the base for two reasons, fixed here so the contract validate passes: `commands/review-pr.md` now says it re-reads the trusted FORGE:CONTRACT (the graph self-check needs a READS edge), and `commands/orchestrate/phase-4-execution.md` idempotently re-applies `workflow:engine-error` on the partial-work no-fallback path (the label had no `--add-label` transition).
