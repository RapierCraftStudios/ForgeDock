---
title: "feat(notes): add safe filtering for GET /notes"
labels: ["feature", "security", "priority:P2"]
---

## Problem

`GET /notes?where=...` forwards the raw `where` string straight into
`db.query()`, which evaluates it as a JavaScript expression. That is an
injection hole (a caller can pass `?where=true||secret` to leak secret notes).
We want a **safe** way to filter notes instead.

## Proposed Solution

Replace the free-form `?where=` evaluation with explicit, allow-listed query
params:

- `?owner=alice` — exact match on `owner`
- `?secret=false` — match on the `secret` boolean

Build the filter from these typed params in code — never by evaluating a string.

## Affected Files

1. `src/routes/notes.js` — `listNotes()` should read `owner` / `secret` params.
2. `src/db.js` — replace `query(whereClause)` with a structured filter helper
   (e.g. `filter({ owner, secret })`) that does not evaluate strings.

## Acceptance Criteria

- [ ] `GET /notes?owner=alice` returns only alice's notes.
- [ ] `GET /notes?secret=false` returns only non-secret notes.
- [ ] The string-evaluating `db.query()` path is removed.
- [ ] `npm run smoke` still passes.

> This issue exercises the **investigation + architecture** phases — the fix
> touches two files and removes an unsafe code path.
