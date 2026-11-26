---
status: fresh
anchor: bin/lean/lane-audit-query.mjs
created: 2026-11-26
---

# ADR: census groups LANE_AUDIT by engine version; batch report rolls up unhappy lanes by class (#6080)

## Context

LANE_AUDIT comments (#6076) were postable and queryable (#6077) but nothing consumed them in the census or batch report.

## Decision

The batch report reads trusted LANE_AUDIT comments from GitHub (the register) for unhappy lanes, fail-soft, instead of carrying the class on the lane row. Pure helpers (`groupByVersion`, `formatAuditRollup`, `censusAudits`) hold no I/O and call no LLM.
