---
issue: 5750
status: fresh
anchor: bin/lean/conformance.mjs
created: 2026-11-21
---

# ADR — Proposed-change sentences freeze as a `guidance` disposition; conformance judges only the outcome rows

## Decision

An issue sentence that prescribes how to fix something (rather than what must be observably true) is frozen as a requirement with disposition `guidance`. It needs a `why` naming the stance (`follow|adapt|reject`) and a reason, needs no deliverable, and is skipped by `precheck` and `decide()`. A contract with guidance rows must keep at least one binding row (`deliver|defer|post-deploy`); a prescription-only issue gets a `deliver` row with `derived_outcome`, or the planner asks for an outcome. The reviewer can flag a guidance quote `misclassified: true` when it is really a symptom or success criterion, which fails the review.

## Context

Lanes were judged on whether they followed the issue author's guessed fix. A lane that fixed the symptom differently failed conformance, and one that followed the guess but missed the symptom could pass.

## Options considered

- **New disposition `guidance` (chosen).** `DISPOSITIONS` is the single switch every gate already reads (validateContract, precheck, decide, reviewSkeleton, activation via `TRACKED`), so one new value plus a few `isGuidance` skips covers every gate, and older contracts are unaffected.
- **A `kind: outcome|proposal` field on requirements.** Rejected: orthogonal to disposition, so every gate would need to check two fields, and combinations such as `kind: proposal, disposition: defer` would need their own meaning.
- **Reuse `not-applicable`.** Rejected: `not-applicable` demands file:line evidence and still gets a judged `issue_coverage` row, and it means "the requirement does not apply", not "the requirement is advice the builder may reject".
- **An LLM judge of every outcome/proposal split.** Rejected (NORTHSTAR non-negotiables 1 and 2): the all-guidance case is detected exactly by a script; the remaining judgment rides on one reviewer field (`misclassified`) in the existing review call.

## Consequences

`derived_outcome` travels on the deliver row and is judged like `amendment.text`. Guidance rows render with their stance and reason in the review table and are excluded from the issue-coverage count.
