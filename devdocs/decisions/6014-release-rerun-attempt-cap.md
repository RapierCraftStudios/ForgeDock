# 6014: cap release-PR CI reruns at 2 per run

A release-PR CI run is rerun at most twice (`RERUN_ATTEMPT_CAP`, from the Actions `run_attempt`; attempt 3 is the last allowed). Past that, `attemptGuard` refuses.

- `bin/lean/release-flakes.mjs`: `attemptGuard` and the cap. `planRerun` applies it before the infra decision. `flakeEntry` gains optional `attempt` and `reuse_forfeited` ("deploy test reuse forfeited"), so the ledger `flakes.json` shows the attempt count and the downstream cost.
- `bin/lean/release.mjs`: `rerunInfraFlakes` records `attempt` on every rerun entry. A refusal by the cap is recorded as a visible `decision` entry and returned in `skipped`, so release-review holds for the owner naming the job.
- `bin/review-staging.mjs`: `rerunCancelled` reads the run attempt, skips capped runs and uses `gh run rerun --failed`. Capped checks stay cancelled, so the existing block fires instead of looping.

The cap is unconditional and stateless (GitHub's `run_attempt` is the register). Filing a new issue from this path is not done here.
