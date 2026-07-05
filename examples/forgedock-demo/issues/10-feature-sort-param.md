---
title: "feat(notes): add ?sort= parameter to GET /notes"
labels: ["feature", "priority:P3"]
difficulty: "easy"
---

## Problem

`GET /notes` always returns notes in insertion order. There is no way for a
caller to request notes sorted by `title` or `createdAt` without fetching all
notes and sorting client-side.

## Proposed Solution

Add a `?sort=` query parameter to `GET /notes` that accepts:

- `sort=id` — sort by numeric id ascending (current default behavior)
- `sort=title` — sort alphabetically by `title`
- `sort=createdAt` — sort by `createdAt` string (ISO 8601, lexicographic sort
  is equivalent to chronological for the demo's fixed-format timestamps)

An unknown `sort` value should return `400 Bad Request`.

## Affected Files

1. `src/routes/notes.js` — extend `listNotes()` to read a `sort` query param
   and apply the appropriate comparison before returning the results array.

## Acceptance Criteria

- [ ] `GET /notes?sort=title` returns notes sorted alphabetically by title.
- [ ] `GET /notes?sort=createdAt` returns notes sorted oldest-first.
- [ ] `GET /notes?sort=id` returns notes in id order (same as current default).
- [ ] `GET /notes?sort=unknown` returns `400 Bad Request`.
- [ ] `GET /notes` (no sort param) still returns notes in insertion order.
- [ ] `npm run smoke` still passes.

> A focused, additive feature — the pipeline should confirm no existing
> behavior changes and that the 400 guard is present.
