---
issue: 4663
status: fresh
anchor: bin/lean/milestonesync.mjs
created: 2026-10-27
---

# Decision: milestone sync is a deterministic command with one debounced sync PR

## Context

`/milestone ship` Step 2 and `/milestone sync` pushed straight to `milestone/{slug}`: that fails under rulesets, wrappers then opened a sync PR per base move (full CI each time), shipped milestones kept getting synced, and append-only registries conflicted on every sync.

## Choice

- **Command:** `forgedock milestone-sync <slug> --reason ship|batch|conflict-risk|manual` (`bin/lean/milestonesync.mjs`). Sync is on demand; a call without a reason is refused.
- **Lifecycle guard:** `isSyncable` refuses a closed milestone or one whose FORGE:LIFECYCLE state is past `building` (#4657). Callers that pick an "active" milestone use the same helper.
- **Protected branch:** branch protection or a ruleset (or a push the rules reject) selects the PR path: ONE `sync/milestone-{slug}` PR, head force-pushed with lease, body marker FORGE:MILESTONE-SYNC (base sha + time). Same base => `unchanged`; inside `milestones.sync_debounce` (default 10m) => `debounced`; `ship` is never debounced. Auto-merge is armed, a CLEAN PR is merged directly (as the #4357 version back-sync).
- **Conflicts:** `resolveBaseConflicts` with `lean.base_merge_*` (#4588); anything else aborts the merge and is reported.

## Rejected

- **Close and reopen the sync PR per base move.** Re-runs required CI each time.
- **An LLM to resolve registry conflicts.** Globs carry the fact (NORTHSTAR: deterministic first).

## Cost

0 LLM calls. A sync is a handful of git commands and at most four gh calls; a debounced or unchanged call pushes nothing and starts no CI.
