**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: medium (usage-limit waits end lanes as final `deferred` rows; recovery needs a second batch)
**Task Type**: bug

### What Was Claimed
A `rate_limited` deferral counts toward `max_deferrals`, so lanes give up after 3 and cannot return: `--requeue` refuses `deferred`. Expected: a usage-limit deferral waits for the reset uncapped (like `sandbox.capacity`, #4528) and `--requeue` accepts `deferred`.

### What We Found
- bin/lean/orchestrate.mjs deferPolicy: base ran the `k > maxDeferrals` cap before the `rate_limited` branch. The branch now handles `rate_limited` first (verified in `git diff origin/staging...HEAD`).
- bin/lean/orchestrate.mjs ~l.603: counter is no longer incremented when `pol.hold`.
- bin/lean/batch.mjs:79 REQUEUABLE now includes `deferred`.
- bin/lean/batch.test.mjs: the #4784 describe plus the fixed #4528 capped-codes list and the sequence test (gaps) are in place; the V1/V2 validates exit 0.
- Remaining failure: `bash scripts/check-devdocs-freshness.sh origin/staging` exits 1. `devdocs/index.yaml:123-125` maps the `orchestrate` dossier to glob `commands/orchestrate*` only, so the entry added to devdocs/modules/orchestrate.md does not cover `bin/lean/orchestrate.mjs` or `bin/lean/batch.mjs`. Those match `bin/lean/*` -> devdocs/modules/lean.md (index.yaml:129-131).

### Root Cause
Code: deferPolicy applied the cap before the usage-limit branch and REQUEUABLE omitted `deferred`. Previous run's stale-docs failure: the dossier entry went to the module whose glob does not match the changed bin/lean files.

### Affected Files
bin/lean/orchestrate.mjs, bin/lean/batch.mjs, bin/lean/batch.test.mjs, commands/orchestrate.md, devdocs/modules/lean.md (to add).

### Sibling Sweep
Other codes (merge.transient, gh.unavailable, cli.idle, sandbox.start_failed, lease-held) stay capped by design; host.busy/sandbox.capacity already uncapped. `engine-error` requeue is out of scope.

### History
#4528 uncapped sandbox.capacity; #4190 usage-limit holds; #4550 added `--requeue`/REQUEUABLE. Prior run of #4784 landed the code in 73ba396f8 and a dossier note in 0505f3219 and ended needs-human (docs.stale).

### Recommendation
Keep the code as is. Add a `## Entry` for #4784 (with `Cite: #4784.`) to devdocs/modules/lean.md, mirroring the existing orchestrate.md entry (or move it there; keep the orchestrate.md one). Re-run `bash scripts/check-devdocs-freshness.sh origin/staging` (expect OK), then V1/V2 and the checks.mjs scoped commands.

### Related Issues
#4528, #4550, #4190.
