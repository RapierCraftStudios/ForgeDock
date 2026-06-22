# FORGE:DESIGN_SPEC — Schema

> **Status:** Committed foundation — canonical schema for the UI Taste Harness (milestone #13, issue #881).
> Output of the [design-architect phase](design-architect-rationale.md) (#886); input to generate + the
> render-critique loop (#882); enforced by the anti-slop linter (#884); persisted to
> [design-memory](design-memory.md) (#887) at close. Draws its vocabulary from the
> [reference corpus](reference-corpus.md) (#880).
> Extended: `craft` object + `surface_depth` rubric dimension (#1047); `motion.tier`, `motion.hero_technique`,
> `motion.video_placeholder` fields + `motion` rubric dimension (#1043).
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
  "craft": {                             // see reference-corpus.md#the-craft-vocabulary — #1047
    "radius_system": {
      "card_px": 16,                     // CONSTRAINT: distinct_count >= 3 across card/button/badge/input
      "button_px": 8,
      "badge_px": 9999,                  // 9999 = pill
      "input_px": 6
    },
    "button": {
      "depth": "shadow-lift",            // shadow-lift | gradient | flat — flat triggers N14
      "hover": "shadow+translate",       // how hover is signaled — must not be color-only
      "active": "press-down",            // translateY(1px) + reduced shadow
      "focus": "custom-ring"             // custom-ring | none — none triggers N18
    },
    "links": {
      "treatment": "animated-underline", // animated-underline | static-underline | color-only
      "underline_offset_px": 3,
      "underline_thickness_px": 1
    },
    "icons": {
      "container": "tinted-square",      // tinted-circle | tinted-square | none
      "size_context": {                  // different sizes by context — uniform triggers N16
        "feature_px": 24,
        "nav_px": 18,
        "inline_px": 16
      }
    },
    "micro_details": {
      "custom_selection": true,          // ::selection — false triggers N18
      "custom_scrollbar": true,          // thin, theme-matched scrollbar
      "custom_focus_rings": true         // branded focus rings on all interactive elements
    },
    "dividers": "spacing-only"           // spacing-only | gradient-fade | hairline | color-shift
  },
  "motion": {
    "tier": 1,                        // 1 = CSS-only | 2 = SVG+JS | 3 = video placeholder — from corpus hero motion vocabulary (#1043)
    "hero_technique": "text-reveal",  // specific technique id from the corpus tier (e.g. "gradient-shift", "typewriter", "svg-path-draw", "video-scaffold")
    "video_placeholder": false,       // true = Tier 3 scaffold included — CSS gradient poster generated, drop-in comment in HTML
    "vocabulary": ["scroll-reveal", "micro-hover"],  // below-fold motion tokens (Tier 1F: scroll-triggered fade-in)
    "default_ms": 200, "easing": "cubic-bezier(.2,.0,.0,1)",
    "reduced_motion": "required"      // MUST honor prefers-reduced-motion — @media (prefers-reduced-motion: reduce) on all animated elements
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
  "effects_plan": {                  // see effects-appropriateness.md (#885) — reasoned via the effects doctrine, not chosen blindly
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
| `effects_plan` (justified + budgeted) — doctrine: [effects-appropriateness](effects-appropriateness.md) (#885) | gratuitous 3D/parallax; perf blowups |
| `acceptance.perf_budget` | "earned its milliseconds" becomes objective (via Playwright, #875) |
| `craft.radius_system` (`distinct_count >= 3`) | one-radius-fits-all AI tell (N13) |
| `craft.button.depth` (not `flat`) | flat Tailwind button with no depth (N14) |
| `craft.micro_details.custom_selection` + `custom_focus_rings` | missing branded micro-details (N18) |
| `craft.icons.size_context` (distinct sizes by context) | default uniform icon treatment (N16) |
| `craft.links.treatment` (not `color-only`) | bare color-only or browser-default link treatment (N17) |
| `motion.tier` + `motion.hero_technique` (committed) | static hero with no motion — the "poster" tell (N21); jQuery-era effects (N23) |
| `motion.reduced_motion: "required"` | motion that ignores `prefers-reduced-motion` — accessibility violation |
| `motion.video_placeholder: true` (when applicable) | video-shaped hero gap: empty space where a demo would go, or placeholder image with no scaffolding |

## Benchmark rubric dimensions

The ABC benchmark (#878) evaluates generated pages on a 1–5 rubric. The `craft` field extension (#1047) added
two dimensions (`surface_depth`, `craft`); the `motion` field extension (#1043) adds a seventh dimension.

| Dimension | What it measures | 1 (worst) | 5 (best) |
|---|---|---|---|
| `typography` | Type hierarchy, scale, non-default faces | System font, single weight, no scale | Non-default face, confident scale ratio, tight tracking |
| `color` | Palette restraint, accent discipline, contrast | Default Tailwind palette, multiple loud accents | Near-monochrome + one disciplined accent, ≥4.5 contrast |
| `surface_depth` | Shadows, borders, radius system, layering | Flat, no depth cues, uniform radius | Soft multi-token shadows, 3+ distinct radii, clear z-layering |
| `craft` | Micro-detail quality — buttons, links, icons, forms, micro-details | All framework defaults, no custom states | Custom depth on buttons, animated links, tinted icon containers, branded micro-details |
| `layout` | Grid, asymmetry, negative space, section rhythm | Centered columns, uniform padding, boilerplate skeleton | Deliberate grid breaks, asymmetry, spacing-as-divider |
| `effects` | Effect appropriateness and restraint | Gratuitous 3D/parallax on non-visual product | Effects justified by product nature, performance-budgeted |
| `motion` | Hero vitality — appropriate motion technique committed and executed per archetype | Static hero (poster) — N21 hit; or jQuery-era effects — N23 hit | Archetype-appropriate tier selected, `prefers-reduced-motion` honored, at most 2 simultaneous motion elements |

The `craft` and `surface_depth` dimensions are new in `corpus_version: 2026.3` (#1047). The `motion` dimension
is new in `corpus_version: 2026.4` (#1043). Past benchmark runs scored under a 4-dimension rubric (no
`surface_depth`, `craft`, or `motion`). Comparison across versions must note the rubric version.

## Section-level surgical re-generation contract

<!-- Added: forge#1044 — user-feedback loop -->

The `layout_grammar.sections` array is the structural hook for **targeted, section-only edits**. Each section carries
an `id` (e.g. `"hero"`, `"features"`, `"pricing"`), a `purpose`, and a `density`. This structure enables Stage 4.5 of
the `/design` pipeline (user-feedback loop, #1044) to re-generate a single section without touching the rest of the
page.

### Rules for surgical re-generation

1. **Section IDs are the targeting key.** When `FORGE:USER_FEEDBACK` names a `section_target`, the re-generation agent
   receives: the full current HTML + the FORGE:DESIGN_SPEC + the feedback for that section ID only. It produces a
   replacement for that section's markup and nothing else.

2. **Committed archetype and signature move are locked.** User feedback can modify a section's visual execution
   (motion, layout detail, asset placement, color treatment) but MUST NOT change the committed `meta.archetype` or the
   signature move recorded in `FORGE:DESIGN_RATIONALE`. Those choices were the architect's and are fixed once the spec
   is committed. If a user requests a direction change that would require a different archetype, the feedback loop
   should note the constraint and suggest the closest achievable variation within the committed direction.

3. **The spec is the source of truth for all non-targeted sections.** Sections not named in `section_target` are
   reproduced from the committed spec unchanged — no style drift, no re-rolling of other sections' taste decisions.

4. **`effects_plan.per_section` updates are allowed.** If feedback changes the hero's visual treatment (e.g., adds a
   product video, changes the motion vocabulary), the `effects_plan.per_section` entry for that section may be updated
   in a revised FORGE:DESIGN_SPEC annotation — this is the only part of the spec a feedback iteration may mutate.

5. **Benchmark bypass.** Section-level re-generation is triggered by user presence (Stage 4.5). The ABC benchmark arm A
   runs non-interactively and bypasses Stage 4.5 entirely — automated runs proceed directly from Stage 4 to Stage 5.

### Asset integration via section targeting

When `FORGE:USER_FEEDBACK` carries an asset, the re-generation agent applies it to the `section_target`:

| Asset type | Section target | Integration |
|---|---|---|
| Video URL (mp4/webm) | `hero` | Replace or augment hero visual with `<video autoplay loop muted playsinline>` scaffold; adjust hero layout to accommodate |
| Video embed URL (YouTube/Vimeo) | `hero` | `<iframe>` with `loading="lazy"`, aspect-ratio container, no autoplay |
| Logo SVG | `nav` / `hero` | Replace text logo node; adjust `width`/`height` to maintain proportional sizing; verify contrast against background |
| Brand hex colors | any | Update `color.*` CSS custom properties matching the section; run contrast check (WCAG AA ≥ 4.5:1) before emitting |
| Product screenshot/image | `hero` / `features` | Replace placeholder with `<img>` or `background-image`; maintain existing sizing/aspect-ratio tokens |

## Lifecycle

1. **architect** (#886) emits this spec from the rationale.
2. **generate** produces HTML constrained by it.
3. **linter** ([`design-system-lint.mjs`](design-system-lint.md), #884) checks deterministic fields (palette, spacing, radius, layout skeleton, craft.radius_system, craft.button.depth, craft.micro_details).
4. **critique loop** (#882) renders + checks `negatives`, `effects_plan` justification, and `acceptance` against the
   rendered result; iterates until pass.
4.5. **user-feedback loop** (#1044) prompts for hero-specific user input; applies surgical section-level re-generation
   using section IDs as targeting keys; bypassed in automated (benchmark) runs.
5. **close** writes the realized spec + outcome to [design-memory](design-memory.md) (#887).
