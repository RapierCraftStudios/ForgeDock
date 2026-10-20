---
issue: 4212
status: fresh
anchor: scripts/symbol-move.mjs
created: 2026-10-20
---

# ADR: `refactor:split` moves TypeScript symbols with a ts-morph codemod and leaves a re-export barrel

## Context

The `refactor:split` lane (#4211) refused every target that was not `.py`. #4196 asks for TypeScript behind the same mover interface as the libcst mover (#4210). `scripts/symbol-index.mjs` (#4208) already indexes TS, and `scripts/refactor-verify.sh` (#4209) already baselines and verifies JS/TS. Only the mover was missing.

## Decision

`scripts/symbol-move.mjs --src <file.ts> --plan <plan.json> [--package <name>] [--extend] [--dry-run]` mirrors `symbol-move.py`: the same plan, one JSON line (`ok` / `refused`), exit 0/2/3. `--probe` only checks that ts-morph resolves.

- **No FD dependency.** ts-morph is resolved from the `--src` directory, then the cwd. `NODE_PATH` is honoured, the same pattern as `typescript` in `symbol-index.mjs`. `symbol-index.mjs` also falls back to the TypeScript bundled with ts-morph, so a repo that has only ts-morph can still be indexed and verified. Without ts-morph, the lane's probe returns `split.unsupported` `no codemod tool for ts: ...` before the grouping call or any edit.
- **Output.** It writes `<stem>_parts/<module><ext>` next to `--src`. Each module holds:
  1. the source's import declarations that its symbols use, pruned to the used bindings, with relative specifiers re-based to the package dir;
  2. `import { ... } from "./<sibling>"` for symbols moved to sibling modules, with `type` on interface and type-alias names (Node type stripping and `verbatimModuleSyntax` need it);
  3. the moved statements copied from the source text byte-for-byte, with leading comments and `export` keywords, in source order. ts-morph parses the source and resolves the references (type checker over the in-memory file), but never re-prints them.
- **Barrel.** `--src` keeps every unmoved statement verbatim. At the first moved statement it gains `export { ... } from "./<pkg>/<module>"` for the moved names that were exported, and `import { ... } from ...` for the moved names that kept code still uses. New specifiers follow the extension style of the source's relative imports (`.ts`, `.js` or none). If the source has no relative import, they use the source's own extension.
- **Refusals.** The mover exits 3 and touches no file when:
  - the plan is invalid (unknown or non-top-level symbol, a duplicate, a split statement, a bad or case-colliding module name, an existing package or module file);
  - a moved symbol needs a name declared in `--src` that stays;
  - a moved symbol is not exported but kept code or another new module uses it;
  - a moved statement is an `export default`;
  - moved code uses module identity (`import.meta`, `__dirname`, `__filename`, a relative `require()` or `import()`);
  - the new modules would import each other in a cycle.

  The non-exported refusal exists because adding `export` changes the declaration line, and a bare `export { x };` line is a logic line for `refactor-verify.sh`. Both would fail the proof.
- **Verify of erased types.** Interfaces and type aliases do not exist at runtime, so `refactor-verify.sh`'s `node import()` check could never resolve them, not even on an unchanged file. The baseline now flags them `"type": true`, and verify resolves them statically: the old module still declares them, lists them in `export { }`, or re-exports them with `export ... from` (following `export * from` relative modules).
- **CI.** `check-commands.yml` installs a pinned `ts-morph@28.0.0` into `$RUNNER_TEMP` and runs `scripts/symbol-move-ts.test.sh` with `SYMBOL_MOVE_REQUIRE_TS_MORPH=1`, so a missing tool fails instead of skipping.

## Rejected

- **ts-morph as an FD npm dependency.** FD ships no runtime dependencies, and the target repo is the one that owns its TypeScript toolchain.
- **ts-morph's `moveToDirectory` / re-printing.** The printer reformats code, so `git diff --color-moved` would see logic lines.
- **Exporting moved private helpers.** It changes the declaration, and the move would no longer be provable as location-only.
- **Rewriting external callers.** The barrel keeps every old import path working, the same choice as the Python shim.

## Known limits

- JS (`.js/.mjs/.cjs`) and Go targets are still refused with `no codemod tool for <lang>`.
- `export default` declarations do not move.
- Barrel `import` lines that a later chain step leaves unused are not removed.
