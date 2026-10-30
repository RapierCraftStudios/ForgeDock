# Decision engine (#4766)

Settles a lane's decision-only `needs-human` escalation against the target repo's own north star instead of parking it.
Only external actions stay with a human. Code: `bin/lean/decision-engine.mjs`. Config: [`decisions:`](CONFIG.md).

## Flow

1. **Policy.** `decisions.policy` (default `NORTHSTAR.md`, then `CLAUDE.md`, `AGENTS.md`) holds objectives, non-negotiables and the
   authority matrix. `decisions.human_only` names the classes that stay human: spend, credentials, external-publish,
   customer-send, prod-write, promotion, legal (each with match hints; override with `hint_<class>`). See
   [NORTHSTAR-TEMPLATE.md](NORTHSTAR-TEMPLATE.md).
2. **Deterministic split** (`splitEscalation`, no model): from the terminal code, block type and matrix hints, into
   `recovery` (retryable code, recovery owns it), `evidence` (missing read-only production data, e.g. `conformance.unimplemented`),
   `post-deploy` (all items post-deploy), `external`, `decision` or `mixed`. External parts are left untouched.
3. **One judgment call per decision part.** Inputs: the issue, the options listed, the policy file and the anchored register
   (#4695) as precedent. The answer records the choice, the cited clause, the rejected alternative, reversibility and confidence.
4. **Guardrails.** A one-way or low-confidence answer, or one with no clause, escalates with the analysis attached (`FORGE:DECISION (escalated)`),
   never a guess. Settled decisions are written to the anchored register, so later lanes follow them; changing one needs a `supersedes`.
5. **Shadow, then live.** Shadow (default) posts `FORGE:DECISION (shadow)` and keeps the label. Live posts `FORGE:DECISION`, clears
   `needs-human` and requeues (`orchestrate --requeue`); a mixed issue keeps the label for its external part.
6. **Veto.** A `forge:decision-veto` label, or a reply starting with `veto` within `veto_hours`, restores `needs-human` and reverts the requeue.
7. **Idempotent** on the escalation comment id (`Escalation: <id>` in the engine's comment).

## Metrics

`decision_engine` telemetry ([TELEMETRY.md](TELEMETRY.md)): decided, escalated, vetoed, reversed, needs-human before/after. A reversal rate above
`reversal_max` turns the engine back to shadow. The batch report lists every decision under `decided`.

## Not in this module

The `issue-watch` stage that lists `needs-human` issues and calls `settle` (`sweep_needs_human`, `--dry-run` via `classify`, caps, status counts)
lands with #4765. Running a declared monitor query for `evidence` and folding `post-deploy` items into the release checklist are follow-ups.
