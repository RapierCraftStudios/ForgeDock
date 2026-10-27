### Approach
One sourced bash snippet gives router, agent and schedd units the same hardening; entrypoints set distinctive process titles; doctor gets a warn-only restart check driven by the journal.

### Changes
- pool/install/unit-hardening.sh: new; OOMScoreAdjust (-500 system, manager's own value for user), Restart=always, StartLimitIntervalSec=0, earlyoom/oomd hint (never edits config).
- pool/install/install-router.sh, install-agent.sh: use the snippet and print the hint.
- pool/install/install-schedd.sh: new schedd user unit.
- bin/pool/cli.mjs: titles for router and agent. bin/engine-cli.mjs: schedd title.
- bin/pool/health.mjs: restartCheck / lastExitReason. bin/forgedock.mjs: doctor Check 14.
- bin/tests/pool-unit.test.mjs: new tests.

### Acceptance Criteria Status
- R1 ✅ bin/pool/cli.mjs:39
- R2 ✅ pool/install/unit-hardening.sh:11-22
- R3 ✅ install-router.sh, install-agent.sh, bin/tests/pool-unit.test.mjs
- R4 ✅ bin/pool/health.mjs, bin/forgedock.mjs Check 14
- R5 ✅ install-schedd.sh, bin/engine-cli.mjs schedd title

### Verification
- V1 pool-unit/pool-cli/router tests: pass (70). V2 engine-cli + execution tests: pass (131). V3 bash -n: ok.
- The title test fails without the fix (title not set). Not run on base explicitly.
- checks.mjs widened to the full suite (929 refs); not run per host rules. `forgedock check` passes.

### Notes
No formatter configured. Doctor "grew in last hour" is derived from journal restart lines. The user-unit OOMScoreAdjust is the user manager's own value, not independently tested on a real systemd.

## Sibling-list check
`health` (bin/pool) is not a member of the lists flagged at bin/lean/execution.test.mjs:222 (gc sandbox test) or bin/tests/router.test.mjs:29 (router CLI tests); neither enumerates bin/pool modules. Recorded in result.json not_members.
