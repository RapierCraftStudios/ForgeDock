---
issue: 4397
status: fresh
anchor: bin/lean/verifier.mjs
created: 2026-10-23
---

# ADR: an opt-in independent adversarial verifier after a conforming review

## Context

The lean conformance reviewer (`bin/lean/prompts.mjs` `reviewerPrompt`) reads the builder's `result.json` as `<builder_result>`. Since #4374 it also answers the same `REVIEW_RUBRIC` the builder self-reviews with. It runs on a Claude model that nothing keeps apart from the builder's. The #4149 replay bench had the shipped reviewer pass 22 of 23 diffs and flag no real bug, while a judge asked a specific falsifiable property found every seeded defect. Review is about 4% of spend.

## Choice

`bin/lean/verifier.mjs` adds one read-only call, gated by forge.yaml `review.verifier: off|shadow|enforce` (default `off`). It runs only after the precheck and the reviewer conform, and at most once per head SHA.

- **Inputs:** the issue, the contract, the diff, and the callers of the changed functions. Callers come from the repo's own `git grep -w`, a deterministic fact. It never sees the builder's result, notes or session.
- **Model:** never the builder's (`pickVerifierModel`).
- **Prompt:** adversarial (boundary inputs, the issue's baselines, callers, a repro test that cannot fail). Only findings at a tracked `file:line` count.
- **Enforce:** findings become `conformance.regression` failures for the existing conformance fix round, a fresh session because they cite `file:line`. The one-resume budget does not change.
- **Spend:** bounded by diff size (`verifierBudget`: wall clock and turns). An empty diff makes no call, and there is no repair re-ask.
- **Measurement:** `VERIFIER` events carry the verifier/implement cost ratio, and `node bin/lean/verifier.mjs` reports it.

## Rejected

- **Default `shadow`:** it adds one LLM call to every lane before anything shows it removes rework. That breaks NORTHSTAR non-negotiable 2 and the anti-goal of extra review passes as the default fix. `review.trigger` defaults to shadow only because it costs nothing.
- **Strip `<builder_result>` from the existing reviewer:** the reviewer needs the builder's validation output to fill `validated_by`, and `decide()` inputs would change.
- **Cross-vendor model:** the lean runner drives only the `claude` CLI (`bin/lean/effects.mjs`). "Different model" is a different Claude model id until a non-Claude backend exists.
- **Repair re-ask or several verifier passes:** unbounded spend. An unparseable reply is no findings.
- **Verifier before or instead of the reviewer:** a change that already fails is headed for a fix round, so verifying it wastes tokens.
