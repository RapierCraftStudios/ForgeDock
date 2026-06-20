# Reference Corpus, Grammar & Negatives

> **Status:** Committed foundation — corpus + grammar + negatives spec for the UI Taste Harness (milestone #13, issue #880).
> Source of the design vocabulary drawn on by the [design-spec-schema](design-spec-schema.md) (#881),
> the [design-architect rationale](design-architect-rationale.md) (#886), and [design-memory](design-memory.md) (#887).
> The negatives below feed the deterministic linter (#884) and the vision critic (#882); the effect-usage patterns feed
> the effects-appropriateness layer (#885); the corpus pages are the benchmark's arm **C** (#878).

## Purpose

The harness must not chase "beautiful" (no signal → mode-collapse to the mean = slop) nor copy one product
("make it like Linear" → mimicry, no variance). Instead it works from a **curated corpus** of
currently-converting, well-funded SaaS pages, from which we extract two *separable* things:

- **The shared grammar** — what they *all* do. This is the contemporary palette / the *reinforcements* (pull toward).
- **The axes of variation** — where they *differ*. This is the room for *variance* (the archetypes).

The corpus is a **living artifact** — design taste shifts, so this file is revised on a cadence (target: quarterly),
and every revision bumps a `corpus_version` so [design-memory](design-memory.md) can reason about "what's current
now vs. then." The `corpus_version` here is the same anchor the [schema](design-spec-schema.md) records in
`meta.corpus_version` for every generated page.

**Current `corpus_version`: `2026.2`**

---

## The corpus (seed set)

Each entry is a real page used only as an internal reference (the benchmark's arm **C**, #878) — never shown to
the generator. Anonymized product names are used in the benchmark briefs (see the benchmark rig, #878).

| Reference | Category | Primary archetype it exemplifies | `archetype` id | Notable effect usage |
|---|---|---|---|---|
| linear.app | Issue tracking | Refined minimal / dark technical-luxury | `minimal-luxury` | subtle parallax, crisp contrast, restrained motion |
| stripe.com | Payments API | Polished / enterprise-developer | `technical-dense` | animated gradient (hero only), layered depth |
| vercel.com | Deploy platform | Stark monochrome / brutalist-minimal | `bold-brutalist` | near-zero effects — restraint *is* the statement |
| modal.com | Serverless AI compute | Technical / playful | `technical-dense` | technical motion, code-forward hero |
| resend.com | Email API | Clean / warm-minimal | `warm-photographic` | calm, typographic, almost no motion |

Extend deliberately, not reflexively — more entries only when they add a *grammar trait* or *archetype*
not already represented.

### Why YC-funded companies as the anchor

The corpus deliberately idolizes what **highly-funded YC / top-tier-VC-backed companies** ship. This is not
brand worship — it's a proxy for a specific, observable thing: these companies hire strong design talent and
ship pages that are *currently converting* at high stakes. They are the leading edge of the contemporary palette.
"YC-funded" is shorthand for "the current high bar of SaaS taste," not a requirement that a reference literally
went through YC. The point is to anchor on what the best-resourced teams consider good *right now* — and to keep
re-anchoring as that bar moves (see [Maintenance](#maintenance)). Lower-tier or dated pages would teach the harness
yesterday's mean, which is exactly the slop we're escaping.

---

## The shared grammar (contemporary funded-SaaS palette) — the *reinforcements*

These are the traits the corpus holds in common. They are what the harness should pull *toward*.

- **Confident type hierarchy.** Large display type; deliberate, large jumps between levels; tight tracking on
  headlines. Type does the heavy lifting, not decoration.
- **Restrained color.** Often near-monochrome plus *one* disciplined accent. Dark-mode-first is increasingly common.
  Color is a tool for emphasis, not surface area.
- **Intentional whitespace rhythm.** Space is composed, not uniform padding. Negative space creates focus.
- **Real product imagery.** Interface shots, real screenshots, product-in-context — *not* stock illustration,
  generic 3D blobs, or abstract shapes.
- **Fine depth.** Hairline (1px) borders; soft, low-spread shadows; a *deliberate* radius system (not rounded-everything).
- **Motion as polish.** Scroll-triggered reveals, subtle gradients/grain, micro-interactions — never gratuitous,
  always serving attention.
- **Information confidence.** Not afraid of dense, well-set text. Says real things about the product rather than
  abstract promises.
- **Non-default typefaces.** A chosen grotesk/geometric sans (often with a serif accent) — never Inter-at-default-weights.

Each trait maps to one or more enforced fields in the [schema](design-spec-schema.md): type hierarchy →
`typography`; restrained color → `color`; whitespace rhythm → `spacing`; fine depth → `radius` + `shadow`;
motion → `motion`; non-default typefaces → `typography.display_family` (constraint: non-default).

---

## The axes of variation — the *archetypes* (this is where variance comes from)

The corpus is **not one aesthetic**. Variance is achieved by sampling a coherent *archetype* per design and
committing to it hard — not by averaging (which yields the mean = slop) and not by copying one product (mimicry).
The `archetype` id column below is the exact token committed to `meta.archetype` in the [schema](design-spec-schema.md).

| Archetype | `archetype` id | Feel | Type | Color | Density | Effects posture |
|---|---|---|---|---|---|---|
| **Editorial / typographic** | `editorial-typographic` | magazine, considered | serif + sans pairing, big display | warm neutrals + 1 accent | medium | minimal, type-led |
| **Technical / dense** | `technical-dense` | dashboard-forward, capable | mono accents, tight sans | dark-first, cool | high | code/data motion welcome |
| **Minimal-luxury** | `minimal-luxury` | premium, lots of air | refined sans, generous scale | monochrome + subtle accent | low | restrained micro-motion |
| **Bold-brutalist** | `bold-brutalist` | high-contrast, opinionated | heavy grotesk, oversized | stark B/W + 1 loud accent | medium | sharp, near-zero decorative |
| **Warm-photographic** | `warm-photographic` | human, approachable | friendly sans | warm palette, photography-led | medium | image-driven, soft motion |

**Selection rule:** the [architect phase](design-architect-rationale.md) (#886) picks one archetype appropriate to
the *product nature* + *audience* (inferred from the brief alone), then commits. Variance between runs = different
archetype + different token instantiation; coherence within a run = no drift.

---

## The negatives — the anti-slop checklist (machine-checkable)

These are the AI-generated "tells." They are enforced two ways: a deterministic linter (#884) and the
vision critic (#882). Any hit is a finding. Each item is phrased so it maps to a concrete, checkable signal
(populated into `negatives` in the [schema](design-spec-schema.md)).

| # | Negative | Primary check surface |
|---|---|---|
| N1 | Purple/blue gradient hero on white background | linter (computed hero background) |
| N2 | Inter (or system default) at default weights, everywhere | linter (font-family + weight) |
| N3 | Everything centered; no asymmetry, no deliberate alignment grid | critic (layout) |
| N4 | Three identical feature cards with lucide/emoji icons | linter + critic (repeated card pattern) |
| N5 | `rounded-2xl` (or one radius) applied to literally everything | linter (radius-token cardinality) |
| N6 | Default Tailwind palette (slate / indigo / gray-50) used as the actual brand color | linter (palette match) |
| N7 | The boilerplate skeleton: hero → 3 cards → testimonial → CTA, in that order, every time | linter (section sequence) |
| N8 | Stock-illustration people / generic 3D blobs / abstract gradient shapes instead of real product | critic (vision) |
| N9 | Glassmorphism overused (frosted panels everywhere) | critic (vision) |
| N10 | Equal visual weight across the page — no hierarchy, nothing leads the eye | critic (vision) |
| N11 | Abstract promises ("Supercharge your workflow") with no concrete product shown | critic (copy + vision) |
| N12 | Decorative effects that serve nothing (see [effect-usage patterns](#effect-usage-patterns-feeds-the-effects-layer-885)) | critic + effects layer (#885) |

---

## Effect-usage patterns (feeds the effects layer, #885)

Extracted from the corpus: *where* and *how intensely* real pages use heavy techniques. This is how the harness
*learns* effect-appropriateness from exemplars rather than inventing it.

| Effect | Observed pattern in corpus | Earns its place when… | Slop when… |
|---|---|---|---|
| 3D / WebGL | rare; only on spatial/visual products, hero centerpiece | product is spatial/visual; one premium hero | bolted onto non-visual B2B; wrecks LCP; no fallback |
| Parallax / scroll-driven | subtle, hero + one reveal section | progressive capability reveal, depth | everywhere; jank/CLS; fights readability |
| Multi-layer depth (glass/grain/gradient) | hero backdrop, restrained | richness, fg/bg separation | over-glass; muddy contrast |
| Contrast (compositional) | pervasive, deliberate | almost always — direct the eye | *low* contrast: flat, equal-weight |

Note the asymmetry: contrast rewards *more* intention; the others reward *restraint*. The single biggest tell of
maturity is matching effect intensity to product nature — e.g. a compute/GPU product may warrant a subtle
technical hero visualization, while an email API should stay calm and typographic, and a Vercel-archetype design
may make restraint itself the move. The harness must infer this **from the brief alone**.

---

## Maintenance

- Revise quarterly or when a clear taste shift is observed.
- Every revision: bump `corpus_version` (above), note what changed, and record it so
  [design-memory](design-memory.md) (#887) can distinguish "current grammar" from "grammar at time of a past design."
- New entries must justify themselves: which grammar trait or archetype do they add?

### Revision log

| `corpus_version` | Date | Change |
|---|---|---|
| `2026.2` | 2026-06 | Initial committed corpus: 5 seed references, 5 archetypes, 12 negatives, 4 effect-usage patterns. |
