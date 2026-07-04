---
title: "fix(notes): GET /notes/count is vulnerable to expression injection"
labels: ["bug", "security", "priority:P1"]
difficulty: "hard"
---

## Problem

`GET /notes/count` builds its `db.query()` where-clause by concatenating the raw
`?owner=` query parameter into a string: `'owner === "' + owner + '"'`. This is
the same injection class as the `?where=` flaw in issue #2, but in a new
endpoint that issue #2's fix does not cover.

A caller can inject arbitrary JavaScript: `?owner=" || true; //` would evaluate
to `owner === "" || true; //` — matching every note and leaking the real count
regardless of owner.

## Steps to Reproduce

```bash
# Normal count
curl -s "http://localhost:3000/notes/count?owner=alice" | jq .
# => {"count":2}

# Injection — count all notes regardless of owner
curl -s 'http://localhost:3000/notes/count?owner=" || true; //' | jq .
# => {"count":3}  (all notes leaked)
```

## Affected Files

1. `src/routes/notes.js` — `countNotes()` must not build a `db.query()` clause
   via string concatenation. Replace the `db.query()` call with a direct
   `db.all().filter()` using strict equality checks on typed values.

## Acceptance Criteria

- [ ] `GET /notes/count?owner=alice` returns `{"count": 2}`.
- [ ] `GET /notes/count?owner=" || true; //` returns `{"count": 0}` (no match,
  not a leak).
- [ ] `GET /notes/count?secret=true` returns the correct count of secret notes.
- [ ] `GET /notes/count` (no filters) returns the total note count.
- [ ] `npm run smoke` still passes.

> This issue reinforces the pattern from issue #2 — injection through dynamic
> `db.query()` clause building — but in a different endpoint, demonstrating that
> fixing the first occurrence doesn't automatically close the class.
