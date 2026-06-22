---
description: Route a design GitHub issue through the UI Taste Harness — investigate → architect → implement → critique loop → close — accumulating FORGE:DESIGN_* annotations and driving the design:* label state machine to design:shipped.
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

| Stage | design:* label | Reads | Produces | Spec it sequences |
|-------|----------------|-------|----------|-------------------|
| 1. design-investigate | `design:investigating` | the brief | `FORGE:DESIGN_CONTEXT` | corpus #880 (grammar) + memory #887 (what to diverge from) |
| 2. design-architect | `design:architecting` | `FORGE:DESIGN_CONTEXT` | `FORGE:DESIGN_RATIONALE` → `FORGE:DESIGN_CANDIDATES` → `FORGE:DESIGN_SPEC` | rationale #886, divergent generation #883, effects #885, schema #881 |
| 3. design-implement | `design:generating` | `FORGE:DESIGN_SPEC` | the generated page (artifact) | — (generate from the committed spec) |
| 4. design-critique | `design:critiquing` | the render + `FORGE:DESIGN_SPEC` | `FORGE:CRITIQUE` (per pass) | render→critique loop #882 (lint #884 floor + perf #875 + a11y) |
| 5. design-close | `design:shipped` / `design:rejected` | the final critique | `FORGE:DESIGN_SHIPPED` | scorecard + write outcome to memory #887 |

**Continuation rule** (mirrors `/work-on`): after any stage completes, if the issue is not at a terminal label
(`design:shipped` or `design:rejected`), proceed to the next stage immediately. No intermediate stage is terminal.

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

## Stage 4 — design-critique (`design:critiquing`)

Run [`/design-render-critique-loop`](design-render-critique-loop.md) (#882): deterministic lint floor (#884) → Playwright
render (desktop + mobile, #875/#878) → vision critique of the perceptual negatives → iterate. Each pass posts a
`FORGE:CRITIQUE`. The loop continues until PASS or budget.

## Stage 5 — design-close (`design:shipped` | `design:rejected`)

Apply the **definition of done**: critique-rubric threshold met **and** perf budget (#875) **and** a11y check **and**
the divergence check vs memory (#887) — not a reskin of a prior design. If all pass → write the realized outcome
(archetype, signature move, palette/type/effects, learnings) to [design-memory](../docs/design/design-memory.md) (#887),
post `FORGE:DESIGN_SHIPPED`, set `design:shipped`, close the issue. Otherwise loop (back to Stage 4) or, if the budget is
exhausted with residual findings, set `design:rejected` with the reasons on the issue.

---

## Label state machine

```
design:investigating → design:architecting → design:generating → design:critiquing → design:shipped
                                                                          └────────────→ design:rejected
```

Terminal labels: `design:shipped`, `design:rejected`. These mirror `workflow:merged` / `workflow:invalid` on the code track.

## Definition of done

A design ships only when it passes **all** of: the critique rubric threshold, the perf budget (#875), the a11y check,
and the divergence check (#887). Anything short loops or is rejected with reasons recorded on the issue — so every
outcome, pass or fail, is auditable on the GitHub issue.

## Why it matters

1. **Traceability** — every design's thinking (`FORGE:DESIGN_RATIONALE`), the candidate set and the choice
   (`FORGE:DESIGN_CANDIDATES`), each critique iteration (`FORGE:CRITIQUE`), and the final outcome
   (`FORGE:DESIGN_SHIPPED`) live on the issue. You can read *why* a page looks the way it does — the designer's diary,
   made auditable, reviewable by a non-designer.
2. **It is arm A.** Driving the seed briefs (Cadence / Tender / Slipstream / Voltage / Plume) through `/design`
   produces the arm-A outputs the benchmark (#878) scores against the real references — so building this makes the ABC
   benchmark runnable end to end.
