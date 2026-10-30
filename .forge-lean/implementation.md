### Approach
Release logic is a new pure-first module (`issuewatch-release.mjs`); `issuewatch.mjs` only parses/validates the new keys, wires selectors, claim registry and lane rule into `releaseTick`, and adds `--dry-run`. gh, clock, batch and the LLM classifier are injected through `io`.

### Changes
- bin/lean/issuewatch-release.mjs (new): score, triggers, theme rules, counted LLM fallback, NORTHSTAR priorities, Depends-on closure under cap, decide, dry-run text, RELEASE_PLAN, releaseTick (tag, one batch, deploy PR once, never merge).
- bin/lean/issuewatch.mjs: new keys, `mode: release` validation, flow-map and `theme_map` block parsing, `releaseStep`, `--dry-run`, status line, real `io.classify`; `dagOrder` now also reads bold `**Depends on**`.
- bin/lean/issuewatch-release.test.mjs (new): 14 tests.
- bin/forgedock.mjs: usage line. docs/ISSUE-WATCH.md, docs/CONFIG.md: release mode. devdocs/modules/lean.md: dossier (amendment add-deliverable, required by check-devdocs-freshness).

### Acceptance Criteria Status
- R1 ✅ bin/lean/issuewatch-release.mjs:37 (triggers), tests "each trigger type", "immediate security issue below threshold"
- R2 ✅ bin/lean/issuewatch-release.mjs:57,76 (rules; classifyPool counts `llm`)
- R3 ✅ bin/lean/issuewatch-release.mjs:112,125 (closure, cap), rollover test
- R4 ✅ bin/lean/issuewatch-release.mjs:178 (releaseTick: plan, tag, one batch, deploy PR, no merge)
- R5 ✅ bin/lean/issuewatch-release.mjs:151 formatDryRun; bin/lean/issuewatch.mjs `--dry-run`
- R6 ✅ pool + threshold in releaseTick
- R7 ✅ test "claims nothing below the threshold"
- R8 ✅ scoreThemes + releasePriorities
- R9 ✅ no merge call; test asserts none
- R10 ✅ formatDryRun output tested

### Verification
- V1 `node --test bin/lean/issuewatch.test.mjs bin/lean/issuewatch-release.test.mjs`: pass; the new test file fails without the fix (module missing).
- V2 `node --test bin/lean/decision-engine.test.mjs bin/lean/gatewatch.test.mjs`: pass.
- Also engine-cli, forge-utils, pitfalls, routing tests pass; `forgedock check` PASS; check-devdocs-freshness OK. No formatter configured in this repo.

### Notes
Release mode LLM fallback shells out to `claude --print`; without an answer issues join theme `general`. No new env vars. Tracker defaults to the first issue of the set.

### Stale-list follow-up
Checked the 10 flagged tests: none enumerates lean modules or mentions issuewatch/gatewatch/decision-engine; recorded each as not_members in result.json. No test edits needed.

### Export collision follow-up
Renamed `decide` in issuewatch-release.mjs to `decideRelease` (conformance.mjs already exports `decide`); updated its caller and test import/uses. V1 passes (33).
