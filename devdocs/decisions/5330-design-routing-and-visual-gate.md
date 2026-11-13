---
status: fresh
anchor: scripts/visual-gate.mjs
created: 2026-11-12
---

# ADR: opt-in design routing and one visual gate shared by the lane and the staging review

## Context

User-visible page work reached staging with plain-text heroes and empty boxes. Review read the diff, not the rendered page. #5330 asked for routing to `/design` before build and a visual gate at the staging review. #5369 asked for the same gate at `review-pr-staging`.

## Choice

- `bin/lean/design-gate.mjs` is the single gate. It's opt-in through forge.yaml `design.routes` (unset means off, as before). `design.gate: blocking|advisory` picks the posture. `parseDesignConfig` reads the keys.
- Routing: after the contract freezes, a predicted page entry under `design.routes` with no `FORGE:DESIGN_SPEC` comment and no `design:approved` label is routed to `/design`. Under `blocking`, the lane ends `needs-human` (`design.spec_required`) before implementation. Under `advisory`, the implement prompt gets a note.
- `scripts/visual-gate.mjs` is a thin CLI over the same gate for `review-pr-staging` Phase 1I. `--list` names the bundle's changed routes. The judgment step reads the specs plus the screenshot and render-critique evidence, posts `FORGE:VISUAL_GATE`, and exits 1 on a blocking finding. The lane precheck and the staging review import the same functions, so they can't drift.
- `critiqueMarkup` is a heuristic source floor (empty or label-only boxes, placeholder copy, text-only pages). The rendered judgment stays with `design-render-critique-loop`.

## Alternatives rejected

- A second copy of the gate for the staging review. It would drift from the lane gate.
- Default-on routing. It would change behaviour for every repo without `design.routes`.

## Not done

- A before/after screenshot comparison with the base (#5369's wording). The gate judges the new render against its spec.
- Uploading screenshot binaries. The comment lists the screenshot paths.
