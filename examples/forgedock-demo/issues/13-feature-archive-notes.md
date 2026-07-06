---
title: "feat(notes): implement archive/soft-delete with ?archived= list filter"
labels: ["feature", "priority:P3"]
difficulty: "hard"
---

## Problem

`DELETE /notes/:id` permanently removes a note. There is no way to soft-delete
(archive) a note and later restore it or filter archived notes out of the default
listing. The `archived` field already exists in the data model but is not
writable or filterable.

## Proposed Solution

1. Add `POST /notes/:id/archive` (protected) — sets `archived: true` on the
   note. Returns the updated note.
2. Add `POST /notes/:id/restore` (protected) — sets `archived: false`.
3. Extend `GET /notes` to support `?archived=true` (list only archived notes),
   `?archived=false` (list only non-archived notes — new default behavior), and
   no `archived` param (list all, preserving today's behavior).

By default (no `?archived=` param) `GET /notes` should still return all notes,
including archived ones, to avoid a breaking change for the existing smoke test.

## Affected Files

1. `src/routes/notes.js` — add `archiveNote()` and `restoreNote()` handlers;
   extend `listNotes()` to apply an `archived` filter when the param is present.
2. `src/server.js` — register the two new routes:
   - `POST /notes/:id/archive`
   - `POST /notes/:id/restore`

## Acceptance Criteria

- [ ] `POST /notes/1/archive` (with token) returns `{"note": {..., "archived": true}}`.
- [ ] `POST /notes/1/restore` (with token) returns `{"note": {..., "archived": false}}`.
- [ ] `GET /notes?archived=false` omits archived notes.
- [ ] `GET /notes?archived=true` returns only archived notes.
- [ ] `GET /notes` (no param) returns all notes regardless of archived status.
- [ ] Both new routes return `401` without a token and `404` for unknown ids.
- [ ] `npm run smoke` still passes.

> A multi-route feature that touches both handler and server wiring. Good for
> testing whether the pipeline correctly sequences route registration and
> confirms no regression on the existing list/create/delete flows.
