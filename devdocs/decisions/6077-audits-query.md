# 6077: `forgedock audits` query command

`forgedock audits [--repo R] [--version X | --since-version X] [--signature S] [--class C] [--active] [--json]` reads
FORGE:LANE_AUDIT issue comments (trusted authors only, via `isTrustedIssueComment`) and filters them with the pure helpers in
`bin/lean/lane-audit-query.mjs`. `--active` means active, not `fixed_in_later`, at the current version, grouped per signature
with count and lanes. The current version is the highest `engine_version` among fetched audits (or `--version`), so external
readers need no engine install. Read-only; `lane-audit.mjs` and `decisions` are unchanged.
