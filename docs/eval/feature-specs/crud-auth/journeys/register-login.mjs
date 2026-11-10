// Hidden oracle: a user registers, logs in, and a bad password is refused. BENCH_APP is the app checkout.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { createApp } = await import(pathToFileURL(join(process.env.BENCH_APP, "app.mjs")).href);
const app = createApp();
assert.equal((await app.handle({ method: "POST", path: "/register", body: { username: "ann", password: "pw1" } })).status, 201);
assert.equal((await app.handle({ method: "POST", path: "/register", body: { username: "ann", password: "pw1" } })).status, 409);
assert.equal((await app.handle({ method: "POST", path: "/login", body: { username: "ann", password: "bad" } })).status, 401);
const ok = await app.handle({ method: "POST", path: "/login", body: { username: "ann", password: "pw1" } });
assert.equal(ok.status, 200);
assert.ok(ok.body.token);
