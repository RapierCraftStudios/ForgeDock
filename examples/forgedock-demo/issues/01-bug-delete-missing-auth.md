---
title: "fix(notes): DELETE /notes/:id is missing an auth check"
labels: ["bug", "security", "priority:P1"]
---

## Problem

`DELETE /notes/:id` lets **anyone** delete any note. The other mutating route
(`POST /notes`) requires a bearer token via `requireToken(req)`, but the delete
handler skips that check entirely. This is an authorization gap.

## Steps to Reproduce

```bash
# No token, yet it succeeds:
curl -X DELETE http://localhost:3000/notes/1
# => {"deleted":1}
```

## Affected Files

1. `src/routes/notes.js` — `deleteNote()` is missing a `requireToken(req)` call.

## Expected Behavior

`DELETE /notes/:id` returns `401 Unauthorized` when no valid bearer token is
supplied, matching the protection on `POST /notes`.

## Acceptance Criteria

- [ ] `deleteNote()` calls `requireToken(req)` before deleting.
- [ ] Unauthenticated delete returns 401.
- [ ] Authenticated delete (`Authorization: Bearer demo-token`) still works.
- [ ] No regression in `npm run smoke`.

> Good first run: this is the simplest issue — expect the pipeline to finish in
> a couple of minutes.
