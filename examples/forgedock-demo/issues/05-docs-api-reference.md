---
title: "docs(api): add an API reference for the Notes endpoints"
labels: ["documentation", "priority:P3"]
---

## Problem

The demo API has no endpoint documentation. A newcomer has to read `server.js`
and `routes/notes.js` to learn what routes exist, which ones need a token, and
what they return.

## Proposed Solution

Add `docs/API.md` documenting every endpoint:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | no | Liveness check |
| GET | `/notes` | no | List notes (supports filtering) |
| GET | `/notes/:id` | no | Fetch one note |
| POST | `/notes` | yes | Create a note |
| DELETE | `/notes/:id` | yes | Delete a note |

Include a `curl` example for each and note the `Authorization: Bearer demo-token`
header for protected routes.

## Affected Files

1. `docs/API.md` (NEW) — endpoint reference.
2. `README.md` — link to the new API reference.

## Acceptance Criteria

- [ ] `docs/API.md` documents all 5 endpoints with auth + examples.
- [ ] README links to it.
- [ ] No code changes required.

> This issue proves the pipeline handles **non-code work** — docs-only changes
> still go through investigate → build → review → merge.
