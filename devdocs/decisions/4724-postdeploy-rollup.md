# 4724 — one post-deploy rollup per release lane

Deferred contract rows carry a `bucket` (post-deploy, verify-now, date:YYYY-MM-DD, owner:<action>, new-issue), decided at contract time.
`scripts/file-deferred-followups.sh` appends class post-deploy items to a single open issue per release lane (`FORGE:POSTDEPLOY_ROLLUP`, lane from `FORGE_RELEASE_LANE`) under `### #<root parent>`.
Item text is deduplicated on its normalized form across parents, `DEFERRED_FROM` chains resolve to the root parent, owner items never enter the rollup, and `DEFERRED_TELEMETRY` carries per-bucket counts.
verify-now items keep a per-parent issue so the gate releases them at once; engineering, external and ops filing is unchanged.
