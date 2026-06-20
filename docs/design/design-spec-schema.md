# FORGE:DESIGN_SPEC — Schema

> **Status:** Committed foundation — canonical schema for the UI Taste Harness (milestone #13, issue #881).
> Output of the [design-architect phase](design-architect-rationale.md) (#886); input to generate + the
> render-critique loop (#882); enforced by the anti-slop linter (#884); persisted to
> [design-memory](design-memory.md) (#887) at close. Draws its vocabulary from the
> [reference corpus](reference-corpus.md) (#880).
>
> Registered as a FORGE annotation type in [`../FORGE-PROTOCOL.md`](../FORGE-PROTOCOL.md).

## Purpose

A structured, **machine-checkable** representation of the design language for one page — carried across pipeline
stages as a `FORGE:DESIGN_SPEC` annotation, exactly like other FORGE annotations carry context. It exists so taste
decisions **persist** instead of being re-rolled on every generation, and so a deterministic linter and a vision
critic can both check the output against the *same* committed intent.

Critically: the spec is **produced by the [rationale](design-architect-rationale.md)** (the reasoning), not authored
from nowhere. Rationale → spec → page.

## Schema

```jsonc
{
  "meta": {
    "product": "Voltage",            // anonymized brief name
    "archetype": "technical-dense",  // one of the corpus archetypes — committed, not blended
    "corpus_version": "2026.2",      // which grammar snapshot this was designed against
    "rationale_ref": "<issue/comment URL of the FORGE:DESIGN_RATIONALE that produced this>"
  },
  "typography": {
    "display_family": "…",           // CONSTRAINT: non-default — never Inter-at-default
    "body_family": "…",
    "mono_family": "…",              // optional
    "scale_ratio": 1.25,             // modular scale; large, confident jumps
    "base_size_px": 17,
    "weights": [400, 500, 700],
    "headline_tracking_em": -0.02
  },
  "color": {
    "mode": "dark",                  // light | dark | auto (dark-first is common)
    "background": "#…",
    "foreground": "#…",
    "accent": "#…",                  // ONE disciplined accent
    "supporting": ["#…"],
    "rules": ["no-default-tailwind-palette", "contrast>=4.5"]
  },
  "spacing":  { "base_unit_px": 8, "scale": [4,8,12,16,24,32,48,64,96] }, // all spacing on-scale
  "radius":   { "scale": [4, 8, 16] },   // deliberate system, NOT uniform rounded-everything
  "shadow":   { "tokens": ["0 1px 2px rgba(0,0,0,.06)", "0 8px 24px rgba(0,0,0,.12)"] }, // soft, low-spread
  "motion": {
    "vocabulary": ["scroll-reveal", "micro-hover"],
    "default_ms": 200, "easing": "cubic-bezier(.2,.0,.0,1)",
    "reduced_motion": "required"     // MUST honor prefers-reduced-motion
  },
  "layout_grammar": {
    // ordered sections with purpose + density — MUST NOT be the boilerplate skeleton
    // (hero → 3 cards → testimonial → CTA). Sections derive from the rationale's communication hierarchy.
    "sections": [
      { "id": "hero", "purpose": "…", "density": "low" },
      { "id": "…",    "purpose": "…", "density": "high" }
    ],
    "rhythm": "alternating-density",
    "intentional_breaks": ["asymmetric hero", "full-bleed product shot"]
  },
  "effects_plan": {                  // see #885 — reasoned in the rationale, not chosen blindly
    "per_section": [
      { "section": "hero", "effect": "subtle-technical-visualization", "intensity": "low",
        "justification": "product is GPU-compute; one earned hero centerpiece" }
    ],
    "budget": { "lcp_ms": 2000, "max_js_kb": 150 },
    "never": ["3d-on-non-hero", "parallax-on-pricing"]
  },
  "negatives": [ /* anti-slop checklist pulled from corpus — linter + critic both check */ ],
  "acceptance": {
    "perf_budget": { "lcp_ms": 2000, "cls": 0.1, "inp_ms": 200 },
    "a11y": { "contrast_min": 4.5, "reduced_motion": true },
    "divergence_ref": "<design-memory check result — see #887>"
  }
}
```

## How each field defends against slop

| Field | Defends against |
|---|---|
| `archetype` (committed) | mode-collapse to the mean (forces a tail direction, not the average) |
| `typography.display_family` non-default | the Inter-default tell |
| `color.rules: no-default-tailwind-palette` | slate/indigo "AI gradient" tell |
| `spacing.scale` (on-scale only) | arbitrary padding / no rhythm |
| `layout_grammar` (non-boilerplate) | the hero→3-cards→testimonial→CTA skeleton |
| `effects_plan` (justified + budgeted) | gratuitous 3D/parallax; perf blowups |
| `acceptance.perf_budget` | "earned its milliseconds" becomes objective (via Playwright, #875) |

## Lifecycle

1. **architect** (#886) emits this spec from the rationale.
2. **generate** produces HTML constrained by it.
3. **linter** (#884) checks deterministic fields (palette, spacing, radius, layout skeleton).
4. **critique loop** (#882) renders + checks `negatives`, `effects_plan` justification, and `acceptance` against the
   rendered result; iterates until pass.
5. **close** writes the realized spec + outcome to [design-memory](design-memory.md) (#887).
