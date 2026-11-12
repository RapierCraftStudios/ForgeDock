# 5556: one audited release control verb set

Context: operator controls (hold, cancel, force a lane, exempt a check, freeze) were done by hand and unaudited (epic #5549, I15/I20/I24/I26).

Decisions:
- One implementation (`runControl` in bin/lean/release-control.mjs); `release control <verb>` and `release <verb>` route to it.
- State lives in key-scoped `_active` keys through `updateActive`; `controls.jsonl` is the audit and a `FORGE:CONTROL` comment goes on the lease issue.
- The hold gate sits inside `fenced()`, the single choke point for merge, rerun and dispatch, and before each `runRelease` step. A hold read failure refuses (I5). This repo has no conductor; one added later must call `fenced()` or `holdCheck`.
- Freeze is the repo's own variable named by policy `deploy.freeze_variable`, not a second mechanism.
- `buildDispatchArgs` rejects `override_*` and `acknowledge_*` inputs, so the engine cannot set break-glass inputs.
