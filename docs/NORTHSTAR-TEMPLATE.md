# NORTHSTAR template for target repos

Copy to `NORTHSTAR.md` and set `decisions.policy` in `forge.yaml` (default: `NORTHSTAR.md`). The decision engine ([DECISIONS.md](DECISIONS.md))
cites a clause of this file for every decision it makes; with no applicable clause it escalates.

```markdown
# <Project> North Star

## Objectives and metrics
1. <what the project optimises, with the metric that measures it>

## Non-negotiables
1. <a rule a decision may never break>

## Authority matrix (stays human)
Mirrors `decisions.human_only` in forge.yaml: spend, credentials, external publish, customer-facing send,
production write or root, staging to main promotion, legal.

## Decide yourself
Everything else that is reversible and covered by a clause above. Prefer the option that is cheaper to undo.
```
