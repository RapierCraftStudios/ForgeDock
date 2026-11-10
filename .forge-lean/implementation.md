### Approach
All logic lives in a new `bin/lean/ci-budget.mjs` (pure policy plus injected `gh`); `engine-cli.mjs`, `forgedock.mjs` and `release.mjs` only call it, so the large `engine-cli.mjs` grows by 7 lines. `ci` keys are flat because the forge.yaml parser is one level deep.

### Changes
- bin/lean/ci-budget.mjs: policy parse, billing detection, projection, mode resolution, budget line, verify coercion, parity, attested status, alerts, digest, forge.yaml `ci` writer, `forgedock ci budget` CLI.
- bin/lean/ci-budget.test.mjs: 15 tests (stub gh).
- bin/forgedock.mjs: `ci` command case.
- bin/engine-cli.mjs: `readVerify` coercion, budget line in the batch report, parity/attestation hook after the check record.
- bin/lean/release.mjs: budget line at release start and finish (with this release's runs and minutes).
- commands/forgedock-ci-setup.md: setup skill. docs/CONFIG.md, forge.yaml.example: docs.
- devdocs/modules/lean.md: dossier entry (not a listed deliverable; amendment recorded).

### Acceptance Criteria Status
- R1 ✅ bin/lean/ci-budget.mjs ciFromCli (prints plan, included, month-to-date, projection, mode); test "forgedock ci budget prints ..."
- R2 ✅ resolveCiMode + formatBudgetLine; batch report bin/engine-cli.mjs (budgetReportLine), release.mjs
- R3 ✅ resolveCiMode public branch; test "public repo"
- R4 ✅ commands/forgedock-ci-setup.md + writeCiBlock (test round-trips through parseForgeYaml)
- R5 ✅ coerceVerify wired in readVerify (engine-cli.mjs)
- R6 ✅ recordHostCheck/attestPayload; docs/CONFIG.md trust trade-off
- R7 ✅ hitRates, pairParity, shown by `ci budget`
- R8 ✅ budgetAlerts, formatDigest, workflowDigest (`--digest`)
- R9 ✅ formatBudgetLine incl. `this release: N CI run, M min`
- R10 ✅ `ci budget --propose` via scripts/ci-local/plan.mjs buildPlan
- R11 ✅ --set-mode/--budget/--reserve/--plan/--json/--digest/--propose

### Verification
- V1 node --test (ci-budget, integration, verify, release, engine-cli, config-docs): 175 pass, 0 fail. New test file fails without the change (module absent).
- V2 check-spec-size + check-command-docs-drift: pass.
- `forgedock check`: PASS. No repo formatter configured.

### Notes
- `FORGEDOCK_CI_BUDGET_DIR` overrides the cache dir (default ~/.forge/ci-budget).
- Default unchanged: no `ci` block = auto, remote until the billing check resolves a switch.
- For `auto`, the switch takes effect from the cached resolution written by `forgedock ci budget` or a batch/release report.
- The billing endpoints (`orgs|users/{owner}/settings/billing/usage`) were not exercised against live GitHub.
- Sibling-enumeration findings (ci-budget, forgedock-ci-setup): inspected the 19 flagged tests; none lists lean modules or command files, recorded as not_members in result.json.

### CI fix pass: "Unit tests (node --test)"
- The CI log was not available. I ran every `npm test` glob (bin/tests, bin/engine, bin/stats, bin/lean, packages/protocol) with TZ and HOME variations. All pass except `bin/tests/reread-nudge.test.mjs` "makeLeanRunner adds the re-read hooks…", and only here because this lane exports `IS_SANDBOX`/`CS_SANDBOX_ID`, which add a PreToolUse guard. With those unset it passes (9/9). The test and `bin/lean/effects.mjs` are not touched by this diff, so this is unrelated and I changed no code for it.
- I could not reproduce a failure attributable to this diff, so I changed no code. The run may have been a flaky or environment-dependent test.

### CI follow-up: Unit tests (node --test)
The CI job log was unavailable. I could not reproduce a failure locally: the 55 test files that reference `commands/`, `forge.yaml.example`, `runBatch`, `releaseFromCli` or `readVerify` pass (3025 pass, 0 fail), as do the command-listing, install and namespace tests (293 pass, 0 fail). No code was changed. The cause is unknown. If the failure is a flaky or timing-dependent test outside the files this diff touches, it is unrelated; that is unconfirmed until the log is read.
