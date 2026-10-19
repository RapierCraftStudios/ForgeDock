---
issue: 4167
status: fresh
anchor: bin/lean/verify.mjs
created: 2026-10-19
---

# Decision: opt-in verify-by-CI before review, with a builder fix loop

## Context

On the AlterLab host (4 cores, 16 GB), lane-local verification (`tsc` ~2 GB per run, `eslint`, `pytest`, docker test DBs) took ~4.4 GB and ~220% CPU. That held concurrency to about 6 lanes behind the admission ceiling. AlterLab's feature→staging PRs get no CI, and staging has no required checks, so the core engine merged right after review. Four deploy PRs in a row (#36037, #36051, #36058, #36067) then failed on lock files, suite wiring, a hang and formatting.

## Choice

`forge.yaml verify.mode: ci|hybrid` (default `local`, no change). The engine pushes the lane branch and runs the repo's CI on GitHub runners: either a `workflow_dispatch` workflow scoped by changed paths, or the head commit's push checks. This happens before every conformance review. Failed-job log tails go back to the same builder session for up to `max_rounds` fix rounds. A verified head lets the precheck accept validate ids the builder left to CI. Docs-only changes (`skip_paths`) skip CI. Slow CI ends `ci-pending`. If CI is unavailable, there is one local fallback.

## Rejected

- **Always-on CI verification.** Operator rule: GitHub Actions minutes before review are not assumed to be available (quota, plus wall time multiplying). It stays opt-in per repo.
- **Reusing the post-review merge wait (`merge_wait: all`).** A red result there is `needs-human` and never reaches the builder. It runs after review, so a fix would land on an unreviewed head. With no required checks it is skipped altogether.
- **`scripts/ci-local.sh`.** It scopes CI checks well, but it still runs them on the host, which is the cost this issue removes.
- **A separate CI-fix agent.** The builder session already has the context. A resume costs less than a cold agent (NORTHSTAR: an agent is the last resort).
