**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: medium (false CRITICAL/P0 erodes trust in /pipeline-health)
**Task Type**: bug

### What Was Claimed
`scripts/doctor-pipeline-state.sh` I4 emits CRITICAL for young lean lanes lacking `FORGE:BUILDER`, and I6 warns on lane-authored and dependabot PRs.

### What We Found
- scripts/doctor-pipeline-state.sh:404-426: I4 checks only `contains("FORGE:BUILDER")`; finding is hard-coded `critical`, `hours_stuck` "0", no age/grace check (STUCK_HOURS only used by I1-I3 at lines ~245, ~283).
- BUILDING list (line ~268) fetches `number,title,updatedAt,labels` — no createdAt/updatedAt use in I4.
- scripts/doctor-pipeline-state.sh:455-487: I6 fetches `number,title,body,createdAt` only (no author/headRefName), flags any body lacking `FORGE:`; only 1h grace.
- Lean branch pattern `feat/issue-N-lean` (see bin/tests/*.test.mjs usages, e.g. `feat/issue-9-lean`).
- No test file exists for this script (only parity/corpus mentions in bin/tests/workflow-state-parity.test.mjs:53).

### Root Cause
I4/I6 encode the classic (non-lean) pipeline's markers only; lean lanes write FORGE:CONTRACT/PLAN/WORK-ON and open PRs from bot app with `feat/issue-N-lean` heads.

### Affected Files
- scripts/doctor-pipeline-state.sh
- bin/tests/doctor-pipeline-state.test.mjs (new)

### Sibling Sweep
I2 uses updatedAt age already. I5 unaffected. Header doc comments (lines 44-46) and commands/pipeline-health/phase-1-context.md mention I4/I6 wording; update the header only.

### History
Check pre-dates lean lanes; no prior fix (recent commits only touch I2/remediating, #2586 tmp perms).

### Recommendation
I4: fetch comment bodies; builder evidence = any of FORGE:BUILDER, FORGE:CONTRACT, FORGE:PLAN, FORGE:WORK-ON. Also fetch createdAt/updatedAt for the issue; if age hours < STUCK_HOURS, skip (grace). Otherwise keep critical. Note hours_since is integer hours, so use `-lt "$STUCK_HOURS"`.
I6: add `author,headRefName` to the pr list JSON. Skip when body has `FORGE:`, or headRefName matches `^(feat|fix)/issue-[0-9]+-lean$` (regexp `^[a-z]+/issue-[0-9]+(-lean)?`), or author.is_bot is true and login matches dependabot/renovate (dependency bots) — treat other bot/app authors named `app/rapiercraft-forgedock` (or forge.yaml configured bot via env/arg if cheap) as pipeline PRs. Hand-made human PR without markers still warns.

### Related Issues
Context pack lists AlterLab PRs #39718, #39437, #39426, #39424, #38601, #37228 (dependabot), #40017 (observed instance).
