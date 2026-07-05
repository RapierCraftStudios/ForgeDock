---
title: "refactor(notes): extract title validation into a shared validate.js module"
labels: ["refactor", "priority:P3"]
difficulty: "easy"
---

## Problem

`createNote()` in `src/routes/notes.js` has an inline `if (!title)` guard. When
the bulk-create endpoint (issue #12) is added, the same check will need to be
duplicated. Any future handler that creates or modifies a note title will face
the same duplication.

This is a pure refactor — no behavior change, no new validation rules.

## Proposed Solution

Extract the title-presence check into a new `src/validate.js` module that
exports a single function: `validateNote({ title })`. The function throws a
`400`-status error if `title` is falsy, identical to the current inline guard.
`createNote()` (and, if issue #12 is already merged, `bulkCreateNotes()`) should
call `validateNote()` instead of the inline check.

## Affected Files

1. `src/validate.js` (NEW) — exports `validateNote({ title })`.
2. `src/routes/notes.js` — replace the inline `if (!title)` block with
   `validateNote({ title })` imported from `../validate`.

## Acceptance Criteria

- [ ] `POST /notes` without a `title` still returns `400` with the same error
  message as before.
- [ ] `src/routes/notes.js` no longer contains a bare `if (!title)` guard —
  that logic lives only in `src/validate.js`.
- [ ] `npm run smoke` still passes.
- [ ] No behavior change in any endpoint.

> A zero-behavior-change refactor. The review agents should confirm that the
> 400 path, the error message, and all other responses are byte-for-byte
> identical to the pre-refactor baseline.
