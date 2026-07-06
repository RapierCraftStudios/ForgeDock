# Seed Briefs — Fixtures

> Reproducible fixtures for the [ABC benchmark](../../abc-benchmark.md) (#878, milestone #13).
> Each brief is **design-blind** (describes only what the product *does*) and uses an **anonymized**
> product name. These are the fixed inputs re-run as the harness evolves.

## What a brief is

A brief is the single input shared by all three arms (A = ForgeDock `/design`, B = raw one-shot model,
C = the real reference). It is derived from a real reference page by **stripping every visual cue** —
no colors, no typefaces, no layout, no "make it like X" — and keeping only a factual description of what
the product does, who it is for, and what the page must communicate.

## Anonymization is load-bearing — do not leak the real brand

Each brief maps to a real reference page (arm C), but the brief **must never name the real product or brand**.

A real brand name lets the generation model recall that brand's actual page from training. That measures
**brand recall, not taste**, and it unfairly inflates arm B (the raw model would reproduce a page it has
memorized). Treat any real-brand reference inside a brief file as a fixture bug.

The mapping below is kept in this README — **separate from the brief files** — so the generator, which is only
ever handed a single `*.md` brief, never sees which real page it is being compared against.

## Brief → reference (C) mapping

| Anonymized brief | Real reference (arm C) | Archetype it exemplifies | Category |
|------------------|------------------------|--------------------------|----------|
| **Cadence**   | resend.com  | Clean / warm-minimal       | Email API / developer tooling |
| **Tender**    | stripe.com  | Polished / enterprise-dev  | Payments API |
| **Slipstream**| vercel.com  | Stark monochrome / brutalist-minimal | Deploy platform |
| **Voltage**   | modal.com   | Technical / playful        | Serverless compute |
| **Plume**     | linear.app  | Refined minimal / dark technical-luxury | Issue tracking |

The references and archetypes are drawn from the [reference corpus](../../reference-corpus.md) (#880). The
mapping is an internal record for scoring and the C-as-calibration check — it is **not** part of the brief
input handed to any arm.

## Adding a brief

1. Pick a corpus reference (#880) not already represented, or one that adds a distinct archetype.
2. Strip it to a design-blind, factual product description. Remove every visual cue.
3. Choose an **anonymized** product name (no resemblance to the real brand).
4. Save as `fixtures/briefs/<name>.md` following the structure of the existing briefs.
5. Add the `<name> → real reference` row to the mapping table above.
6. Keep n high enough: the benchmark runs 3–5 generations per arm across 3–5 products — adding a sixth brief
   is fine, but never run fewer than three.
