---
title: "perf(notes): replace O(n²) tag de-duplication in listTags with a Set"
labels: ["performance", "priority:P3"]
difficulty: "easy"
---

## Problem

`GET /notes/tags` de-duplicates tags using a nested loop: for every tag in every
note it scans the entire `unique` array to check for a duplicate. This is O(n²)
on the total tag count. With a large corpus of notes and many tags, this becomes
slow.

The fix is a one-line change to use a `Set` for deduplication instead.

## Investigation Hint

Before optimizing, confirm where the nested loop is and calculate the actual
time complexity. Verify that the `Set`-based replacement produces the same
output (same tags, same order — first-seen wins, matching the current
behavior).

## Affected Files

1. `src/routes/notes.js` — `listTags()`: replace the nested-loop uniqueness
   check with a `Set`.

## Acceptance Criteria

- [ ] `GET /notes/tags` returns the same tags in first-seen order as before.
- [ ] The nested loop in `listTags()` is removed.
- [ ] `npm run smoke` still passes.

> A focused, single-function perf fix. The pipeline should confirm output
> equivalence before and after the change, not just that the test passes.
