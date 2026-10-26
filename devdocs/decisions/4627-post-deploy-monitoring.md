---
issue: 4627
status: fresh
anchor: bin/lean/postdeploy-monitor.mjs
created: 2026-10-26
---

# ADR: windowed post-deploy check monitoring

## Context

Part 1 (#4626) runs a named check once and closes the follow-up on a pass, so a fix that breaks again later goes unseen.

## Choice

- A checks-file entry may add `for` (window) and `every` (cadence, default 6h; needs `for`), parsed with `parseMinAge`. Windowing keys live in the default-branch checks file, never in the issue.
- A windowed first pass leaves the follow-up open with the `post-deploy-monitoring` label and a `FORGE:PROBE` record (`at`, `default_sha`, `window_until`, `every_ms`). GitHub is the register: no local state.
- `sweepDue` is due when `every` elapsed or `origin/<default>` moved ("release" is a move of that ref; the repo has no tag or deploy API). Commands are re-read from the default branch each run.
- A pass-then-fail files one `FORGE:REGRESSION` issue (fix commit, last passing and breaking `default_sha`) and closes the follow-up. The parent is not reopened: the regression issue is the report. The follow-up's latest record being a fail stops any re-run or second filing.
- Triggers: `forgedock probe --due` and an unref'd, non-overlapping timer in the schedd daemon (`FORGEDOCK_SCHEDD_DUE_MS`, default 15 min). No model call.

## Rejected

- A local state file: breaks "GitHub is the register".
- Reopening the parent on a regression: the parent's fix did hold once; a new issue names the breaking release.
- Changing `probeResultOf`: `monitorRecord` reads the extra fields, so existing FORGE:PROBE readers are untouched.
