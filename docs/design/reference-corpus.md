# Reference Corpus, Grammar & Negatives

> **Status:** Committed foundation — corpus + grammar + craft vocabulary + hero motion vocabulary + negatives spec for the UI Taste Harness (milestone #13).
> Source of the design vocabulary drawn on by the [design-spec-schema](design-spec-schema.md) (#881),
> the [design-architect rationale](design-architect-rationale.md) (#886), and [design-memory](design-memory.md) (#887).
> The negatives below feed the deterministic linter (#884) and the vision critic (#882); the effect-usage patterns feed
> the effects-appropriateness layer (#885); the corpus pages are the benchmark's arm **C** (#878);
> the craft vocabulary feeds the CSS component library (#1048); the hero motion vocabulary feeds `motion` in the schema (#881).
>
> Issues: #880 (initial corpus), #1047 (craft vocabulary extension — `corpus_version` `2026.3`), #1043 (hero motion vocabulary — `corpus_version` `2026.4`).

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

**Current `corpus_version`: `2026.4`**

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

## Hero motion vocabulary — making the hero feel alive

A static hero is the single biggest gap between AI-generated pages and real funded-SaaS pages. The craft vocabulary
(above) addresses element-level polish; the hero motion vocabulary addresses **section-level vitality** — whether
the hero *moves*. This layer slots beside the craft vocabulary and is governed by the same principle: match
technique to archetype, commit deliberately, never add motion for its own sake.

The [effects-appropriateness doctrine](effects-appropriateness.md) (#885) already covers when to use *heavy* effects
(3D/WebGL/parallax). This vocabulary covers the *lighter* tier: CSS-only animations, SVG motion, and video
placeholders — achievable in a single HTML file with zero or minimal JavaScript. Heavy effects are an upgrade path
from Tier 2; they are not documented here.

The `motion` object in the [schema](design-spec-schema.md) (#881) carries the committed tier and technique.
The [architect phase](design-architect-rationale.md) (#886) selects both alongside the archetype.

### Tier 1 — CSS-only motion (default; no JS required)

These are achievable in a single HTML file. They are the **default motion posture** for the harness — every
generated page should include at least one Tier 1 technique unless the archetype explicitly calls for restraint
(see per-archetype motion profiles below).

**All Tier 1 patterns MUST include a `prefers-reduced-motion` fallback.**

#### 1A. Gradient background animation

Animates `background-position` on a large gradient, creating a slow-shifting color field behind the hero.

```css
/* CSS-only gradient shift — zero JS */
.hero {
  background: linear-gradient(135deg, var(--bg-1), var(--bg-2), var(--bg-3));
  background-size: 300% 300%;
  animation: gradient-shift 12s ease infinite;
}
@keyframes gradient-shift {
  0%   { background-position: 0% 50%; }
  50%  { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
@media (prefers-reduced-motion: reduce) {
  .hero { animation: none; background-position: 0% 50%; }
}
```

Archetype fit: `editorial-typographic` (warm gradient shifts), `technical-dense` (dark cool shift),
`minimal-luxury` (monochrome gradient — very slow, near-imperceptible).

#### 1B. Text reveal / entrance animation

Staggered entrance of hero headline, subline, and CTA using `clip-path` or `opacity` + `translateY`.
No JS required — use CSS animation-delay for stagger.

```css
.hero-headline { animation: reveal-up 600ms cubic-bezier(.2,.0,.0,1) both; }
.hero-subline  { animation: reveal-up 600ms cubic-bezier(.2,.0,.0,1) 120ms both; }
.hero-cta      { animation: reveal-up 600ms cubic-bezier(.2,.0,.0,1) 240ms both; }

@keyframes reveal-up {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .hero-headline, .hero-subline, .hero-cta { animation: none; }
}
```

Archetype fit: all archetypes. Stagger duration scales with archetype energy —
`bold-brutalist` uses faster, snappier timing (200ms); `minimal-luxury` uses slower, more deliberate timing (800ms).

#### 1C. Floating / breathing element

A subtle looping translate + scale on a background shape, blob, or decorative element. Creates the impression
of depth and life without demanding attention.

```css
.hero-float {
  animation: float 6s ease-in-out infinite;
}
@keyframes float {
  0%, 100% { transform: translateY(0) scale(1); }
  50%       { transform: translateY(-12px) scale(1.02); }
}
@media (prefers-reduced-motion: reduce) {
  .hero-float { animation: none; }
}
```

Archetype fit: `warm-photographic` (floating soft shapes), `minimal-luxury` (single refined element).
Not appropriate for `bold-brutalist` (restraint is the statement).

#### 1D. Typewriter / typing effect

CSS-only typing using `steps()` and `ch` units. A cursor blinks using `border-right` animation.
No JS — a single static phrase only (multiple phrases require JS and belong in Tier 2).

```css
.typewriter {
  width: 0;
  overflow: hidden;
  white-space: nowrap;
  border-right: 2px solid var(--accent);
  animation:
    typing   3s steps(30, end) forwards,
    blink  0.7s step-end infinite;
}
@keyframes typing { from { width: 0; } to { width: 100%; } }
@keyframes blink  { 50% { border-color: transparent; } }
@media (prefers-reduced-motion: reduce) {
  .typewriter { width: 100%; animation: none; border-right: none; }
}
```

Archetype fit: `technical-dense` (code-typing effect), `editorial-typographic` (elegant phrase reveal).
Avoid for `minimal-luxury` — too busy for the premium posture.

#### 1E. Shimmer / glow on CTA

A moving highlight gradient over the primary CTA button, creating a premium luster without JavaScript.

```css
.btn-primary {
  position: relative;
  overflow: hidden;
}
.btn-primary::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,.18) 50%, transparent 60%);
  background-size: 200% 100%;
  animation: shimmer 2.4s linear infinite;
}
@keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) {
  .btn-primary::after { animation: none; }
}
```

Archetype fit: `minimal-luxury`, `editorial-typographic`. Skip for `bold-brutalist` (contradicts flat CTA posture).

#### 1F. Scroll-triggered fade-in (IntersectionObserver + CSS)

Below-the-fold sections use a minimal IntersectionObserver to add an `.is-visible` class, triggering a CSS
transition. This is Tier 1 because the JS is trivial (~10 lines) and contains no dependencies.

```html
<!-- Markup: add data-reveal to any section -->
<section data-reveal>…</section>
```

```css
[data-reveal] { opacity: 0; transform: translateY(24px); transition: opacity 500ms ease, transform 500ms ease; }
[data-reveal].is-visible { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) {
  [data-reveal] { opacity: 1; transform: none; transition: none; }
}
```

```js
// ~10 lines, no dependencies
const io = new IntersectionObserver(entries =>
  entries.forEach(e => e.isIntersecting && e.target.classList.add('is-visible')),
  { threshold: 0.15 }
);
document.querySelectorAll('[data-reveal]').forEach(el => io.observe(el));
```

Archetype fit: all archetypes for below-the-fold sections. Not a *hero* technique — use for feature grids,
social proof, pricing sections below the fold.

#### 1G. Staggered grid entrance

Feature card grids animate in with staggered delays, creating a ripple of content appearance.

```css
.feature-grid .card { animation: reveal-up 500ms cubic-bezier(.2,.0,.0,1) both; }
.feature-grid .card:nth-child(1) { animation-delay: 0ms; }
.feature-grid .card:nth-child(2) { animation-delay: 80ms; }
.feature-grid .card:nth-child(3) { animation-delay: 160ms; }
@media (prefers-reduced-motion: reduce) {
  .feature-grid .card { animation: none; }
}
```

Archetype fit: `technical-dense`, `editorial-typographic`. Skip for `minimal-luxury` — stagger reads too busy
against premium negative space.

---

### Tier 2 — SVG + lightweight JS motion

These require SVG or ~50–200 lines of vanilla JS. No framework dependencies.
Performance budget: `max_js_kb: 50` for Tier 2 additions (within the `lcp_ms: 2000` budget from the schema).

**All Tier 2 patterns MUST include a `prefers-reduced-motion` check in JS.**

#### 2A. SVG path drawing animation

Animates `stroke-dashoffset` to draw a path progressively — a logo tracing, a connector line, or an
abstract shape drawing itself in.

```css
.svg-path {
  stroke-dasharray: var(--path-length);
  stroke-dashoffset: var(--path-length);
  animation: draw-path 1.8s cubic-bezier(.4,0,.2,1) forwards;
}
@keyframes draw-path { to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) {
  .svg-path { animation: none; stroke-dashoffset: 0; }
}
```

*Note*: `--path-length` is computed at render time via `path.getTotalLength()` (3 lines of JS), or pre-computed
and set as a CSS custom property in the SVG's `style` attribute.

Archetype fit: `editorial-typographic` (logo or editorial mark drawing in), `technical-dense` (connector
lines between diagram nodes), `minimal-luxury` (single refined mark).

#### 2B. CSS clip-path morphing

Transitions between two `clip-path: polygon()` shapes on hover or entrance, creating a morphing edge
effect without JavaScript.

```css
.hero-shape {
  clip-path: polygon(0 0, 100% 0, 100% 85%, 85% 100%, 0 100%);
  transition: clip-path 600ms cubic-bezier(.4,0,.2,1);
}
.hero-shape:hover {
  clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 15%);
}
@media (prefers-reduced-motion: reduce) {
  .hero-shape { transition: none; }
}
```

Archetype fit: `bold-brutalist` (sharp shape transformations), `technical-dense` (geometric transitions).

#### 2C. Animated counter (number roll-up)

Numbers count up from 0 to their final value on entrance. Used in social proof ("10M+ deployments"),
metric showcases, or pricing comparisons.

```js
// ~30 lines, no dependencies
function animateCounter(el) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const target = parseInt(el.dataset.target, 10);
  const duration = 1200;
  const start = performance.now();
  const tick = now => {
    const progress = Math.min((now - start) / duration, 1);
    el.textContent = Math.floor(progress * target).toLocaleString();
    if (progress < 1) requestAnimationFrame(tick);
    else el.textContent = target.toLocaleString();
  };
  requestAnimationFrame(tick);
}
document.querySelectorAll('[data-counter]').forEach(el => {
  new IntersectionObserver(([e]) => e.isIntersecting && animateCounter(el), { threshold: 0.5 }).observe(el);
});
```

Archetype fit: `technical-dense` (metric-forward hero), `editorial-typographic` (impact numbers).
Not appropriate for `minimal-luxury` (undermines the premium calm).

#### 2D. Simple scroll parallax (transform only)

A lightweight parallax using `scroll` event + CSS `transform: translateY()` — no library. Moves a
background layer at a fraction of the scroll rate to create depth.

```js
// ~15 lines, no dependencies
const layer = document.querySelector('.parallax-layer');
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  window.addEventListener('scroll', () => {
    layer.style.transform = `translateY(${window.scrollY * 0.3}px)`;
  }, { passive: true });
}
```

Performance note: use `transform` only — never animate `top`/`left`/`background-position` in JS (triggers layout).

Archetype fit: `warm-photographic` (photo layer parallax), `editorial-typographic` (text + image depth separation).
Inappropriate for `bold-brutalist` (contradicts zero-decoration posture) and `minimal-luxury` (too active for
premium restraint).

---

### Tier 3 — Video / asset placeholders (user-supplied content)

The harness **cannot generate video content**, but it can scaffold the integration so dropping in a real
product demo video is a one-line replacement. Tier 3 is appropriate whenever a `warm-photographic` or
`technical-dense` archetype brief implies a demo or product experience exists.

**Default behavior**: the scaffold renders an animated CSS gradient as a poster frame. The visitor sees motion
before the user has supplied the actual video.

#### 3A. Full-bleed video hero scaffold

```html
<!-- Replace the <source> src with your product demo video -->
<!-- The .video-poster CSS gradient shows until the video loads -->
<div class="hero-video-wrap">
  <video
    class="hero-video"
    autoplay
    loop
    muted
    playsinline
    poster=""
    aria-hidden="true">
    <!-- Replace with your product demo video -->
    <source src="" type="video/mp4">
  </video>
  <!-- Animated CSS gradient poster — visible before video loads, or if no src -->
  <div class="video-poster" aria-hidden="true"></div>
  <!-- Hero copy overlay -->
  <div class="hero-content">
    <!-- headline, subline, CTA here -->
  </div>
</div>
```

```css
.hero-video-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: #000;
}
.hero-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* Animated gradient poster — shows until video src is filled in */
.video-poster {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--bg-1, #0f0f14), var(--bg-2, #1a1a2e), var(--bg-3, #0d1117));
  background-size: 300% 300%;
  animation: gradient-shift 12s ease infinite;
}
/* Hide poster when video has loaded */
.hero-video[src]:not([src=""]) ~ .video-poster { opacity: 0; transition: opacity 400ms ease; }
.hero-content {
  position: relative;
  z-index: 2;
  /* overlay text — position absolutely over the video */
}
@media (prefers-reduced-motion: reduce) {
  .video-poster { animation: none; }
}
```

*Drop-in instruction* (left as an HTML comment in generated output):
```
<!-- Replace <source src=""> with your product demo video path.
     Recommended: MP4 H.264, ≤10MB for above-the-fold autoplay.
     The gradient poster above shows until the video loads. -->
```

Archetype fit: `warm-photographic` (product lifestyle video), `technical-dense` (product demo screencast).

#### 3B. Windowed product screenshot with motion overlay

For archetypes that use a product screenshot rather than video, scaffold a browser-chrome wrapper with
a subtle looping CSS animation simulating UI activity (a blinking cursor, a progress bar, a pulsing indicator).

```html
<!-- Replace the inner content with a real product screenshot or iframe -->
<div class="product-window">
  <div class="window-chrome" aria-hidden="true">
    <span class="chrome-dot dot-red"></span>
    <span class="chrome-dot dot-yellow"></span>
    <span class="chrome-dot dot-green"></span>
  </div>
  <div class="window-body">
    <!-- Replace with your product screenshot: <img src="screenshot.png" alt="…"> -->
    <!-- Placeholder: animated terminal cursor -->
    <div class="terminal-placeholder" aria-hidden="true">
      <span class="terminal-cursor"></span>
    </div>
  </div>
</div>
```

```css
.product-window {
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0,0,0,.3), 0 0 0 1px rgba(255,255,255,.06);
}
.window-chrome {
  display: flex;
  gap: 6px;
  padding: 12px 16px;
  background: rgba(255,255,255,.04);
  border-bottom: 1px solid rgba(255,255,255,.06);
}
.chrome-dot { width: 12px; height: 12px; border-radius: 50%; }
.dot-red    { background: #ff5f57; }
.dot-yellow { background: #febc2e; }
.dot-green  { background: #28c840; }
.terminal-cursor {
  display: inline-block;
  width: 8px;
  height: 1.2em;
  background: var(--accent);
  animation: blink 1s step-end infinite;
  vertical-align: text-bottom;
}
@keyframes blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .terminal-cursor { animation: none; }
}
```

*Drop-in instruction* (left as an HTML comment in generated output):
```
<!-- Replace .terminal-placeholder with: <img src="screenshot.png" alt="Product interface"> -->
```

Archetype fit: `technical-dense` (terminal/code UI), `editorial-typographic` (app UI in a clean frame).

---

### Per-archetype motion profiles

Each archetype has a preferred motion tier and technique. The architect phase commits to one; the schema
carries it in `motion.tier` and `motion.hero_technique`. The generator applies it.

| Archetype | Preferred tier | Default hero technique | Notes |
|---|---|---|---|
| `editorial-typographic` | Tier 1 | `text-reveal` (1B) + optional `gradient-shift` (1A) | Type-led; motion serves the reading experience, never distracts |
| `technical-dense` | Tier 1–2 | `typewriter` (1D) or `svg-path-draw` (2A) or `video-scaffold` (3A) | Code/terminal motion earns its place; counters (2C) for metric heroes |
| `minimal-luxury` | Tier 1 (minimal) | `gradient-shift` (1A) at very slow timing (20s+), or `text-reveal` (1B) | One technique only; restraint is the signal — two or more = slop |
| `bold-brutalist` | Tier 1 (sharp) | `text-reveal` (1B) with fast, hard timing (150–200ms) or none | Hard cuts preferred; looping animations are anti-brutalist |
| `warm-photographic` | Tier 1–3 | `float` (1C) + `video-scaffold` (3A), or `scroll-parallax` (2D) | Image and video motion earns its place; gradient poster doubles as animation before video loads |

**Motion restraint rule**: regardless of tier, a hero should have **at most two simultaneous motion elements**.
A gradient-shifting background + a text-reveal is the maximum for Tier 1. Adding floating elements on top
of both reads as busy, not polished.

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
| N21 | Static hero with no motion or visual interest — a poster, not an experience; inappropriate for archetype | critic (vision) |
| N22 | Motion that fights readability: looping animations over primary text, excessive parallax, or more than two simultaneous motion elements in the hero | critic (vision + motion layer) |
| N23 | jQuery-era motion effects: bouncing, sliding content in from offscreen, accordion animations everywhere, spinning decorative elements | critic (vision) |

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
| `2026.4` | 2026-06 | Added hero motion vocabulary (Tier 1 CSS-only, Tier 2 SVG+JS, Tier 3 video placeholders with CSS examples), per-archetype motion profiles table, negatives N21–N23 (#1043). Schema extended with `motion.tier`, `motion.hero_technique`, `motion.video_placeholder` fields and `motion` rubric dimension. |
