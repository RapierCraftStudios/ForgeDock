# 6122 / 6123: decisions reset the repeat count; env re-admits back off

## Context
- #6122: a lane parked with `failure.repeated`, a `FORGE:DECISION` was posted and the issue requeued, and the next run parked again with the same text. `countIdentical` counted every earlier NEEDS_HUMAN/PARKED of the same signature regardless of decisions posted after them.
- #6123: an issue held on an `env.*` gap was re-admitted when its env issue closed or the tool probe passed, re-parked on the same signature, and looped every ~4 minutes.

## Decision
- `bin/lean/failure-stop.mjs` `countIdentical`: comments are chronological; a trusted `FORGE:DECISION` (not the engine's own "no needs-human" premise note) resets the count, so only identical failures after the newest decision count. An identical failure after the decision still parks. A requeue with `--reason` and an issue-body edit leave no GitHub comment today, so they are not detected here; a decision comment is the supported reset.
- `bin/lean/orchestrate.mjs`: a re-admit caused by env-issue closure or the tool probe is recorded per issue with its signature. If the lane re-holds on the same signature, `envHold.notBefore` is set to 15 m, then 1 h, then 4 h ahead (`ENV_READMIT_BACKOFF_MS`); those two triggers are ignored until then. Engine version change and `--set-env` still re-admit at once (real input changes). A different signature clears the record.

## Not done
- The probe still runs on the orchestrator host; checking the host that will run the lane (remote image) is left to #6106.
