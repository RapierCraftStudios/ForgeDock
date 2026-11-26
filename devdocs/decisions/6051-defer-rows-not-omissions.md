# 6051: frozen defer/post-deploy rows are follow-ups, not omissions

- `bin/lean/conformance.mjs` `decide()`: an `issue_coverage` row that is not covered is skipped as `conformance.omission` when every contract row it names (by `contract_ids`, else by quote) is frozen `defer`/`post-deploy`; it is returned in `followUps`. A narrowed or missing `deliver` row still yields an omission.
- `autoPostDeployE2e` also converts metric / replay / production-measurement rows (`metricReplayRow`, e.g. "Metric: ... under X% over a real batch") to checkless post-deploy rows (outcome evidence), as #5468/#5524 do for e2e rows.
- An amendment citing a frozen decision id (D#/K#) present in `contract.decisions` is annotated with and judged against that decision instead of "amendment not accepted"; unknown ids behave as before.
- `bin/lean/prompts.mjs`: reviewer prompt states both rules.
