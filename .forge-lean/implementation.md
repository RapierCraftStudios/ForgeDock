forge-stamp: issue=5752 contract=fb8999b53a4a

### Approach
Deterministic, layer-1 changes only (0 LLM calls): a pure source classifier marks a guard test as weak when it only asserts that literals exist in file text. Broken weak guards become review notes instead of `guard_broken`. A `supersedes` amendment carrying `mechanism` retires every broken guard whose test files the lane deleted. A new off-by-default `outcome_evidence` gate needs a before/after row on recorded real inputs, and a metric baseline on post-deploy checks, for declared areas. Its failures reuse `conformance.unimplemented`, so there is no new outcome code (K1).

### Changes
- bin/lean/weakguard.mjs: new `isWeakGuardTest(source, path)` for JS/TS and Python. A file is weak only when it reads file text, imports no local non-test module, runs no process, has at least one assertion, and every assertion is a literal-presence form. Anything else is strong.
- bin/lean/weakguard.test.mjs: weak fixtures, strong fixtures (imported function, mixed file, equality on a computed value), Python cases, and negative examples for the classifier.
- bin/lean/guardgate.mjs: `materialize` tags each job `weak` from the base body, and runs carry `weak`. `guardFailures` excludes weak runs. New `weakGuardNotes(runs)`. `supersededIds(contract, selected, removedPaths)` adds guards retired by a mechanism.
- bin/lean/guardgate.test.mjs: a weak failing guard gives a note and no failure; a strong failing guard is still `guard_broken`; mechanism-retired ids reach `supersededIds`.
- bin/lean/conformance.mjs: `supersedes` with `{mechanism, why}` is validated and stored as `contract.mechanisms`. `precheck` drops a `guard_broken` row whose test is in `removedPaths` when a mechanism exists, and pushes `outcomeEvidenceFailures`.
- bin/lean/conformance.test.mjs: mechanism validation, retirement of deleted-test guards, a surviving strong guard still failing, one amendment retiring many, and the outcome failures pushed.
- bin/lean/outcomeevidence.mjs: new `parseOutcomeEvidenceConfig`, `touchedAreas`, `rawChecksAt` and `outcomeEvidenceFailures` (kinds `outcome_evidence_missing|invalid|regressed|baseline_missing`). Each failure detail names the area, the files and the required row shape.
- bin/lean/outcomeevidence.test.mjs: config parsing, the untouched-area pass, each failure kind, the good-row pass, and the post-deploy baseline cases.
- bin/lean/lean.mjs: takes the `outcomeEvidenceConfig` option and calls `outcomeEvidenceFailures` beside the docs gate. The guard gate emits `guard_weak` and adds the weak notes to the trajectory decisions. It computes `removedPaths` when a mechanism amendment exists and passes it to the supersession comment loop.
- bin/engine-cli.mjs: `readEnvConfig` parses forge.yaml `outcome_evidence` and returns `outcomeEvidenceConfig`.
- bin/lean/prompts.mjs: adds the builder rule that new classifiers ship negative examples, and documents the mechanism supersedes amendment and the `outcome_evidence` row and baseline shapes.
- bin/lean/lean.test.mjs: three wiring tests: a weak guard does not block and is noted; a missing outcome-evidence row blocks with its reason (and no config means no check); the prompt carries both rules.
- docs/CONFIG.md: documents `outcome_evidence.paths` and `outcome_evidence.corpus`, the result row, the post-deploy baseline, weak guards and the mechanism amendment.
- devdocs/modules/lean.md: Guard gate section updated, and a dated #5752 entry.

### Acceptance Criteria Status
- R1 ✅ bin/lean/weakguard.mjs:91
- R2 ✅ bin/lean/guardgate.mjs:252,259; bin/lean/lean.mjs:3277
- R3 ✅ bin/lean/weakguard.mjs:91 (anything not proven weak is strong); bin/lean/guardgate.test.mjs:356
- R4 ✅ bin/lean/conformance.mjs:803,1205; bin/lean/guardgate.mjs:273
- R5 ✅ bin/lean/outcomeevidence.mjs:28,80; bin/engine-cli.mjs:608; bin/lean/lean.mjs:3360
- R6 ✅ bin/lean/outcomeevidence.mjs:101
- R7 ✅ bin/lean/prompts.mjs:275; bin/lean/weakguard.test.mjs:26
- R8 ✅ bin/lean/guardgate.mjs:182,252
- R9 ✅ bin/lean/conformance.mjs:1205; bin/lean/conformance.test.mjs:2250
- R10 ✅ bin/lean/outcomeevidence.mjs:80; bin/lean/conformance.mjs:1212

### Verification
- V1: exit 1 on this host. The only failure is the existing #4931 restore test, which gets `a2\r\n` because the host git sets `core.autocrlf=true`. With `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false`, V1 exits 0. All new weakguard, outcomeevidence, guardgate and conformance tests pass.
- V2: exit 0.
- V3: exit 1 on this host, and existing untouched tests (#5436, #4899, core work-on and others) fail the same way. The `runCore` test harness keys its fake worktree as `/wt/lean-7`, while `path.join` on Windows produces backslashes, so every full-lane test reports "contract.json is missing". With a preload in $TMPDIR that sets `path.join`/`dirname` to `path.posix`, all three #5752 tests pass. At base 3b977a9a, with the same preload, the untouched #5436 test fails identically (verified by checking out the base versions of the modified files, then restoring HEAD), so these V3 failures predate this change.
- G1: exit 0.
- `forgedock check`: FAIL (2 failing: V1 and V3), for the host-environment reasons above. V2 and G1 pass. checks.mjs widened to the full suite (fan-out cap), which the host rules forbid, so the scoped validates and eslint were run instead.
- eslint on all changed .mjs files: exit 0.
- Fails without the fix: the guardgate weak test and the lean.test weak-guard test would see `conformance.guard_broken`. The outcome-evidence and prompt tests import or match code that does not exist on base.

### Notes
- New forge.yaml section `outcome_evidence` (`paths`, `corpus`). It is off when unset, so repos without it see no new check (P3).
- New result.json field `outcome_evidence: [{area, metric, corpus, before, after, better}]`.
- New optional post-deploy check field `baseline: {metric, value, better}`.
- New amendment variant `{"kind":"supersedes","mechanism":"<name>","why":""}`. The per-guard form is unchanged (P4).
- New event `guard_weak`, and `guard_run` gains a `weak` count. No new outcome code (P5).

### Stale-list check (siblings not named)
Checked the 10 flagged tests at the cited lines. None enumerates bin/lean modules or symbols (stub lanes, ledger fixtures, MECHANICAL_KINDS, etc.), so `outcomeevidence` and `weakguard` are not members of any list. All 20 pairs are recorded in result.json `not_members` and no test changed.
