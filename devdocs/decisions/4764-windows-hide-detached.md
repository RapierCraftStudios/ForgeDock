# 4764 — detached spawns pass `windowsHide: true`

Node gives a `detached: true` child its own console window on Windows, so each lane and sub-step opened a visible window. Every detached spawn under `bin/` and `scripts/` (including `scripts/ci-local/run.mjs` `exec`) now sets `windowsHide: true`; it is a no-op off Windows and changes no spawn semantics. Non-detached spawns inherit the parent's hidden console and are untouched. `bin/tests/windows-hide.test.mjs` is the guard: it fails on a `detached: true` options object without `windowsHide: true`.
