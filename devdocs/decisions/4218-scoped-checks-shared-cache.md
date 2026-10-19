---
issue: 4218
status: fresh
anchor: bin/lean/checks.mjs
created: 2026-10-20
---

# ADR: lane checks are scoped to the change and share a write-once cache

## Context

A lane's builder ran the repo's full typecheck, lint and test scripts, and every lane warmed its own tsc and eslint caches. With several lanes on one host that repeated the same work (#4218).

## Decision

`bin/lean/checks.mjs` discovers the repo's checks and scopes each one to the lane's changed files:

- **Discovery:** turbo task, then workspace package scripts, then root script. Python uses `pytest` and `ruff check` through `uv run` or `poetry run`. Only declared workspace packages are discovered, and system binaries skip the package-manager exec prefix.
- **Scoping:** ci-local's `scopeCommand` narrows each command. `scripts/ci-local/scoping.mjs` gained a `tsc` selector (`scopeTsc`, `tsProjectOf`): the nearest owning `tsconfig.json` of the changed and referencing files gives `tsc -p <project>`, several composite or referenced projects give `tsc -b`. The root project, several non-composite projects and any widening trigger (lockfile, tsconfig, CI config) run in full. Unknown impact never narrows.
- **Cache key and location:** the shared entry is `~/.forge/verify-cache/<sha256(git common dir)>/<merge-base sha>/`. It is copied into the worktree's `node_modules/.cache/forge-verify/` (hydrate). tsc runs with `--incremental --tsBuildInfoFile` and eslint with `--cache --cache-strategy content --cache-location` there.
- **Publish rule:** `--publish` creates the shared entry only when absent: a tmp dir, then rename, so the first writer wins. A published entry is never modified.

`HOST_RULES` in `prompts.mjs` tells the builder to run `checks.mjs` output instead of the full scripts.

## Rejected

- **Narrowing on unknown impact:** a lockfile, tsconfig or CI-config change can affect any project, so these widen to the full run.
- **Overwriting the shared entry:** concurrent lanes would race and a half-written cache would poison later runs.
