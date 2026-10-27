### Approach
Logic lives in a new pure script, `scripts/readiness.mjs`; the specs only call it (spec-size budget, NORTHSTAR rules 1 and 7). A prerequisite is an open `needs-human:external` issue whose body carries `gates:` and `owner:` lines. "Code milestones it still needs" are the milestones of open non-prerequisite issues that carry the same `gates:` line.

### Changes
- scripts/readiness.mjs: new. Parsing, per-gate readiness report, dependency-ordered digest (cycle-safe), deployable verdict, CLI.
- bin/tests/readiness.test.mjs: new tests.
- commands/pipeline-status.md: Readiness section and digest.
- commands/deploy-info.md: gate verdict line.
- commands/issue.md, commands/bootstrap.md: the label and `gates:` rule.
- templates/bootstrap/needs-human-issue.md: `gates:` and `owner:` lines.
- scripts/bootstrap-validate.mjs: `missing-gates` error; `needs-human:external` counts as needs-human.
- scripts/bootstrap-create.mjs: adds the `needs-human:external` label.
- docs/spec/label-state-machine.md: documents `gates:` and readiness.
- Test fixtures and test (bin/tests): needs-human bodies gained a `gates:` line; new missing-gates test.
- docs/site/start-a-new-project.md: the worked example needs a `gates:` line to pass the validator (amendment).

### Acceptance Criteria Status
- R1 ✅ commands/issue.md, commands/bootstrap.md, scripts/bootstrap-validate.mjs, scripts/bootstrap-create.mjs
- R2 ✅ commands/pipeline-status.md, scripts/readiness.mjs readiness()/formatReadinessReport
- R3 ✅ scripts/readiness.mjs (feature-flag gate is red, blocksMerge false, ignored by deployable)
- R4 ✅ scripts/readiness.mjs digest()
- R5 ✅ commands/deploy-info.md, scripts/readiness.mjs deployable() and `--target` exit 1

### Verification
- V1 node --test readiness, bootstrap-validate, bootstrap (plus bootstrap-guide): 61 pass. The missing-gates test fails without the validator change.
- V2 check-spec-size.sh: PASS.
- `forgedock check`: PASS.

### Notes
needs-human plan issues now require a valid `gates:` line (new validation error). No env vars. No formatter config exists in the repo.

## Docs freshness fix
Added `lean-readiness` (`scripts/readiness*`) and `lean-bootstrap` (`scripts/bootstrap-*`) globs in devdocs/index.yaml and a dated entry in devdocs/modules/lean.md describing the readiness gates behaviour. check-devdocs-freshness passes; V1 and V2 still pass.
