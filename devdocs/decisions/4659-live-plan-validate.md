# 4659: live dependency-order validation

`scripts/plan-validate-live.mjs` applies the bootstrap validator's forward-milestone rule to live GitHub state (`forgedock plan validate --live`) and gates parallel milestone starts in `forgedock orchestrate` (`--force "<reason>"` bypasses and is recorded as `forced` in the batch plan).

- Train order is derived: milestone `due_on` ascending (nulls last), then milestone number. GitHub has no explicit order field.
- Edges: `ok` (earlier milestone, dep closed), `held` (earlier, not closed), `invalid` (dep in a later milestone). Only `invalid` fails the command.
- Start gate: a dependency outside the batch must be closed by a merged PR whose base is the issue's lane, or whose merge commit is an ancestor of the lane (`git merge-base --is-ancestor`, e.g. it arrived through a milestone sync); a refusal names the missing commit. Admitting and holding unmet issues instead of refusing is tracked in #5031. Unreadable issues are skipped (fail open); an unreadable dependency counts as unmet. Resumes are not re-gated.
- Deterministic, no LLM; `Depends on` lines are read with `parseDependsOn` so the gate agrees with engine admission.
