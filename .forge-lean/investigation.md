**Verdict**: CONFIRMED
**Confidence**: medium
**Severity**: P1 (no test covers the real new-user experience; a false success banner shipped)
**Task Type**: feature

### What Was Claimed
No test exercises what a new user sees. Asks for a scripted journey run on the host before each release: (1) clean container, `npx forgedock` from the packed tarball, assert not-ready output, files written, doctor output; (2) real sandbox repo: setup, doctor green, `demo --run`/first issue to merged PR, record time-to-first-merge and prompts; (3) snapshot user-visible output. Acceptance: `forgedock selftest --journey` runs both stages and fails on the regressions; result posted on the release PR next to GATE_PASS.

### What We Found
- `forgedock selftest` accepts only `--static`/`--live`; anything else throws usage: bin/lean/selftest-live.mjs:243 (`selftestFromCli`). No `--journey` exists (grep of bin/ finds none).
- Dispatch at bin/forgedock.mjs:4295 and help text at bin/forgedock.mjs:3414 mention only static/live.
- Release gate: marker `FORGE:SELFTEST` built/parsed/posted in bin/lean/selftest-gate.mjs:10-46; `review-staging` enforces it at bin/review-staging.mjs:242-249 and posts `FORGE:GATE_PASS` at :523. A journey result needs its own marker (reusing `FORGE:SELFTEST` would clobber the live result, since the newest marker wins: selftest-gate.mjs:28).
- Harness pattern to reuse: all process access via injected `io`, `StepError`, first failure stops, cleanup always runs (selftest-live.mjs:25-30, 178-205); sandbox repo from `--repo` / `selftest.sandbox_repo`, refusal if it equals the project/release repo (selftest-live.mjs:262-266).
- `demo --run` exists (bin/demo.mjs:64-96, 396-450) but requires ANTHROPIC_API_KEY; `doctor` at bin/forgedock.mjs:4457; the onboarding journey is bin/journey.mjs.
- Snapshot precedent: none for CLI output (only bin/lean/release-snapshot.mjs, unrelated).
- Docs: docs/SELFTEST.md, docs/CONFIG.md:725, devdocs/modules/lean.md (entry 2026-10-31 #4865).

### Root Cause
Existing selftest (#4865) checks gh/orchestrate contracts only; nothing runs the packed CLI as a first-time user, so UX regressions (false success banner, inconsistent prereq checks, placeholder config, jargon errors) pass unit tests.

### Affected Files
- bin/lean/selftest-journey.mjs (new): stage 1, stage 2, snapshot compare, injected `io`.
- bin/lean/selftest-journey.test.mjs (new).
- bin/lean/selftest-live.mjs: parse `--journey`, call journey runner, post marker.
- bin/lean/selftest-gate.mjs: journey marker build/parse/post (`FORGE:JOURNEY`).
- bin/lean/selftest-gate.test.mjs: marker tests.
- bin/forgedock.mjs: help line (:3414).
- bin/tests/fixtures/journey-snapshots/*.txt (new): committed snapshots.
- docs/SELFTEST.md, devdocs/modules/lean.md.

### Sibling Sweep
`selftest-nightly.mjs` runs `--live` only; journey stays out of nightly (needs container, spends LLM). `review-staging.mjs` gate reads only FORGE:SELFTEST; keep it unchanged (journey result is informational next to GATE_PASS, per the issue, not a new blocker).

### History
Live harness added in #4865, hardened #4952, refactored #5032. Related release-gate work #5277/#5278. No prior journey test.

### Recommendation
Add `selftest --journey [--repo] [--pr N] [--update-snapshots]` as pure-logic module with injected io.
Stage 1: `npm pack`, then in a clean env (docker `node:<ver>` with only git if docker exists, else a temp HOME/empty-PATH-except-node+git dir) run `npx <tarball>`; assert exit/not-ready wording, list of files written, and `doctor` output; scrub volatile bits (paths, versions, timestamps) and diff against committed snapshots (banner, help, doctor, errors); a missing/changed snapshot fails with a diff. Stage 2 (skipped with a note when gh unauthenticated or no `claude` on PATH): fresh sandbox repo from config, setup, `doctor` must exit 0, `demo --run` to merged PR; record time-to-first-merge and prompts into the result; cleanup always. Result posted on the release PR as a `FORGE:JOURNEY result=… sha=… ttfm=…` comment (distinct from FORGE:SELFTEST). Stage 2 live execution is verified out-of-band; unit tests cover it with fakes.

### Related Issues
#5290 (time-to-first-merge metric, open), #5277/#5278 (host-run checks), #4865 (live selftest), #4782 (CLI onboarding).
