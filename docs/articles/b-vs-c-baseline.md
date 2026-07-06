# B-vs-C Baseline Scorecard

> **Benchmark date**: 2026-06-22
> **Issue**: #879 (part of milestone #877, UI Taste Harness + ABC benchmark)
> **Rig**: `/design-bench` (#878)
> **Generation model (B)**: claude-sonnet-4-6
> **Judge model**: claude-sonnet-4-6 (independent — not the harness critique loop)
> **Corpus version**: seed-v1
> **Products**: 5 (Cadence, Tender, Slipstream, Voltage, Plume)
> **Runs per product**: 3

This is the **first hard datapoint** — the bar the ForgeDock design harness (arm A) must beat.
It measures the raw-model gap: how does a frontier model's one-shot HTML output (arm B) compare
against real, professionally-designed, funded-SaaS reference pages (arm C)?

## Headline Result

**Arm B wins 0% of clean pairwise comparisons against arm C.**

The raw frontier model cannot produce a page that reads as professionally designed when compared
against real reference pages. C won 12/12 clean comparisons (excluding Slipstream — see calibration
note below). This is the gap the harness must close.

## Pairwise Win-Rate vs C

| Product | B win-rate vs C | Runs | Notes |
|---------|----------------|------|-------|
| Cadence (resend.com) | **0%** | 0/3 | C dominated all runs |
| Tender (stripe.com) | **0%** | 0/3 | C dominated all runs |
| Slipstream (vercel.com) | 100%* | 3/3 | *Calibration artifact — see note |
| Voltage (modal.com) | **0%** | 0/3 | Largest gap — C dominated |
| Plume (linear.app) | **0%** | 0/3 | C dominated all runs |
| **Overall (clean)** | **0%** | **0/12** | |
| **Overall (all)** | **20%** | **3/15** | Inflated by Slipstream artifact |

### Slipstream Calibration Note

The vercel.com reference screenshot was viewport-only (54KB) due to a Playwright rendering timeout
on vercel.com's heavy JS/animation. The judge saw a sparse, cropped hero vs full-page arm B
generations — an unfair comparison. All 3 Slipstream runs are flagged as `miscalibrated` in the
scorecard. **Clean metrics exclude Slipstream throughout this report.**

## Rubric Scores (1-5, mean across all clean runs)

| Dimension | Arm B | Arm C | Gap |
|-----------|-------|-------|-----|
| Hierarchy | 3.17 | 5.00 | -1.83 |
| Typography | 3.25 | 5.00 | -1.75 |
| Color | 3.08 | 5.00 | -1.92 |
| Whitespace | 3.17 | 4.75 | -1.58 |
| Originality | 2.83 | 5.00 | -2.17 |
| Mobile | 3.08 | 4.00 | -0.92 |
| **Mean** | **3.10** | **4.79** | **-1.69** |

### Key Observations

- **Originality is the widest gap** (2.83 vs 5.00, delta -2.17). AI output mode-collapses to
  template-like layouts (3-column feature grids, gradient heroes, symmetric pricing cards). Real
  pages have distinctive, intentional design language.
- **Color discipline** is the second-widest gap (-1.92). AI pages use safe, generic palettes
  (dark + accent gradient) rather than the sophisticated, brand-specific color systems of real pages.
- **Mobile** is the narrowest gap (-0.92). Tailwind's responsive utilities give arm B reasonable
  mobile adaptability, but this is the framework doing the work, not design taste.

## Slop Count (mean AI tells per arm)

| Arm | Mean Slop | Notes |
|-----|-----------|-------|
| B | **5.0** | Range: 2-7 per run |
| C | **0.5** | Range: 0-1 per run |

Common AI tells detected across arm B runs:
- Cookie-cutter 3-column feature grids with circular icons (13/15 runs)
- Blue-purple gradient overuse (8/15 runs)
- Generic hero text ("Revolutionize", "Built for", "Supercharge")
- Overly symmetrical layouts
- Testimonial sections with identical card structures
- Pricing tier cards (3 columns: Free/Pro/Enterprise)
- Excessive rounded corners and drop shadows

## Per-Product Rubric Detail

### Cadence (vs resend.com)

| Dim | B r1 | B r2 | B r3 | C |
|-----|------|------|------|---|
| Hierarchy | 3 | 3 | 3 | 5 |
| Typography | 3 | 3 | 3 | 5 |
| Color | 3 | 3 | 3 | 5 |
| Whitespace | 3 | 3 | 3 | 5 |
| Originality | 3 | 3 | 3 | 5 |
| Mobile | 3 | 3 | 3 | 4 |
| Slop | 5 | 4 | 5 | 0 |

Consistent 3/5 across all B runs — competent but generic. Resend's reference page demonstrates
warm minimalism with purposeful whitespace that none of the B runs achieved.

### Tender (vs stripe.com)

| Dim | B r1 | B r2 | B r3 | C |
|-----|------|------|------|---|
| Hierarchy | 4 | 3 | 4 | 5 |
| Typography | 4 | 3 | 4 | 5 |
| Color | 4 | 3 | 3 | 5 |
| Whitespace | 4 | 3 | 3 | 5 |
| Originality | 3 | 3 | 3 | 5 |
| Mobile | 3 | 3 | 3 | 4 |
| Slop | 4 | 6 | 5 | 1 |

Best arm B performance — run 1 and run 3 hit 4/5 on hierarchy/typography. The payments brief
elicits more structured, professional-feeling output. But originality never exceeds 3 — the pages
look like payment templates, not like Stripe.

### Voltage (vs modal.com)

| Dim | B r1 | B r2 | B r3 | C |
|-----|------|------|------|---|
| Hierarchy | 3 | 3 | 2 | 5 |
| Typography | 3 | 3 | 2 | 5 |
| Color | 3 | 3 | 2 | 5 |
| Whitespace | 3 | 3 | 3 | 4 |
| Originality | 2 | 3 | 2 | 5 |
| Mobile | 3 | 3 | 3 | 4 |
| Slop | 5 | 6 | 7 | 1 |

Widest gap in the benchmark. Modal's reference page has exceptional editorial layout variety and
rich product screenshots. Arm B defaulted to generic dark-theme developer tool aesthetics with
high slop counts (5-7). Run 3 was the weakest arm B output in the entire benchmark (2/5 on
4 dimensions, 7 slop).

### Plume (vs linear.app)

| Dim | B r1 | B r2 | B r3 | C |
|-----|------|------|------|---|
| Hierarchy | 3 | 4 | 3 | 5 |
| Typography | 3 | 4 | 4 | 5 |
| Color | 3 | 4 | 3 | 5 |
| Whitespace | 3 | 4 | 3 | 5 |
| Originality | 2 | 4 | 3 | 5 |
| Mobile | 3 | 4 | 3 | 4 |
| Slop | 6 | 2 | 5 | 1 |

Notable variance: run 2 (editorial/warm sand aesthetic) scored 4/5 across the board with only
2 slop — the best single arm B run in the entire benchmark. This suggests that when the model
breaks out of the default dark-gradient template (as the serif/editorial approach forced it to),
quality jumps significantly. This is evidence for the archetype sampling hypothesis (#883).

## Implications for the Harness

1. **The gap is real and large.** Mean rubric delta of -1.69 points on a 5-point scale confirms
   the thesis: raw model output is recognizably AI-generated and substantially below professional
   quality.

2. **Originality is the #1 lever.** The widest gap (-2.17) is originality — the model defaults
   to template-like output. The archetype sampling system (#883) directly targets this by forcing
   commitment to a coherent design direction before generation.

3. **Slop is measurable and actionable.** Mean 5.0 AI tells per page is high. The anti-slop
   negatives list (#880) and the design-system linter (#884) can mechanically eliminate many of
   these.

4. **Variance contains signal.** Plume run 2 (4/5, 2 slop) vs Plume run 1 (3/5, 6 slop) shows
   the model CAN produce better output when pushed away from defaults. The harness's job is to
   make that the floor, not a lucky outlier.

5. **The bar to beat**: arm A must achieve >0% win-rate vs C to demonstrate any value. The first
   milestone target should be closing the rubric gap to <1.0 mean delta.

## Raw Data

- Runs file: `docs/design/fixtures/runs/b-vs-c-baseline/runs.json`
- Scorecard: `docs/design/fixtures/runs/b-vs-c-baseline/scorecard.json`
- Arm B HTML: `docs/design/fixtures/runs/b-vs-c-baseline/{product}/arm-b/run-{1,2,3}.html`

## Scorecard JSON

```json
{
  "corpus_version": "seed-v1",
  "generation_model": "claude-sonnet-4-6",
  "judge_model": "claude-sonnet-4-6",
  "n_products": 5,
  "n_runs_per_product": 3,
  "win_rate_vs_C": {
    "B": {
      "mean": 0.2,
      "by_product": {
        "cadence": 0, "tender": 0, "slipstream": 1,
        "voltage": 0, "plume": 0
      },
      "mean_clean": 0,
      "note": "Clean excludes slipstream (calibration artifact)"
    }
  },
  "rubric_mean": {
    "B": 3.10,
    "C": 4.79,
    "delta": -1.69
  },
  "slop_mean": {
    "B": 5.0,
    "C": 0.5
  },
  "judge_calibration": {
    "ok": false,
    "miscalibrated_runs": 3,
    "all_in": "slipstream (viewport-only C screenshot)"
  }
}
```
