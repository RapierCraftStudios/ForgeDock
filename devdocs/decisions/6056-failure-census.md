# 6056: failure census tool + evidence dossier

## Context
Pipeline fixes were being designed from guesses. The 2026-11-26 audit measured why lanes park, conflict, wait and waste
compute; agents building fixes need that evidence in the repo, and a way to refresh it.

## Choice
- `bin/lean/failure-census.mjs` (pure, tested) classifies FORGE:NEEDS_HUMAN/PARKED bodies into buckets, normalises
  failure rows, reads the last FORGE:AMENDMENT-STATE per issue, base-sync conflict files, and batch-log outcomes/phases.
- `scripts/failure-census.mjs` is the read-only CLI (gh + local batch logs) printing Markdown or JSON.
- `devdocs/evidence/2026-11-26-*` holds the dossier and the two host audits (external repo and host names redacted).

## Rejected
- A dashboard or new service: a deterministic script over the register is enough and costs no LLM calls.
