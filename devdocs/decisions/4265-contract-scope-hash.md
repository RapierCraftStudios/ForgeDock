---
issue: 4265
status: fresh
anchor: bin/lean/lean.mjs
created: 2026-10-20
---

# Decision: the frozen contract records the issue scope it was planned from

## Context

AlterLab #36229 parked as needs-human twice. A rerun recovered the FORGE:CONTRACT frozen before an owner comment extended the scope, then judged the current scope against it. Every lease renewal (FORGE:STATE in the body) and engine comment was also logged as "Issue edited during the run", so the one real scope change looked like noise.

## Choice

- `conformance.mjs` `scopeText`: title + body + trusted comments, without HTML-comment blocks and without comments that start with `<!-- FORGE:`. Its hash (`contractHash`) is the edit signal (`refreshIssue`) and the contract's provenance.
- The FORGE:CONTRACT `<summary>` carries it: `contract.json (sha256 H, issue S)`. The contract hash itself is unchanged, and old comments still parse (`scope: null`).
- Rerun: recover only when `S` equals the current scope hash. A legacy contract is recovered only if no trusted human comment came after it and every `deliver` quote is still in the issue. Otherwise re-plan (one plan call) and freeze a new contract, which is the latest comment and wins on the next rerun.
- Any new or edited trusted human text counts as a scope change. A false positive costs one plan call. A false negative cost a whole lane ($7.89 over two lanes in #36229).

## Rejected

- **Issue `updated_at` / body edit time:** they move on the engine's own FORGE:STATE writes.
- **Hashing the full text (the #4188 behaviour):** the engine's own writes make the signal fire on every run.
- **An LLM judging whether a comment changes requirements:** a hash is a fact (Deterministic first). The extra plan call is the cheaper side.
