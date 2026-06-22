---
description: Route a design GitHub issue through the UI Taste Harness — investigate → architect → implement → critique loop → user-feedback loop → close — accumulating FORGE:DESIGN_* annotations and driving the design:* label state machine to design:shipped.
argument-hint: <issue-number> | <brief-name>
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /design — the design pipeline (the `/work-on` analog for design)

**Input**: $ARGUMENTS — a design issue number, or a seed brief name (`cadence` | `tender` | `slipstream` | `voltage` | `plume`) which is opened as a design issue first.

This is the **spine of the UI Taste Harness** (milestone #13, issue #888). Just as a code task is a GitHub issue
routed `investigate → build → review → close` by [`/work-on`](work-on.md) — accumulating `FORGE:*` annotations, closed
at the end — a **design task is a GitHub issue routed through this design pipeline**, accumulating `FORGE:DESIGN_*`
annotations and closed when the design ships and passes its gates. It is a parallel track on the same "GitHub as a
knowledge graph" model, not a new paradigm.

**It IS arm A of the ABC benchmark (#878).** Running a brief through `/design` produces the arm-A output; the benchmark
rig (`/design-bench`) feeds briefs in and screenshots the result, so this command is what makes the benchmark runnable
end to end.

**Agent model policy**: `model: "claude-opus-4-6"` — Opus is the validated generation model. Benchmark #878 (90% A-vs-B pairwise win-rate with Opus vs 54% with Sonnet) confirms a tier-level quality difference. Both arm A and arm B MUST use the same model to keep the benchmark valid (see [design-bench](design-bench.md)).

**No application runtime.** ForgeDock is a set of command specs. `/design` *sequences* the already-built stage specs —
it does not reimplement them. The only executable helper in the chain is the deterministic linter
`scripts/design-system-lint.mjs` (#884).

---

## Universal Stage Dispatcher

<!-- This is the single source of truth for design:* transitions, mirroring /work-on's Universal Phase Dispatcher. -->

| Stage | design:* label | Terminal? | Reads | Produces | Spec it sequences |
|-------|----------------|-----------|-------|----------|-------------------|
| 1. design-investigate | `design:investigating` | No | the brief | `FORGE:DESIGN_CONTEXT` | corpus #880 (grammar) + memory #887 (what to diverge from) |
| 2. design-architect | `design:architecting` | No | `FORGE:DESIGN_CONTEXT` | `FORGE:DESIGN_RATIONALE` → `FORGE:DESIGN_CANDIDATES` → `FORGE:DESIGN_SPEC` | rationale #886, divergent generation #883, effects #885, schema #881 |
| 3. design-implement | `design:generating` | No | `FORGE:DESIGN_SPEC` | the generated page (artifact) | — (generate from the committed spec) |
| 4. design-critique | `design:critiquing` | No | the render + `FORGE:DESIGN_SPEC` | `FORGE:CRITIQUE` (per pass) | render→critique loop #882 (lint #884 floor + perf #875 + a11y) |
| 4.5. user-feedback | `design:awaiting-feedback` | No | `FORGE:CRITIQUE` + user input | `FORGE:USER_FEEDBACK` (per round) | this spec (#1044); bypassed in automated/benchmark runs |
| 5. design-close | `design:shipped` / `design:rejected` | **Yes** | `FORGE:USER_FEEDBACK` (latest) or `FORGE:CRITIQUE` | `FORGE:DESIGN_SHIPPED` | scorecard + write outcome to memory #887 |

**Continuation rule** (mirrors `/work-on`): after any stage completes, if the issue is not at a terminal label
(`design:shipped` or `design:rejected`), proceed to the next stage immediately. No intermediate stage is terminal.
`design:awaiting-feedback` is **non-terminal** — it resolves to Stage 5 when `FORGE:USER_FEEDBACK.satisfied == "yes"`
or when no user is present (automated runs bypass Stage 4.5 entirely).

---

## Stage 1 — design-investigate (`design:investigating`)

Parse the brief into message / audience / single objection. Pull the relevant grammar from the
[reference corpus](../docs/design/reference-corpus.md) (#880) and query [design-memory](../docs/design/design-memory.md)
(#887) for the recent signature moves / archetypes / palettes to **diverge** from. Post `FORGE:DESIGN_CONTEXT`.

## Stage 2 — design-architect (`design:architecting`)

Run the [design-architect rationale](../docs/design/design-architect-rationale.md) (#886): the 7-element diary →
`FORGE:DESIGN_RATIONALE`. Then [divergent generation](../docs/design/divergent-generation.md) (#883): commit one
archetype, diverge into N directions, independent taste-judge selects → `FORGE:DESIGN_CANDIDATES`. The winning
direction + the [effects-appropriateness](../docs/design/effects-appropriateness.md) (#885) `effects_plan` are
committed into `FORGE:DESIGN_SPEC` ([schema](../docs/design/design-spec-schema.md), #881).

## Stage 3 — design-implement (`design:generating`)

Generate the page from the committed `FORGE:DESIGN_SPEC`. The spec is the contract — no taste decisions are re-rolled
here; generation realizes the committed intent.

### Foundation CSS injection <!-- Added: forge#1048 -->

Before generating the page, inject the archetype's pre-built CSS foundation as the starting stylesheet. Foundation files live in `docs/design/foundations/` and are keyed by `meta.archetype` from `FORGE:DESIGN_SPEC`:

| `meta.archetype` | Foundation file |
|---|---|
| `editorial-typographic` | `docs/design/foundations/editorial.css` |
| `technical-dense` | `docs/design/foundations/technical.css` |
| `minimal-luxury` | `docs/design/foundations/minimal-luxury.css` |
| `bold-brutalist` | `docs/design/foundations/brutalist.css` |
| `warm-photographic` | `docs/design/foundations/warm-photo.css` |

**Injection pattern**: read the foundation file content and include it in the generation prompt as the starting `<style>` block. Instruct the generator to:
1. Use the foundation's component classes (`.btn`, `.card`, `.badge`, `.input`, `.reveal`) where applicable — do NOT replace them with generic Tailwind equivalents.
2. Override `--color-accent` and `--color-bg` custom properties with the spec's `color.accent` and `color.background` values to apply the committed palette to the foundation.
3. Extend, don't replace — additional styles may be added on top of the foundation, but the foundation's radius system, component state management (hover/active/focus), and micro-detail rules (::selection, scrollbar, focus rings) must be preserved.

The foundation is the professional baseline. The generator adds layout and content on top.

## Stage 4 — design-critique (`design:critiquing`)

Run [`/design-render-critique-loop`](design-render-critique-loop.md) (#882): deterministic lint floor (#884) → Playwright
render (desktop + mobile, #875/#878) → vision critique of the perceptual negatives → iterate. Each pass posts a
`FORGE:CRITIQUE`. The loop continues until PASS or budget.

## Stage 4.5 — user-feedback loop (`design:awaiting-feedback`) <!-- Added: forge#1044 -->

**Entry condition**: Stage 4 (design-critique) has completed — `FORGE:CRITIQUE` posted with verdict `PASS` or
`BUDGET-EXHAUSTED`. **Automated/benchmark bypass**: if no user is present (e.g., running as part of the ABC benchmark
arm A), skip this stage entirely and proceed to Stage 5.

**Purpose**: The automated critique loop (#882) closes the perceptual-quality loop. This stage closes the **brand
fit** loop — the part only the user can judge. Brand assets are user-supplied, emotional register is subjective, and
the best heroes are refined, not generated once. Stage 4.5 collects that input in a structured way and routes it to
surgical section-level re-generation rather than full-page regeneration.

### Step 1 — Set label

```bash
gh issue edit {NUMBER} {GH_FLAG} --add-label "design:awaiting-feedback" \
  --remove-label "design:critiquing" 2>/dev/null || true
```

### Step 2 — Prompt the user with structured hero-specific questions

After Stage 4 completes, post a comment on the design issue asking the user the following questions. Present them
clearly — the user's answer drives the `FORGE:USER_FEEDBACK` structured fields.

```
## Hero feedback — your turn

The automated critique is complete. Now it's yours to shape.

Please answer any or all of the following:

1. **Demo video or animation** — Do you have a product demo video or animation to feature in the hero?
   (paste a URL, or say "none")

2. **Primary emotion** — What's the primary feeling you want the hero to evoke?
   Options: trust / speed / power / craft / play — or describe in your own words.

3. **Brand assets** — Any assets to integrate?
   - Logo SVG (paste URL or say "none")
   - Brand hex colors (e.g. "#1a1a2e, #e94560" or "none")
   - Product screenshots (paste URLs or say "none")

4. **Anything that feels off?** — Any section, element, or overall impression that feels wrong or
   off-brand? Describe it.

If you're happy with the design as-is, reply: **"looks good, ship it"** (or any affirmative) — that
sets `satisfied: yes` and moves to Stage 5 without re-generation.
```

### Step 3 — Parse the user's response into `FORGE:USER_FEEDBACK`

Read the user's reply and produce a structured `FORGE:USER_FEEDBACK` annotation. Map natural-language input to
the structured fields:

| User says | Maps to |
|---|---|
| Pastes a video URL | `feedback_type: asset`, `asset_url: <url>`, `section_target: "hero"` |
| "make it feel faster / more urgent" | `feedback_type: emotion`, `emotion_target: speed`, `modification: "increase motion intensity; tighten headline tracking"` |
| "add our logo" + SVG URL | `feedback_type: asset`, `asset_url: <url>`, `section_target: "nav"`, `modification: "replace text logo with SVG; adjust sizing"` |
| Provides brand hex colors (e.g. "#1a1a2e") | `feedback_type: asset`, `asset_url: none`, `section_target: "all"`, `modification: "update CSS custom properties: --color-accent: #… --color-bg: #…"` |
| Describes a layout change | `feedback_type: direction`, `modification: <parsed description>` |
| Freeform complaint | `feedback_type: freeform`, `freeform_notes: <verbatim>`, `modification: <best-effort parse>` |
| "looks good" / "ship it" / affirmative | `satisfied: yes` → proceed to Stage 5 without re-generation |

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:USER_FEEDBACK -->
## User Feedback — {product} · round {n}

**Section target:** {section_target}
**Feedback type:** {asset | emotion | direction | freeform}
**Asset URL:** {URL or "none"}
**Modification:** {structured description of what to change}
**Emotion target:** {trust | speed | power | craft | play | unchanged}
**Satisfied:** {yes | no}
**Freeform notes:** {verbatim user input not captured above}
<!-- FORGE:USER_FEEDBACK:COMPLETE -->"
```

### Step 4 — Route on `satisfied`

**If `satisfied: yes`** (user approved, or no feedback given): proceed immediately to Stage 5 (design-close).
No re-generation needed.

**If `satisfied: no`** (feedback given): proceed to Step 5 (surgical re-generation), then loop back to Step 2
for another feedback round.

### Step 5 — Surgical re-generation (only when `satisfied: no`)

Use the `section_target` from `FORGE:USER_FEEDBACK` and the section IDs in `FORGE:DESIGN_SPEC →
layout_grammar.sections` to re-generate only the targeted section. See
[`docs/design/design-spec-schema.md`](../docs/design/design-spec-schema.md) for the full surgical re-generation
contract.

**Inputs for the re-generation agent**:
1. The full current HTML page
2. `FORGE:DESIGN_SPEC` (the committed spec — defines what all non-targeted sections must look like)
3. `FORGE:USER_FEEDBACK` (the modification + asset URL for the targeted section)

**Re-generation rules**:
- Modify **only** the targeted section's markup and styles
- Do NOT change any other section's content, layout, or CSS
- Do NOT re-roll the committed `meta.archetype` or the signature move from `FORGE:DESIGN_RATIONALE`
- If the feedback requires an archetype change, note the constraint and propose the closest variant within the committed direction
- After re-generation, run the deterministic linter on the modified section to catch any regressions (#884)

**Asset integration**:

| Asset | Integration procedure |
|---|---|
| Video URL (mp4/webm) | Add `<video autoplay loop muted playsinline>` scaffold in the hero visual area; adjust hero layout CSS to accommodate; keep LCP budget ≤ 2000ms |
| Video embed URL (YouTube/Vimeo) | `<iframe>` with `loading="lazy"` and aspect-ratio container (`padding-top: 56.25%`); no autoplay |
| Logo SVG | Fetch the SVG; inline or `<img>` it at the nav/hero logo node; remove the text logo; set `width`/`height` to maintain proportional sizing; verify contrast against background (WCAG AA ≥ 4.5:1) |
| Brand hex colors | Update the relevant CSS custom properties (`--color-accent`, `--color-bg`, etc.); run contrast check on all text/background pairs; record the update in `effects_plan.per_section` if it affects a hero effect |
| Product screenshot/image | Replace the placeholder with `<img loading="lazy" decoding="async">` or a `background-image`; maintain existing aspect-ratio and sizing tokens from the spec |

**After re-generation**: loop back to Step 2 — prompt the user again for the next round.

### Budget

Maximum **3 user-feedback rounds** per design issue (configurable). If the budget is exhausted with `satisfied: no`,
post a summary of the rounds and proceed to Stage 5 with the best version. The design was not fully approved by the
user — note this in the `FORGE:DESIGN_SHIPPED` annotation.

---

## Stage 5 — design-close (`design:shipped` | `design:rejected`)

Apply the **definition of done**: critique-rubric threshold met **and** perf budget (#875) **and** a11y check **and**
the divergence check vs memory (#887) — not a reskin of a prior design. If all pass → write the realized outcome
(archetype, signature move, palette/type/effects, learnings) to [design-memory](../docs/design/design-memory.md) (#887),
post `FORGE:DESIGN_SHIPPED`, set `design:shipped`, close the issue. Otherwise loop (back to Stage 4) or, if the budget is
exhausted with residual findings, set `design:rejected` with the reasons on the issue.

---

## Label state machine

```
design:investigating → design:architecting → design:generating → design:critiquing → design:awaiting-feedback → design:shipped
                                                                                              │                       ↑
                                                                                              └──── (loop ≤ 3) ───────┘
                                                                                  (automated bypass: skip awaiting-feedback)
                                                                          └──────────────────────────────────────────→ design:rejected
```

Terminal labels: `design:shipped`, `design:rejected`. These mirror `workflow:merged` / `workflow:invalid` on the code
track. `design:awaiting-feedback` is **non-terminal** — it resolves to `design:shipped` (via Stage 5) when the user
approves or the feedback budget is exhausted.

## Definition of done

A design ships only when it passes **all** of: the critique rubric threshold, the perf budget (#875), the a11y check,
and the divergence check (#887). Anything short loops or is rejected with reasons recorded on the issue — so every
outcome, pass or fail, is auditable on the GitHub issue.

## Why it matters

1. **Traceability** — every design's thinking (`FORGE:DESIGN_RATIONALE`), the candidate set and the choice
   (`FORGE:DESIGN_CANDIDATES`), each critique iteration (`FORGE:CRITIQUE`), each user-feedback round
   (`FORGE:USER_FEEDBACK`), and the final outcome (`FORGE:DESIGN_SHIPPED`) live on the issue. You can read *why* a
   page looks the way it does — the designer's diary, made auditable, reviewable by a non-designer.
2. **It is arm A.** Driving the seed briefs (Cadence / Tender / Slipstream / Voltage / Plume) through `/design`
   produces the arm-A outputs the benchmark (#878) scores against the real references — so building this makes the ABC
   benchmark runnable end to end.
3. **Brand fit.** The automated critique loop (#882) closes the perceptual-quality loop. Stage 4.5 closes the brand-fit
   loop — the part only the user can judge. Brand assets are user-supplied, emotional register is subjective, and the
   best heroes are refined through iteration. The feedback annotations make that iteration traceable and repeatable.
