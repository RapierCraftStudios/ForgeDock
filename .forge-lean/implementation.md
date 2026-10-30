### Approach
Add `verify.guard_command` (extension -> command template). `commandFor` consults it first; the config reaches it through `parseVerify` -> `vcfg.guardCommand` -> `runGuards`. forge.yaml's one-level parser cannot read the nested map, so `readVerify` loads it with a new block-map reader.
### Changes
- bin/lean/guardgate.mjs: `commandFor(path, contract, guardCommand)` and `runGuards({guardCommand})`; template wins, `{path}` substituted or appended.
- bin/lean/lean.mjs: passes `vcfg.guardCommand` to `runGuards`.
- bin/lean/verify.mjs: `parseVerify` returns normalised `guardCommand` (default `{}`).
- bin/engine-cli.mjs: `readYamlMap` plus the `readVerify` wiring.
- docs/CONFIG.md: key documented.
- Tests: guardgate.test.mjs, verify.test.mjs, engine-cli.test.mjs, lean.test.mjs (default-shape deepEqual).
### Acceptance Criteria Status
- R1 ✅ bin/lean/guardgate.mjs commandFor, verify.mjs parseVerify, engine-cli.mjs readYamlMap
- R2 ✅ guardgate.mjs runGuards runs the command with `cwd` = worktree and the repo-relative guardbase path (test asserts it)
### Verification
- V1 guardgate.test.mjs + verify.test.mjs: pass (42). The new guardgate test fails without the guardgate.mjs change.
- V2 name-filtered engine-cli.test.mjs + lean.test.mjs: pass (47).
- scripts/check-devdocs-freshness.sh: OK. The repo has no formatter script. checks.mjs widened to the full suite (package.json change), which I did not run per host rules.
### Notes
No behaviour change without the key. No new env vars.
- `forgedock check` ran the scoped shell checks in parallel: 3 (classify-finding, verify-phase-trail, lint-dispatch-prompt) hit their 300s timeout under host load; none touches a changed file (no scripts/ change in the diff). lint-dispatch-prompt.test.sh rerun alone: pass=132 fail=0 in 101s. The other two were not rerun.
