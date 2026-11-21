forge-stamp: issue=5752 contract=-
**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: medium (workflow cost; complexity ratchet, no data loss)
**Task Type**: feature

### What Was Claimed
Guards are all strong: any test a merged fix names parks a later lane (`conformance.guard_broken`) even when it only asserts a literal exists, and each removal needs one `supersedes` per guard. A repo cannot demand before/after outcome evidence, and new heuristics need not show negative examples.

### What We Found
- `bin/lean/guardgate.mjs:141-236` `runGuards` treats every failing base test alike; `guardFailures` (`:249-254`) turns each into `conformance.guard_broken` with no weak/strong notion.
- `bin/lean/guardgate.mjs:213-218` `materialize` already reads the base test body (`git show mergeBase:path`), so a source-text classifier needs no extra git call.
- `bin/lean/conformance.mjs:1197-1199` retires a failure only via per-guard `contract.supersedes`; `:802-806` records one row per `{guard, why}`; `:740` expands `guards:[...]` but still one row per id, so removing N guards needs N ids.
- `bin/lean/conformance.mjs:1003` `removedPathsOf` and the `precheck` param `removedPaths` (`:1123`) already carry the lane's deleted files; `lean.mjs:3382` computes them only when a validate is substituted.
- `bin/lean/lean.mjs:3265-3279` `guardGate` returns `r.failures` into `precheck` (`:3393`); `lean.mjs:4211` posts the supersession comment from `supersededIds` (`guardgate.mjs:262`).
- Declared-area gate precedent: `docsgate.mjs:23,76` (parse `forge.yaml docs`, return `conformance.unimplemented` rows), read in `bin/engine-cli.mjs:606`, run at `lean.mjs:3356`, passed to `precheck` (`conformance.mjs:1203`). Nothing equivalent exists for outcome evidence.
- Post-deploy check entries (`.forge/post-deploy-checks.json`) are `{run, pass, timeout, for}`; no baseline field. `lean.mjs:3381` already reads them (`checksAt`) when a post-deploy row exists.
- Builder rules live in `bin/lean/prompts.mjs` (`reproPlanNote:343`, `invariantsPlanNote:380`, supersedes line `:268`); none mentions negative examples. No `prompts.test.mjs` exists.

### Root Cause
The guard gate (#4693) and supersedes (#4695) have one guard strength and one override granularity, and the contract has no outcome-evidence concept, so adding proof is cheap and retiring it is costly.

### Affected Files
`bin/lean/weakguard.mjs` (new), `bin/lean/guardgate.mjs`, `bin/lean/conformance.mjs`, `bin/lean/lean.mjs`, `bin/lean/outcomeevidence.mjs` (new), `bin/engine-cli.mjs`, `bin/lean/prompts.mjs`, `docs/CONFIG.md`, `devdocs/modules/lean.md`, and tests for each.

### Sibling Sweep
- `basered.mjs` (`verify.invariants` guards) is a different guard set; unchanged.
- `decisions.mjs` preserve rows (`decision_unsuperseded`, `conformance.mjs:1103`) share the "one amendment per guard" shape but guard declared decisions, not exact-text tests; out of scope.
- `reproPlanNote` is the sibling for the negative-examples rule.

### History
Guard gate #4693, guards index #4692, supersedes #4695/#4916/#4883, baseline compare #4968, batching #5436. No prior weak/strong or outcome-evidence work.

### Recommendation
1. `weakguard.mjs`: pure `isWeakGuardTest(source, path)`: weak only when the file reads file text, imports no local non-test module, has at least one assertion, and every assertion is a literal-presence form. Any behavioural assertion makes it strong.
2. `runGuards` tags runs `weak`; `guardFailures` excludes them; `weakGuardNotes(runs)` yields review notes (trajectory decision plus `guard_weak` event), never a precheck failure.
3. Mechanism removal: amendment `{"kind":"supersedes","mechanism":"<name>","why":".."}` stored as `contract.mechanisms`; precheck retires strong guard failures whose test file the lane deleted; `supersededIds` also returns those guards so the post-merge comment still fires. Weak guards need no amendment, so a mechanism plus its weak guards needs at most one.
4. `outcomeevidence.mjs` plus forge.yaml `outcome_evidence: {paths: {area: globs}, corpus: {area: globs}}` (off when absent). A lane whose non-test changed files match an area needs `result.outcome_evidence:[{area, metric, corpus, before, after, better?}]`: corpus exists in the tree and matches a declared corpus glob, numeric before/after, after not worse; else `conformance.unimplemented` rows (`outcome_evidence_missing|invalid|regressed`) with the reason. Also fails when a post-deploy row's check in `.forge/post-deploy-checks.json` has no `baseline` for a touched area.
5. Builder rule line in `prompts.mjs`: a new keyword or regex classifier ships negative examples (layer 2, zero cost).
No new outcome code, no new default-off flag (outcome evidence is opt-in by declaration; weak labelling is the AC default). No route or prod_parity surface is touched.

### Related Issues
#4693, #4695, #4692, #4968, #4883, #5419 (docs gate precedent).

### Test plan
Feature, not a bug. Tests: `weakguard.test.mjs` (weak vs strong, mixed file, behavioural file importing the module), `guardgate.test.mjs` (weak failing guard gives a note and no failure; strong still fails), `conformance.test.mjs` (mechanism amendment validated, retires deleted-test guards, surviving strong guards still fail), `outcomeevidence.test.mjs` (parse, missing/invalid/regressed/ok, baseline), `lean.test.mjs` (prompt rule, wiring).
