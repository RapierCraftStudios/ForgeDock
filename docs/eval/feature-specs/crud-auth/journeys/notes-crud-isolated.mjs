// Hidden oracle: a user creates, edits and deletes a note, and a second user cannot see or touch it.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { createApp } = await import(pathToFileURL(join(process.env.BENCH_APP, "app.mjs")).href);
const app = createApp();
const login = async (u) => {
  await app.handle({ method: "POST", path: "/register", body: { username: u, password: "pw" } });
  return { authorization: `Bearer ${(await app.handle({ method: "POST", path: "/login", body: { username: u, password: "pw" } })).body.token}` };
};
const a = await login("ann"), b = await login("bob");
assert.equal((await app.handle({ method: "POST", path: "/notes", body: { text: "x" } })).status, 401);
const made = await app.handle({ method: "POST", path: "/notes", headers: a, body: { text: "one" } });
assert.equal(made.status, 201);
const id = made.body.id;
assert.equal((await app.handle({ method: "GET", path: "/notes", headers: b })).body.length, 0);
assert.equal((await app.handle({ method: "PUT", path: `/notes/${id}`, headers: b, body: { text: "hijack" } })).status, 404);
assert.equal((await app.handle({ method: "PUT", path: `/notes/${id}`, headers: a, body: { text: "two" } })).status, 200);
assert.equal((await app.handle({ method: "GET", path: "/notes", headers: a })).body[0].text, "two");
assert.equal((await app.handle({ method: "DELETE", path: `/notes/${id}`, headers: a })).status, 200);
assert.equal((await app.handle({ method: "GET", path: "/notes", headers: a })).body.length, 0);
