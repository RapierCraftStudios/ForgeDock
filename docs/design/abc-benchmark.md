# The ABC Benchmark — Methodology

> **Status:** Foundation spec for issue #878 (milestone #13, UI Taste Harness).
> The benchmark is the milestone's **fitness function** — built *before* the harness. It is what tells us
> whether each lever the harness adds actually moves design quality. Harness development reduces to one
> question this rig answers: *"did arm A's score against C go up?"*
>
> Companion to [design-spec-schema](design-spec-schema.md) (#881), [reference-corpus](reference-corpus.md) (#880),
> and the [`/design-bench`](../../commands/design-bench.md) command spec.
> Results are carried as a `FORGE:BENCH_SCORECARD` annotation — registered in
> [`../FORGE-PROTOCOL.md`](../FORGE-PROTOCOL.md).

## Why this exists first

A taste benchmark is not a test we run at the end. It is the reward signal. Without it, every "improvement" to
the harness is a guess. With it, each lever (archetype sampling, anti-slop negatives, the critique loop) is a
measurable hypothesis: add the lever, re-run the benchmark, confirm arm A's win-rate against C went up. Build the
ruler before building the thing it measures.

## The three arms — same input, one variable

The **input is a single design-blind product brief** derived from a real reference page. It describes only what the
product *does* — no "make it like X", no colors, no type, no layout hints. The real product name is **anonymized**
so the generation model cannot recall the real brand's design from training. (Brand recall would measure memory,
not taste, and would unfairly inflate arm B — see [Anonymization](#anonymization-is-load-bearing).)

| Arm | What it is | Role |
|-----|------------|------|
| **A** | **ForgeDock harness** — the brief run through the `/design` pipeline (#888). | The thing under test. |
| **B** | **Raw frontier model**, one shot, no tools, no iteration, given the same brief. | Control / lower bound. |
| **C** | **The real reference page** the brief was stripped from. | Gold standard + judge calibration. |

**The one variable rule.** Arms A and B MUST use the **same generation model**. The harness (its pipeline,
structured design language, render→critique loop) is then the *only* difference between A and B — which is exactly
what makes the A-vs-B delta attributable to the harness. If A and B use different models, you are benchmarking
models, not the harness. This is non-negotiable.

## C does double duty

C is both the gold standard and a **free validity check on the judge**:

- As gold standard, win-rate against C is the primary metric for A and B.
- As calibration, if the judge ever ranks C **below** A or B in the blind pairwise comparison, the judge is
  miscalibrated — its result for that run is suspect and flagged in the scorecard. A real, professionally designed,
  funded-SaaS page losing to a one-shot generation is a judge defect, not a harness triumph.

## Rendering — kill the confounds

All three arms are rendered through the **identical** pipeline so the only thing the judge compares is design, not
rendering artifacts.

- **Self-contained HTML** for arms A and B (Tailwind CDN is fine; no build step).
- **Playwright** (milestone render dependency) renders all three at:
  - **1440px** desktop and **390px** mobile,
  - `networkidle` + fonts loaded before capture,
  - **full-page** screenshot.
- **C is captured through the same pipeline.** Trim cookie banners and hero video so C is compared on its design,
  not on a consent modal. Document any trim applied to C in the run record for reproducibility.

## Judging — three layers

The judge is a **named, independent stage**. See [Anti-Goodhart](#anti-goodhart-judge-independence) — it MUST NOT
be the harness's own critique loop (#882).

### Layer 1 — Blind randomized pairwise (primary metric)

The judge sees **two anonymized screenshots in shuffled order** and answers one question:

> *"Which reads more like a professionally designed, well-funded SaaS landing page?"*

Run all three pairings: **A-vs-C**, **B-vs-C**, **A-vs-B**. Screenshots carry no arm labels; left/right order is
randomized per comparison. **Metric = win-rate against C.** The harness improves when A's win-rate against C rises
(and ideally approaches or exceeds B's gap to C closing).

### Layer 2 — Rubric (1–5 per dimension)

A per-arm absolute score across six dimensions:

| Dimension | Looks for |
|-----------|-----------|
| Hierarchy | clear primary action, deliberate reading order |
| Typography | confident scale, non-default families, tight headline tracking |
| Color discipline | restrained palette, one accent, no "AI gradient" tell |
| Whitespace rhythm | composed negative space, not uniform padding |
| Originality vs slop | a committed direction, not the hero→3-cards→testimonial→CTA mean |
| Mobile | the 390px capture holds up, not a squished desktop |

### Layer 3 — Slop detector (binary checklist)

A nearly objective pass/fail checklist over the **negatives** corpus (#880): default Inter at default weights,
slate/indigo gradient, rounded-everything, boilerplate section skeleton, stock 3D blobs, etc. Each negative is a
yes/no. The slop score is the count of negatives present (lower is better).

## Two non-negotiable methodology rules

### n=1 is a lie

Taste output is high-variance. A single generation per arm tells you almost nothing. **Run 3–5 generations per arm
across 3–5 products** and report **distributions** — win-rate over runs, and the mean and spread of rubric scores.
The scorecard aggregator (`scripts/bench-scorecard.mjs`) **rejects runs with n<3** to enforce this.

### Anti-Goodhart — judge independence

The benchmark judge **MUST be independent from the harness's own critique loop (#882)**. If the harness optimizes
against the same judge that scores the benchmark, you are training to the test — the number goes up while real
quality does not. Concretely: the benchmark judge uses its own prompt and is invoked as a distinct stage; it does
**not** import, share state with, or reuse the #882 critique judge. This independence is asserted in both this doc
and the [`/design-bench`](../../commands/design-bench.md) command spec.

## Anonymization is load-bearing

Each brief is derived from a real reference (arm C) but uses an **anonymized product name** and strips every visual
cue. The mapping from anonymized brief → real reference lives in
[`fixtures/briefs/README.md`](fixtures/briefs/README.md) (kept separate from the briefs so the generator never sees
it). A real brand name in a brief lets the model reproduce that brand's actual page from training — measuring recall,
not taste, and inflating arm B. Treat any real-brand leak in a brief as a fixture bug.

## Seed inputs (fixtures)

Briefs are **fixed and hand-written**, kept as reproducible fixtures under
[`fixtures/briefs/`](fixtures/briefs/): **Cadence**, **Tender**, **Slipstream**, **Voltage**, **Plume**. Fixed
inputs are what make the benchmark reproducible across runs and over time — the same five briefs are re-run as the
harness evolves, so score movement is attributable to the harness, not to changing inputs.

## Scorecard schema

The aggregator consumes a **runs file** (the raw per-run judge output) and emits a **scorecard**.

### Input — runs file (`runs.json`)

```jsonc
{
  "corpus_version": "2026.2",       // grammar snapshot the briefs were designed against
  "generation_model": "…",          // the SAME model used for arms A and B
  "judge_model": "…",               // the INDEPENDENT benchmark judge (not #882)
  "products": [
    {
      "product": "Voltage",          // anonymized brief name
      "reference": "modal.com",      // real arm-C reference (internal record only)
      "runs": [
        {
          "run": 1,
          "pairwise": {              // winner of each blind pairwise comparison
            "A_vs_C": "C",           // "A" | "B" | "C" | "tie"
            "B_vs_C": "C",
            "A_vs_B": "A"
          },
          "rubric": {                // 1–5 per arm per dimension
            "A": { "hierarchy": 4, "typography": 3, "color": 4, "whitespace": 4, "originality": 3, "mobile": 4 },
            "B": { "hierarchy": 3, "typography": 2, "color": 2, "whitespace": 3, "originality": 2, "mobile": 3 },
            "C": { "hierarchy": 5, "typography": 5, "color": 5, "whitespace": 5, "originality": 5, "mobile": 5 }
          },
          "slop": {                  // count of negatives present (lower is better)
            "A": 1, "B": 4, "C": 0
          }
        }
        // … runs 2..n (n >= 3)
      ]
    }
    // … 3–5 products
  ]
}
```

### Output — scorecard

```jsonc
{
  "n_products": 5,
  "n_runs_per_product": 4,
  "win_rate_vs_C": {                 // primary metric — fraction of runs the arm beat C
    "A": { "mean": 0.15, "by_product": { "Voltage": 0.25, "…": 0.10 } },
    "B": { "mean": 0.05, "by_product": { "…": 0.00 } }
  },
  "a_vs_b_win_rate": 0.70,           // fraction of runs A beat B (the harness delta)
  "rubric": {                        // mean + spread per arm per dimension across all runs
    "A": { "hierarchy": { "mean": 3.8, "stdev": 0.6 }, "…": {} },
    "B": { "…": {} },
    "C": { "…": {} }
  },
  "slop": {                          // mean negatives present per arm (lower better)
    "A": 1.2, "B": 3.9, "C": 0.1
  },
  "judge_calibration": {             // C must win A-vs-C and B-vs-C; flag if not
    "miscalibrated_runs": [],        // runs where C lost to A or B
    "ok": true
  }
}
```

## Running the benchmark

The full reproducible workflow — reference URL → brief → render arms → judge → scorecard — is driven by the
[`/design-bench`](../../commands/design-bench.md) command. The deterministic aggregation step is
`node scripts/bench-scorecard.mjs runs.json`.
