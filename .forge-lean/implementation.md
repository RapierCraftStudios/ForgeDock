### Approach
Phase 2 of `/review-pr` now exports the PR's existing changed files as `$FORGE_CHANGED_FILES` and runs three optional scoped steps (`typescript.typecheck_changed`, `typescript.test_changed`, `python.test_changed`) through the existing `run_step` and test-loop paths. Files reach commands by env var, never spliced into the eval'd string.

### Changes
- commands/review-pr.md: export of `FORGE_CHANGED_FILES`; `typecheck_changed` after `typecheck`; test loop runs `test` and `test_changed` with `EXIT <lang>.<step>=N`, flaky classifier kept; test SKIPPED only when neither form is set; bullet describing blocking rules.
- docs/CONFIG.md: row documenting the three keys and the env var.
- forge.yaml.example: commented examples.
- commands/forgedock-init.md: suggest the commands when vitest/pytest is detected.
- scripts/review-pr-changed-verification.test.sh: new test running the extracted Phase 2 fence with a stub yq.

### Acceptance Criteria Status
- R1 ✅ commands/review-pr.md:329-339
- R2 ✅ commands/review-pr.md:324 (command is user-configured; docs/CONFIG.md and forge.yaml.example show the filtered-tsc recipe)
- R3 ✅ commands/review-pr.md:329
- R4 ✅ commands/review-pr.md:308
- R5 ✅ commands/review-pr.md:324,330-332,342
- R6 ✅ commands/forgedock-init.md (4E decision list)

### Verification
- V1 review-pr-changed-verification.test.sh: 17 passed; with the spec change reverted it fails 10 checks.
- V2 check-spec-size.test.sh: pass 45; check-spec-size.sh origin/staging: PASS.
- V3 review-pr-gate2.test.sh: 19 passed.
- V4 review-prepare.test.sh: skipped by the script (yq not installed on this host).
- check-devdocs-freshness.sh: no devdocs update required.
- `forgedock check`: first run timed out on 3 slow tests (300s, host load; each passes alone in about 2 min); second run PASS.

### Notes
New env var `FORGE_CHANGED_FILES` (newline-separated, existing files only; deleted files are dropped). `typecheck_changed` runs inside the node_modules guard. Unconfigured `typecheck_changed` prints a SKIPPED line like the other steps.
