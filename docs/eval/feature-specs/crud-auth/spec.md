# Notes service with accounts

Build a small in-memory notes service in plain Node (ESM, no dependencies, no network).

Write `app.mjs` in the repository root exporting `createApp()`, which returns `{ handle(req) }`. `handle` takes
`{ method, path, headers, body }` (body is an object or undefined) and resolves to `{ status, body }`.

Endpoints:
- `POST /register` with `{ username, password }`: 201, or 409 when the username exists, or 400 when a field is missing.
- `POST /login` with `{ username, password }`: 200 with `{ token }`, or 401 on bad credentials.
- `POST /notes` with `{ text }`: needs header `authorization: Bearer <token>`; 201 with `{ id, text }`; 401 without a valid token.
- `GET /notes`: the caller's own notes only, 200 with an array.
- `PUT /notes/:id` with `{ text }` and `DELETE /notes/:id`: 200 on the caller's note, 404 on anyone else's or an unknown id.

Passwords must not be stored or returned in clear text. Add a `README.md` saying how to run it.
