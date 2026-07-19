---
description: Run the ABC benchmark — reference URL → design-blind brief → render arms A/B/C → blind judge → scorecard with win-rates over n runs
argument-hint: "[<brief-name>|all] [--n <runs>] [--corpus-version <ver>]"
install: internal
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /design-bench — The ABC Benchmark Rig

**Input**: $ARGUMENTS — a seed brief name (`cadence` | `tender` | `slipstream` | `voltage` | `plume`) or `all`, with optional `--n <runs>` (default 3, min 3) and `--corpus-version <ver>`.

This is the **fitness function** for the UI Taste Harness (milestone #13, issue #878). It is built *before*
the harness and is the only thing that tells us whether each lever the harness adds actually moves design
quality. Running this command answers one question: **did arm A (the harness) score higher against the real
reference (arm C) than it did last time?**

Read [`docs/design/abc-benchmark.md`](../docs/design/abc-benchmark.md) (methodology) before running. The three
arms, the same-model rule, the C-as-calibration check, the three-layer judging protocol, and the n>=3 rule all
live there — this command is the executable workflow over that methodology.

**No application runtime.** ForgeDock is a set of command specs. This command is a step-by-step procedure an
agent executes; the only executable helper is the deterministic aggregator `scripts/bench-scorecard.mjs`.

Plan mode: see `commands/shared/agent-policies.md` § Plan mode ban if not already in context.

<!-- FORGE:SPEC_LOADED — design-bench.md loaded and active. Agent is bound by this spec. -->

---

## The three arms (one variable)

| Arm | What it is | How this command produces it |
|-----|------------|------------------------------|
| **A** | ForgeDock harness output | Run the brief through `/design` (#888). **Pluggable** — see [Arm A is pluggable](#arm-a-is-pluggable). |
| **B** | Raw frontier model, one shot | Hand the brief to the model once, no tools, no iteration. |
| **C** | The real reference page | Capture the brief's real reference URL through the same render pipeline. |

**Hard rule — same generation model for A and B.** The harness is the ONLY difference between A and B; that is
what makes the A-vs-B delta attributable to the harness. Different models benchmark models, not the harness.

**Validated generation model: `claude-opus-4-6`.** Benchmark results (#878) show a tier-level quality difference: 90% A-vs-B pairwise win-rate with Opus vs 54% with Sonnet, rubric mean 4.11 vs 3.40, slop 1.2 vs 1.8. The canonical baseline going forward is the Opus run. Raw data: `docs/design/fixtures/runs/full-abc-opus/`. Use Opus for both arm A and arm B unless explicitly testing a different model.

---

## Phase 0: Resolve inputs

1. Parse `$ARGUMENTS`: the brief name(s) and `--n` (default 3; **reject n<3** — n=1 is a lie). `all` = every
   brief under `docs/design/fixtures/briefs/` (excluding `README.md`).
2. For each brief, load `docs/design/fixtures/briefs/<name>.md`. This is the design-blind input handed to arms
   A and B.
3. Load the brief→reference(C) mapping from `docs/design/fixtures/briefs/README.md`. **The mapping is for the
   judge/calibration record only — it is NEVER shown to the generating arms.** A real brand name leaking into a
   brief measures recall, not taste, and inflates arm B.

---

## Phase 1: Brief (reference URL → design-blind brief)

The seed briefs are pre-stripped fixtures, so for the seed set this phase is a load, not a derivation.

**To add a new reference URL** (outside the seed set): fetch the page, strip every visual cue (color, type,
layout, "make it like X"), keep only what the product *does* / who it's for / what the page must communicate,
and assign an **anonymized** product name. Save as a new fixture and add its mapping row. Follow
`docs/design/fixtures/briefs/README.md`.

---

## Phase 2: Render arms (kill confounds)

Render **all three arms through the identical pipeline** so the judge compares design, not rendering artifacts.

For each of the `--n` runs per brief:

1. **Arm A** — run the brief through `/design` (#888) → self-contained HTML.
2. **Arm B** — one-shot the SAME model with the brief → self-contained HTML. No tools, no iteration.
3. **Arm C** — the real reference URL.

Render every arm with **Playwright** (milestone render dependency) at:

- **1440px** desktop and **390px** mobile,
- `networkidle` + fonts loaded before capture,
- **full-page** screenshot.

For arm C, trim cookie banners / hero video and **record any trim applied** in the run record (reproducibility).

> **Arm A is pluggable.** Until `/design` (#888) lands, arm A is produced by a clearly-labeled manual hook:
> generate arm A by hand using the harness method-of-the-day and drop its HTML into the run record marked
> `arm_a_source: manual`. The rig — brief loading, render protocol, judging, scorecard — is fully operational
> without #888. When #888 lands, replace the manual hook with the `/design` invocation; nothing else changes.
> **Do NOT block the benchmark on #888.**

---

## Phase 3: Judge (three layers)

The judge is a **named, independent stage**. See [Anti-Goodhart](#anti-goodhart) — it MUST NOT be the harness's
own critique loop (#882).

For each run, produce judge output in the [runs-file schema](../docs/design/abc-benchmark.md#scorecard-schema):

### Layer 1 — Blind randomized pairwise (primary)
Show the judge two **anonymized** screenshots in **shuffled** order and ask: *"Which reads more like a
professionally designed, well-funded SaaS landing page?"* Run **A-vs-C, B-vs-C, A-vs-B**. Record the winner
(`"A" | "B" | "C" | "tie"`) per comparison. Screenshots carry no arm labels.

### Layer 2 — Rubric (1–5 per arm)
Score each arm on: hierarchy, typography, color discipline, whitespace rhythm, originality-vs-slop, mobile.

### Layer 3 — Slop detector (binary)
Run the anti-slop negatives checklist (corpus #880) over each arm; record the count of negatives present
(lower is better).

Append each run to the brief's `runs[]` array in the runs file.

---

## Phase 4: Scorecard

Aggregate deterministically:

```bash
node scripts/bench-scorecard.mjs runs.json > scorecard.json
```

The aggregator (see `scripts/bench-scorecard.mjs`):
- **rejects any product with n<3 runs** (exit 1) — enforces the no-point-estimate rule,
- emits **win-rate vs C** per arm (overall + per-product), the **A-vs-B harness delta**, **rubric mean+stdev**
  per arm/dimension, **mean slop** per arm,
- runs the **judge-calibration check**: C must beat A and B in the pairwise; any run where C loses is listed in
  `judge_calibration.miscalibrated_runs` and the command exits 2 with a warning. A real reference losing to a
  generated arm is a judge defect, not a harness win — treat those runs as suspect.

Post the result as a `FORGE:BENCH_SCORECARD` annotation (registered in
[`docs/spec/forge-protocol-v1.md`](../docs/spec/forge-protocol-v1.md)) on the tracking issue:

```bash
gh issue comment <ISSUE> --body "<!-- FORGE:BENCH_SCORECARD -->
## ABC Benchmark Scorecard

**Corpus version**: <ver> · **Generation model (A & B)**: <model> (canonical: claude-opus-4-6) · **Judge model**: <independent judge>
**Products**: <n_products> · **Runs/product**: <n>

| Arm | Win-rate vs C | A-vs-B | Mean slop |
|-----|---------------|--------|-----------|
| A   | <wr>          | <a_vs_b> | <slop_A> |
| B   | <wr>          | —        | <slop_B> |

**Judge calibration**: <ok | MISCALIBRATED — N runs where C lost (suspect)>

\`\`\`json
<scorecard.json>
\`\`\`

<!-- FORGE:BENCH_SCORECARD:COMPLETE -->"
```

---

## Two non-negotiable rules

### n=1 is a lie
Taste output is high-variance. Run **3–5 generations per arm across 3–5 products** and report **distributions**.
The aggregator hard-fails on n<3.

### Anti-Goodhart
The benchmark judge **MUST be independent from the harness's own critique loop (#882)**. Optimizing against the
same judge that scores the benchmark is training to the test — the number rises while real quality does not. The
benchmark judge uses its own prompt and is a distinct stage; it does not reuse the #882 critique judge.

---

## Acceptance (issue #878)

- [x] Reproducible command/workflow: reference URL → brief → render arms → judge → scorecard.
- [x] Arms A/B/C defined; same generation model for A and B; C = gold standard + judge calibration.
- [x] Three judging layers: blind randomized pairwise, 1–5 rubric, binary slop detector.
- [x] n=3–5 across 3–5 products; distributions reported; n=1 rejected by the aggregator.
- [x] Benchmark judge independent from the #882 critique loop (anti-Goodhart).
- [x] Five seed briefs as fixtures (Cadence/Tender/Slipstream/Voltage/Plume), anonymized + mapped to C.
- [x] Arm A pluggable — rig runs now, plugs into `/design` (#888) when it lands.
