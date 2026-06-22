# Reference Corpus, Grammar & Negatives

> **Status:** Committed foundation — corpus + grammar + craft vocabulary + negatives spec for the UI Taste Harness (milestone #13).
> Source of the design vocabulary drawn on by the [design-spec-schema](design-spec-schema.md) (#881),
> the [design-architect rationale](design-architect-rationale.md) (#886), and [design-memory](design-memory.md) (#887).
> The negatives below feed the deterministic linter (#884) and the vision critic (#882); the effect-usage patterns feed
> the effects-appropriateness layer (#885); the corpus pages are the benchmark's arm **C** (#878);
> the craft vocabulary feeds the CSS component library (#1048).
>
> Issues: #880 (initial corpus), #1047 (craft vocabulary extension — `corpus_version` `2026.3`).

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

**Current `corpus_version`: `2026.3`**

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

## The craft vocabulary — micro-details that signal professional design

A page can satisfy all eight grammar traits above and still feel like a template. The grammar operates at
the macro level (type hierarchy, color system, layout). The craft vocabulary operates at the **element level**:
the 50+ decisions that professional designers make instinctively but AI models skip because they default to
framework primitives. These are not optional polish — they are the difference between "AI-generated" and
"someone designed this."

The craft vocabulary is carried in the `craft` object in the [schema](design-spec-schema.md). The
[per-archetype craft profiles](#per-archetype-craft-profiles) below translate these categories into
archetype-specific defaults. The negatives N13–N20 enforce them.

### 1. Element-specific radius system

**AI default**: `rounded-lg` (or `rounded-2xl`) applied uniformly to every element.

**Professional pattern**: Each element type has its own radius, scaled to the element's visual weight and
function. A radius system uses **at least 3 distinct values**; one-radius-fits-all is an immediate AI tell.

```css
/* AI default — uniform radius everywhere */
.card   { border-radius: 12px; }
.button { border-radius: 12px; }
.badge  { border-radius: 12px; }
.input  { border-radius: 12px; }

/* Professional — scaled to element size and purpose */
.card   { border-radius: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.04), 0 0 0 1px rgba(0,0,0,.06); }
.button { border-radius: 8px; }          /* smaller than card — deliberate scale relationship */
.badge  { border-radius: 9999px; padding: 2px 10px; }  /* pill — categorically different shape */
.input  { border-radius: 6px; border: 1px solid rgba(0,0,0,.1); }  /* smallest — most precise */
```

Constraint: `craft.radius_system` in the schema enforces `distinct_count >= 3`.

### 2. Button craft

**AI default**: `bg-blue-600 text-white rounded-lg px-4 py-2` — the Tailwind starter button, flat fill,
no depth, no state feedback.

**Professional patterns**:
- Depth: subtle inner shadow or very soft gradient that creates dimensional feel (not flat color)
- Hover: combination of shadow lift + slight scale (`transform: scale(1.01)`) + color shift — not just `hover:bg-blue-700`
- Active: pressed-in feel — `transform: translateY(1px)` + reduced shadow + slightly darker fill
- Focus: custom ring matching the button's accent color, not the browser default blue outline
- Ghost/outline variants: custom border color + matching text — not generic `border-gray-300`
- Icon alignment: inline icons need `translateY(-1px)` optical correction to sit on the text baseline

```css
/* Professional primary button */
.btn-primary {
  background: var(--accent);
  box-shadow: 0 1px 2px rgba(0,0,0,.08), inset 0 1px 0 rgba(255,255,255,.08);
  transition: box-shadow 120ms ease, transform 120ms ease;
}
.btn-primary:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,.12), inset 0 1px 0 rgba(255,255,255,.08);
  transform: translateY(-1px);
}
.btn-primary:active {
  box-shadow: 0 1px 2px rgba(0,0,0,.06);
  transform: translateY(1px);
}
.btn-primary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
```

### 3. Link and text treatments

**AI default**: Browser-default blue underlined links, or unstyled colored text with no decoration.

**Professional patterns**:
- Underline: `text-decoration-thickness: 1px; text-underline-offset: 3px;` — precise, not browser default
- Animated underline: grow-in via `background-image: linear-gradient(currentColor, currentColor); background-size: 0 1px;` → `hover: background-size: 100% 1px`
- Nav active indicators: bottom border, background pill, or dot — not bold-weight alone
- Inline code: tinted background matching brand color at 8–12% opacity + `font-size: 0.875em` + custom padding

```css
/* Animated underline link */
.link {
  background-image: linear-gradient(currentColor, currentColor);
  background-position: 0 100%;
  background-size: 0 1px;
  background-repeat: no-repeat;
  transition: background-size 200ms ease;
  text-decoration: none;
}
.link:hover { background-size: 100% 1px; }
```

### 4. Dividers and separators

**AI default**: `<hr>` or `border-b border-gray-200` — a hard line with no thought.

**Professional patterns**:
- Gradient divider: `background: linear-gradient(to right, transparent, rgba(0,0,0,.08) 20%, rgba(0,0,0,.08) 80%, transparent)` — fades at edges
- Spacing-as-divider: no visible line at all; section rhythm created purely by vertical space and background color shifts
- Dot/dash decorative separators as section intros (archetype-appropriate — editorial only)
- Subtle background-color shifts between sections (`#FAFAFA` → `#FFFFFF`) in place of drawn lines

### 5. Icon treatments

**AI default**: Lucide/Heroicons dropped in at `w-5 h-5` with the default text color. All icons identical.

**Professional patterns**:
- Tinted containers: icon in a circle or rounded square with `background: rgba(var(--accent-rgb), 0.08)` — color matches brand
- Size varies by context: feature icons at 24px, nav icons at 18px, inline icons at 16px — not all `w-5 h-5`
- Color matches text hierarchy: muted (`opacity: 0.5`) for secondary, accent for emphasis, never icon-only accent without label hierarchy support
- Feature icons use archetype-appropriate container shape: circles for warm/human archetypes, squares for technical

### 6. Form element craft

**AI default**: Browser-default inputs with a single border. No custom focus state. Native select, checkbox, radio.

**Professional patterns**:
- Focus: `box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.15); border-color: var(--accent);` — branded ring, not browser blue
- Placeholder: `color: rgba(var(--fg-rgb), 0.35); font-weight: 400; letter-spacing: 0.01em;` — lighter weight and tracking than input text
- Input groups: icon + input + button flush-joined as one visual unit (`border-radius` only on outer corners)
- Custom select: arrow replaced with `background-image: url("data:image/svg+xml,…")` matching brand color
- Toggle/checkbox/radio: always custom-styled — native appearance never ships

```css
.input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.12);
  transition: box-shadow 120ms ease, border-color 120ms ease;
}
.input::placeholder {
  color: rgba(var(--fg-rgb), 0.35);
  font-weight: 400;
  letter-spacing: 0.01em;
}
```

### 7. Branded micro-details — the "someone designed this" signals

These are the details visible only when you look closely, but collectively signal professional intent:

- **Custom text selection**: `::selection { background: rgba(var(--accent-rgb), 0.2); color: inherit; }` — brand color tint, not browser blue
- **Custom scrollbar** (WebKit): `scrollbar-width: thin; scrollbar-color: rgba(0,0,0,.15) transparent;` — thin, matching theme
- **Custom cursor feedback**: `cursor: pointer` with `transition: opacity 80ms` on interactive elements — tiny signal of responsiveness
- **Loading/skeleton states**: branded shimmer gradient (`background: linear-gradient(90deg, …)`) — never a spinner alone
- **Tooltip styling**: matches design system — correct background, radius from the radius system, `font-size: 0.8125rem`
- **Custom list bullets**: SVG checkmarks or brand-shaped markers via `list-style: none` + `::before` — never browser disc/circle
- **Code block styling**: custom syntax theme derived from the brand palette — not default highlight.js or Prism defaults

### 8. Compositional sophistication

**AI default**: Every section is a centered column with uniform padding. All cards the same size. No visual tension.

**Professional patterns**:
- **Overlapping elements**: a card or badge that breaks grid boundaries, or a product screenshot that bleeds into the next section
- **Asymmetric layouts**: deliberate left/right weight — headline left-aligned with right-side visual, not everything centered
- **Z-depth layering**: background texture/pattern → main content → floating badge/annotation at 3 distinct visual planes
- **Negative space as design**: intentional "empty" areas that create breathing room and direct the eye — not filled with content
- **Grid breaks**: one card in a 3-column row is taller, or a full-width row interrupts a card grid — planned asymmetry

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

### Per-archetype craft profiles

Each archetype has a specific craft posture across four dimensions. These are the *defaults* — the generator
commits to them and deviates only with explicit rationale. The `craft` object in the
[schema](design-spec-schema.md) carries these values.

| Archetype | Radius system | Button style | Divider style | Icon treatment |
|---|---|---|---|---|
| `editorial-typographic` | generous (16px card / 12px input / 8px button) | serif-label text button or outlined; subtle warm shadow | gradient fade to transparent at edges | tinted squares or rectangles at low opacity |
| `technical-dense` | tight (8px card / 6px input / 4px button) | sharp, mono-label; no gradient; high-contrast border on ghost | hairline 1px solid at 8% opacity | monochrome, small (16px), uniform |
| `minimal-luxury` | mixed (20px card / 12px input / 8px button) | ghost or borderless; minimal fill; no visible shadow | spacing only — no visible line between sections | none or near-invisible; no colored backgrounds |
| `bold-brutalist` | zero or max (0px or 9999px — never in between) | high-contrast; heavy border (2px+); flat fill; no shadow | bold solid line (2–3px) or full color-block section break | bold, oversized (32px+); high contrast; no tinted backgrounds |
| `warm-photographic` | soft (12px card / 8px input / 6px button) | rounded; warm-tinted shadow; soft fill matching photo palette | photo-edge bleed or subtle warm-tinted rule | warm-tinted circles; 24px; soft drop shadow |

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
| N13 | Uniform border-radius: fewer than 3 distinct radius values across card / button / badge / input elements | linter (radius-token cardinality in craft vocabulary; see N5 for the one-class case) |
| N14 | Flat primary button: no depth signal — no shadow, no gradient, no hover lift/press state | linter (button shadow/transform rules) + critic |
| N15 | Browser-default form elements: unstyled inputs (no custom focus ring), native select/checkbox/radio | linter (CSS property presence) + critic |
| N16 | Default icon treatment: all icons same size (`w-5 h-5`), no tinted container, no contextual sizing | critic (vision) |
| N17 | No custom link treatment: relies on browser-default underline or bare color-only links | linter (text-decoration-thickness / background-size pattern) |
| N18 | Missing branded micro-details: no custom `::selection`, no custom scrollbar, no custom focus rings on interactive elements | linter (CSS rule presence) |
| N19 | All sections same visual weight: uniform padding and background — no spacing-as-divider, no color shifts, no grid breaks | critic (layout rhythm) |
| N20 | No hover/active/focus states on interactive elements beyond color change | linter (transition + transform properties on interactive selectors) |

---

## Effect-usage patterns (feeds the effects layer, #885)

Extracted from the corpus: *where* and *how intensely* real pages use heavy techniques. This is how the harness
*learns* effect-appropriateness from exemplars rather than inventing it. The governing doctrine that turns these
patterns into per-section authoring rules lives in [effects-appropriateness](effects-appropriateness.md) (#885) — the
canonical consumer of this table and of N12.

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

## Generation Model

**Validated generation model**: `claude-opus-4-6`

Benchmark #878 ran the full ABC benchmark with both Sonnet and Opus as the generation model. Results were conclusive:

| Metric | Sonnet (`claude-sonnet-4-6`) | Opus (`claude-opus-4-6`) |
|--------|------------------------------|--------------------------|
| A vs B pairwise win-rate | 54.2% | **90.0%** |
| A rubric mean | 3.40/5 | **4.11/5** |
| A slop count (avg) | 1.8 | **1.2** |

The gap is a tier difference, not marginal. Opus is the validated generation model for the harness going forward. The Opus run (`docs/design/fixtures/runs/full-abc-opus/`) is the canonical benchmark baseline. The Sonnet run (`docs/design/fixtures/runs/full-abc/`) is preserved as historical comparison data.

Per the design-bench "same model" rule: both arm A and arm B use the same generation model. Changing the canonical model for a benchmark run requires running both arms with the new model.

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
| `2026.3` | 2026-06 | Added craft vocabulary (8 categories with CSS examples), per-archetype craft profiles table, negatives N13–N20 (#1047). Schema extended with `craft` object and `surface_depth` rubric dimension. |
