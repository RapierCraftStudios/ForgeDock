### Approach
getBody now fails loudly instead of returning "", reads with -R when the repo is known, and writeState refuses a write that would drop existing non-STATE text.

### Changes
- bin/engine/projector.mjs: `makeProjector(io,{repo})`; getBody adds `-R`, throws on non-JSON or non-string body; writeState guard before `gh issue edit`.
- bin/lean/effects.mjs: passes `{ repo }`.
- bin/engine-cli.mjs: passes `repo` at the engine tick projector.
- bin/tests/engine-projector.test.mjs: 3 new tests.

### Acceptance Criteria Status
- R1 ✅ bin/engine/projector.mjs:24-27, test engine-projector.test.mjs (non-JSON)
- R2 ✅ projector.mjs:23, test "-R when the repo is known"
- R3 ✅ test "writeState leaves the body unchanged when the issue view output is not JSON"
- R4 ✅ projector.mjs writeState guard
- R5 ✅ projector.mjs getBody throws; no edit call

### Verification
- node --test bin/tests/engine-projector.test.mjs: 15 pass; 3 fail with projector.mjs reverted (fails without fix).
- node --test bin/lean/lean.test.mjs bin/stats/stats.test.mjs: 588 pass.
- engine-cli and effects tests: 78 pass. forgedock check: PASS.
- checks.mjs widened to the full suite (fan-out); not run per host rules.

### Notes
Callers without a repo (bin/engine.mjs, hooks/interactive-engine.mjs) keep cwd resolution. A failed body read now makes writeState throw.
- Docs: added devdocs/modules/lean.md entry for the #4860 projector change (docs freshness).
