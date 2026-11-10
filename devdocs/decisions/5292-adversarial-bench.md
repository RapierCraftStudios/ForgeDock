---
issue: 5292
status: fresh
anchor: scripts/bench-adversarial.mjs
created: 2026-11-10
---

# ADR: adversarial benchmark corpus, full lane vs bare agent, as a sibling harness

## Context

The #4453 harness grades only valid issues, by upstream oracle tests. The failures the process is meant to prevent (wrong premise, duplicate, already shipped, a missed integration point) were not measured, so the "fixed process beats a bare agent" claim was argued, not shown.

## Choice

- **Sibling script.** `scripts/bench-adversarial.mjs` reuses `runArm`, `validateRunConfig`, `parseRows` and `benchDefaultRun` from `bench-lightlane.mjs`. The only change there is that `grade` skips the fix fetch and the oracle for an issue that has no `fix_sha`/`oracle`.
- **Deterministic grading.** From the arm's grade checkout, `git diff --name-only` and `git diff -U0` against the base give the changed paths and added lines. Wrong issue implemented: an invalid kind with a claimed fix. Duplicate created: an added line matching `forbid_new_defs`. Integration missed: `must_touch` paths not in the diff. No LLM grader (as in ADR 4453).
- **Evidence in the corpus.** Each invalid issue carries `{file, pattern}`, checked at the base by `calibrate`, so the "should be closed" label is proven rather than asserted.
- **Integration issues have no oracle.** They are new functions with no upstream fix, so they are graded on `must_touch` only; the oracle pass rate covers the 3 `valid` issues.
- **Live run deferred.** The scorecard renderer is committed and tested on fixture rows. The numbers need API spend and sandbox repos, so they are not fabricated.

## Rejected

- **Extending `bench-lightlane.mjs` `aggregate`.** Its targets are light-lane specific and every row assumes an oracle.
- **A third `invalid` arm of LLM-judged "closed with evidence".** Closing with evidence is detected as not claiming a fix; the evidence text is not judged.
