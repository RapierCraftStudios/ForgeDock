---
description: Render a design from its FORGE:DESIGN_SPEC, critique the rendered pixels against the perceptual negatives, and iterate until it passes or the budget is spent — the missing reward signal.
argument-hint: [<issue-number>|<spec-path>] [--max-iters <n>] [--viewports desktop,mobile]
install: internal
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /design-render-critique-loop — render → vision-critique → iterate

**Input**: $ARGUMENTS — the design issue number (reads its `FORGE:DESIGN_SPEC`) or a path to a spec, with optional
`--max-iters <n>` (default 3) and `--viewports` (default `desktop,mobile`).

This is the **missing reward signal** for the UI Taste Harness (milestone #13, issue #882). Every other lever in the
harness can still raw-dog the output — write a page and defend it blind. This loop is the only stage that *looks at the
rendered pixels* and feeds a correction back in. Without it the harness has no feedback loop; with it, a page measurably
improves across iterations.

Read [`docs/design/render-critique-loop.md`](../docs/design/render-critique-loop.md) (methodology) before running —
the thesis, the iteration protocol, the deterministic-floor-first ordering, the anti-Goodhart independence rule, and the
pass/budget criteria all live there. This command is the executable procedure over that methodology.

**No application runtime.** ForgeDock is a set of command specs. The only executable helper is the deterministic
linter `scripts/design-system-lint.mjs` (#884); the render + critique steps are agent-driven via the Playwright MCP.

---

## Inputs (read before iterating)

| Input | Source | Role |
|-------|--------|------|
| `FORGE:DESIGN_SPEC` | the design issue (#881) | the committed intent the render must satisfy |
| `scripts/design-system-lint.mjs` | #884 | deterministic floor — cheap, runs first |
| Perceptual negatives N3, N8–N12 | [`reference-corpus.md`](../docs/design/reference-corpus.md) (#880) | what the vision critic judges (the linter declares these out of scope) |
| Render protocol | the #878 / #875 Playwright protocol | desktop + mobile capture, same viewports as the benchmark |

## The loop

```
iteration = 0
while iteration < max_iters:
    iteration += 1

    # 1. Deterministic floor FIRST (cheap — never spend a render on a page that fails the linter)
    Run: node scripts/design-system-lint.mjs --spec <spec> --html <generated> [--strict]
    if HARD findings: fix against the spec, continue   # do not render a lint-failing page

    # 2. Render (Playwright MCP) — desktop + mobile, same protocol as #878
    Capture the page at each viewport.

    # 3. Vision critique — judge the RENDERED pixels against the perceptual negatives ONLY
    For N3 (centered/no asymmetry), N8 (stock/generic 3D), N9 (glassmorphism overuse),
    N10 (no visual hierarchy), N11 (abstract copy / no product shown), N12 (decorative effects
    that serve nothing): is the negative present in the render? Each hit is a finding.
    Also check the render against the spec's own acceptance + effects_plan justification (#885).

    # 4. Emit the per-iteration trail
    Post a FORGE:CRITIQUE annotation (schema below) with findings + verdict.

    if no perceptual findings AND lint clean: PASS — break
    else: translate each finding into a concrete spec/markup correction and iterate.

if iteration == max_iters and not PASS:
    Post the final FORGE:CRITIQUE with verdict BUDGET-EXHAUSTED and the residual findings.
```

## Ordering rule (cheap gate first)

The deterministic linter (#884) runs **before** every render. A page that fails a hard lint rule is fixed before a
render is ever captured — rendering and vision-critiquing a page the linter already rejects wastes the expensive step.
The critic owns **only** the perceptual negatives the linter declares out of scope (N3, N8–N12); it never re-checks a
deterministic rule. No duplication.

## Anti-Goodhart independence (non-negotiable)

The critic in this loop is **strictly independent** from the ABC benchmark judge (#878). The benchmark judge is the
*evaluator* — it scores finished arms blind against arm C to tell us whether the harness improved. If the loop
optimized against that same judge, the harness would be training on its own test set (Goodhart). The loop's critic
judges *one page against its own committed spec + the perceptual negatives*; the benchmark judge judges *arms against a
real reference*. They must never be the same judge. This is also distinct from the divergent-generation taste-judge
(#883), which scores pre-render candidate directions.

## `FORGE:CRITIQUE` annotation

Registered in [`docs/spec/forge-protocol-v1.md`](../docs/spec/forge-protocol-v1.md). One per iteration, so the improvement trajectory is an
auditable artifact:

```markdown
<!-- FORGE:CRITIQUE -->
## Critique — {product} · iteration {i}/{max}

**Lint floor:** {PASS | fixed N hard findings}
**Render:** desktop + mobile captured
**Perceptual findings:**
- N{n}: {what was observed in the render} → {correction}
**Verdict:** {PASS | ITERATE | BUDGET-EXHAUSTED}
<!-- FORGE:CRITIQUE:COMPLETE -->
```

## Success measure

The loop works when a page **improves across iterations** and when, on the seed set, *A-with-loop* scores higher than
*A-without-loop* and higher than *raw B*, measured against the #879 baseline via the ABC benchmark (#878). The loop is
the reward signal; the benchmark is the independent scoreboard that confirms it moved.
