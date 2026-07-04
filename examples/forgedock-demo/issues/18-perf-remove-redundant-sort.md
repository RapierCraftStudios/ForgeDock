---
title: "perf(notes): remove unnecessary O(n²) sort before pagination slice"
labels: ["performance", "priority:P3"]
difficulty: "medium"
---

## Problem

`GET /notes?limit=...&offset=...` runs `db.bubbleSortById(results)` before
slicing — an O(n²) bubble sort — even though `results` is already in id order
(the in-memory store is maintained in insertion order and ids are
monotonically increasing). The sort is both redundant and slow.

## Investigation Hint

Trace the insertion order invariant through `db.insert()` and `db.reset()` to
confirm that `notes` is always in id-ascending order. Then verify that
`db.bubbleSortById` does not change the element order for already-sorted input
(it should not — confirm this, don't assume it). Once confirmed, the sort call
is safe to remove.

## Affected Files

1. `src/routes/notes.js` — `listNotes()`: remove the `db.bubbleSortById(results)`
   call in the pagination branch. Slice `results` directly.

## Acceptance Criteria

- [ ] `GET /notes?limit=2` returns the same two notes as before (first two by
  id).
- [ ] `GET /notes?offset=1&limit=1` returns the same note as before.
- [ ] The `db.bubbleSortById` call is no longer present in `listNotes()`.
- [ ] `npm run smoke` still passes.

> This issue showcases the **investigation phase confirming an invariant** —
> the pipeline must verify the insertion-order guarantee before removing the
> sort, rather than blindly deleting it.
