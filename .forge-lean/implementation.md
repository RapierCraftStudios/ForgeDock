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
