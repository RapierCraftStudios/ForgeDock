---
title: "feat(notes): add POST /notes/bulk for all-or-nothing batch creation"
labels: ["feature", "priority:P3"]
difficulty: "hard"
---

## Problem

Creating multiple notes requires a separate `POST /notes` call per note.
For loading test fixtures or seeding data, callers want to create several notes
in one request, with the guarantee that either all are created or none are
(all-or-nothing semantics).

## Proposed Solution

Add `POST /notes/bulk` (protected) that accepts `{ "notes": [...] }` where each
item has the same shape as the single-note `POST /notes` body. The endpoint
must:

1. Validate that the top-level `notes` field is a non-empty array.
2. Validate that every item has a non-empty `title`.
3. Only insert any notes if all items are valid (all-or-nothing).
4. Return `{ "notes": [...created notes] }` with status 201 on success.

## Affected Files

1. `src/routes/notes.js` — add a new `bulkCreateNotes()` handler.
2. `src/server.js` — register `POST /notes/bulk` in the route table **before**
   the existing `POST /notes` entry so the literal path match takes priority.

## Acceptance Criteria

- [ ] `POST /notes/bulk` with a valid array creates all notes and returns 201.
- [ ] If any note is missing `title`, returns `400` and no notes are created.
- [ ] `POST /notes/bulk` without a token returns `401`.
- [ ] `POST /notes/bulk` with `{"notes": []}` returns `400`.
- [ ] `GET /notes` after a successful bulk create shows the new notes.
- [ ] `npm run smoke` still passes.

> This feature requires careful thought about route ordering (the `/bulk`
> literal path must not be shadowed by `POST /notes$`) and about transaction
> semantics in the in-memory store.
