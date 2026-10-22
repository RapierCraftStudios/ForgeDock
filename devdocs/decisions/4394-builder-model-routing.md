---
issue: 4394
status: fresh
anchor: bin/lean/routing.mjs
created: 2026-10-23
---

# ADR: route the builder model by the frozen contract's class

## Context

Implement is about 96% of lane spend and review about 4%. Every builder call runs on the top model, including docs-only, config-only and one-file changes that a mid-tier model handles. Nothing records which model built a merge, so there is no way to compare tiers before changing the default.

## Choice

- **Class from contract paths:** `bin/lean/routing.mjs` classes a lane from the frozen contract's deliverable paths (risk, docs-config-test, small ≤2 non-test files, large). The contract is the first deterministic fact set of a lane (NORTHSTAR non-negotiable 1). So the route is computed after the plan, and the plan stays on the top model.
- **Plan on top:** the plan and contract-correction calls keep `builderModel`, because the plan's quality is what the class is read from.
- **Default on:** `lean.builder_routing` defaults to `on` with mid model `claude-sonnet-5-5`, and `off` restores today's behaviour. A per-tier comparison needs mid-tier lanes, and the 2-week no-regression check on `forgedock stats --tiers` is the post-deploy gate on this default.
- **Escalation on validate rounds only:** a failed `precheck`, `ci_red` or `merge_ci` round on the mid tier switches that round and every later builder call to the top model, once. It adds no round (#4366 rejects rework caps and new loops).
- **Reuse `review.risk_paths`:** declared risk globs come from `review.risk_paths` plus the built-in risk words (`riskClassOf`), the same facts the review trigger and risk-path enforce use.
- **Record the tier:** `RUN_TERMINAL` carries `builder_tier/class/escalated/model`, so every merge records its model.

## Rejected

- **LLM triage of size:** a model call to guess what the contract already states as paths; non-deterministic and not free.
- **Size labels (`size:S/M/L`):** not set on most issues and not checked against the change. The contract's paths are.
- **Routing the plan:** the plan defines the contract the class is read from, and a weak plan costs more downstream than it saves.
- **A new risk-glob key:** it would duplicate `review.risk_paths` and drift from it.
- **Built-in word `detection`:** it is specific to one target repo. That repo declares it in its own `review.risk_paths`.
- **Shadow mode (record the would-be tier, keep top):** it produces no mid-tier data, so the comparison the issue asks for could never run.
