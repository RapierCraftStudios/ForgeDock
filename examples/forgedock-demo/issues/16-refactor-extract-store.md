---
title: "refactor(db): extract the generic array-store machinery into store.js"
labels: ["refactor", "priority:P3"]
difficulty: "hard"
---

## Problem

`src/db.js` conflates two things: the generic in-memory array/index operations
(`all`, `findById`, `insert`, `remove`, `reset`) and the Notes-specific seed
data and field defaults. If a second resource (e.g. users) were added, all of
that generic machinery would need to be duplicated.

This is a pure refactor — no behavior change, no new features.

## Proposed Solution

Extract the generic store machinery into `src/store.js`, exporting a factory
function `createStore(seed, defaults)`. The returned object exposes:
`all`, `findById`, `insert`, `remove`, `reset`.

`src/db.js` becomes a thin wrapper: it calls `createStore(SEED, { secret:
false, tags: [], archived: false })` and re-exports the resulting methods plus
`query` and `bubbleSortById` (which remain in `db.js` as Notes-specific logic).

The public API visible to `routes/notes.js` must be byte-for-byte compatible.

## Affected Files

1. `src/store.js` (NEW) — generic `createStore(seed, defaults)` factory.
2. `src/db.js` — delegates `all`/`findById`/`insert`/`remove`/`reset` to the
   store instance; keeps `query`/`bubbleSortById`.

## Acceptance Criteria

- [ ] `db.all()`, `db.findById()`, `db.insert()`, `db.remove()`, `db.reset()`
  all behave identically to today.
- [ ] `db.query()` and `db.bubbleSortById()` are unchanged.
- [ ] No code in `src/routes/notes.js` or `src/server.js` changes.
- [ ] `npm run smoke` still passes.
- [ ] No behavior change in any endpoint.

> A structural refactor that introduces an abstraction boundary — the review
> agents should verify that the public interface is preserved exactly and that
> no observable behavior changes.
