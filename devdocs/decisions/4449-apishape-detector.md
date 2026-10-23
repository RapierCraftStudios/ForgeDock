---
issue: 4449
status: fresh
anchor: bin/lean/apishape.mjs
created: 2026-10-23
---

# ADR: public-API-shape detector reuses the symbol indexers with an opt-in `--shape` mode

## Context

In the #4442 benchmark, a ForgeDock fix turned more-itertools `ichunked` from a generator function into a plain function. That is an API-shape change, and no gate flagged it. The planned light lane (#4448, #4450) upgrades to the full lane when the public API shape changes, so it needs a deterministic, codebase-agnostic detector. Python and JS/TS are covered first; other languages report `unknown`.

## Choice

- `bin/lean/apishape.mjs` diffs `<base>...<head>` (`git diff -M`) and indexes the base and head blob of each changed source file. It compares public symbols by name: `signature`, `sync-async`, `generator-function`, `renamed` (a vanished public symbol paired with a new one of the same kind and shape) or `removed`.
- The facts come from the existing indexers, `scripts/symbol-index.py` (stdlib `ast`) and `scripts/symbol-index.mjs` (the target repo's `typescript`, else ts-morph's). An opt-in `--shape` flag adds `async`, `generator` and a normalized `sig`. The indexers already encode publicity (`__all__`, underscore, `export`), so the detector does not re-derive it. Default output is byte-identical for refactor:split.
- `sig` keeps parameter kinds, names, annotation text and a `=` marker for defaults, but never default values. Values are behaviour, and the indexers never emit literals.
- Code without an indexer, or a blob the indexer refuses, is `unknown`. Docs, config, data, test files and `.d.ts` are skipped. The light lane always edits tests, and counting docs as `unknown` would make the trigger fire on almost every change.
- The JS/TS tests get TypeScript from the environment (`APISHAPE_TS_NODE_MODULES`). CI requires them using the existing ts-morph install, so no package.json dependency is added.

## Rejected

- A regex/grep detector over the diff: it can't tell a generator from a function or reliably resolve publicity (NORTHSTAR: never put a reasoning problem in a grep, use the repo's own parser).
- Bundling a JS parser, such as the `@babel/parser` that vitepress devDependencies pull in: it reimplements the target's tooling, and it isn't present in the published package.
- Comparing default values: that is behaviour, not shape, and it would emit literals.
- An LLM judgement of API drift: these are structural facts a parser decides, at zero model cost.
