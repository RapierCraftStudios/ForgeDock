---
issue: 4304
status: fresh
anchor: bin/lean/orchestrate.mjs
created: 2026-10-20
---

# ADR: no batch recovery on the full path; the spec CI gates ignore forgedock/verify too

## Context

Delta pass 4 of the 1.29.0 staging review (#4291) left five LOW findings. Two of them needed a choice.

- SPEC-10: the batch requeued a full-path (`engine.path: full`) needs-human as a recovery lane. `run-issue` then threw on `--recover`, the lane was relaunched once, and it posted an extra `FORGE:NEEDS_HUMAN`.
- BUG-3 residual: `commands/deploy-pr.md` and `commands/review-pr-staging.md` read `gh pr checks` themselves, so a red `forgedock/verify` still sent deploy-pr to `/fix-ci`. The deploy-pr re-check after `/fix-ci` also queried fields that do not exist (`status`, `conclusion`), and its fallback of `0` passed the gate.

## Decision

- `orchestrateFromCli` turns recovery off when the resolved engine path is `full` and prints `recovery: off`. Recovery lanes and their `RECOVER_HOW` prompts belong to the core path. Rerunning a full-path issue on core would switch pipelines partway through an issue. The `--recover` throw in `run-issue` stays as the backstop.
- The spec gates filter `select(.name != "forgedock/verify")` on `--json name,bucket`, count `fail`/`cancel` and fail closed (`|| echo "1"`), matching `scripts/wait-ci-green.sh`'s default ignore list (#4298).
- The other fixes: the pre-filter cost is counted once on a recovery row; the context-pack cache key uses the scope-text hash plus the attempt count, not `updatedAt`, which the lane's own posts bump; and `wait-ci-green.sh --help` prints the whole header.

## Alternatives

- `--path core` on recovery lanes: a core recovery of a full-path run would mix two pipelines' state and prompts.
