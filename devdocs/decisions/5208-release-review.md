# 5208 part 2: the release review and fix steps

`release-review.mjs` fills the two steps part 1 stubbed (#5212). Decisions:

- **Library entry, not a rewrite.** `bin/review-staging.mjs` exports `reviewStagingJson(argv, io)`, which runs any mode with
  `--json` and returns `{code, data, lines}` instead of printing. `reviewStagingFromCli` is unchanged, so the manual path and
  `bin/tests/review-staging.test.mjs` are untouched. A stop becomes `{code, lines}`, never a throw.
- **Every effect is a seam.** `reviewStep` and `fixStep` talk to `ctx.io.review` (default `realSeam`: review-staging, the
  engine runner `makeLeanRunner`, `issue-create.sh` + `review-finalize.sh file-verify`, gh, a `run-issue` lane process). Tests
  inject the whole seam; `release.mjs` is unchanged.
- **Reviewers are not read-only.** Each posts its own `FORGE:REVIEW-AGENT` comment with `gh`, as the spec requires, so the runner
  is called without `readOnly`. The spec-owned panel (material-change, bug-hunter-general, code-quality, regression-risk) is a
  prompt that points the session at its phase of `commands/review-pr-staging.md`; a delta pass dispatches only the briefs,
  because the pre-dispatch credits the earlier pass.
- **Head moves are delta passes.** The head is re-read before finalize. A moved head, or a finalize refusal for one, starts a
  `--delta <reviewed-sha>` pass; finalize never runs at a moved head. At most `MAX_DELTA_PASSES` (2), then the job blocks.
- **Re-ask once.** A finalize stop that names reviewers without a findings block re-sends only their brief with the note the
  spec prescribes, then finalizes again; a second miss blocks as a degraded panel.
- **Filing.** FILE items are filed one by one; a failed filing blocks before the summary. NOTEs are appended to the PR body under
  `## Non-blocking notes` (edit, never replace), then `--summary --filed`.
- **Fix lanes.** `fixStep` does nothing on GATE_PASS. Otherwise it runs a `run-issue` lane on the staging branch for each
  blocking filed issue (CRITICAL/HIGH), requires `terminalReason: merged`, then reviews the delta from the last reviewed head;
  `MAX_FIX_ROUNDS` (2) bounds it. Red CI has no finding, so one issue naming the failing required checks is filed and gets a lane too.
- **R1 is measured out of band.** No lane has a live repo and model sessions; the wiring is unit-tested with the seam, and the
  first real `forgedock release` is the live check.
