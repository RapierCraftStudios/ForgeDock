# Decision engine (#4766)

> **Status: wired (#4793).** The issue-watch stage runs `settle` each round for the open `needs-human` issues that match the watch's selectors.

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

## The issue-watch stage

`bin/lean/issuewatch-decisions.mjs` runs inside `forgedock issue-watch` (every mode), not as a separate entry point. It is active when `decisions.mode: live`
or the watch sets `sweep_needs_human: true`. Each round it lists open `needs-human` issues of trusted authors that match the watch selectors, takes the newest
`FORGE:NEEDS_HUMAN` comment (its comment id is the escalation id `settle` is idempotent on) and the typed `terminalCode` from `FORGE:STATE`, and calls `settle`.

- **Backlog.** An escalation older than the watch start is only touched by a watch with `sweep_needs_human: true`. `forgedock issue-watch run --dry-run` prints the `classify` result for every escalation (backlog marked) and writes nothing.
- **Caps.** Each handled issue counts against `max_issues`; each requeue (a live decision or an evidence hand-off) against `max_launches`, which also stops the watch claiming past it.
- **Status.** `issue-watch status` gains `needs-human decisions: decided N  evidence-gathered N  folded N  external-kept N`.
- **Evidence.** A block of "missing read-only production data" on a repo whose forge.yaml declares `prod_watch.sources` clears `needs-human` and goes back to a lane with a comment naming the prod monitor capability (placement `prod_monitor`); without a declared source it keeps the label.
- **Post-deploy only.** Folded into the watch's `postdeploy_rollup` checklist, `needs-human` cleared and the issue closed; without a rollup it is kept.
- **Veto.** A `forge:decision-veto` label or a `veto` reply inside `veto_hours` reverts a live decision (`revertVeto`) and counts toward the reversal rate that forces shadow.
- The judge is the only LLM call (`claude --print` in the real io).
