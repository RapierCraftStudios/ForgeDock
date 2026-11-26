# 5909: plan-lane verdict ends settle the issue

`settleLane` in `bin/lean/orchestrate.mjs` used to treat every non-`planned` plan-lane end as `plan-failed` and requeue the issue for a build lane. That discarded real verdicts (`invalid` closes the issue, `needs-human`).

Now a plan lane ending `invalid`, `needs-human`, `decomposed` or `budget-exceeded` (`PLAN_VERDICT`) logs `STACK_PLAN_FAILED` with the reason, is not requeued, and settles through the normal final-row path, so dependents and `SATISFIED` handling work as for build lanes. Other non-`planned` ends (engine-error, dependency-open) still emit `plan-failed` and requeue. Plan lanes still never count toward the breaker or engine-error relaunch.
