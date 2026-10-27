### Approach
One deterministic module, `bin/lean/milestonesync.mjs`, plus a `forgedock milestone-sync` command; the spec now calls it instead of raw merge+push. No LLM calls.

### Changes
- bin/lean/milestonesync.mjs: `syncMilestone`, `isSyncable`, `isProtectedBranch`, `readSyncDebounce`, `runMilestoneSyncCli`.
- bin/lean/milestonesync.test.mjs: bare-origin git fixture with stub gh (10 tests).
- bin/engine-cli.mjs: thin `milestoneSyncFromCli` export.
- bin/forgedock.mjs: `milestone-sync` dispatch and known-command entry (added by amendment).
- commands/milestone.md: ship Step 2 and Sync action call the command; on-demand and shipped-never rules; conflict note.
- docs/CONFIG.md: `milestones.sync_debounce`; `lean.base_merge_*` also applies to milestone sync.
- devdocs/decisions/4663-milestone-sync.md: ADR.

### Acceptance Criteria Status
- R1 ✅ bin/lean/milestonesync.mjs (protection probe, PR + `--auto`, CLEAN fallback); test "protected branch" and "CLEAN PR".
- R2 ✅ same file (marker, debounce, force-with-lease, `pr edit`); test "fast-moving base".
- R3 ✅ `isSyncable` + refusal in `syncMilestone`; test "never syncs a shipped...". No active-milestone picker exists in this repo, so "never pick as active" is delivered as the exported guard plus the spec rule; external pickers must call it.
- R4 ✅ `reason` required (refused otherwise); spec says on demand only.
- R5 ✅ `resolveBaseConflicts` with `readBaseMerge`; test "append-only registry".
- R6 ✅ bin/lean/milestonesync.test.mjs.

### Verification
- V1 `node --test bin/lean/milestonesync.test.mjs bin/lean/basesync.test.mjs bin/lean/lifecycle.test.mjs`: pass (36). The new tests cover a new module, so they cannot run without the fix.
- V2 `bash scripts/publish-staging-sync.test.sh && bash scripts/check-spec-markers.sh`: pass.
- `forgedock check`: PASS; `bin/tests/engine-cli.test.mjs`: pass (77).

### Notes
New command `forgedock milestone-sync <slug> --reason ship|batch|conflict-risk|manual --repo o/r [--base B]`. New forge.yaml key `milestones.sync_debounce` (default 10m). No formatter is configured in the repo.

## Enumeration follow-up
The ten flagged bin/lean tests (batch, checks, conformance, conformance.e2e, context, execution, execution.e2e, fixround, heavy, lean) hold no list naming sibling modules (conflictres, basesync, lifecycle are absent); recorded `milestonesync` as not_members in result.json.
