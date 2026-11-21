---
status: fresh
anchor: bin/lean/depcache.mjs
created: 2026-11-21
---

# ADR: the dependency cache never walks or removes through a link, and a checkpoint never commits foreign deletions

## Context

On a Windows host a lane's dependency-cache publish failed with `EPERM` while recreating pnpm's
`node_modules/@scope/<pkg>` link (a junction to the workspace package directory; no symlink privilege). The worktree had lost
753 tracked files of the workspace packages (sources, fixtures, migrations). The exit checkpoint ran `git add -A`, committed
the deletions as `wip(forge): checkpoint after exit (needs-human)` and pushed them to the PR branch.

Three gaps let that happen. `depcache.mjs` decided "link or directory" from the dirent type alone and walked (`linkTree`),
chmodded (`readOnly`) and recursively removed (`rmTrees`, the publish tmp dir, pruned snapshots via `fs.rmSync`) without ever
checking where a directory really resolves; a junction that reads as a directory, or a recursive delete that follows one, reaches
the package's own sources. Nothing put tracked files back after a failed publish or materialize. And the checkpoint committed
whatever `git add -A` staged.

## Decision

1. **Containment in `depcache.mjs`.** Every walk asks `linkish()`: the dirent/lstat link type, and on Windows also "the real
   path is not the parent's real path plus the name" (a junction reported as a plain directory). Links are recreated, never
   entered, chmodded or removed through. All recursive removal goes through `safeRm()`: it unlinks links (a junction by
   `rmdir` when `unlink` refuses), and refuses (`EFORGE_PROTECTED`) any directory whose real path is inside the worktree but
   outside every `node_modules`/`.venv`. `rmTrees` only accepts dependency-tree paths. The env library's claim uses the same
   `safeRm` and refuses a manifest whose trees are not dependency trees.
2. **Junction fallback (#5807).** `relink()` retries a symlink that fails with `EPERM` on win32 as a directory junction
   (absolute target, resolved against where the tree finally lives, so a publish's tmp-then-rename keeps it valid) or, for a
   file target, as a hardlink/copy of the file. This keeps the cache usable without the symlink privilege; the cache-empty half
   of #5807 is otherwise out of scope here.
3. **Restore on failure.** After a `failed`, `materialize-fallback` or failed-publish result, `prepare()` lists
   `git ls-files --deleted` at the checkout's top level and checks out every missing tracked file outside dependency trees. The
   result carries `restore: {restored, missing, sample}` (or `{error}`); the lane logs `DEPS_WORKTREE_RESTORED` and an anomaly.
4. **Checkpoint deletion guard (`delguard.mjs`).** After `git add -A`, staged deletions (`diff-index --cached -M`) of files the
   base tracks and the contract's deliverables do not list (exact path or directory prefix; a rename into a deliverable is the
   lane's move; files the lane added itself are its own) are counted. Over `FORGE_CHECKPOINT_MAX_DELETIONS` (default 0) they
   are unstaged and checked out from HEAD, the rest commits locally, nothing is pushed (`gitPush` and `rescuePush` refuse
   from then on), `CHECKPOINT_DELETIONS_REFUSED` is logged, the worktree is kept, and the lane ends `engine-error`
   (`engine.error`) with the evidence, overriding the ending it was on (`TERMINAL_OVERRIDDEN`).

## Rejected

- Copying the trees instead of hardlinking: the hardlink design is what makes the cache cheap, and the copy would still walk
  into the package through a misread junction. Containment fixes the walk itself.
- `git checkout -- .` after a failure: it would also discard modifications. Only missing tracked files are restored.
- A total-deletions threshold that also counts deliverables: a contract that lists its deletions is the authority, so listed
  deletions always commit; the knob only tolerates unlisted ones.
- Guarding every builder commit at push time: builders delete files as part of a change, and the scope gate already judges
  the diff before a merge. The checkpoint is the engine's own blind `git add -A`, so the guard sits there.
