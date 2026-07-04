---
title: "refactor(server): centralize auth enforcement with a protected flag in the route table"
labels: ["refactor", "priority:P3"]
difficulty: "medium"
---

## Problem

Authorization (`requireToken`) is enforced by each route handler individually.
As routes grow, there is no single place to see which routes are protected — a
reviewer must read every handler. Missing a `requireToken` call in a new handler
is exactly how issue #1's bug was introduced.

## Proposed Solution

Add a boolean `protected` flag as the fourth element of each route-table entry
in `src/server.js`. The server's request dispatch loop should call
`requireToken(req)` centrally, before the handler is invoked, whenever the flag
is `true`. Handlers that currently call `requireToken()` themselves should have
that call removed (it is now redundant).

This is a pure refactor — every endpoint's authorization behavior must remain
identical.

## Affected Files

1. `src/server.js` — add `protected: true/false` to each TABLE entry; call
   `requireToken(req)` in the dispatch loop when the flag is set.
2. `src/routes/notes.js` — remove all `requireToken(req)` calls from handlers
   that will be protected by the table flag instead.

## Acceptance Criteria

- [ ] `POST /notes` without a token still returns `401`.
- [ ] `PATCH /notes/:id` without a token still returns `401`.
- [ ] `DELETE /notes/:id` still returns its current response (intentionally
  unprotected in the baseline — issue #1 is not yet fixed).
- [ ] No `requireToken(req)` call remains inside any route handler.
- [ ] `npm run smoke` still passes.
- [ ] No behavior change in any endpoint.

> This refactor makes the authorization surface visible at a glance —
> a pattern that directly prevents the class of bug introduced in issue #1.
