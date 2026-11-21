---
status: fresh
anchor: bin/lean/mergetrain.mjs
created: 2026-11-21
---

# ADR: lanes exit at PR-ready and a batch merge train merges (phase 1)

## Context

From PR open to merge takes 27 min p50 (81 min mean), which is 46% of an issue's lifecycle. During that time the lane holds its admission slot and polls CI in `bin/lean/lean.mjs` step 7. Base-sync ran in 151 of 279 runs. A slot is the scarce resource, because it caps builder sessions on the host. A lane that only waits on CI spends a slot without doing any work.

## Decision

- forge.yaml `orchestration.merge_train: off|on` (default `off`). When it is on, `forgedock orchestrate` passes `mergeTrain` to every lane (`--merge-train` for spawned and remote lanes) and builds one train for the batch (`bin/lean/mergetrain.mjs` `makeMergeTrain`).
- **Lane exit criteria.** A lane ends with the new terminal reason `pr-ready` (code `awaiting_merge`) when all of these hold:
  - the PR is pushed;
  - review passed;
  - the lane has reached the step-7 CI wait and its required checks are pending, not red and not green.
  
  At that point it returns `{pr, head, required, policy, lane, defaults, structure}`. A red check still gets the lane's own CI fix round first, because only the lane has the builder session. A lane whose checks are already green merges itself, which costs no wait. Only a plain merge is handed over. The following keep the lane waiting as before, because their merge-time work needs the lane's in-memory state:
  - a `refactor:split`;
  - an e2e gate;
  - numbered sequence files (late binding needs the sequence lease);
  - pending follow-ups, `FORGE:DECISION` records or supersessions;
  - a partial or left-open close.
- **Train state.** The runner keeps a `train` map (issue -> `{pr, head, lane, required, policy, since, syncs, cost, minutes}`) in the batch `state.json`, which it saves atomically. An entry has no slot, is not pending and has no final row. Its dependents wait, and the batch does not end while the map is non-empty. A batch that stops on a cancel or the breaker reports the entry as a `pr-ready` row, and `--resume` continues it.
- **Train loop.** The runner calls `step(entry)` for each entry in FIFO order every `pollMs` (60 s). A pass merges at most one PR per lane base. One `step` reads the PR once (`gh pr view`), and `trainVerdict` decides:
  - green and clean: merge with `gh pr merge --merge --match-head-commit <reviewed head>`, unless the release merge hold (#5709) applies;
  - green but `BEHIND`: `gh pr update-branch`, which adds a merge commit and never rebases. CI then runs again. After 5 syncs the entry is handed back as `base.conflict`;
  - red (a required check, or a DCO check): `needs-human` `ci.red`, with the failing checks and their URLs;
  - conflicting: `base.conflict`;
  - a head the train did not record: `merge.head_mismatch`, because the train never merges an unreviewed head;
  - still pending after 360 min: `ci-pending`.
- **Hand-back.** A hand-back goes through `settleLane` like a lane end. In-batch recovery therefore requeues a fix lane (`--recover ci.red` / `base.conflict`) under the class budgets. That lane resumes the PR, fixes it, and ends `pr-ready` again. A hand-back that is not recovered is labelled `needs-human` once, with the train's evidence. A recovery that later merges through the train is reported as `recovered`.
- **After the merge.** The train posts a `FORGE:MERGE_TRAIN` comment, closes the issue as completed (unless another own PR is open), sets `workflow:merged`, clears the pipeline labels and deletes the lane branch. It does not delete a protected branch, or a branch that another open PR is based on. The row is `merged` with the lane's cost and minutes plus `train: {result, waited_min, syncs}`. Drift, integration and lifecycle see it as a lane merge.
- **Report.** The batch report adds a `merge train:` line: merged count, handed back by code, train wait p50, base-syncs, and the count still PR-ready.

## Consequences

- A slot is free from PR-ready on. At equal parallelism, throughput should rise by roughly the share of lane time spent in the CI wait. To measure it, compare merged issues per hour and `phases.ci_wait` before and after on a batch with `merge_train: on`.
- Required checks and branch protection still gate every merge: GitHub refuses a merge that protection blocks, and the train keeps waiting. The train only adds the reviewed-head match and update-branch for strict protection.
- The train does not re-run the lane's local post-merge gate (#4406) after update-branch. CI on the merged head is the gate. A conflict always goes back to a lane, which owns the builder.
- The merge-time `FORGE:STATE` lease is released at `pr-ready`. Dependents outside the batch use the PR-ancestry rule (`mergedTo` is on the row, not on `FORGE:STATE`). The post-merge `FORGE:GUARD` is not posted for train merges yet.

## Rejected

- **Keeping the lane process alive as a cheap waiter that does not hold a slot.** It saves the slot but keeps one process per PR and one CI poll loop per PR. It also cannot batch or bisect later.
- **Having the train relaunch the lane to merge.** A resumed lane re-runs the build and review path, which costs more than the wait it saves.
- **Batching and bisection now.** That is phase 2: validate several PR-ready PRs as one merged tree, bisect on red and return only the culprit.
