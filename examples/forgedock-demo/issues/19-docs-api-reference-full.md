---
title: "docs(api): add complete API reference covering all endpoints"
labels: ["documentation", "priority:P3"]
difficulty: "easy"
---

## Problem

The demo API now has 9 endpoints (health, list, count, tags, get, create, patch,
delete, and the bulk/archive/restore endpoints added by later issues) but only
the original 5 are described in issue #5's `docs/API.md` — and issue #5 may not
have been run yet. Either way, the current baseline has no `docs/API.md`, or an
incomplete one.

## Proposed Solution

Create (or rewrite) `docs/API.md` documenting all endpoints in the **current
baseline** (i.e. after the source-code changes in this PR land):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | no | Liveness check |
| GET | `/notes` | no | List notes (supports `?where=`, `?tag=`, `?limit=`, `?offset=`) |
| GET | `/notes/count` | no | Count notes (supports `?owner=`, `?secret=`) |
| GET | `/notes/tags` | no | List all unique tags |
| GET | `/notes/:id` | no | Fetch one note |
| POST | `/notes` | yes | Create a note |
| PATCH | `/notes/:id` | yes | Update title/body |
| DELETE | `/notes/:id` | no* | Delete a note |

Include a `curl` example for each endpoint, note the intentional flaws inline
(e.g. `?where=` is injection-vulnerable — see issue #2), and describe the
`Authorization: Bearer demo-token` header.

`*` DELETE is intentionally unprotected — document this as a known flaw (issue #1).

## Affected Files

1. `docs/API.md` (NEW or REWRITE) — full endpoint reference.
2. `README.md` — add a "API reference: docs/API.md" link in the "What's inside"
   section if not already present.

## Acceptance Criteria

- [ ] `docs/API.md` documents all 8 baseline endpoints with method, path, auth
  requirement, description, and a `curl` example.
- [ ] The intentional flaws (injection, missing auth on DELETE) are called out
  inline with references to the corresponding issue numbers.
- [ ] `README.md` links to `docs/API.md`.
- [ ] No code changes required.

> Non-code work that still goes through the full pipeline — investigate the
> current route surface, write accurate docs, review for completeness.
