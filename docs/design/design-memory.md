# Design Memory & Deliberate Divergence

> **Status:** DRAFT for review — foundation spec for issue #887 (milestone #13).
> Queried by the [design-architect phase](design-architect-rationale.md) (#886) for the "different from my previous
> work / what new thing am I applying" questions. Enforced by the critique loop (#882).

## The problem it solves

Mode-collapse is not only a *per-page* phenomenon — it is why *all* AI output looks the same *across* pages. Per-page
taste (the spec, the critique loop) fixes one page. **Design memory fixes the portfolio.** To answer "how is this
different from before," the harness must *remember before*.

## The store

Local, file-based, on the AGPL CLI side — under `.forgedock/design-memory/` (like per-repo adaptive scripts:
`.gitignore`d by default, opt-in to commit). One record per shipped design:

```jsonc
{
  "product": "…",
  "shipped_at": "<timestamp>",
  "corpus_version": "2026.2",          // taste shifts; record what was "current" then
  "archetype": "technical-dense",
  "signature_move": "…",               // the hook — the thing to NOT repeat next time
  "palette_move": "…",                 // the distinctive color decision
  "type_pairing": "…",
  "effects_used": ["…"],
  "rationale_summary": "…",
  "learnings": ["…"]                   // techniques discovered/applied — grows the vocabulary
}
```

## Two mechanisms

### 1. Diverge (anti-sameness)
The architect phase receives a summary of recent records and is required to **not repeat** the last N designs':
- signature moves (the hook),
- archetype (don't ship `technical-dense` three times running for similar briefs),
- palette/type/effect moves.

The [render → vision-critique loop](render-critique-loop.md) (#882) can enforce a **divergence check**: "is this meaningfully distinct from prior outputs,
or a reskin?" A reskin fails.

### 2. Evolve (incorporate learnings)
`learnings` accumulate into a rotating technique/pattern library. The architect's "what I'm trying this time"
(rationale item 6) draws from it, so the harness deliberately applies and rotates new techniques rather than
converging on a comfortable default. This is the autopilot / self-improvement angle: **the system gets better the
more it ships.**

## Open-core boundary

- Memory is **local, AGPL CLI side**. No cross-repo import.
- It emits nothing the Platform needs to function; if a user opts in, a summary could feed the Platform's
  observability (per `devdocs/project/architecture.md` boundary rules) — but the CLI never depends on the Platform.

## Acceptance

- Architect phase receives prior signature moves and avoids repeating them.
- Across N consecutive generations for similar briefs, outputs show measurable variance in concept / hook / palette —
  not the same page reskinned.
- `learnings` demonstrably influence later designs ("trying this time" references a prior learning).
