# 5202: a pushed checkpoint the lane rewrote is merged back, not force-pushed

Context: at the context ceiling the engine commits and pushes `wip(forge): checkpoint after context ceiling`, then restarts a
fresh builder session in the same worktree. In AlterLab #39689 that session ran `git commit --amend` on the checkpoint:
same parent and tree (`9cc66b95df` vs `3d041098b4`), new sha. The final plain push was rejected non-fast-forward, and
`lean.mjs` ended the lane `needs-human` with no code. A manual `--requeue` redid the follow-on work, because the diverged
salvage ref is ignored by `pickSalvage`.

Choice: before every lane-branch push (`gitPush`, and `ciVerify` before it reads the head, #4621),
`checkpoint-reconcile.mjs` merges `origin/<branch>` with `-s ours` when every remote-only commit is a `wip(forge): checkpoint`
that this worktree's reflog holds. The lane's newer tree wins, the checkpoint stays in history, and no force push happens
(same rule as base-sync). The restart and continue prompts tell the builder the checkpoint is pushed and not to rewrite it.
A non-ff rejection that is neither reconcilable nor owned by another lane ends `engine-error` `engine.push_diverged`
(relaunched), never `needs-human`. Permission and protected-branch rejections stay `needs-human`: a relaunch cannot fix
credentials, mirroring `engine.dco_rewrite` vs `ci.dco` (#4997).

Rejected:
- Rebase onto the checkpoint (the issue's suggestion): it can conflict when the builder reworked the hunks, and it rewrites
  the lane's unpushed commits again.
- `--force-with-lease`: it removes the pushed commit from the branch, which breaks the never-force rule.
- Resetting the worktree to `origin/<branch>` on restart: it discards whatever the builder did locally.
- Matching on the subject alone: a checkpoint from another host's lane would be dropped by `-s ours`. The reflog proves this
  worktree held it.
