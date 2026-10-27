### Approach
Extend the #4389/#4626 post-deploy gate: due-date state, decision items as owner asks, a deterministic parked sweep on the schedd timer, and outcome handling (tick, file issues, owner ask) in measureFollowup. No lane or model call is involved.
### Changes
- bin/lean/prefilter.mjs: `due:` token, `awaiting-due` gate state, decision-only items, owner-ask, `gateOnly`, report lines.
- bin/lean/parked-sweep.mjs: new `sweepParked`.
- bin/lean/postdeploy-check.mjs: tick items on pass, one engineering issue per failing check, typed owner ask.
- bin/engine-cli.mjs: sweep on schedd due pass and `probe --due`.
- bin/lean/lifecycle.mjs, light.mjs, bin/labels.json: `awaiting-due` label.
- Tests, devdocs/modules/lean.md, decision ADR, docs/CONFIG.md.
### Acceptance Criteria Status
- R1-R6: ✅ bin/lean/prefilter.mjs (postDeployGate, prefilterIssue), bin/lean/parked-sweep.mjs
- R7-R11: ✅ bin/lean/postdeploy-check.mjs (measureFollowup, tickItems, fileFailureIssues, postOwnerAsk)
- R12-R13: ✅ bin/lean/prefilter.mjs (formatParkedLine)
### Verification
- V1, V2 (`forgedock check`): pass. The new tests exercise code that did not exist before the change, so they fail without it.
### Notes
No new env vars. New labels `awaiting-due` and `due:<date>`.

## Stale-list fix
The ten flagged tests (batch, checks, conformance(.e2e), context, execution(.e2e), fixround, heavy, lean) enumerate unrelated things (fixtures, fix-round kinds, heavy binaries), not lean modules. `parked-sweep` is recorded in result.json `not_members` for each.
