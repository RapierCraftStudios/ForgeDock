---
title: "perf(db): make findById O(1) instead of a linear scan"
labels: ["performance", "priority:P3"]
---

## Problem

`db.findById(id)` and `db.remove(id)` both do a linear `Array.find` /
`Array.filter` over every note on each call. With the seed data that is fine,
but it is O(n) per lookup and will not scale as the note count grows.

## Investigation Hint

Before optimizing, confirm where the linear scans actually are and whether an
index can stay consistent across `insert`, `remove`, and `reset`. The point of
this issue is to show ForgeDock's **investigation phase** tracing the real hot
path rather than guessing.

## Proposed Solution

Maintain an `id -> note` index (a `Map`) alongside the array so `findById` is
O(1). Keep the index in sync in `insert`, `remove`, and `reset`.

## Affected Files

1. `src/db.js` — add and maintain a `Map` index; use it in `findById`.

## Acceptance Criteria

- [ ] `findById` uses an O(1) Map lookup.
- [ ] The index stays consistent after `insert`, `remove`, and `reset`.
- [ ] `npm run smoke` still passes.

> This issue showcases the **investigation phase** — the agent verifies the
> claim against the code before writing the optimization.
