---
title: "fix(notes): negative ?offset= returns wrong notes instead of 400"
labels: ["bug", "priority:P2"]
difficulty: "medium"
---

## Problem

`GET /notes?offset=-1` silently applies JavaScript's negative-index slice
semantics (`Array.prototype.slice(-1)` returns the last element) instead of
returning a client error. A caller expecting an empty or 400 response receives
the final note in the list, which is confusing and incorrect.

## Steps to Reproduce

```bash
# List all notes first
curl -s http://localhost:3000/notes | jq '.notes | length'
# => 3

# Negative offset returns the last note — unexpected
curl -s "http://localhost:3000/notes?offset=-1" | jq '.notes'
# => [{...note 3...}]

# Expected: 400 Bad Request or normalized to 0
```

## Affected Files

1. `src/routes/notes.js` — `listNotes()` must clamp `offset` to a non-negative
   integer (reject with 400, or normalize to 0) before passing it to
   `Array.prototype.slice`.

## Acceptance Criteria

- [ ] `GET /notes?offset=-1` returns `400 Bad Request` with a clear error message.
- [ ] `GET /notes?offset=0` still returns all notes.
- [ ] `GET /notes?offset=1&limit=2` returns notes starting from index 1.
- [ ] `npm run smoke` still passes.

> This issue demonstrates that **numeric input validation** is a separate concern
> from type validation — the value is a number but falls outside the accepted range.
