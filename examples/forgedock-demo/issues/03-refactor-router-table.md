---
title: "refactor(server): extract the router into its own module"
labels: ["refactor", "priority:P3"]
---

## Problem

`src/server.js` mixes three concerns in one file: the route table, request
body parsing, and the HTTP server wiring. As more routes are added this file
will become hard to read and test.

## Proposed Solution

Extract the routing logic into a dedicated `src/router.js` module that exports
a `route(req, res)` function (or a small `Router` object). `server.js` should
shrink to: create the HTTP server, delegate to the router, and listen.

This is a pure refactor — no behavior changes.

## Affected Files

1. `src/server.js` — remove the inline `TABLE` + matching logic.
2. `src/router.js` (NEW) — owns the route table and dispatch.

## Acceptance Criteria

- [ ] Route table and dispatch live in `src/router.js`.
- [ ] `server.js` only creates the server and listens.
- [ ] All endpoints behave exactly as before.
- [ ] `npm run smoke` still passes.

> A clean refactor with zero behavior change — a good way to see how the review
> agents confirm "no regression".
