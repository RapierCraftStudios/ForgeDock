---
issue: 4210
status: fresh
anchor: scripts/symbol-move.py
created: 2026-10-20
---

# ADR: `refactor:split` moves Python symbols with a libcst codemod and leaves an import-only shim

## Context

A `refactor:split` issue (#4196) moves groups of symbols out of a hotspot module. Retyping thousands of lines with an LLM is slow and expensive, and the result cannot be trusted to be identical. The grouping plan `{module:[symbols]}` comes from one LLM call over the symbol index (#4208). The move itself has to be mechanical, and its output has to pass `scripts/refactor-verify.sh` (#4209).

## Decision

`scripts/symbol-move.py --src <file.py> --plan <plan.json> [--package <name>] [--dry-run]` runs no LLM and no network. It moves symbols with libcst:

- **Output.** It writes `<stem>_parts/` (or `--package`) next to `--src`, with an empty `__init__.py` and one `<module>.py` per plan entry. Each module holds:
  1. the source's `from __future__` imports;
  2. the module-level import statements its symbols use, verbatim (relative imports gain one level);
  3. `from .<other> import (...)` for symbols that moved to sibling modules;
  4. each moved statement copied byte-for-byte (`Module.code_for_node`, leading comments included), in source order.
- **Shim.** `--src` keeps every unmoved statement verbatim. At the position of the first moved statement it gains `from <dotted package>.<module> import (...)` re-exports for every moved name, private names included. Every changed line is therefore a moved block or an import line, and every old import path still resolves. This is exactly what `refactor-verify.sh verify` checks.
- **Refusal.** The script prints `{"status":"refused","reason":...}`, exits 3 and touches no file when:
  - libcst is not importable (only the stdlib is imported before that check);
  - the source does not parse;
  - the plan is invalid: an unknown or non-top-level symbol, a symbol listed twice, a statement split across modules, a bad or colliding module name, or an existing package path;
  - a moved symbol needs a name that stays in `--src`;
  - a name is bound by both moved and kept statements;
  - moved code uses module-identity globals (`__name__`, `globals()`, ...);
  - the source has a star import;
  - the new modules would import each other in a cycle.
- **Atomic writes.** Every file is built in memory, written to a temp file and `os.replace`d in, the shim last. On error the temp files and the new package directory are removed.

The test is `scripts/symbol-move.test.sh`, wired in `.github/workflows/check-commands.yml`. That job installs a pinned libcst and sets `SYMBOL_MOVE_REQUIRE_LIBCST=1`, so a missing tool fails the test instead of skipping it. The test does the following:

1. Generates a ~3k-line module plus a unittest suite (`scripts/fixtures/symbol-move/gen_big.py`).
2. Records a `refactor-verify.sh` baseline.
3. Moves four groups and checks that verify is ok, with identical pass/skip counts.
4. Checks the refusal cases, including the no-libcst case, which runs under `python3 -I -S`.

## Rejected

- **LLM retyping.** It is slow, its cost grows with file size, and it is not provably identical.
- **A stdlib line-slicing mover without a CST.** It cannot attach comments to statements or resolve which names a moved symbol uses, so it would guess at imports.
- **Turning the module into a package via `__init__.py`.** It leaves no file at the old path, and the `__init__.py` diff mixes moved code and shim.
- **rope as a second backend.** One CST tool meets both criteria. rope is named only in the refusal reason.

## Known limits

- `mock.patch("pkg.big.f")` no longer affects the globals of moved code. Patch the new module path instead.
- Callers outside the moved module are not rewritten. The shim keeps their imports working.
