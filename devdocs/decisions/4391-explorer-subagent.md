---
issue: 4391
status: fresh
anchor: bin/lean/explore.mjs
created: 2026-10-23
---

# ADR: builder discovery runs in a cheap explorer subagent that returns a file/line digest

## Context

Implement is ~96% of lane cost (AlterLab batches 2026-10-22: $86.17 implement vs $3.14 review over 10 merged lanes). Builders explore in the main session, so every byte they read is re-read as cache on each later turn: AlterLab#36620 took 91 turns and 12.2M cache-read tokens despite a complete file:line design.

## Decision

- **Custom `--agents` explorer.** A ForgeDock-defined subagent (`bin/lean/explore.mjs`) with a fixed digest format and a 60-line cap, read-only tools and a pinned cheap model (`lean.explore_model`, default `haiku`), passed to every builder call.
- **One short rule** on the plan and implement prompts: discover through the explorer, open a file only to edit it or to verify a digest claim.
- **Opt-in with an A/B tag.** `lean.explore` defaults to off (argv and prompts unchanged); `RUN_TERMINAL.explore` groups runs, as `context_pack` did for #4275.

## Rejected

- Built-in Explore agent: free-form output with no digest bound, and its model is not ours to pin.
- An engine-side digest call before the plan: a separate LLM call the builder cannot ask follow-up questions of.
- Default on: #4149 measured prompt-level changes as noise, so the default flips only on measured turns and cache-read with equal merge and conformance rates.

## Cost

0 engine LLM calls. ~120 prompt tokens per builder prompt when on. Explorer turns run on the cheap model in their own context; their cost is included in the builder call's `cost_usd`.
