---
issue: 4569
status: fresh
anchor: devdocs/modules/lean.md
created: 2026-10-25
---

# ADR — Resolved review findings never block the staging verdict

## Context

`forgedock review-staging --summary` counted every CONFIRMED HIGH/CRITICAL finding, including delta-credited ones whose
filed `review-finding` issue was already closed, so a fixed finding blocked every later pass. file-prepare also passed the
shared "(review finding — PR #N)" title suffix to `issue-dedup.sh`, whose 3-token rule then matched a neighbouring finding.

## Decision

- file-prepare dedups on `fix: <title>` without the suffix.
- On a DELTA run a closed same-location issue yields `action: skip-resolved` (`dedup_of` = that issue) instead of a P1 regression;
  FULL runs keep the regression behaviour.
- `--finalize` excludes `skip-resolved` findings from `confirmedCritical`/`confirmedHigh` and records them in `<pr>_finalize.json`
  `resolved`; `--summary` lists them. Open findings still block.
