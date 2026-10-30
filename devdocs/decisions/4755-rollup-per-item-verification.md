# 4755 — the post-deploy rollup is verified per item

R11 (deferred from #4727): when the deploy goes green, one read-only lane works through the rollup, ticks items with evidence and files issues only for failures.
The lane already exists: the #4389 gate releases a rollup once every parent's fix is on the default branch (optionally `post_deploy.precondition_cmd`), and `measureFollowup` runs default-branch checks with no model call and no lane.
Its gap was all-or-nothing handling: one check-less or failing item parked the whole rollup and nothing was ticked.
For a rollup (`FORGE:POSTDEPLOY_ROLLUP` in the body, no windowed check) `measureItems` now ticks each passing item (evidence: the FORGE:PROBE record), files one issue per failing check, posts one owner ask for check-less items, and closes only when every item is ticked.
A check a PROBE record of the same fix failed is not re-run; a new parent changes the fix set and re-runs it. Non-rollup and windowed follow-ups are unchanged.
