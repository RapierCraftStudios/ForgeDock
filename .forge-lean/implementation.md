### Approach
The script groups normalised TSV rows by class and runs the existing lookup/append/create flow once per class. Requirement text moves out of column 1 into a new label column 5, which is the item's identity, so the checklist line, `DEFERRED_FROM` marker and `identity<TAB>issue` rows stay byte-compatible for review-finalize.sh, prefilter.mjs and followupMap. Milestone and default milestone are passed in by the engine.

### Changes
- scripts/file-deferred-followups.sh: 5-column TSV with validation (exit 2, `DEFERRED_TSV=INVALID`), class derivation, per-class lookup (all before filing) and filing, `FORGE:DEFERRED_CLASS` marker, class-aware claim marker and verify, `followup:<class>` labels (+ `external-prerequisite`), milestone resolution (parent, next open by due date, default), telemetry with all issues and classes.
- scripts/file-deferred-followups.test.sh: mock extended; cases for milestone inheritance, class labels/issues, class reuse, rejected rows, label rows, body contents (59 checks).
- bin/lean/conformance.mjs: `FOLLOWUP_CLASSES`, `followupClass`, `class` on followup items, optional requirement `class` validated.
- bin/lean/conformance.test.mjs: class test.
- bin/lean/effects.mjs: `fileFollowups` sends `-` + class + label columns and the milestone env; `runWithInput` takes an env.
- bin/lean/lean.mjs: `track()` passes `milestone` and `o.followupsDefaultMilestone`.
- bin/engine-cli.mjs: `readFollowupsDefaultMilestone` (forge.yaml `followups.default_milestone`) wired into both option spreads (amendment).
- bin/labels.json: five labels. docs/CONFIG.md: `followups` section. commands/work-on/build.md: TSV/class docs.
- devdocs/modules/lean.md, devdocs/decisions/4664-followup-classes.md: freshness (amendments).

### Acceptance Criteria Status
- R1 ✅ scripts/file-deferred-followups.sh:214 (resolve_milestone), bin/engine-cli.mjs readFollowupsDefaultMilestone, bin/lean/lean.mjs track()
- R2 ✅ scripts/file-deferred-followups.sh:229 (file_class labels), bin/lean/conformance.mjs:759
- R3 ✅ file_class external body/labels + FORGE_EXTERNAL_PREREQ link; `[check:]` kept (test 18, "post-deploy issue" test)
- R4 ✅ scripts/file-deferred-followups.sh:57-87
- R5 ✅ scripts/file-deferred-followups.sh:161,298
- R6 ✅ scripts/file-deferred-followups.test.sh (sections 19-21)

### Verification
- V1 `bash scripts/file-deferred-followups.test.sh`: passed=59 failed=0 (also under /bin/bash). Against the base script, 23 checks fail, so the new tests fail without the fix.
- V2 `node --test` postdeploy-check, prefilter, conformance.e2e, lean tests: pass. V3 conformance.test.mjs: pass (combined run 648 pass, 0 fail).
- `forgedock check`: PASS. check-devdocs-freshness.sh origin/staging: OK. No formatter is configured in the repo. checks.mjs widened to the full suite, which the host rules forbid, so only the targeted tests were run.

### Notes
- Env: FORGE_FOLLOWUP_MILESTONE, FORGE_FOLLOWUPS_DEFAULT_MILESTONE, FORGE_EXTERNAL_PREREQ. forge.yaml: `followups.default_milestone`.
- Engineering follow-ups keep the old title; others are `follow-up (<class>): ...`. Existing issues without a class marker count as engineering. A parent without a milestone gets none.
- Telemetry line gains `classes=` and `batched_into` may list several issues.
