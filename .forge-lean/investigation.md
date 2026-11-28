forge-stamp: issue=6239 contract=-
**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: P1 (lanes merge a change that the repo's own CI rejects on every later push; ~21 alert issues/day seen externally)
**Task Type**: feature

### What Was Claimed
Lanes add shell scripts without mode 100755. With no required PR checks on staging (#6150) they merge, and the repo's own executable-bit CI then fails on every later push. Wanted: a generic lane-side mode check on added/modified files (shebang files, or `*.sh` invoked directly from a workflow/script/package.json), builder fix via `git update-index --chmod=+x`, and a mode regression (+x dropped) also caught.

### What We Found
- No exec-bit check exists: `grep ls-files -s|100755|chmod` over `bin/lean` hits only worktree/provisioning code, none in a pre-PR gate.
- The pre-PR round (`bin/lean/lean.mjs:3005-3140`) runs only forge.yaml `learned.test_commands` plus derived CI jobs (`ci-precheck.mjs`); it inspects no file modes.
- Closest pattern: deterministic gates `duplicateGate` (`lean.mjs:3307-3330`), `io.duplicateExports` (`effects.mjs:749`) -> `postmerge.mjs`, prompt `duplicateExportsPrompt` (`prompts.mjs:73`), opt-out `verify.duplicate_exports` (`verify.mjs:88`). Same shape fits a mode gate (detector, mechanical fix first like #5348 `dupsResidual`, then one narrow builder round, then anomaly).
- Changed files are available as `files = await changedFiles()` in lean.mjs.

### Root Cause
Nothing in the lane verifies git file modes; the model creates files as 100644 and the only enforcer is repo CI, which is off for staging PRs.

### Affected Files
- new `bin/lean/execbit.mjs` (pure detector: `git diff --raw`/`ls-files -s` for base..HEAD, shebang read, direct-invocation scan of `.github/workflows`, `scripts`, package.json, Makefile; regression = base 100755 -> 100644)
- `bin/lean/effects.mjs` (io.execBits), `bin/lean/lean.mjs` (gate: apply `git update-index --chmod=+x` / `chmod -x` restore mechanically, commit, else a builder round, else anomaly), `bin/lean/prompts.mjs` (short prompt), `bin/lean/verify.mjs` (optional `verify.exec_bits: false` opt-out), `devdocs/modules/lean.md` (entry).

### Sibling Sweep
Same defect class (git-tracked metadata the model cannot see): symlink mode 120000 and CRLF are out of scope. Existing gates (duplicate exports, enumerating, i18n copies) show where to hook; none cover modes.

### History
Introduced by design gap when per-PR CI was dropped for staging (#6150). No prior fix. Context: #6169, #6199.

### Recommendation
Implement a no-LLM detector plus mechanical fix (`git update-index --chmod=+x`, which also works on files `chmod` alone would leave unstaged) as a gate beside `duplicateGate`; a builder round only if the mechanical fix cannot apply. Flag only shebang files or `*.sh` directly invoked; never flag `bash x.sh` callers. Detect regression via base mode.

### Related Issues
#6150, #6169, #6199.

### Test plan
New `bin/lean/execbit.test.mjs`: (a) added shebang file at 100644 flagged; (b) `*.sh` invoked as `./x.sh` in workflow flagged, invoked as `bash x.sh` not flagged; (c) 100755 -> 100644 regression flagged; (d) already 100755 / non-script clean. Plus a lean.test.mjs case: gate applies chmod mechanically and commits. Run only these files with `node --test`.
