# 6016: shape gates are advisory; generic sandbox installs; recurrence evidence excludes releases

## Context
Audit 2026-11-26 of 215 needs-human parks on 102 open commented issues (this repo and one consumer repo):
- Parks rose from ~5-15/day to 34/70/53 on 11-23..25, when five releases shipped in three days. Batches re-admit held
  lanes on an engine upgrade, so each new gate judged contracts frozen before it existed.
- ~30% of parks were shape rules (amendment syntax, post-deploy check ids, file scope, recurrence design block). A
  malformed amendment was replayed from earlier runs on every rerun, so the same rows parked one issue 19 times.
- 77 of 215 parks were "Remote sandbox lacks X" with no host fallback and no recipe.
- 45 of 67 conflicted base-syncs were in two files the gates made every lane edit (the lean dossier and
  `.forge/post-deploy-checks.json`).
- The recurrence detector counted release PRs and later sibling merges as "earlier fixes".

## Choice
- `splitAdvisory` (conformance.mjs): `ADVISORY_KINDS`/`ADVISORY_CODES` are recorded as `Advisory (not blocking)`
  decision lines and an `ADVISORY` event, never a failure, in the precheck and in the review/verifier verdict. Lanes still
  block on failing validate/CI/guard/repro runs, regressions, unimplemented requirements, untracked deferrals and
  production-parity evidence.
- Invalid amendments are kind `amendment_invalid` (advisory): the amendment is simply not applied.
- A remote tool miss with no recipe gets a generic install by miss kind (pip / npm / apt) and a re-probe before any park;
  `execution.offload_wrappers` names host wrappers that only send work elsewhere, shimmed to run their argument directly.
- Recurrence evidence skips `release/*` heads and PRs merged after the issue's `createdAt`.
- Docs prompts prefer a new `devdocs/decisions/<issue>-<slug>.md` over editing a shared dossier (no merge conflicts).

## Rejected
- Fixing each gate's trap one by one (contract-version gating, amendable design blocks): more code, keeps every new gate
  able to strand older lanes again.
- One recipe per missing tool: the treadmill that produced the parks. The structural answer is a ForgeDock-owned lane
  image (#6017); the generic install is the bridge.
