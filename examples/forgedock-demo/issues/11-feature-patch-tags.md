---
title: "feat(notes): allow PATCH /notes/:id to update tags"
labels: ["feature", "priority:P3"]
difficulty: "medium"
---

## Problem

`PATCH /notes/:id` currently only updates `title` and `body` (after the fix from
issue #8). There is no way to add or replace tags on an existing note without
deleting and recreating it.

## Proposed Solution

Extend `PATCH /notes/:id` to accept an optional `tags` field. The value must be
an array of strings (validate at write time, same fix pattern as issue #6).
When supplied, it replaces the note's existing `tags` array entirely — a full
replacement (not a merge/append), keeping the semantics simple.

## Affected Files

1. `src/routes/notes.js` — `updateNote()` should accept `tags` in addition to
   `title` and `body`. Validate that `tags` is an array when present; return
   `400` if it is not.

## Acceptance Criteria

- [ ] `PATCH /notes/:id` with `{"tags": ["work", "urgent"]}` replaces the note's
  tags and returns the updated note.
- [ ] `PATCH /notes/:id` with `{"tags": 99}` returns `400 Bad Request`.
- [ ] Omitting `tags` from the patch body leaves existing tags unchanged.
- [ ] `GET /notes?tag=urgent` returns the patched note after its tags are updated.
- [ ] `npm run smoke` still passes.

> This feature has a deliberate dependency on issue #8 being fixed first — tags
> must not be writable via mass-assignment before they are intentionally writable
> via a validated field. Run issue #8 before this one.
