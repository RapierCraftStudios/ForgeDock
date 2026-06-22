# Design-Architect Phase & FORGE:DESIGN_RATIONALE — the designer's diary

> **Status:** Committed foundation — design-architect phase spec for issue #886 (milestone #13).
> The reasoning-before-generation phase. Produces the [DESIGN_SPEC](design-spec-schema.md) (#881);
> queries [design-memory](design-memory.md) (#887); read by generate + the critique loop (#882).
> Extended: motion tier selection added as diary step 5 (#1043).

## Why this exists

Everything else in the harness (spec, effects, critique loop) can still **raw-dog** the output: jump straight to a
page and defend it afterward. A page produced without deliberation is a guess. What separates craft from a guess is
**thinking before generating** — and capturing that thinking so it's reviewable.

ForgeDock already does this for code: `investigate → architect → implement → validate`, where the *architect* phase
reasons about *how* before any code is written, and writes a FORGE annotation the next stage reads. **A design harness
without a design-architect phase is just vibes.** So this is not a new paradigm — it is the ForgeDock pattern applied
to design:

```
design-investigate (what's the message?) → design-architect (diary + rationale → spec) → generate → critique-loop
```

The architect phase's output is a `FORGE:DESIGN_RATIONALE` annotation — the diary — which *produces* the
[DESIGN_SPEC](design-spec-schema.md) instead of the spec appearing from nowhere.

## The diary — structured chain of thought

The phase must reason through all eight, in order. This is what a designer's diary actually contains.

1. **Intent & emotional register** — One core message. One feeling to evoke (trust / speed / power / craft / play).
   What should the visitor feel, and what should they do?
2. **Audience & objection** — Who lands here? What do they already believe? What is the single objection this page
   must overcome?
3. **Communication hierarchy** — What gets said 1st, 2nd, 3rd. This *is* the visual hierarchy — it is derived from
   meaning, not chosen as decoration. (Feeds `layout_grammar.sections` in the spec.)
4. **Direction & why** — The chosen archetype/concept *and the reasoning for it* — why it serves this message for this
   audience. **Plus the alternatives considered and explicitly rejected, and why.** (Rejection is where taste shows.)
5. **Motion tier & hero technique** — Which motion tier (1–3) from the [corpus hero motion vocabulary](reference-corpus.md#hero-motion-vocabulary--making-the-hero-feel-alive)
   is appropriate for this archetype and product nature? Which specific technique? Commit to both. The default per-archetype
   motion profile in the corpus is the starting point; deviation requires explicit reasoning. Every page requires a
   committed motion posture — "no motion" for `bold-brutalist` or `minimal-luxury` is a valid deliberate choice, but
   it must be stated, not omitted.
   - Feeds `motion.tier` and `motion.hero_technique` in the [DESIGN_SPEC](design-spec-schema.md).
   - If a video placeholder is appropriate (Tier 3): set `motion.video_placeholder: true` — the generator scaffolds
     the HTML and CSS gradient poster.
   - State the `prefers-reduced-motion` fallback explicitly (e.g., "gradient-shift pauses; text remains visible").
6. **The signature move** — The one memorable, non-obvious idea that makes it *this* page and not a template. The "hook."
7. **What I'm trying this time** — A technique or learning being deliberately applied. Queries
   [design-memory](design-memory.md) so it builds on, and diverges from, prior work.
8. **Non-goals** — What this page deliberately will *not* do. Restraint stated as a decision, not an omission.

## FORGE:DESIGN_RATIONALE — annotation format

Posted to the design issue at the architect stage (see the `/design` pipeline, #888):

```markdown
<!-- FORGE:DESIGN_RATIONALE -->
## Design Rationale — {product}

**Intent / feeling:** {one message} · {one feeling}
**Audience / objection:** {who} — must overcome: {objection}
**Communication hierarchy:** 1) {…} 2) {…} 3) {…}
**Direction:** {archetype} — because {reasoning}
  - Considered & rejected: {alt A} (because {…}); {alt B} (because {…})
**Motion:** Tier {1|2|3} — technique: {hero_technique} — because {reasoning}
  - `prefers-reduced-motion` fallback: {what degrades gracefully}
  - Video placeholder: {yes — Tier 3 scaffold generated | no}
**Signature move:** {the one non-obvious idea}
**Trying this time:** {technique/learning} (from memory: avoiding {prior move})
**Non-goals:** {what this won't do}

→ Produces DESIGN_SPEC: {link}
```

## Why it matters for a non-designer

The rationale is **reviewable without judging pixels.** A non-designer can read the *thinking* and catch when the
reasoning is thin or generic — "this hook is the same as every other page," "the direction has no justification" —
**before a single pixel renders.** The harness externalizes the designer's thought process the user may not have.
This is the review checkpoint that makes the whole pipeline trustworthy.

## Acceptance

- Every generated page is preceded by a DESIGN_RATIONALE covering all 8 elements, with ≥1 explicitly rejected
  alternative, a committed motion tier + technique, and a named signature move.
- The `**Motion:**` line must be present in every rationale — "no motion" is acceptable only for `bold-brutalist`
  and `minimal-luxury` archetypes, and must be stated with reasoning, not left absent.
- On the seed set, rationales for Voltage / Plume / Slipstream show genuinely different intent, hierarchy,
  motion techniques, and signature moves — derived from the briefs alone (no design hints in the brief).
