---
issue: 4221
pr: null
commit: null
status: fresh
anchor: bin/lean/worktree.mjs
created: 2026-10-20
---

# ADR: sparse lane worktrees by blob size

## Context

Every lean lane was a full `git worktree add` (`bin/lean/lean.mjs`). On the AlterLab host 34 worktrees took 13 GB. Measured there on 2026-10-20: the tracked tree is 311 MB across 6428 files, 207 MB of it in 107 blobs >= 1 MiB (versioned OpenAPI JSON, screenshots, PDFs), and lane dirs were 331-365 MB, almost all checkout. The #4220 hardlinked dependency cache already covers the `node_modules`/`.venv` share of per-lane disk. Target: < 300 MB per additional lane, codebase-agnostic.

## Decision

`bin/lean/worktree.mjs` `addLaneWorktree` reads `git ls-tree -r -l -z <ref>` and leaves out regular blobs >= forge.yaml `env.sparse_max_kb` (default 1024 KB; 0 = off). Lockfiles, manifests, toolchain pins, `tsconfig*.json`, `forge.yaml`, `.gitattributes` and `.gitignore` are always kept (the dep cache and toolchain pins read them). The worktree is added with `--no-checkout`, `sparse-checkout set --no-cone` turns sparse on for that worktree only, the non-cone patterns (`/*`, `!/<escaped path>`) are written to the worktree's own `info/sparse-checkout` (no argv limit), and `read-tree -mu HEAD` materializes it. AlterLab drops to about 104 MB of checkout per lane.

- A repo with no such blob gets today's exact `git worktree add` argv.
- A failed sparse step runs `sparse-checkout disable` + a full `read-tree`: an anomaly, never a lane failure.
- Absent files carry skip-worktree, so `git add -A` (salvage, checkpoint, builder commits) never stages them as deletions. A file written at that path shows as modified, and `git sparse-checkout add /<path>` brings one back. The builder prompt says so.
- Side effect: git sets `extensions.worktreeConfig=true` in the shared repo config. `core.sparseCheckout` lives in `.git/worktrees/<wt>/config.worktree`, so the main checkout is unchanged.

## Rejected options

- **Reflink / copy-on-write clones of a warm tree.** The host is ext4.
- **Hardlinked source files across lanes.** The builder edits files in place, so one lane would corrupt the others.
- **Cone mode from the contract's paths.** The worktree exists before the contract does, and the builder reads widely.
- **Warm worktree reuse per base commit (deferred, #4221 R2).** It does not lower disk per lane, only checkout time. It needs a park/adopt lifecycle in the #4179 teardown that is safe against #4118/#4162, and the dep cache skips a tree whose `node_modules` already exists.
