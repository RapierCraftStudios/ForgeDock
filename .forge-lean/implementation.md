### Approach
One new module, `bin/lean/issuewatch.mjs`, with pure selectors/lane/cap logic and injected io (gh, clock, launch, batch), as in `lane.mjs`/`lifecycle.mjs`. forge.yaml `issue_watch.watches` is parsed by the module's own `parseWatches` because `parseForgeYaml` (bin/forge-utils.mjs:48) reads only one nested level, so no amendment to forge-utils was needed. The base watcher did not exist on origin, so it is created here with the issue's names and CLI shape.

### Changes
- bin/lean/issuewatch.mjs: config parse/validate, selectors (milestone/none, labels, exclude_labels, search, title_regex, since, version), lane rule, per-(repo,name) lock and status.json, repo-wide claims registry, caps (`max_issues`, `until`, `max_inflight`) with drain, per-issue and batch modes, `Depends on` ordering, defer-only follow-ups, post-deploy rollup, status, CLI.
- bin/lean/issuewatch.test.mjs: 17 tests.
- bin/forgedock.mjs: `issue-watch` command, KNOWN_COMMANDS entry, help row.
- docs/ISSUE-WATCH.md (new), docs/CONFIG.md (`issue_watch` section).
- devdocs/modules/lean.md: dossier entry (required by scripts/check-devdocs-freshness.sh; amendment add-deliverable).

### Acceptance Criteria Status
- R1 ✅ issuewatch.mjs `watchDir`, `issueWatchFromCli`; R2 ✅ `acquireLock`, `claimIssue`; R3-R9 ✅ `matchesSelectors`, `issueVersion`; R10 ✅ `laneFor`
- R11 ✅ `tick` drain; R12 ✅ `max_inflight`; R13 ✅ `until`; R14 ✅ no-cap path
- R15 ✅ `tick` batch branch + `realIo.batch`; R16, R17 ✅ `classify`, `fold`; R18 ✅ `formatStatus`
- R19-R23 ✅ issuewatch.test.mjs (one test per criterion); R24 ✅ docs/ISSUE-WATCH.md, docs/CONFIG.md
- R25 ❌ deferred (the owner's uncommitted branch is not on origin); it was a `defer` in the contract.

### Verification
- V1 `node --test bin/lean/issuewatch.test.mjs`: 17 pass. Fails without the change (the module does not exist): true.
- V2 batch.test.mjs + lane.test.mjs: 66 pass. router.test.mjs: only `help|unknown command` run (12 pass); the full file exceeded the 10-minute host limit and was killed.
- V3 `node --check` on both files: ok.
- V4 `check-devdocs-freshness.sh origin/staging`: OK.
- `forgedock check`: exit 0. checks.mjs widened to the full suite (fan-out); not run per host rules.

### Notes
- New env var: `FORGEDOCK_WATCH_DIR` (default `~/.forge/watch`).
- Real batch start spawns `orchestrate` and finds the new batch id by diffing the batch root; `mode: batch` settles issues by their closed state. Neither was exercised against a live orchestrate.
- No formatter is configured in the repo.

## Sibling-list follow-up
Checked the 10 flagged tests: none enumerates bin/lean modules; recorded issuewatch under not_members in result.json (no code change).

## Export collision
Renamed issuewatch.mjs export `classify` to `classifyIssue` (decision-engine.mjs already exports `classify`); updated the test and result.json. issuewatch tests pass (17/17).

## CI unit-test fix (run 41100351102)
Log unavailable. The `classify` collision was already fixed in 15796c8. Could not reproduce a failure: `node --test "bin/lean/**/*.test.mjs"` via with-run-tmpdir passes (1626/0). Fixed a real defect found meanwhile: the #4765 dossier entry had been inserted mid-entry in devdocs/modules/lean.md, splitting the #4785/#4788 entry; moved it to the end.

## CI follow-up (Unit tests, node --test)
The CI log was not available. Re-ran the `npm test` globs locally at reduced concurrency: bin/lean + packages/protocol 1780 pass, 1 fail (lean.test.mjs #4690, an idle-kill timing test that passes alone: 6/6); bin/tests + bin/engine + bin/stats 2841 pass, 3 fail, all in bin/tests/journey.test.mjs (WSL platform rows, root-user copyFile, platform detection), a file this branch does not touch. No failure traceable to #4765 was found, so no code change; the earlier classify export collision was already fixed in 15796c8dc.
