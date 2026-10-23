---
issue: 4396
status: fresh
anchor: bin/lean/decompose.mjs
created: 2026-10-23
---

# ADR: gate builder decomposition on independence and size

## Context

The engine filed every typed `split-required` block (#4124) without checking it. AlterLab#36614 was split into
#36626–#36629. All four touched alert routing, and each sub-lane rebuilt the same context: $3.76 + $9.20 + $7.00 +
$19.80, plus the parent's own lane. One lane with a checklist would likely have cost less. Nothing recorded why a
split happened, and the batch report could not compare costs.

## Choice

- Gate deterministically on facts the builder declares in the block: `paths` per sub-issue, and an optional `size`
  `{files, lines}` for the whole change. A split is admitted when the parts are disjoint (no path equals or sits
  under another part's path) or when the size exceeds 25 files or 1500 lines.
- The lean engine has no "L turn budget". `--max-turns` exists only in the legacy runner. The thresholds are
  constants in `decompose.mjs` and can be tuned against the new report line.
- A rejected split is an `untyped` block. It reuses the existing single corrective resume, which asks for one lane
  with an ordered checklist and a validate per item. There is no new phase, outcome or loop.
- The rationale goes on `FORGE:DECOMPOSED`, the decision line and the lane result. The batch report compares $/parent
  of decomposed parents (parent plus sub-lanes) with merged single-lane parents.

## Rejected

- An LLM judge of independence: a new call for a fact that the declared paths already give (NORTHSTAR 1–2).
- A new planning phase that drafts the checklist: the builder already writes the contract.
- Refusing every split: a genuinely oversized or disjoint epic still benefits from parallel lanes.
