# Render → vision-critique → iterate loop

> **Status**: committed methodology doc for the UI Taste Harness (#882).
> Executed by [`/design-render-critique-loop`](../../commands/design-render-critique-loop.md).
> Consumes: [`FORGE:DESIGN_SPEC`](design-spec-schema.md) (#881), the deterministic linter `scripts/design-system-lint.mjs` (#884), the perceptual negatives N3/N8–N12 in [reference-corpus](reference-corpus.md) (#880), the #878/#875 Playwright render protocol.
> Independent from the [ABC benchmark judge](abc-benchmark.md) (#878) — anti-Goodhart.
> Part of #877.

## The thesis

AI UI is generic because UI generation has **no feedback loop**: the model writes markup blind, never sees the rendered
pixels, and defends whatever it produced. Every other lever in the harness — the spec (#881), the effects doctrine
(#885), divergent generation (#883) — still operates *before* a pixel exists. This loop is the one stage that closes
the loop: render the page, *look at it*, and feed a correction back in. It is the missing reward signal.

## Why a loop, not a one-shot check

A single post-hoc lint pass catches deterministic tells but cannot see whether the *rendered* page has hierarchy,
whether an effect served the content, or whether the composition is generic. Those are perceptual judgements that only
exist once pixels are on screen, and fixing one often surfaces another. So the correction must **iterate**: critique →
fix → re-render → re-critique, until the page passes or the budget is spent.

## Iteration protocol

1. **Deterministic floor first.** Run the linter (#884) before every render. Never spend a render on a page that fails
   a hard rule. This keeps the expensive perceptual step off pages a cheap check already rejects.
2. **Render** at desktop + mobile, using the same Playwright protocol as the benchmark (#878/#875).
3. **Vision-critique the pixels** against the perceptual negatives the linter declares out of scope — N3 (centered / no
   asymmetry), N8 (stock / generic 3D), N9 (glassmorphism overuse), N10 (no hierarchy), N11 (abstract copy / no product
   shown), N12 (decorative effects that serve nothing) — plus the spec's own acceptance and the `effects_plan`
   justifications (#885).
4. **Emit a `FORGE:CRITIQUE`** per iteration so the improvement trajectory is auditable.
5. **Iterate** until no perceptual findings remain (PASS) or `max_iters` is reached (BUDGET-EXHAUSTED with residuals).

## Division of labour (no duplication)

| Stage | Owns | Nature |
|---|---|---|
| Linter (#884) | deterministic negatives (N1, N2, N4-structural, contrast floor, off-scale spacing) | cheap, hard gate, runs first |
| This critic (#882) | perceptual negatives N3, N8–N12 + spec acceptance | iterative, perceptual |
| Perf gate (#875) | `effects_plan.budget` (LCP/CLS/INP/JS-kb) | hard, objective |

The critic never re-checks a deterministic rule; the linter never judges perception. Each negative has exactly one
owner.

## Anti-Goodhart independence

The loop's critic is **not** the ABC benchmark judge (#878) and **not** the divergent-generation taste-judge (#883).
The benchmark judge is the independent scoreboard that tells us whether the harness improved; optimizing the loop
against it would be training on the test set. The taste-judge scores pre-render candidate directions. Three judges,
three jobs — the separation is what keeps the reward signal honest.

## Success measure

The loop is working when a page **measurably improves across iterations**, and when — on the seed set, scored by the
independent benchmark (#878) against the #879 baseline — *A-with-loop* > *A-without-loop* > *raw B*. The loop produces
the improvement; the benchmark, which the loop never sees, confirms it.
