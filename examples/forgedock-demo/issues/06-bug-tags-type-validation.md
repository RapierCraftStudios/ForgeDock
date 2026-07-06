---
title: "fix(notes): POST /notes stores malformed tags without validation"
labels: ["bug", "priority:P2"]
difficulty: "medium"
---

## Problem

`POST /notes` accepts a `tags` field from the request body but stores it without
checking that it is an array. When a caller passes `"tags": 42` (or any non-array
value), the malformed value is saved to the in-memory store. A subsequent
`GET /notes?tag=work` then throws an uncaught `TypeError: n.tags.includes is not
a function` from the tag-filter in `listNotes()`, returning a 500 response for
all future tag-filtered requests — until the server is restarted.

## Steps to Reproduce

```bash
# 1. Create a note with malformed tags
curl -s -X POST http://localhost:3000/notes \
  -H "Authorization: Bearer demo-token" \
  -H "Content-Type: application/json" \
  -d '{"title":"bad","tags":99}' | jq .

# 2. Any tag-filtered list now 500s
curl -s "http://localhost:3000/notes?tag=work" | jq .
# => {"error":"n.tags.includes is not a function"}
```

## Affected Files

1. `src/routes/notes.js` — `createNote()` must validate that `tags`, when
   supplied, is an array. Return 400 if it is not.

## Acceptance Criteria

- [ ] `POST /notes` with `"tags": 42` returns `400 Bad Request`.
- [ ] `POST /notes` with `"tags": ["work"]` still succeeds (201).
- [ ] `GET /notes?tag=work` works correctly after a valid note with tags is created.
- [ ] `npm run smoke` still passes.

> This issue exercises the **validation gap** pattern — the pipeline should
> add a type check at the write boundary so the read path stays safe.
