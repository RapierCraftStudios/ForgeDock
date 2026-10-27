### Approach
Split joined requirement references into individual amendment rows before applying them. Tell the builder the valid kinds and one id per row. Make the repro harness report UNRUNNABLE when head fails only on a missing host module or command.

### Changes
- bin/lean/conformance.mjs: `splitRequirementRefs` and row expansion in `applyAmendments`. Handles `/ , ; & + and` separators and `R2-R3` / `R2–R3` ranges. Applies to defer, post-deploy and amend-requirement.
- bin/lean/prompts.mjs: no `scope-note` kind; one requirement id per row.
- scripts/acceptance-red-green.sh: head run failed on `No module named <third-party>` or `X: command not found` is UNRUNNABLE. A module the repo tracks stays FAILED. The change is in `run_in`, not the shared classifier, so validate callers are unaffected (D6 seam, D3 unchanged).
- bin/lean/conformance.test.mjs, scripts/acceptance-red-green.test.sh: regression tests.

### Acceptance Criteria Status
- R1 ✅ bin/lean/conformance.mjs (splitRequirementRefs, applyAmendments)
- R2 ✅ bin/lean/conformance.mjs, bin/lean/prompts.mjs:194
- R3 ✅ scope-note stays invalid (test) and the prompt forbids it
- R4 ✅ scripts/acceptance-red-green.sh (run_in, host_missing)

### Verification
- node --test bin/lean/conformance.test.mjs: pass (94). The new tests fail without the fix (2 fail).
- bash scripts/classify-test-run.test.sh: pass
- bash scripts/acceptance-red-green.test.sh: pass. The new case fails without the fix.
- node --test bin/lean/lean.test.mjs bin/lean/light.test.mjs: pass
- forgedock check: PASS. The scoped checks.mjs asked for the full suite (widened), which I did not run per host rules.

### Notes
- D3 and D5 (classify-test-run.sh) were deliberately not changed. The fix lives in run_in (D6) to avoid altering the classifier used by commands/work-on/build/validate.md.
- Head-only: base missing-module failures remain legitimate red proof.
- devdocs/modules/lean.md was not updated (not a deliverable). scripts/check-devdocs-freshness.sh reports no update required.

Docs: devdocs/modules/lean.md entry for #4655 (joined refs split, scope-note rejected, host-missing => UNRUNNABLE).
