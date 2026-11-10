### Approach
`selftest --journey` is a new module with all process access injected through `io`, the same pattern as `selftest-live.mjs`. Stage 1 packs the tarball and runs `npx --package <tgz> forgedock` in a clean environment (Docker `node:22` with `--rm` and `FORGE_DOCKER_LABELS`, else a throwaway HOME and a PATH of only node, git and shell basics). It asserts on the output and the files written, then compares scrubbed output with committed snapshots. Stage 2 runs on the sandbox repo: `demo`, `doctor`, `demo --run`, requires a merged PR, and records time to first merge and prompts. The result is posted with a separate `FORGE:JOURNEY` marker so it cannot replace the `FORGE:SELFTEST` gate result.

### Changes
- bin/lean/selftest-journey.mjs: new; stages, scrub, assertions, snapshot compare, real io, `journeyFromCli`.
- bin/lean/selftest-journey.test.mjs: new; 15 tests with fake io.
- bin/lean/selftest-live.mjs: `--journey` routes to the journey module; usage string updated.
- bin/lean/selftest-gate.mjs: `buildJourneyMarker`, `parseJourneyMarker`, `postJourneyMarker`.
- bin/lean/selftest-gate.test.mjs: journey marker tests.
- bin/forgedock.mjs: help line for `--journey`.
- bin/tests/fixtures/journey-snapshots/{banner,help,doctor,errors,not-ready}.txt: committed snapshots.
- docs/SELFTEST.md, devdocs/modules/lean.md: documentation.

### Acceptance Criteria Status
- R1 ✅ bin/lean/selftest-live.mjs:244, bin/lean/selftest-journey.mjs (runJourney)
- R2 ✅ bin/lean/selftest-gate.mjs (postJourneyMarker), selftest-journey.mjs (journeyFromCli, --pr)
- R3 ✅ selftest-journey.mjs stage1, assertStage1, realJourneyIo.clean
- R4 ✅ selftest-journey.mjs stage2 (setup, doctor, first-merge)
- R5 ✅ selftest-journey.mjs stage2 (ttfmMs), PROMPT capture, printed in journeyFromCli
- R6 ✅ compareSnapshots, bin/tests/fixtures/journey-snapshots/
- R7 ✅ host-run only; documented in docs/SELFTEST.md; not added to nightly or CI

### Verification
- V1 `node --test` on selftest-journey, -gate, -live, -nightly, -static tests: pass (119 pass with V2, 0 fail). The new journey tests fail without the module (import error); the gate tests fail without the marker functions.
- V2 `node --test bin/tests/review-staging.test.mjs`: pass.
- `scripts/check-devdocs-freshness.sh origin/staging`: OK. `forgedock check`: PASS.
- Real stage 1 run (host fallback, no Docker) against the packed tarball: snapshots generated and a second run reproduced them.
- Stage 2 was not run for real: it needs gh auth, Claude Code and a sandbox repo, so it is covered by fakes only.
- No formatter or linter is configured in package.json; none was run.

### Notes
- The real stage 1 run currently FAILS on `forge.yaml`: `npx forgedock` writes `owner: "your-github-org"` and `repo: "your-repo-name"` placeholder values. This is the placeholder-config defect from the issue. It is a product defect outside this contract's deliverables, so it is not fixed here. The committed snapshots were generated without the assertions.
- Anyone running `--journey` before that product fix will see failing step `files`.
- Snapshots came from a host-fallback run, not Docker. Regenerate on the release host with `--update-snapshots` if a Docker run differs.
- Env: `FORGE_JOURNEY_IMAGE` (default `node:22`), `FORGE_DOCKER_LABELS`.

Sibling-list check: the 10 flagged tests (telemetry-seam, batch-health, batch, checks, ci-budget, conformance(.e2e), context, drift, execution.e2e) enumerate no selftest-* modules or bin/lean files; recorded as not_members in result.json.
