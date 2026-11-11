forge-stamp: issue=5421 contract=-
**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: medium (host disk fills to 100%, lanes then fail; no data loss)
**Task Type**: feature

### What Was Claimed
GC only runs inside `/orchestrate` (preflight, and pre-admission when `nearCeiling` sees CPU/mem/tmp pressure). Nothing runs between batches, disk pressure never triggers it, and several ForgeDock-made leftovers are not "owned" so gc only reports them: `~/.forge/tmp` scratch, lane compose volumes, legacy `.forge/worktrees/*` dirs.

### What We Found
- `bin/engine-cli.mjs:1974-2008`: gc runs only in `runGcPhase("preflight")` and `beforeAdmit`; `beforeAdmit` triggers only on `nearCeiling` or `gcPending`. No scheduler anywhere (`scripts/systemd/` holds only the bot-token timer; `git ls-files | grep -i timer`).
- `bin/lean/admission.mjs:64-78`: `nearCeiling` checks load, mem and free MB of `host.tmpPaths()`. Nothing for the worktree-root filesystem or `~/.forge`; no `min_free_gb`. `ADMISSION_DEFAULTS` (line 9) has only `min_free_tmp_mb`.
- `bin/lean/effects.mjs:220-241`: `makeHostProbe().freeMb(p)` already exists (statfs); `tmpPaths` includes `~/.forge/tmp`, but not the worktree root. The probe is injectable, matching the issue's test requirement.
- `bin/gc.mjs:33`: `WORKTREE_DIR_RE = /^(lean|agent)-/`; `bin/gc.mjs:105-110` `worktreeRoot` is only `<cwd>/.claude/worktrees`, so `<repo>/.forge/worktrees/*` is never scanned.
- `bin/gc.mjs:370-410`: tmp scope only owns dirs with `.forge-run-owner` and `<repoKey>/<issue>` scratch; other entries are reported. `makeRunTmp().make` (`bin/lean/effects.mjs:168-174`) writes the marker only under `~/.forge/tmp/runs`. A grep of `bin/` and `scripts/` found no code that creates `wt-*`, `stg*`, `text-*`, `zero-*` in `~/.forge/tmp`; the creator (probably a shell/runtime `TMPDIR`) must be located before marking them.
- Docker volumes: `bin/gc.mjs:300-306` owns only `forgedock.owner=1` labels. Lanes get `FORGE_DOCKER_LABELS` (`bin/lean/lean.mjs:741`), but only a prompt line (`bin/lean/prompts.mjs:257`) asks for compose labels; compose-created volumes carry `com.docker.compose.project` only.
- `bin/gc.mjs:59-76`: `HYGIENE_DEFAULTS`/`readHygiene` have no `schedule` or `min_free_gb`. `hygieneCheck` (`bin/gc.mjs:595`) and doctor Check 13 (`bin/forgedock.mjs:3319-3337`) have no free-disk input.
- `bin/forgedock.mjs:1087` `initFlow` and doctor `--fix` install no timer.

### Root Cause
GC was designed as a batch-scoped hook keyed on CPU/mem pressure (ADR `devdocs/decisions/4180-gc-reaper.md`). It has no standalone trigger and no disk signal, and the ownership model recognises only labels, ledgers and `lean-|agent-` names, so ForgeDock's own scratch, compose volumes and legacy dirs are conservatively reported forever.

### Affected Files
`bin/gc.mjs`, `bin/lean/admission.mjs`, `bin/lean/effects.mjs`, `bin/engine-cli.mjs`, `bin/forgedock.mjs`, new `bin/gc-schedule.mjs`, `bin/lean/lean.mjs` (compose project env), `bin/lean/prompts.mjs`, `docs/CONFIG.md`, `devdocs/decisions/4180-gc-reaper.md`, `devdocs/modules/lean.md`; tests `bin/tests/gc.test.mjs`, `bin/lean/lean.test.mjs`, new `bin/tests/gc-schedule.test.mjs`.

### Sibling Sweep
`makeHeavyIo` (`bin/lean/heavy.mjs`, wired at `effects.mjs:329`) gates heavy steps by CPU/mem; it is the place for the free-disk refusal of image builds. `scripts/ci-local/run.mjs:120` already labels its docker resources. Production ingress and `topology.prod_parity` are not touched (no routes added).

### History
Introduced by #4180 (reaper) and #4183 (auto mode, `nearCeiling`); #4361 added budget; #4962 scoped doctor stale. No prior fix for scheduling or disk pressure (#4156 is the parent epic).

### Recommendation
Implement in one lane (about 12 files, well under the split size). Add `hygiene.schedule` and `hygiene.min_free_gb`; a disk probe in `nearCeiling` and a heavy-step refusal; a timer installer (systemd user timer, cron fallback) called by doctor `--fix` and init; marker for scratch ForgeDock creates; compose project naming `forgedock-lane-<n>` so volumes are owned by name (never unlabelled foreign ones); legacy `.forge/worktrees` scanned, reclaim only when clean, pushed and unregistered-or-stale. Marker-less `wt-*`-style tmp entries stay report-only unless the build finds the creator and can mark it.

### Related Issues
#4156, #4180, #4183, #4361, #4962.
