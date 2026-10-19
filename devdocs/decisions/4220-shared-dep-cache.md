---
issue: 4220
pr: null
commit: null
status: fresh
anchor: bin/lean/depcache.mjs
created: 2026-10-20
---

# ADR: shared dependency installs keyed by lock hash (hardlinked snapshots)

## Context

Every lean lane starts from a bare worktree (`bin/lean/lean.mjs` `worktree add`), so each lane paid a full dependency install and kept its own `node_modules`/`.venv` on disk. That was part of the ≈6-lane host ceiling measured in #4168. Any fix has to be codebase-agnostic (JS: npm/pnpm/yarn; Python: uv/poetry), safe across concurrent lanes, and must never mutate a shared tree in place.

## Decision

The engine runs `bin/lean/depcache.mjs` `prepare` deterministically, right after the worktree exists:

- **Key:** sha256 of the ecosystem, the lockfile, the manifests (root + tracked workspace `package.json`, or `pyproject.toml`/`.python-version`), the runtime version and the platform.
- **Miss:** the repo's own frozen install runs in the lane under a per-key lock (`open wx`; a dead or expired holder is stale). The produced trees are hardlinked into `<eco>-<key>.tmp-<pid>`, made read-only and atomically renamed into place. A lane that loses the race discards its tmp. An existing snapshot is never written to.
- **Hit:** the snapshot is hardlinked into the lane. Files under `.bin/` and venv `bin/` that name the build worktree are copied with the path rewritten, and absolute symlinks are rewritten. The repo's warm repair install then runs (pnpm `--offline`, `uv sync --frozen`, `poetry install --sync`), which reinstalls the editable project for this lane. npm and yarn get no repair pass: their trees hold only relative links, and npm rewrites its hidden lockfile in place, which the read-only snapshot refuses.
- **Read-only:** shared inodes are read-only, so an in-place write from any lane fails with EACCES instead of corrupting the cache. A lane that changes its lockfile gets a new key. The builder prompt says to `rm -rf` the tree before reinstalling.
- **Shared stores:** pnpm store, npm, uv, poetry and pip caches are exported to every runner call.
- **Pruning:** `forgedock gc` prunes snapshots unused for 7 days (under their lock), dead publishers' tmp dirs and dead locks.
- **Failure:** a missing tool, EXDEV, a timeout or a failed install falls back to the old behaviour and never fails the run. `FORGE_DEPCACHE=0` opts out.

## Rejected options

- **Symlink one shared `node_modules`/`.venv` into every lane.** Lanes would install into, and mutate, the shared tree.
- **Reflink or full copy.** Reflinks are not portable (ext4 has none), and a full copy costs the disk this issue is meant to save.
- **Package-manager stores alone.** Warm pnpm/uv installs are not ≈ 0 on large monorepos, and npm/poetry have no hardlinking store.
- **A shared deps-only venv plus a `.pth` overlay.** `uv sync`/`poetry install` would not see the overlay and would reinstall everything.

## Consequences

- Cold lanes pay one install, as before, plus a hardlink walk. Warm lanes pay a hardlink walk plus a no-op repair.
- Disk per extra lane drops to directory entries and copied bin scripts.
- The cache must be on the same filesystem as the worktrees. Otherwise it is skipped (EXDEV).
- `scripts/check-devdocs-freshness.sh` now defaults `<base-ref>` to the branch's upstream (`@{upstream}`) when it is omitted, so a lane can run the check as written in its contract. CI still passes `origin/<base>` explicitly. With no ref and no upstream it still exits 2.
