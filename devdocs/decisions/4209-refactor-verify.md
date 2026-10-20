---
issue: 4209
status: fresh
anchor: scripts/refactor-verify.sh
created: 2026-10-20
---

# ADR: `refactor:split` is proved a pure move by a deterministic baseline-vs-after script, not by review

## Context

A `refactor:split` issue (#4196) must only move code. Review by an LLM cannot reliably tell a move from a behaviour change, and a green test suite alone does not catch a dropped export or a new import cycle.

## Decision

`scripts/refactor-verify.sh` runs no LLM and no network, and never modifies the target repo, its index or its worktree. It has two modes:

- **`baseline`** runs before the refactor. It runs `--test-cmd` via `bash -c` in `--root` and parses passed/skipped counts (pytest, unittest, node TAP/spec, jest/vitest; several summaries are summed). It indexes `--target` with `scripts/symbol-index.py` (`.py`) or `scripts/symbol-index.mjs`, records every public symbol as `{module,name}`, and records the package's import cycles. It writes one key-sorted JSON file.
- **`verify`** runs with the worktree at `--head` (default `HEAD`). It prints key-sorted JSON `{ok,failures}` and exits 0 when ok, 1 on failures, 2 on usage or environment errors. Failure kinds:
  - `logic-diff`: an added or removed line in `git diff --color-moved=plain --no-renames <base> <head>` that is not moved, not blank and not an import line.
  - `missing-symbol`: a baseline public symbol that no longer resolves from its old module path. Resolution happens at runtime (Python `importlib` + `getattr`, JS/TS `import()`), so re-export shims and a module turned into a package still pass.
  - `count-changed`: passed or skipped changed, or the test exit went from 0 to non-zero.
  - `new-cycle`: an import cycle that is not in the baseline.

Its test is `scripts/refactor-verify.test.sh`, wired in `.github/workflows/check-commands.yml`.

## Rejected

- **Asking a reviewer to confirm "only moved":** not deterministic, and it adds a review phase.
- **Test counts alone:** they miss dropped re-exports and new cycles.
- **Static symbol comparison by file path:** it fails when a module becomes a package or leaves a shim behind.
