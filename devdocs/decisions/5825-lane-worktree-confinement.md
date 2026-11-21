---
status: fresh
anchor: bin/lean/laneconfine.mjs
created: 2026-11-21
---

# ADR: lane git calls are confined to the lane worktree

## Context

Lane worktrees live under `<repo>/.claude/worktrees/lean-<N>`, inside the operator's checkout. On Windows, lane folders were left without their `.git` link and were no longer in `git worktree list`. Lanes kept using them. A folder without `.git` is not a repository, so git walked up from it to the operator's checkout. The salvage step (`git add -A` + `write-tree`) and the checkpoint (`git add -A`) then staged the operator's untracked files. The repro harness also ran in a folder that was missing whole tracked directories.

Two engine defects made this possible:

- `leftoverDir` checked registration with an exact `worktree <path>` match. git prints `C:/...` on Windows while the engine holds `C:\...`, so a registered lane worktree never matched. Its files were deleted with `rmSync`, and on Windows a locked file can stop that delete partway (EBUSY), so the folder could stay behind with no `.git` link.
- `salvage()` and every lane git call ran with plain `cwd: wt`, so nothing stopped git from looking in parent folders.

The sparse-checkout writer tested `startsWith("/")` on git's `--git-path` output. On Windows that output is `C:/...`, so the writer joined it under the worktree and created a stray `C` folder there.

## Decision

- `bin/lean/laneconfine.mjs` provides the helpers. `ceilingEnv(wt)` sets `GIT_CEILING_DIRECTORIES` to the worktree's parent, using git's own separator (`;` on win32, `:` elsewhere, never the host's `path.delimiter`). A parent that contains the separator returns null and is refused, so it is never split into fragments. `verifyLaneWorktree` checks three things: a `.git` link exists, `rev-parse --show-toplevel` is the lane folder, and `--git-common-dir` is the repository's. It compares paths in the platform's form and after realpath. `quarantineDir` moves a folder to `<root>/.quarantine/<name>-<ms>`.
- The ceiling applies to every lane git call: the `git` wrapper, salvage, the branch lock probe, the post-merge guard and the fix-round fetch. It also applies to every lane child process through `laneEnv()`: the builder session, checks, red-green, env.setup and mutation runs.
- The engine asserts that the lane is confined (`io.confine.verify`) at these points:
  - at lane start, after the worktree is added or claimed;
  - before every git write through the lane wrapper (add, commit, push, rm, reset, checkout, merge, rebase, ...);
  - at the start of every checkpoint and push.

  A mismatch emits `WORKTREE_NOT_CONFINED` with the toplevel and common dirs git reported and ends the lane `engine-error` with that evidence before any write. Later checkpoints and rescue pushes are skipped.
- Salvage and leftover handling never reuse a bare folder:
  - before salvage, a lane folder that fails verification is quarantined (`WORKTREE_QUARANTINED`), not salvaged with git;
  - an unregistered leftover that `rmdir` cannot fully remove is quarantined as well;
  - a folder that cannot be moved stops the lane `engine-error`.

  The lane then always runs `git worktree add`, and the start assertion proves the new worktree is registered.
- The registration check compares paths in the platform's form (`listedWorktree`). The sparse writer uses `isAbsPath`.

## Alternatives

- Pass `GIT_DIR`/`GIT_WORK_TREE` explicitly. Rejected: it changes how the builder's own git commands and nested repositories behave (submodules, test fixtures that `git init`). The ceiling only stops discovery from going up past the lane folder.
- Move lane worktrees outside the checkout by default. Not done here. gc (`bin/gc.mjs` worktree root and legacy root), warm trees, init-detect and operator docs all assume `<repo>/.claude/worktrees`, and moving the root needs a migration for existing lanes. With the ceiling and the assertions, the location no longer leaks into the checkout. `runCore`'s `worktreeRoot` option remains the single place to change it later.

## Not established

The run log also showed a stray `lean-<N>;C` folder, which looks like a path joined with a `;`-list fragment. No engine path joins the lane folder into a `;` list: PATH builders use `path.delimiter`, and the only hard-coded `:` split (`issuewatch-install.mjs`) is POSIX-only. The two Windows path joins that did create stray folders are fixed above. A ceiling parent that contains the separator is refused, so `GIT_CEILING_DIRECTORIES` can never be the source.
