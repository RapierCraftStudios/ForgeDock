# 4176 — /bootstrap: thin spec + deterministic backlog creation

**Context.** #4155 needs one command from an idea to an orchestrate-ready backlog. The prerequisites have landed:
the plan validator (#4171), `/issue --greenfield` (#4172), init repo creation (#4173), the board and domain labels (#4174),
and the `/milestone --plan` and decompose `FORGE:BOOTSTRAP_PLAN` intake (#4175). A new command spec may be at most
4096 bytes (`scripts/check-spec-size.sh`). The field test that motivated #4155 needed a custom script for creation,
placeholder resolution and board sync.

**Choice.**
- `commands/bootstrap.md` holds only judgment: the interview, defaults with rationale, at most 4 multiple-choice
  doubts per batch, writing the spike doc and authoring the plan.
- `scripts/bootstrap-create.mjs` does every GitHub write from the validated plan, in one deterministic pass. It refuses
  to write anything while the plan fails `bootstrap-validate.mjs` or the spike doc misses a section or rationale.
- Re-runs reuse what already exists: the spike by title, milestones by title, `milestone/<slug>` branches (the slug
  comes from `bin/lean/lane.mjs` `milestoneSlug`, so the lanes match what the engine expects), sub-issues by title plus
  `**Parent**: #<spike>`, and the spike's marker comments when a trusted one is present (`scripts/trusted-comments.sh`).
- Plan guardrails and domain rules are appended to every Context. Forward `#{{KEY}}` references are resolved in an
  edit pass after creation.
- Board items get Status=Todo, Priority and Component.
- The spike gets `FORGE:BOOTSTRAP_PLAN` and `FORGE:DECOMPOSED` (decompose's D0/D5 formats, so a later decompose run
  sees the spike as ALREADY_DONE) and `workflow:decomposed` via `transition-label.sh`.
- The validator gains `missing-design-spec`, `hero-not-routed` and `missing-needs-human-section`. These are exact,
  zero-LLM checks for criteria that used to depend on the writer remembering them.

**Rejected.**
- Driving `/milestone` and `/issue` once per issue from the spec: an LLM loop over 100+ issues, no idempotent reuse
  by parent, and far over the spec budget.
- Extending `scripts/issue-create.sh`: it creates one issue and reports DEDUP rather than reusing, and it is shared
  with brownfield `/issue`, which must not change.

**Cost.** Creation and board sync use no LLM calls (previously agents or hand-written scripts in the field test).
Re-running a completed backlog makes read calls only.
