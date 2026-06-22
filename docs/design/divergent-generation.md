# Divergent generation + archetype sampling + taste-judge selection

> **Status**: committed foundation doc for the UI Taste Harness (#883).
> The variance lever: how the harness produces *different* good pages instead of mode-collapsing to one.
> Consumes: [reference-corpus](reference-corpus.md) archetypes (#880), the [design-architect rationale](design-architect-rationale.md) (#886).
> Produces: a `FORGE:DESIGN_CANDIDATES` set whose winner hands off into [`FORGE:DESIGN_SPEC`](design-spec-schema.md) (#881).
> Judge is independent from the render → vision-critique loop (#882) and the [ABC benchmark judge](abc-benchmark.md) (#878) — anti-Goodhart.
> Part of #877.

## Purpose

Two failure modes bracket AI UI generation. **Mode collapse**: "make it beautiful" yields the same gradient-hero
template every time — zero variance. **Incoherent blending**: averaging archetypes ("a bit editorial, a bit
brutalist") yields mush — variance without taste. This doc defines the lever that sits between them: **commit to one
archetype, then diverge *within* it across N distinct directions, and let an independent taste-judge pick the winner.**

Variance between runs comes from *which archetype + which direction* is chosen — never from blending. Coherence within
a run comes from committing and not drifting.

## Step 1 — Archetype sampling (commit, never blend)

From the design-blind brief + the architect rationale (#886), select **exactly one** archetype from the five committed
in [reference-corpus](reference-corpus.md) (#880). The ids are fixed tokens — they must match exactly, because the
selected id is written into `meta.archetype` in the [spec](design-spec-schema.md):

| `archetype` id | When it fits |
|---|---|
| `editorial-typographic` | considered, magazine, type-led products; content-forward |
| `technical-dense` | dashboards, compute, infra; capable, data-forward |
| `minimal-luxury` | premium, lots of air; restraint as the message |
| `bold-brutalist` | opinionated, high-contrast; a stance |
| `warm-photographic` | human, approachable; image/people-led |

**Selection rule** (from the corpus): pick the one appropriate to *product nature* + *audience* inferred from the
brief, then **commit**. No blending, no averaging, no "60% A / 40% B". The variance lever is the *choice between*
archetypes across runs and the divergent directions below — not a blend within a run.

## Step 2 — Divergent generation (N distinct directions)

Within the committed archetype, generate **N distinct directions** (default N=3). Each direction is a genuinely
different interpretation of the *same* archetype + rationale — different layout grammar, different signature move,
different typographic instantiation — not N near-duplicates with a hue shift. Divergence is structural, not cosmetic.

Each direction carries:
- a one-line concept (the interpretation),
- its **signature move** (from the rationale's diary — the non-obvious idea that makes it *this* page),
- the salient token/grammar choices that distinguish it from its siblings.

Sampling within one archetype keeps every direction coherent; requiring *structural* difference keeps them genuinely
divergent. If two directions collapse to the same signature move, one is rejected and re-rolled — duplicate directions
defeat the lever.

## Step 3 — Taste-judge score + select

An **independent taste-judge** scores the N directions and selects one winner. The judge:
- scores each direction on a small taste rubric (hierarchy/intent, signature-move strength, archetype fit, restraint),
- rejects any that trip the corpus negatives or duplicate a sibling,
- selects the highest-scoring surviving direction; ties break toward the stronger signature move.

### Judge independence (anti-Goodhart) — non-negotiable

This taste-judge is **distinct** from both:
- the **render → vision-critique loop** (#882), which judges a *rendered* page against its committed spec, and
- the **ABC benchmark judge** (#878), which scores arms blind against arm C for evaluation.

Reusing either as the selection judge would let the harness optimize directly against its own evaluator — the textbook
Goodhart failure. The selection judge scores *candidate directions* (pre-render intent); the critic scores *rendered
output*; the benchmark scores *finished arms*. Three separate judges, three separate jobs.

## Step 4 — Hand-off to DESIGN_SPEC

The winning direction is what gets fully specified: it hands off into [`FORGE:DESIGN_SPEC`](design-spec-schema.md)
(#881) — `meta.archetype` = the committed id, `layout_grammar`/`signature` = the winning direction. The losing
directions are retained in the `FORGE:DESIGN_CANDIDATES` annotation (below) so the choice is auditable and so
[design-memory](design-memory.md) (#887) can later diverge from past winners.

## The `FORGE:DESIGN_CANDIDATES` annotation

Registered in [FORGE-PROTOCOL](../FORGE-PROTOCOL.md). Posted at the divergent-generation step, between the rationale
and the spec. It records the committed archetype, the N directions, and the judge's selection + scores — so the
variance decision is a first-class, machine-queryable artifact, not a hidden roll.

```markdown
<!-- FORGE:DESIGN_CANDIDATES -->
## Design Candidates — {product}

**Archetype (committed):** {one of the 5 corpus ids}
**Directions:**
1. {concept} — signature: {move} — {distinguishing grammar/tokens}
2. {concept} — signature: {move} — {…}
3. {concept} — signature: {move} — {…}
**Judge scores:** 1) {score} 2) {score} 3) {score}
**Selected:** #{n} — because {reason}

→ Winner produces DESIGN_SPEC: {link}
```

## Acceptance (worked expectation)

On the seed set, the same brief produces a *committed archetype* and visibly different *directions*:
- **Voltage** (`technical-dense`): directions differ on whether the signature move is a scaling-compute visualization,
  a code-first hero, or a benchmark-grid — same archetype, three structures.
- **Plume** (`minimal-luxury` / `editorial-typographic`): directions differ on keyboard-motif vs cycle-timeline vs
  pure-type hierarchy — all restrained, all coherent.

Variance shows up as *which archetype + which direction wins*, across runs — never as a blend within a run.
