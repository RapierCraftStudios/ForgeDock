---
title: "fix(notes): PATCH /notes/:id allows mass-assignment of owner and secret"
labels: ["bug", "security", "priority:P1"]
difficulty: "hard"
---

## Problem

`PATCH /notes/:id` lets any authenticated caller overwrite the `owner` and
`secret` fields alongside `title` and `body`. This is a mass-assignment
vulnerability: a caller can flip `"secret": true` notes to `false`, making them
visible in unauthenticated `GET /notes` responses, or reassign `owner` to
impersonate another user.

Unlike issue #1 (which has no auth check at all), this endpoint does require a
token — the flaw is that it accepts a too-wide field set.

## Steps to Reproduce

```bash
# Flip a secret note to non-secret without knowing its content
curl -s -X PATCH http://localhost:3000/notes/2 \
  -H "Authorization: Bearer demo-token" \
  -H "Content-Type: application/json" \
  -d '{"secret":false}' | jq .
# => note is now visible to unauthenticated callers

# Confirm it is now publicly listed
curl -s http://localhost:3000/notes | jq '[.notes[] | select(.id==2)]'
# => [{...secret note now visible...}]
```

## Affected Files

1. `src/routes/notes.js` — `updateNote()` must restrict the allowed fields to
   `title` and `body` only. Attempts to set `owner` or `secret` should return
   `400 Bad Request` with a message listing the disallowed fields.

## Acceptance Criteria

- [ ] `PATCH /notes/:id` with `{"secret": false}` returns `400 Bad Request`.
- [ ] `PATCH /notes/:id` with `{"owner": "hacker"}` returns `400 Bad Request`.
- [ ] `PATCH /notes/:id` with `{"title": "new"}` still succeeds and updates the title.
- [ ] `PATCH /notes/:id` with both `{"title": "new", "secret": false}` returns `400`.
- [ ] `npm run smoke` still passes.

> This issue covers the **mass-assignment / over-permissive write** pattern — a
> common class of security bugs where an update endpoint accepts more fields than
> it should.
