---
issue: 4657
status: fresh
anchor: bin/lean/lifecycle.mjs
created: 2026-10-27
---

# Decision: milestone lifecycle recorded in the milestone description, carry-over classified from labels

## Context

`/milestone ship` cleared the milestone on every open issue and closed the milestone at the staging merge. Unattended `orchestrate` runners never closed milestones. Nothing said whether a milestone was on staging or on the default branch.

## Choice

- **Register:** a `<!-- FORGE:LIFECYCLE {json} -->` block (`state`, `sha` of the staging merge) in the milestone description, beside FORGE:DRIFT. States only move forward: `building`, `shipped:staging`, `deployed:default`, `closed`.
- **Close point:** forge.yaml `milestones.close_on` (`staging|default`, default `default`). A milestone with open issues never closes. `deployed:default` is observed with `git merge-base --is-ancestor <sha> origin/<default>`.
- **Orchestrate:** an optional `lifecycle` seam runs at batch end for milestones the batch merged into, so runner-driven milestones close too.
- **Carry-over:** ship pre-flight needs a target milestone and a class per open issue. The class is derived from labels (`needs-human:external`, `awaiting-*`, `wont-do`, `carry:<class>`). External, flag/legal-gated and off-base-dependent issues are never demoted to fast lane.
- **pipeline-status:** `SHIPPED_WITH_OPEN` and `EMPTY_BUT_OPEN` from the milestone list.

## Rejected

- **A label per lifecycle state.** Milestones have no labels; the description already holds FORGE:DRIFT.
- **An LLM to classify carry-over.** Labels carry every fact (NORTHSTAR: deterministic first).

## Cost

0 LLM calls. At batch end: one milestone list read per touched milestone, plus one issue list and at most one PATCH.
