# Effects-appropriateness layer

> **Status**: committed foundation doc for the UI Taste Harness (#885).
> Consumes: [reference-corpus](reference-corpus.md) effect-usage patterns (#880),
> [design-spec-schema](design-spec-schema.md) `effects_plan` slot (#881).
> Enforced by: the perf gate (#875, hard/objective) and the vision critique loop (#882, perceptual — N12).
> Stays out of: the deterministic [linter](design-system-lint.md) (#884) — effect justification is not deterministically checkable.
> Authored to be consumed by: the [design-architect rationale](design-architect-rationale.md) (#886) and [design-memory](design-memory.md) (#887) phases.
> Part of #877.

## Purpose

The schema (#881) gives every page an `effects_plan` — a slot for *which* heavy techniques run *where*, at *what*
intensity, with a *budget* and a *never* list. The slot is a placeholder. This doc is the **reasoning doctrine that
fills it**: how the harness decides, **from the design-blind brief alone**, when a heavy effect earns its cost and
when restraint is the more confident choice.

The thesis: AI UI mode-collapses toward gratuitous motion because "make it impressive" has no cost model. The fix is
to treat every effect as a spend that must be *justified against the content it serves and the budget it consumes* —
and to make the default **restraint**, with effects added only on evidence, never by reflex.

## The core asymmetry

Not all effects reward the same posture. This is the single most important rule in this doc:

> **Compositional contrast rewards *more* intention. 3D/WebGL, parallax, and multi-layer depth reward *restraint*.**

Flattening this into "less is always more" loses the doctrine. Low contrast is itself a slop tell (flat, equal-weight,
nothing directs the eye — see N12's sibling failures). Deliberate contrast is almost always correct. The *decorative*
effects (depth, motion, 3D) are the ones that must earn their place against a hard cost.

## Effect taxonomy + appropriateness/cost

Derived from the corpus effect-usage table (#880); this layer formalizes the `Earns its place when…` / `Slop when…`
columns into authoring rules with an explicit cost axis.

| Effect | Posture | Earns its place when… | Slop when… | Primary cost |
|---|---|---|---|---|
| **Compositional contrast** | *more* intention | almost always — direct the eye, establish hierarchy | flat, equal-weight, everything the same size/color | ~none (CSS) |
| **Multi-layer depth** (glass / grain / gradient) | restraint | one hero backdrop; foreground/background separation that aids reading | over-glass, muddy contrast, applied everywhere | contrast/a11y risk; minor paint |
| **Parallax / scroll-driven** | restraint | a single progressive-capability reveal where depth *is* the message | on every section; jank/CLS; fights readability | INP/CLS; JS |
| **3D / WebGL** | strong restraint | the product is spatial/visual; exactly one premium hero centerpiece with a fallback | bolted onto non-visual B2B; wrecks LCP; no reduced-motion/no-WebGL fallback | LCP + JS-kb (largest) |

## The 6 decision inputs

The architect/rationale phase (#886) infers all six from the brief alone, then writes them into `effects_plan`:

1. **Product nature** — is the product itself *spatial/visual* (renders, maps, 3D, creative tooling), *technical/data*
   (compute, dashboards, infra), or *text/workflow* (trackers, docs, email)? Spatial → a heavy hero may be earned;
   text/workflow → near-zero decorative.
2. **Archetype** — the committed archetype carries an **effects posture** prior (#880): `bold-brutalist` →
   "sharp, near-zero decorative"; `technical-dense` → "code/data motion welcome"; `minimal-luxury` →
   "restrained micro-motion"; `editorial-typographic` → "minimal, type-led"; `warm-photographic` → "image-driven, soft motion".
3. **Section job** — what is *this* section for? A hero may carry one centerpiece; a pricing table or feature grid
   carries none. Effect intensity is assigned **per section**, not per page.
4. **Audience expectation** — engineers who "read the code sample closely" reward technical credibility and are
   *repelled* by gratuitous motion; a consumer/creative audience tolerates more spectacle.
5. **Measurable perf budget** (#875) — LCP / CLS / INP / JS-kb ceilings. This is the **hard gate**: an effect that
   blows the budget is rejected regardless of how good it looks.
6. **Accessibility** — `prefers-reduced-motion` must be honored; depth must not destroy contrast; every WebGL/3D
   centerpiece needs a static fallback. A11y failures are not negotiable against aesthetics.

## Mapping decision inputs → `effects_plan`

The fields mirror [design-spec-schema](design-spec-schema.md) exactly:

`effects_plan { per_section[{ section, effect, intensity, justification }], budget{ lcp_ms, max_js_kb }, never[] }`

- **`per_section[].effect` / `.intensity`** — from inputs 1–4. Default `intensity: none`. Raise it only when product
  nature + archetype + section job *agree* that the effect serves the content. Each step up in intensity needs a
  stronger justification.
- **`per_section[].justification`** — one sentence stating *what content the effect serves*. "Looks premium" is not a
  justification; "the spatial product *is* the demo, shown once in the hero" is. The critic (#882) reads this field
  and judges whether the rendered effect actually delivered on it (N12).
- **`budget{ lcp_ms, max_js_kb }`** — from input 5. The hard ceiling. The perf gate (#875) measures the rendered arm
  against it; over-budget = fail, no aesthetic override.
- **`never[]`** — from inputs 2 + 6. Per-archetype prohibitions (e.g. `bold-brutalist` → `never: [parallax, glass]`)
  and universal a11y rules (`never: [motion-without-reduced-motion-fallback]`).

## Enforcement split

Three mechanisms, deliberately non-overlapping — no single check owns the whole problem:

| Mechanism | Owns | Nature |
|---|---|---|
| **Perf gate** (#875) | `budget` — did the effect stay within LCP/CLS/INP/JS-kb? | **Hard, objective.** Earned its *ms*. Blocking. |
| **Vision critic** (#882) | N12 — did each effect *serve the content* it claimed to? | **Perceptual.** Earned its *place*. Finding. |
| **Deterministic linter** (#884) | nothing here | Effects are explicitly **out of scope** — not deterministically checkable. |

The perf gate answers "could the user afford it?"; the critic answers "was it worth it?". An effect must pass **both**:
within budget *and* serving the content. Within budget but gratuitous → critic N12 finding. Justified but over budget →
perf-gate fail. The linter stays out because perceptual judgement can't be reduced to a regex without false hard-fails
(consistent with `design-system-lint.md`'s N8–N12 out-of-scope list).

## Worked inferences (seed set)

Demonstrating that the doctrine produces **visibly different effect intensity from the briefs alone** — the acceptance
criterion. Each is derived purely from the design-blind brief; no visual direction is given.

### Voltage — serverless compute / GPUs for ML engineers
- **Product nature**: technical/data (compute), with a *credible* spatial story (containers scaling zero→thousands).
- **Audience**: engineers who read the code sample closely → reward technical credibility, repelled by spectacle.
- **Inference**: `technical-dense` archetype; **one restrained** technical hero visualization (subtle scaling/compute
  motion that *is* the product story), `intensity: subtle`. Code sample is the real hero. No parallax, no glass.
- `effects_plan`: hero → `effect: technical-motion, intensity: subtle, justification: "the zero→N scaling IS the product, shown once"`;
  all other sections → `none`. `never: [parallax, decorative-3d]`. Tight JS budget (audience will notice bloat).

### Plume — fast, keyboard-driven issue tracker for software teams
- **Product nature**: text/workflow. Speed and focus are the message.
- **Audience**: craft-focused technical teams who find heavy tools heavy → motion that slows them is *anti-product*.
- **Inference**: `minimal-luxury` / `editorial-typographic`; **near-zero motion**. The product's own speed is the
  argument; any decorative effect contradicts it. Contrast and typography do all the work.
- `effects_plan`: every section → `intensity: none`; `never: [parallax, 3d, glass]`. Restraint *is* the design.

### Slipstream — git-connected deploy platform / global edge
- **Product nature**: technical/infra; "confidence and restraint" stated explicitly in the brief.
- **Audience**: frontend/full-stack devs; serious, opinionated platform.
- **Inference**: restrained, typographic-technical. At most **one** subtle scroll reveal for the push→production flow
  (depth *is* part of that narrative), `intensity: subtle`; everything else `none`. Restraint as the move.
- `effects_plan`: hero/flow → `effect: scroll-reveal, intensity: subtle, justification: "push→prod is a sequence; one reveal shows it"`;
  rest → `none`. `never: [decorative-3d, glass]`.

**Differential**: Voltage gets one subtle *technical* hero motion; Plume gets *zero*; Slipstream gets one subtle
*scroll reveal* — three visibly different intensities, inferred from product nature + audience alone. None reaches for
3D/WebGL, because none is a spatial/visual product. That restraint is the doctrine working.

## Authoring checklist (for the rationale phase, #886)

- [ ] Default every section to `intensity: none`; raise only on agreement of inputs 1–4.
- [ ] Every non-`none` entry carries a content-serving `justification` (not "looks premium").
- [ ] `budget` set from #875 ceilings; `never[]` set from archetype posture + a11y.
- [ ] Reduced-motion + WebGL/3D fallback covered in `never[]` or per-section notes.
- [ ] Contrast treated as *expected*, not optional; low contrast flagged as a tell.
