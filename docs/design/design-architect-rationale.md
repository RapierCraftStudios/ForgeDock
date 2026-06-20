# Design-Architect Phase & FORGE:DESIGN_RATIONALE — the designer's diary

> **Status:** DRAFT for review — foundation spec for issue #886 (milestone #13).
> The reasoning-before-generation phase. Produces the [DESIGN_SPEC](design-spec-schema.md) (#881);
> queries [design-memory](design-memory.md) (#887); read by generate + the critique loop (#882).

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

The phase must reason through all seven, in order. This is what a designer's diary actually contains.

1. **Intent & emotional register** — One core message. One feeling to evoke (trust / speed / power / craft / play).
   What should the visitor feel, and what should they do?
2. **Audience & objection** — Who lands here? What do they already believe? What is the single objection this page
   must overcome?
3. **Communication hierarchy** — What gets said 1st, 2nd, 3rd. This *is* the visual hierarchy — it is derived from
   meaning, not chosen as decoration. (Feeds `layout_grammar.sections` in the spec.)
4. **Direction & why** — The chosen archetype/concept *and the reasoning for it* — why it serves this message for this
   audience. **Plus the alternatives considered and explicitly rejected, and why.** (Rejection is where taste shows.)
5. **The signature move** — The one memorable, non-obvious idea that makes it *this* page and not a template. The "hook."
6. **What I'm trying this time** — A technique or learning being deliberately applied. Queries
   [design-memory](design-memory.md) so it builds on, and diverges from, prior work.
7. **Non-goals** — What this page deliberately will *not* do. Restraint stated as a decision, not an omission.

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

- Every generated page is preceded by a DESIGN_RATIONALE covering all 7 elements, with ≥1 explicitly rejected
  alternative and a named signature move.
- On the seed set, rationales for Voltage / Plume / Slipstream show genuinely different intent, hierarchy, and
  signature moves — derived from the briefs alone (no design hints in the brief).
