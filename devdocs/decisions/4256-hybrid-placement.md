---
issue: 4256
status: fresh
anchor: bin/lean/execution.mjs
created: 2026-10-20
---

# ADR: hybrid execution places each lane from facts

## Context

`execution.mode: hybrid` (#4253) was parsed but always ran lanes on the host. Most of a lane's host cost is its heavy validation (`tsc` ~2 GB per run, eslint, test suites; #4170 baseline). Its LLM phases mostly wait on the API. Shipping every lane to a sandbox bills cheap lanes, and keeping every lane local caps the lane count at the host.

## Decision

- Placement is a pure function, `placeLane`, over facts gathered by scripts:
  - the lane kind (issue labels);
  - the repo's expected validation weight (declared check commands classified by heavy.mjs, toolchain markers across ecosystems);
  - host headroom (the admission memory floor plus one heavy step);
  - `verify.mode`.
- `verify.mode: ci` keeps the lane local: its heavy validation already runs, and is billed, on CI runners, so a sandbox would bill it twice.
- Capacity is applied at admission, not in the pure function. In hybrid mode, a full `max_remote` or a budget refusal runs the lane on the host instead of waiting or stopping. `on_budget` keeps its meaning for `mode: remote`.
- The decision is recorded where it can be audited from GitHub alone: `placement: {where, reason, mode}` in the lane's FORGE:STATE (passed as `run-issue --placement/--placement-reason`) and a trajectory line. It is also kept in the batch row.

## Rejected

- An LLM placement call: the facts are deterministic, and a model call per lane costs more than a misplacement.
- Waiting for a remote slot in hybrid: a lane that can run on the host now is cheaper than an idle queue.
- Per-issue diff-size estimates: there is no diff before the lane runs, and labels plus repo toolchain are the facts available at admission.
- Passing the placement through the sandbox env: the env is scoped to `GH_REPO`, `FORGEDOCK_BATCH_ID` and allowlisted secrets (#4253).
